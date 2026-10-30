/**
 * One classic-ESP32 runtime session (runtime R1): a QEMU process plus the host end of the
 * synchronous bridge (protocol.ts). Every frame QEMU raises is answered before the guest
 * continues, so the host's electrical response is applied at zero elapsed simulation time.
 *
 * Fail closed. Every way a session can end is classified (`Outcome`); nothing restarts, nothing
 * is retried, and the caller's firmware artifact and project are never touched (the session runs
 * on a private overlay, artifacts.ts). Guest serial output (UART0, `S` frames) and QEMU's own
 * diagnostics (stderr) are kept strictly apart and both are bounded.
 */
import { directLauncher, type RuntimeLauncher, type RuntimeProcess } from './launcher.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  encodeReply,
  parseFrame,
  ProtocolError,
  type Capability,
  type Command,
  type I2cPhase,
  type InputSchedule,
  type LedcChannelState,
  type LedcTimerState,
  type Level,
  type PadFunction,
  type UnmodelledFacility,
} from './protocol.js';

/** How a session ended. */
export type Outcome =
  /** The host asked QEMU to quit (`Q`) and it exited cleanly. */
  | 'completed'
  /** QEMU exited on its own (e.g. the guest requested a reset/shutdown: unsupported in V1). */
  | 'guest_exit'
  /** QEMU's bridge rejected the host's reply and terminated (exit status 3). */
  | 'protocol_error_runtime'
  /** The host rejected a frame from QEMU (malformed, out of order) and terminated QEMU. */
  | 'protocol_error_host'
  /** QEMU lost its host connection (a crashed host bridge) and terminated (exit status 4). */
  | 'peer_lost'
  /** The host-side handler threw (e.g. a command-ordering error); QEMU was terminated. */
  | 'host_error'
  /** QEMU died from a signal it was not sent by the session (a crash). */
  | 'crashed'
  /** The wall-clock limit expired; QEMU was terminated. */
  | 'timeout'
  /**
   * The runtime stopped making simulation progress: less than 1 ms of simulation time in
   * `stallTimeoutMs` of wall time while the host owed it nothing (a healthy session advances
   * about a thousand times faster). Observed with an erased flash: the mask ROM rejects the
   * image and virtual time freezes (upstream behaviour, also without the TBI patches; a real chip
   * would be reset by its RTC watchdog, which V1 does not support). QEMU was terminated.
   */
  | 'stalled'
  /** QEMU exited before completing the bridge handshake (bad arguments, bad firmware path...). */
  | 'start_failed'
  /** Runtime R2: no bridge handshake within `startupTimeoutMs`; QEMU was terminated. */
  | 'start_timeout'
  /**
   * Runtime R2: ended on request (`signal` aborted), or QEMU did not exit within `quitGraceMs`
   * after the host asked it to quit. QEMU was terminated.
   */
  | 'terminated';

export interface PadEvent {
  vns: bigint;
  pad: number;
  drive: Level;
  level: Level;
}

export interface PadFunctionEvent {
  vns: bigint;
  pad: number;
  func: PadFunction;
  openDrain: boolean;
}

export interface I2cEvent {
  vns: bigint;
  bus: 0 | 1;
  phase: I2cPhase;
}

/** An LEDC timer or channel changed (capability `pwm`, patch 0009). */
export type PwmEvent =
  | { vns: bigint; timer: number; state: LedcTimerState }
  | { vns: bigint; signal: number; state: LedcChannelState };

export interface SessionHandler {
  /**
   * Initial external pad levels, applied before the first guest instruction. `caps` are the
   * runtime's bridge capabilities (empty for a v1 runtime, ADR-011 §1).
   */
  hello?(tickNs: bigint, caps: readonly Capability[]): Command[];
  pad?(e: PadEvent): Command[];
  /** A pad's routed function changed (capability `pad-func`). */
  func?(e: PadFunctionEvent): Command[];
  /**
   * One I2C bus phase (capability `i2c`). The reply must hold exactly one `K` (S, W) or `D` (R)
   * and none for P. Without a handler no target exists: START and bytes are NACKed and a read
   * sees the released bus (0xff).
   */
  i2c?(e: I2cEvent): Command[];
  /** An LEDC timer (`P`) or channel (`W`) state change (capability `pwm`). Reply `C` only. */
  pwm?(e: PwmEvent): Command[];
  /** Periodic virtual-time tick: the only point where runtime commands apply (ADR-007). */
  tick?(vns: bigint): Command[];
  /** (unmodelled, Runtime v4) the guest started using a facility the emulator does not model. */
  unmodelled?(vns: bigint, facility: UnmodelledFacility): Command[];
  /** (input-read, Runtime v5) the guest read an input register while these marked pads were undefined. */
  inputRead?(vns: bigint, pads: readonly number[]): Command[];
  serial?(vns: bigint, bytes: Buffer): void;
}

