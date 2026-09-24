/**
 * One Session Host session (runtime R2): private flash copy, one QEMU process, the synchronous
 * bridge, the production electrical engine, a command queue and a bounded event log. Nothing is
 * shared with any other session; nothing mutable is global.
 *
 * The MCU <-> electrical loop runs here, co-located: a pad event from QEMU is solved by the SAME
 * EngineSession the browser uses and the resulting input levels are injected before the guest's
 * next instruction, at the pad event's own simulation time. Host commands (mirrors, transient
 * input) apply only at command ticks (hostCommandQuantum = 1 ms of simulation time), which R1
 * patch 0005 guarantees do not shape guest execution.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { ESP32_DEVKITC_WROOM32, boardPinForGpio } from '@tbi-lab/domain';
import {
  EngineSession,
  interpretDigitalInput,
  type DigitalLevel,
  type RuntimePinMode,
  type SolveOutcome,
} from '@tbi-lab/engine';
import type { Command } from '../harness/protocol.js';
import { runSession, type Outcome, type SessionResult } from '../harness/session.js';
import type { HostConfig } from './config.js';
import { sessionDir } from './config.js';
import { EventLog } from './eventLog.js';
import {
  COMMAND_QUANTUM_US,
  jsonSafe,
  type CommandRejection,
  type CreateSessionRequest,
  type EndReason,
  type FailReason,
  type SessionCommand,
  type SessionState,
} from './protocol.js';
import { SessionStateMachine, isTerminal } from './stateMachine.js';

const SHA = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
const fileSha = (path: string) => SHA(readFileSync(path));

interface Queued {
  command: SessionCommand;
  atNs: bigint | null;
}

export interface SessionStatus {
  sessionId: string;
  state: SessionState;
  reason: EndReason | FailReason | null;
  detail?: unknown;
  simNs: string;
  lastEventSeq: number;
  createdAt: string;
  endedAt: string | null;
  runtime: { pid: number | null; outcome: Outcome | null };
}

export class HostSession {
  readonly id = randomBytes(16).toString('hex');
  /** Only its hash is kept; compared in constant time by the host. */
  readonly tokenHash: string;
  readonly token: string;
  readonly sm = new SessionStateMachine();
  readonly log: EventLog;
  readonly createdAt = new Date();
  endedAt: Date | null = null;
  lastActivity = performance.now();
  streams = 0;

  private readonly dir: string;
  private readonly flash: string;
  private engine: EngineSession | null = null;
  private readonly quantumNs: bigint;
  private readonly publishNs: bigint;
  private readonly lifetimeMs: number;
  private readonly abort = new AbortController();
  private pid: number | null = null;
  private outcome: Outcome | null = null;
  private runPromise: Promise<void> | null = null;

  // ---- runtime loop state (touched only from the bridge handlers) ----
  private lastTickNs = -1n;
  private simNs = 0n;
  private queue: Queued[] = [];
  private lastClientSeq = -1;
  private quitRequested = false;
  private pendingFailure: { reason: FailReason; detail?: unknown } | null = null;
  private endRequest: EndReason | null = null;
  private inputLevels = new Map<number, DigitalLevel>();
  private gpioWindow = new Map<number, { drive: 0 | 1; level: 0 | 1; transitions: number }>();
  private serialWindow: Buffer[] = [];
  private serialWindowBytes = 0;
  private serialDropped = 0;
  private latest: SolveOutcome | null = null;
  private readonly inputOnlyDiagnosed = new Set<number>();
  private latestPublished: string | null = null;

  constructor(
    private readonly config: HostConfig,
    private readonly tmpRoot: string,
    private readonly request: CreateSessionRequest,
  ) {
    this.token = randomBytes(24).toString('base64url');
    this.tokenHash = SHA(Buffer.from(this.token));
    this.log = new EventLog(config.eventLogCapacity);
    this.dir = sessionDir(tmpRoot, this.id);
    this.flash = join(this.dir, 'flash.bin');
    const quantumUs = request.commandQuantumUs ?? COMMAND_QUANTUM_US;
    this.quantumNs = BigInt(quantumUs) * 1000n;
    // Publishing happens on command ticks: the window is a whole number of quanta.
    const windows = Math.max(1, Math.round(config.publishIntervalUs / quantumUs));
    this.publishNs = this.quantumNs * BigInt(windows);
    this.lifetimeMs = Math.min(config.maxLifetimeMs, request.limits?.maxLifetimeMs ?? Infinity);
  }

  get state(): SessionState {
    return this.sm.state;
  }

  private emitState(detail?: unknown) {
    const reason = this.sm.reason ?? undefined;
    this.log.append({
      type: 'state',
      simNs: null,
      state: this.sm.state,
      ...(reason && isTerminal(this.sm.state) ? { reason } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  private fail(reason: FailReason, detail?: unknown) {
    if (isTerminal(this.sm.state)) return;
    this.sm.to('failed', reason, detail);
    this.endedAt = new Date();
    this.discardFiles();
    this.emitState(detail);
  }

  private end(reason: EndReason) {
    if (isTerminal(this.sm.state)) return;
    // A running session always passes through `stopping` (its resources are being released).
    if (this.sm.state === 'running') {
      this.sm.to('stopping');
      this.emitState();
    }
    this.sm.to('ended', reason);
    this.endedAt = new Date();
    this.discardFiles();
    this.emitState();
  }

  /** Remove the private directory. Idempotent. Guest writes are discarded here. */
  private discardFiles() {
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Bytes used by the session directory (flash copy and anything the runtime creates). */
  storageBytes(): number {
    if (!existsSync(this.dir)) return 0;
    return readdirSync(this.dir).reduce((n, f) => {
      try {
        return n + statSync(join(this.dir, f)).size;
      } catch {
        return n;
      }
    }, 0);
  }

  // -------------------------------------------------------------------------------------------
  // creating -> ready

  /**
   * Verify the artifact, make the private copy, check capabilities and compile the circuit.
   * Synchronous and bounded (a 4 MiB hash and copy): no client input reaches a file path.
   */
  prepare(): void {
    this.emitState();
    const sha = this.request.artifact.sha256; // validated: 64 lowercase hex characters
    const artifact = join(this.config.artifactsDir, `${sha}.bin`);
    if (!existsSync(artifact)) return this.fail('artifact_unknown', { sha256: sha });
    let actual: string;
    try {
      actual = fileSha(artifact);
    } catch {
      return this.fail('artifact_missing', { sha256: sha });
    }
    if (actual !== sha) return this.fail('artifact_hash_mismatch', { sha256: sha });

    // Features V1 does not simulate: refuse explicitly instead of running with dead behaviour.
    const f = this.request.firmwareFeatures ?? {};
    const unsupported = {
      ...(f.internalPull?.length ? { internalPull: f.internalPull } : {}),
      ...(f.gpioInterrupt?.length ? { gpioInterrupt: f.gpioInterrupt } : {}),
    };
    if (Object.keys(unsupported).length) {
      this.log.append({
        type: 'diagnostic',
        simNs: null,
        severity: 'error',
        code: 'unsupported_feature',
        detail: unsupported,
      });
      return this.fail('unsupported_feature', unsupported);
    }

    // Board capability map (R1.3): only pads the simulator supports may join the circuit.
    for (const a of this.request.attachments) {
      const pin = boardPinForGpio(ESP32_DEVKITC_WROOM32, a.gpio);
      if (!pin || pin.simulatorSupport === 'none') {
        return this.fail('invalid_attachment', {
          gpio: a.gpio,
          reason: pin ? pin.reason : 'not exposed on this board',
        });
      }
    }

    // Private writable copy in a fresh 0700 directory; the copy is verified too.
    mkdirSync(this.dir, { mode: 0o700 });
    copyFileSync(artifact, this.flash);
    chmodSync(this.flash, 0o600);
    if (fileSha(this.flash) !== sha) return this.fail('artifact_hash_mismatch', { sha256: sha });
    if (this.storageBytes() > this.config.maxSessionStorageBytes) return this.fail('storage_limit');

    // The production engine, with the board pads attached.
    this.engine = new EngineSession(this.request.circuit, { pins: this.request.attachments });
    const first = this.engine.solve();
    if (!first.ok) {
      if (first.error.code === 'invalid_attachment')
        return this.fail('invalid_attachment', jsonSafe(first.error));
      return this.fail('electrical_error', jsonSafe(first.error));
    }
    this.latest = first;
    if (this.endRequest) return this.end(this.endRequest); // terminated while creating
    this.sm.to('ready');
    this.emitState();
  }

  // -------------------------------------------------------------------------------------------
  // ready -> running -> stopping -> ended/failed

  run(): { ok: true } | { ok: false; error: string } {
    if (this.sm.state !== 'ready') return { ok: false, error: `cannot run from ${this.sm.state}` };
    this.sm.to('running');
    this.emitState();
    this.runPromise = this.execute();
    return { ok: true };
  }

  /** Orderly stop: the runtime quits at its next command tick. Idempotent. */
  stop(): void {
    if (this.sm.state === 'ready' || this.sm.state === 'creating') {
      if (this.sm.state === 'creating') this.endRequest = 'stopped';
      else this.end('stopped');
      return;
    }
    if (this.sm.state !== 'running') return;
    this.sm.to('stopping');
    this.emitState();
    this.quitRequested = true;
  }

  /** Immediate termination for any reason; resources are released before it reports ended. */
  terminate(reason: EndReason): Promise<void> {
    const s = this.sm.state;
    if (isTerminal(s)) return Promise.resolve();
    if (s === 'creating') {
      this.endRequest = reason;
      return Promise.resolve();
    }
    if (s === 'ready') {
      this.end(reason);
      return Promise.resolve();
    }
    this.endRequest = reason;
    if (s === 'running') {
      this.sm.to('stopping');
      this.emitState();
    }
    this.abort.abort();
    return this.runPromise ?? Promise.resolve();
  }

  /**
   * Host-initiated failure (a limit was exceeded): the runtime is terminated and the session
   * ends FAILED with `reason`. Idempotent.
   */
  failNow(reason: FailReason, detail?: unknown): Promise<void> {
    const st = this.sm.state;
    if (isTerminal(st)) return Promise.resolve();
    if (st === 'creating' || st === 'ready') {
      this.fail(reason, detail);
      return Promise.resolve();
    }
    this.pendingFailure = { reason, detail };
    this.abort.abort();
    return this.runPromise ?? Promise.resolve();
  }

  /** Resolves once the runtime process has exited and the session is terminal. */
  done(): Promise<void> {
    return this.runPromise ?? Promise.resolve();
  }

  private async execute(): Promise<void> {
    let result: SessionResult;
    try {
      result = await runSession(
        {
          qemu: this.config.qemu,
          flash: this.flash,
          dir: this.dir,
          tickUs: Number(this.quantumNs / 1000n),
          env: this.config.runtimeEnv,
          signal: this.abort.signal,
          startupTimeoutMs: this.config.startupTimeoutMs,
          stallTimeoutMs: this.config.stallTimeoutMs,
          wallTimeoutMs: Number.isFinite(this.lifetimeMs) ? this.lifetimeMs : 2 ** 31 - 1,
          quitGraceMs: this.config.quitGraceMs,
          killGraceMs: this.config.killGraceMs,
          onSpawn: (pid) => (this.pid = pid),
        },
        {
          hello: () => this.onHello(),
          pad: (e) => this.onPad(e.vns, e.pad, e.drive, e.level),
          tick: (vns) => this.onTick(vns),
          serial: (vns, bytes) => this.onSerial(vns, bytes),
        },
      );
    } catch (e) {
      this.fail('internal', { message: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.outcome = result.outcome;
    this.flushWindow(this.simNs); // whatever the runtime produced before it ended
    this.finish(result);
  }

  private finish(r: SessionResult): void {
    if (this.pendingFailure)
      return this.fail(this.pendingFailure.reason, this.pendingFailure.detail);
    const detail = { outcome: r.outcome, exitCode: r.exitCode, signal: r.signal, error: r.error };
    switch (r.outcome) {
      case 'completed':
        return this.end(this.endRequest ?? 'stopped');
      case 'terminated':
        if (this.endRequest) return this.end(this.endRequest);
        return this.fail('internal', { ...detail, note: 'runtime did not quit within the grace' });
      case 'timeout':
        return this.end('lifetime_exceeded');
      case 'guest_exit':
        return this.fail('guest_reset', detail);
      case 'protocol_error_runtime':
        return this.fail('runtime_protocol_error', detail);
      case 'protocol_error_host':
        return this.fail('host_protocol_error', detail);
      case 'peer_lost':
        return this.fail('bridge_lost', detail);
      case 'crashed':
        return this.fail('runtime_crashed', detail);
      case 'stalled':
        return this.fail('stalled', detail);
      case 'start_failed':
        return this.fail('start_failed', detail);
      case 'start_timeout':
        return this.fail('start_timeout', detail);
      case 'host_error':
      default:
        return this.fail('internal', detail);
    }
  }

  // -------------------------------------------------------------------------------------------
  // The co-located loop (bridge handlers). Everything here is synchronous with QEMU.

  private solveAndInject(): Command[] {
    const out = this.engine!.solve();
    this.latest = out;
    if (!out.ok) {
      // No defined operating point: the inputs cannot be derived honestly. Fail closed.
      this.pendingFailure = { reason: 'electrical_error', detail: jsonSafe(out.error) };
      return [{ type: 'Q' }];
    }
    const cmds: Command[] = [];
    for (const p of out.pins ?? []) {
      const prev = this.inputLevels.get(p.gpio);
      const next = interpretDigitalInput(p.voltage, prev ?? 0);
      if (prev === next) continue;
      this.inputLevels.set(p.gpio, next);
      cmds.push({ type: 'I', pad: p.gpio, level: next });
    }
    return cmds;
  }

  private onHello(): Command[] {
    return this.solveAndInject();
  }

  private onPad(vns: bigint, pad: number, drive: 0 | 1, level: 0 | 1): Command[] {
    this.simNs = vns;
    const pin = boardPinForGpio(ESP32_DEVKITC_WROOM32, pad);
    if (pin?.simulatorSupport === 'digital-input' && drive) {
      // GPIO34..39 have no output driver: enabling output does nothing on the hardware, so the
      // pad stays an input electrically. Diagnosed (once per pad), never silently driven.
      if (!this.inputOnlyDiagnosed.has(pad)) {
        this.inputOnlyDiagnosed.add(pad);
        this.log.append({
          type: 'diagnostic',
          simNs: vns.toString(),
          severity: 'warning',
          code: 'output_on_input_only_pad',
          detail: { gpio: pad, level },
        });
      }
      drive = 0;
      level = 0;
    }
    if (pin && pin.simulatorSupport !== 'none') {
      const w = this.gpioWindow.get(pad);
      this.gpioWindow.set(pad, { drive, level, transitions: (w?.transitions ?? 0) + 1 });
    }
    if (!this.request.attachments.some((a) => a.gpio === pad)) return [];
    const mode: RuntimePinMode = drive ? (level ? 'output-high' : 'output-low') : 'input';
    this.engine!.setPinMode(pad, mode);
    return this.solveAndInject();
  }

  private onSerial(vns: bigint, bytes: Buffer): void {
    this.simNs = vns;
    const room = this.config.serialWindowMaxBytes - this.serialWindowBytes;
    if (room <= 0) {
      this.serialDropped += bytes.length;
      return;
    }
    const kept = bytes.subarray(0, room);
    this.serialWindow.push(kept);
    this.serialWindowBytes += kept.length;
    this.serialDropped += bytes.length - kept.length;
  }

  private onTick(vns: bigint): Command[] {
    this.simNs = vns;
    this.lastTickNs = vns;
    const cmds: Command[] = [];
    if (this.quitRequested || this.pendingFailure) cmds.push({ type: 'Q' });
    // Apply due commands in client order.
    let applied = false;
    while (this.queue.length && !this.pendingFailure) {
      const head = this.queue[0]!;
      if (head.atNs !== null && head.atNs > vns) break;
      this.queue.shift();
      if (this.apply(head.command, vns)) applied = true;
    }
    if (applied && !this.pendingFailure) cmds.push(...this.solveAndInject());
    if (this.pendingFailure && !cmds.some((c) => c.type === 'Q')) cmds.push({ type: 'Q' });
    if (vns % this.publishNs === 0n) this.flushWindow(vns);
    return cmds;
  }

  /** Apply one command at tick `vns`; emits its acknowledgement. */
  private apply(c: SessionCommand, vns: bigint): boolean {
    const ack = (result: 'applied' | 'rejected', reason?: CommandRejection) =>
      this.log.append({
        type: 'command',
        simNs: vns.toString(),
        commandSeq: c.seq,
        result,
        ...(reason ? { reason } : {}),
      });
    if (c.category === 'mirror') {
      const err = this.engine!.applyControl(c.component, c.control, c.projectRevision);
      if (err) {
        ack('rejected', 'unsupported_control');
        // The runtime no longer represents the persisted project: the session is stale.
        this.pendingFailure = {
          reason: 'mirror_failed',
          detail: { commandSeq: c.seq, error: jsonSafe(err) },
        };
        return false;
      }
      ack('applied');
      return true;
    }
    const err = this.engine!.setMomentary(c.component, c.action === 'press');
    if (err) {
      ack('rejected', 'unknown_component');
      return false;
    }
    ack('applied');
    return true;
  }

  /** Publish the coalesced window: GPIO changes, then the latest operating point, then serial. */
  private flushWindow(vns: bigint): void {
    const t = vns.toString();
    if (this.gpioWindow.size) {
      const changes = [...this.gpioWindow.entries()]
        .sort(([a], [b]) => a - b)
        .map(([gpio, s]) => ({ gpio, ...s }));
      this.gpioWindow.clear();
      this.log.append({ type: 'gpio', simNs: t, changes });
    }
    if (this.latest) {
      const json = JSON.stringify(jsonSafe(this.latest));
      if (json !== this.latestPublished) {
        this.latestPublished = json;
        this.log.append({ type: 'electrical', simNs: t, outcome: JSON.parse(json) });
      }
    }
    if (this.serialWindowBytes || this.serialDropped) {
      const data = Buffer.concat(this.serialWindow).toString('base64');
      this.log.append({
        type: 'serial',
        simNs: t,
        data,
        ...(this.serialDropped ? { dropped: this.serialDropped } : {}),
      });
      this.serialWindow = [];
      this.serialWindowBytes = 0;
      this.serialDropped = 0;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Commands from the client (validated structurally by protocol.ts before reaching here)

  submit(c: SessionCommand): { accepted: boolean; reason?: CommandRejection } {
    const reject = (reason: CommandRejection) => {
      this.log.append({
        type: 'command',
        simNs: this.lastTickNs >= 0n ? this.lastTickNs.toString() : null,
        commandSeq: c.seq,
        result: 'rejected',
        reason,
      });
      return { accepted: false, reason };
    };
    if (c.seq <= this.lastClientSeq) return reject('duplicate');
    this.lastClientSeq = c.seq;
    if (this.sm.state !== 'running' && this.sm.state !== 'ready') return reject('not_running');
    if (!this.request.circuit.components.some((x) => x.id === c.component))
      return reject('unknown_component');
    const atNs = c.atSimNs === undefined ? null : BigInt(c.atSimNs);
    if (atNs !== null && atNs <= this.lastTickNs) return reject('late');
    const tail = [...this.queue].reverse().find((q) => q.atNs !== null);
    if (atNs !== null && tail && tail.atNs! > atNs) return reject('out_of_order');
    if (this.queue.length >= this.config.maxQueuedCommands) return reject('queue_full');
    this.queue.push({ command: c, atNs });
    return { accepted: true };
  }

  status(): SessionStatus {
    return {
      sessionId: this.id,
      state: this.sm.state,
      reason: this.sm.reason,
      ...(this.sm.detail !== undefined ? { detail: this.sm.detail } : {}),
      simNs: this.simNs.toString(),
      lastEventSeq: this.log.lastSeq,
      createdAt: this.createdAt.toISOString(),
      endedAt: this.endedAt?.toISOString() ?? null,
      runtime: { pid: this.pid, outcome: this.outcome },
    };
  }

  /** For tests and housekeeping: the private directory (never exposed to clients). */
  get privateDir(): string {
    return this.dir;
  }
}
