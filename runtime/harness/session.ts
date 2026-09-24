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
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { encodeReply, parseFrame, ProtocolError, type Command, type Level } from './protocol.js';

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
  | 'start_failed';

export interface PadEvent {
  vns: bigint;
  pad: number;
  drive: Level;
  level: Level;
}

export interface SessionHandler {
  /** Initial external pad levels, applied before the first guest instruction. */
  hello?(tickNs: bigint): Command[];
  pad?(e: PadEvent): Command[];
  /** Periodic virtual-time tick: the only point where runtime commands apply (ADR-007). */
  tick?(vns: bigint): Command[];
  serial?(vns: bigint, bytes: Buffer): void;
}

export interface SessionOptions {
  qemu: string;
  /** The session's private writable flash (artifacts.ts overlay). */
  flash: string;
  /** Private session directory (for the optional monitor socket). */
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
    kind: 'malformed_reply' | 'invalid_pad' | 'drop_connection' | 'stop_replying';
  };
  onSpawn?(pid: number): void;
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
  frames: { H: number; G: number; T: number; S: number };
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
  const frames = { H: 0, G: 0, T: 0, S: 0 };
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
  const started = performance.now();

  return new Promise<SessionResult>((resolve) => {
    let sock: Socket | null = null;
    let settled = false;
    let child: ChildProcess;
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
              if (opts.fault.kind === 'malformed_reply') s.write('X not-a-command\n');
              else if (opts.fault.kind === 'invalid_pad') s.write('I 40 1\nC\n');
              else if (opts.fault.kind === 'drop_connection') s.destroy();
              // 'stop_replying': send nothing; QEMU waits and the wall-clock limit ends it.
              hostHolding = true;
              return;
            }
            s.write(reply);
          } catch (e) {
            hostOutcome = e instanceof ProtocolError ? 'protocol_error_host' : 'host_error';
            hostError = (e as Error).message;
            kill('SIGKILL');
          }
        }
      });
      s.on('error', () => {});
    });

    /** One frame from QEMU -> the reply to send (null: no reply expected). */
    function onLine(line: string): string | null {
      const f = parseFrame(line);
      if (f.type !== 'H' && f.vns < lastVns) {
        throw new ProtocolError(`simulation time went backwards: ${f.vns} < ${lastVns}`);
      }
      if (f.type !== 'H') lastVns = f.vns;
      frames[f.type]++;
      if (f.type === 'S') {
        const room = serialLimit - serialBytes;
        if (room > 0) serialChunks.push(f.bytes.subarray(0, room));
        serialBytes += Math.min(room, f.bytes.length);
        serialOverflow += Math.max(0, f.bytes.length - Math.max(room, 0));
        if (quitAt === null) handler.serial?.(f.vns, f.bytes);
        return null;
      }
      if (quitAt !== null) return 'C\n'; // shutting down: let QEMU finish, change nothing
      let cmds: Command[];
      if (f.type === 'H') {
        if (f.version !== 1) throw new ProtocolError(`unsupported bridge protocol ${f.version}`);
        if (f.tickNs !== BigInt(tickUs) * 1000n) throw new ProtocolError('tick mismatch');
        startupMs = performance.now() - started;
        cmds = handler.hello?.(f.tickNs) ?? [];
      } else if (f.type === 'G') {
        cmds = handler.pad?.({ vns: f.vns, pad: f.pad, drive: f.drive, level: f.level }) ?? [];
      } else {
        cmds = handler.tick?.(f.vns) ?? [];
      }
      if (cmds.some((c) => c.type === 'Q')) {
        lastSample = sampleProc(child.pid!) ?? lastSample;
        quitAt = performance.now();
      }
      return encodeReply(cmds);
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
        lastVns,
        startupMs: null,
        wallMs: performance.now() - started,
        shutdownMs: null,
        qemu: null,
      });
    });
    server.listen(0, '127.0.0.1', () => start((server.address() as { port: number }).port));

    function start(port: number): void {
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
        `tbi-bridge,syncport=127.0.0.1:${port},tick-us=${tickUs}`,
        ...(opts.stressMainLoop ? ['-qmp', `unix:${qmp},server=on,wait=off`] : []),
      ];
      child = spawn(opts.qemu, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
          if (!progressed && quitAt === null && !hostHolding && !stalled) {
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
        if (stress) clearInterval(stress);
        server.close();
        (sock as Socket | null)?.destroy();
        const ended = performance.now();
        let outcome: Outcome;
        if (hostOutcome) outcome = hostOutcome;
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