export interface SessionOptions {
  qemu: string;
  /** The session's private writable flash (artifacts.ts overlay). */
  flash: string;
  /**
   * Private session directory: the bridge's unix socket (and the optional monitor socket) live
   * here (Sprint 8: no TCP, so the runtime needs no network access).
   */
  dir: string;
  /** Host command quantum, microseconds of simulation time. V1: 1000 (ADR-007). */
  tickUs?: number;
  /** Diagnostic stress: a monitor client querying QEMU's main loop every ~1 ms. */
  stressMainLoop?: boolean;
  wallTimeoutMs?: number;
  /** Wall window in which less than 1 ms of simulation progress is a stall. Default 10 s. */
  stallTimeoutMs?: number;
  serialLimitBytes?: number;
  diagnosticsLimitBytes?: number;
  /** Fault injection for failure-mode tests (never used in normal sessions). */
  fault?: {
    afterFrames: number;
    kind: 'malformed_reply' | 'invalid_pad' | 'drop_connection' | 'stop_replying' | 'raw_reply';
    /** `raw_reply`: these exact reply lines (without the final `C`), bypassing the encoder. */
    reply?: string[];
  };
  onSpawn?(pid: number): void;
  // ---- Runtime R2 (Session Host); all optional, defaults keep the R1 behaviour ----------------
  /** Abort: terminate QEMU (SIGTERM, then SIGKILL after `killGraceMs`). Outcome 'terminated'. */
  signal?: AbortSignal;
  /** Environment for QEMU. Default: the host's (R1). The Session Host passes a minimal one. */
  env?: NodeJS.ProcessEnv;
  /** Wall time allowed from spawn to the bridge handshake. Default: none (R1). */
  startupTimeoutMs?: number;
  /** After `Q`, wall time allowed for QEMU to exit before it is killed. Default: none (R1). */
  quitGraceMs?: number;
  /** SIGTERM -> SIGKILL grace when terminating on abort. Default 0 (immediate SIGKILL). */
  killGraceMs?: number;
  /** How QEMU is started (Sprint 8): directly (default) or as a sandboxed per-session unit. */
  launch?: RuntimeLauncher;
  // ---- Sprint 12 (bridge v2) ------------------------------------------------------------------
  /**
   * The host's mirror of QEMU's scheduled-input queue. The session advances it on every frame and
   * records every `J`/`X` it sends, so a handler can check `problem()` before scheduling.
   */
  schedule?: InputSchedule;
  /**
   * Sprint 12 (D-10, V1-ARCHITECTURE §7.8): real-time pacing. Simulation time may run at most
   * `rate` x wall time after the handshake (1 = real time). The cap is applied ONLY by delaying
   * the reply to a tick: QEMU waits for every reply, so simulation time does not advance while it
   * is withheld and pacing cannot alter the simulated timeline. A session behind real time is
   * never sped up. Absent: unpaced (as fast as the host allows).
   */
  pace?: { rate: number; slackMs?: number };
  /** Observation only: called for every tick with the wall-clock gap since the previous one. */
  onTickGap?(gapMs: number, vns: bigint): void;
}

export interface ResourceSample {
  vmRssKb: number;
  vmHwmKb: number;
  cpuMs: number;
}

export interface SessionResult {
  outcome: Outcome;
  exitCode: number | null;
  signal: string | null;
  error?: string;
  /** QEMU stderr: runtime diagnostics only, never guest output. */
  diagnostics: string;
  /** Guest UART0 output, in order. */
  serial: Buffer;
  /** Bytes dropped because the serial buffer limit was reached. */
  serialOverflow: number;
  frames: {
    H: number;
    G: number;
    T: number;
    S: number;
    F: number;
    B: number;
    P: number;
    W: number;
  };
  /** Sprint 12 (D-10): wall time the tick replies were withheld to keep real time (0: unpaced). */
  pacedMs: number;
  /** Bridge capabilities the runtime announced (empty: v1 runtime or no handshake). */
  caps: Capability[];
  lastVns: bigint;
  /** spawn -> bridge handshake (machine initialised, before the first guest instruction). */
  startupMs: number | null;
  wallMs: number;
  /** `Q` sent -> process exited. */
  shutdownMs: number | null;
  /** Last /proc sample of the QEMU process (taken just before shutdown when completed). */
  qemu: ResourceSample | null;
}

const CLK_TCK = 100;
/** Minimum simulation progress per stall window (see 'stalled'). */
const STALL_MIN_PROGRESS_NS = 1_000_000n;

function sampleProc(pid: number): ResourceSample | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(status)?.[1]);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[11]) + Number(fields[12]); // utime + stime
    return { vmRssKb: kb('VmRSS'), vmHwmKb: kb('VmHWM'), cpuMs: (ticks * 1000) / CLK_TCK };
  } catch {
    return null;
  }
}

export function runSession(opts: SessionOptions, handler: SessionHandler): Promise<SessionResult> {
  const tickUs = opts.tickUs ?? 1000;
  const serialLimit = opts.serialLimitBytes ?? 1 << 20;
  const diagLimit = opts.diagnosticsLimitBytes ?? 64 << 10;
  const frames = { H: 0, G: 0, T: 0, S: 0, F: 0, B: 0, P: 0, W: 0, U: 0, N: 0 };
  let caps: Capability[] = [];
  let hello = false;
  let pacedMs = 0;
  let paceOrigin: number | null = null;
  let lastTickWall: number | null = null;
  const serialChunks: Buffer[] = [];
  let serialBytes = 0;
  let serialOverflow = 0;
  let diagnostics = '';
  let lastVns = 0n;
  let startupMs: number | null = null;
  let quitAt: number | null = null;
  let hostOutcome: Outcome | null = null;
  let hostError: string | undefined;
  let lastSample: ResourceSample | null = null;
  let progressMark: { wall: number; vns: bigint } | null = null;
  let hostHolding = false;
  let stalled = false;
  let startupTimedOut = false;
  let terminated = false;
  let quitForced = false;
  const started = performance.now();

  return new Promise<SessionResult>((resolve) => {
    let sock: Socket | null = null;
    let settled = false;
    let child: RuntimeProcess;
    const server = createServer((s) => {
      if (sock) {
        s.destroy(); // exactly one bridge connection per session
        return;
      }
      sock = s;
      s.setNoDelay(true);
      let buf = '';
      progressMark = { wall: performance.now(), vns: 0n };
      let handled = 0;
      s.on('data', (chunk) => {
        buf += chunk.toString('latin1');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0 && !hostOutcome) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const reply = onLine(line);
            if (reply === null) continue;
            handled++;
            if (opts.fault && handled >= opts.fault.afterFrames && quitAt === null) {
              if (opts.fault.kind === 'malformed_reply') s.write('Z not-a-command\n');
              else if (opts.fault.kind === 'invalid_pad') s.write('I 40 1\nC\n');
              else if (opts.fault.kind === 'raw_reply')
                s.write(`${(opts.fault.reply ?? []).map((l) => `${l}\n`).join('')}C\n`);
              else if (opts.fault.kind === 'drop_connection') s.destroy();
              // 'stop_replying': send nothing; QEMU waits and the wall-clock limit ends it.
              hostHolding = true;
              return;
            }
            const hold = paceHold(line);
            if (hold > 0) {
              pacedMs += hold;
              setTimeout(() => !s.destroyed && s.write(reply), hold);
            } else s.write(reply);
          } catch (e) {
            hostOutcome = e instanceof ProtocolError ? 'protocol_error_host' : 'host_error';
            hostError = (e as Error).message;
            kill('SIGKILL');
          }
        }
      });
      s.on('error', () => {});
    });

    /**
     * Pacing (D-10): how long to withhold the reply to `line` (a tick only). Simulation time
     * `vns` may not run ahead of wall time since the handshake, by more than the slack.
     */
    function paceHold(line: string): number {
      if (line[0] !== 'T') return 0;
      const now = performance.now();
      if (lastTickWall !== null) opts.onTickGap?.(now - lastTickWall, lastVns);
      lastTickWall = now;
      if (!opts.pace || paceOrigin === null || quitAt !== null) return 0;
      const due = paceOrigin + Number(lastVns) / 1e6 / opts.pace.rate;
      const ahead = due - now;
      if (ahead <= (opts.pace.slackMs ?? 2)) return 0;
      lastTickWall = due; // the gap is measured from when the reply is released
      return ahead;
    }

    /** One frame from QEMU -> the reply to send (null: no reply expected). */
    function onLine(line: string): string | null {
      const f = parseFrame(line);
      if (f.type === 'H') {
        if (hello) throw new ProtocolError('second bridge handshake');
        hello = true;
      } else if (!hello) throw new ProtocolError(`${f.type} frame before the handshake`);
      if (f.type !== 'H' && f.vns < lastVns) {
        throw new ProtocolError(`simulation time went backwards: ${f.vns} < ${lastVns}`);
      }
      if (f.type !== 'H') {
        lastVns = f.vns;
        opts.schedule?.advance(f.vns);
      }
      if (f.type === 'F' && !caps.includes('pad-func'))
        throw new ProtocolError('F frame without the pad-func capability');
      if (f.type === 'B' && !caps.includes('i2c'))
        throw new ProtocolError('B frame without the i2c capability');
      // Runtime v5: with i2c-clock every START carries its SCL period; without it none does.
      if (
        f.type === 'B' &&
        f.phase.op === 'S' &&
        caps.includes('i2c-clock') !== (f.phase.sclCycles !== undefined)
      )
        throw new ProtocolError('B S frame with an SCL period that does not match i2c-clock');
      if ((f.type === 'P' || f.type === 'W') && !caps.includes('pwm'))
        throw new ProtocolError(`${f.type} frame without the pwm capability`);
      if (f.type === 'U' && !caps.includes('unmodelled'))
        throw new ProtocolError('U frame without the unmodelled capability');
      if (f.type === 'N' && !caps.includes('input-read'))
        throw new ProtocolError('N frame without the input-read capability');
      frames[f.type]++;
      if (f.type === 'S') {
        const room = serialLimit - serialBytes;
        if (room > 0) serialChunks.push(f.bytes.subarray(0, room));
        serialBytes += Math.min(room, f.bytes.length);
        serialOverflow += Math.max(0, f.bytes.length - Math.max(room, 0));
        if (quitAt === null) handler.serial?.(f.vns, f.bytes);
        return null;
      }
      const ctx = { frame: f, caps };
      // A bus phase always needs its K/D, also while shutting down (the target is gone: NACK).
      const absent = (p: I2cPhase): Command[] =>
        p.op === 'R'
          ? [{ type: 'D', byte: 0xff }]
          : p.op === 'P'
            ? []
            : [{ type: 'K', ack: false }];
      if (quitAt !== null) return encodeReply(f.type === 'B' ? absent(f.phase) : [], ctx);
      let cmds: Command[];
      if (f.type === 'H') {
        if (f.tickNs !== BigInt(tickUs) * 1000n) throw new ProtocolError('tick mismatch');
        caps = f.caps;
        ctx.caps = caps;
        startupMs = performance.now() - started;
        paceOrigin = performance.now();
        cmds = handler.hello?.(f.tickNs, caps) ?? [];
      } else if (f.type === 'G') {
        cmds = handler.pad?.({ vns: f.vns, pad: f.pad, drive: f.drive, level: f.level }) ?? [];
      } else if (f.type === 'F') {
        cmds =
          handler.func?.({ vns: f.vns, pad: f.pad, func: f.func, openDrain: f.openDrain }) ?? [];
      } else if (f.type === 'B') {
        cmds = handler.i2c
          ? handler.i2c({ vns: f.vns, bus: f.bus, phase: f.phase })
          : absent(f.phase);
      } else if (f.type === 'P') {
        cmds = handler.pwm?.({ vns: f.vns, timer: f.timer, state: f.state }) ?? [];
      } else if (f.type === 'W') {
        cmds = handler.pwm?.({ vns: f.vns, signal: f.signal, state: f.state }) ?? [];
      } else if (f.type === 'U') {
        // Fail closed: a host that does not handle it ends the run at once, as a FAILURE
        // (host_error), never as a normal completion (independent review, finding 6).
        if (!handler.unmodelled)
          throw new Error(`unmodelled facility ${f.facility} at ${f.vns} ns (no handler)`);
        cmds = handler.unmodelled(f.vns, f.facility);
      } else if (f.type === 'N') {
        // Fail closed like U: an unhandled read of an undefined input ends the run as a failure.
        if (!handler.inputRead)
          throw new Error(
            `undefined input read on ${f.pads.join(',')} at ${f.vns} ns (no handler)`,
          );
        cmds = handler.inputRead(f.vns, f.pads);
      } else {
        cmds = handler.tick?.(f.vns) ?? [];
      }
      const reply = encodeReply(cmds, ctx);
      for (const c of cmds) {
        if (c.type === 'J') opts.schedule?.add(c.vns, c.pad);
        else if (c.type === 'X') opts.schedule?.cancel(c.pad);
      }
      if (cmds.some((c) => c.type === 'Q')) {
        lastSample = sampleProc(child.pid!) ?? lastSample;
        quitAt = performance.now();
      }
      return reply;
    }

    let killedBySession = false;
    const kill = (sig: NodeJS.Signals) => {
      killedBySession = true;
      child.kill(sig);
    };

    server.on('error', (e) => {
      settled = true;
      resolve({
        outcome: 'start_failed',
        exitCode: null,
        signal: null,
        error: `bridge listener: ${e.message}`,
        diagnostics: '',
        serial: Buffer.alloc(0),
        serialOverflow: 0,
        frames,
        caps,
        pacedMs,
        lastVns,
        startupMs: null,
        wallMs: performance.now() - started,
        shutdownMs: null,
        qemu: null,
      });
    });
    // The bridge endpoint is a unix socket in the private session directory (Sprint 8): QEMU
    // connects by path, so it needs no network access at all.
    // A unix socket path must fit in 108 bytes. A session directory nested deep (tests) gets its
    // socket in a short private directory instead, removed with the session; the sandboxed runtime
    // unit always uses <session root>/s-<id>/bridge.sock, which is short.
    let shortDir: string | null = null;
    let bridgePath = join(opts.dir, 'bridge.sock');
    if (Buffer.byteLength(bridgePath) >= 100) {
      // Named like a host root (tbi-host-<pid>-…): if this process dies outright, the next
      // host's stale-root sweep removes it.
      shortDir = mkdtempSync(join(tmpdir(), `tbi-host-${process.pid}-br-`));
      bridgePath = join(shortDir, 'b.sock');
    }
    if (bridgePath.includes(',')) throw new Error(`unusable bridge socket path: ${bridgePath}`);
    server.listen(bridgePath, () => start(bridgePath));

    function start(path: string): void {
      const qmp = join(opts.dir, 'qmp.sock');
      const args = [
        '-machine',
        'esp32',
        '-display',
        'none',
        '-monitor',
        'none',
        '-no-reboot',
        '-drive',
        `file=${opts.flash},if=mtd,format=raw`,
        '-icount',
        'shift=3,sleep=off',
        '-chardev',
        'tbi-serial,id=tbiser',
        '-serial',
        'chardev:tbiser',
        '-device',
        `tbi-bridge,syncpath=${path},tick-us=${tickUs}`,
        ...(opts.stressMainLoop ? ['-qmp', `unix:${qmp},server=on,wait=off`] : []),
      ];
      // Sprint 13 (overnight audit): a launcher that throws (the systemd launcher refuses a bad
      // session layout, or chmod/env-file writes fail, e.g. on a full disk) used to escape here,
      // inside the listen callback: the session never settled and, in the Session Host, the
      // uncaught exception ended the process for every user. It is now a start failure.
      try {
        child = (opts.launch ?? directLauncher)({
          qemu: opts.qemu,
          args,
          ...(opts.env ? { env: opts.env } : {}),
          dir: opts.dir,
          flash: opts.flash,
          bridgePath: path,
          tickUs,
          stressMainLoop: !!opts.stressMainLoop,
        });
      } catch (e) {
        settled = true;
        server.close();
        if (shortDir) rmSync(shortDir, { recursive: true, force: true });
        resolve({
          outcome: 'start_failed',
          exitCode: null,
          signal: null,
          error: e instanceof Error ? e.message : String(e),
          diagnostics: '',
          serial: Buffer.alloc(0),
          serialOverflow: 0,
          frames,
          caps,
          pacedMs: 0,
          lastVns: 0n,
          startupMs: null,
          wallMs: performance.now() - started,
          shutdownMs: null,
          qemu: null,
        });
        return;
      }
      let spawnError: string | undefined;
      child.on('error', (e) => (spawnError = e.message));
      if (child.pid !== undefined) opts.onSpawn?.(child.pid);
      child.stderr!.on('data', (d: Buffer) => {
        if (diagnostics.length < diagLimit)
          diagnostics += d.toString().slice(0, diagLimit - diagnostics.length);
      });

      const sampler = setInterval(() => {
        if (quitAt === null) lastSample = sampleProc(child.pid!) ?? lastSample;
        const now = performance.now();
        if (progressMark && now - progressMark.wall > (opts.stallTimeoutMs ?? 10_000)) {
          const progressed = lastVns - progressMark.vns >= STALL_MIN_PROGRESS_NS;
          // Stalls count only after the handshake: before it, `startupTimeoutMs` (R2) or the
          // wall timeout owns the failure.
          if (!progressed && startupMs !== null && quitAt === null && !hostHolding && !stalled) {
            stalled = true;
            kill('SIGKILL');
          }
          progressMark = { wall: now, vns: lastVns };
        }
      }, 200);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        kill('SIGKILL');
      }, opts.wallTimeoutMs ?? 240_000);
      // Runtime R2 controls.
      const r2Timers: ReturnType<typeof setTimeout>[] = [];
      if (opts.startupTimeoutMs !== undefined) {
        r2Timers.push(
          setTimeout(() => {
            if (startupMs === null && !settled) {
              startupTimedOut = true;
              kill('SIGKILL');
            }
          }, opts.startupTimeoutMs),
        );
      }
      const terminate = () => {
        if (settled || terminated) return;
        terminated = true;
        const grace = opts.killGraceMs ?? 0;
        if (grace <= 0) return kill('SIGKILL');
        kill('SIGTERM');
        r2Timers.push(setTimeout(() => !settled && kill('SIGKILL'), grace));
      };
      if (opts.signal?.aborted) terminate();
      else opts.signal?.addEventListener('abort', terminate, { once: true });
      if (opts.quitGraceMs !== undefined) {
        const grace = opts.quitGraceMs;
        const watch = setInterval(() => {
          if (quitAt !== null && !settled && performance.now() - quitAt > grace) {
            clearInterval(watch);
            quitForced = true;
            kill('SIGKILL');
          }
        }, 50);
        r2Timers.push(watch as unknown as ReturnType<typeof setTimeout>);
      }

      let stress: ReturnType<typeof setInterval> | null = null;
      if (opts.stressMainLoop) {
        const attach = () => {
          const q = connect(qmp);
          q.on('error', () => !settled && setTimeout(attach, 50));
          q.on('data', () => {});
          q.on('connect', () => {
            q.write('{"execute":"qmp_capabilities"}\n');
            stress = setInterval(() => !q.destroyed && q.write('{"execute":"query-status"}\n'), 1);
          });
        };
        setTimeout(attach, 50);
      }

      // 'close' (not 'exit'): also fires when the executable could not be started at all.
      child.on('close', (code, signal) => {
        settled = true;
        clearInterval(sampler);
        clearTimeout(timer);
        for (const t of r2Timers) clearTimeout(t as ReturnType<typeof setTimeout>);
        opts.signal?.removeEventListener('abort', terminate);
        if (stress) clearInterval(stress);
        server.close();
        if (shortDir) rmSync(shortDir, { recursive: true, force: true });
        (sock as Socket | null)?.destroy();
        const ended = performance.now();
        let outcome: Outcome;
        if (hostOutcome) outcome = hostOutcome;
        else if (terminated || quitForced) outcome = 'terminated';
        else if (startupTimedOut) outcome = 'start_timeout';
        else if (timedOut) outcome = 'timeout';
        else if (stalled) outcome = 'stalled';
        else if (code === 3) outcome = 'protocol_error_runtime';
        else if (code === 4) outcome = 'peer_lost';
        else if (signal && !killedBySession) outcome = 'crashed';
        else if (startupMs === null) outcome = 'start_failed';
        else if (code === 0 && quitAt !== null) outcome = 'completed';
        else outcome = 'guest_exit';
        if (spawnError && !hostError) hostError = spawnError;
        const serial = Buffer.concat(serialChunks);
        resolve({
          outcome,
          exitCode: code,
          signal,
          ...(hostError ? { error: hostError } : {}),
          diagnostics,
          serial,
          serialOverflow,
          frames,
          caps,
          pacedMs,
          lastVns,
          startupMs,
          wallMs: ended - started,
          shutdownMs: quitAt === null ? null : ended - quitAt,
          qemu: lastSample,
        });
      });
    }
  });
}
