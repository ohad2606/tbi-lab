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
import {
  CATALOG,
  ESP32_DEVKITC_WROOM32,
  boardPinForGpio,
  liveControlProblem,
} from '@tbi-lab/domain';
import {
  EngineSession,
  interpretDigitalInput,
  type DigitalLevel,
  type RuntimePinMode,
  type SolveOutcome,
  type SolveSuccess,
} from '@tbi-lab/engine';
import {
  InputSchedule,
  LEDC_SIGNALS,
  type Capability,
  type Command,
  type I2cPhase,
  type PadFunction,
} from '../harness/protocol.js';
import { runSession, type Outcome, type PwmEvent, type SessionResult } from '../harness/session.js';
import type { Principal } from '../identity/principal.js';
import type { TicketFeatures } from '../identity/ticket.js';
import type { HostConfig } from './config.js';
import { sessionDir } from './config.js';
import { RUNTIME_DEVICE_TYPES, RuntimeDevices } from './devices.js';
import { EventLog } from './eventLog.js';
import { I2cDevices, i2cAddressConflict } from './i2cDevices.js';
import {
  COMMAND_QUANTUM_US,
  jsonSafe,
  type CommandRejection,
  type CreateSessionRequest,
  type EndReason,
  type MirrorRevisions,
  type FailReason,
  type PwmPadState,
  type SessionCommand,
  type SessionState,
} from './protocol.js';
import { SessionStateMachine, isTerminal } from './stateMachine.js';
import { LedcTracker, ns, ratCeilNs, ratToNumber, type Rat, type Waveform } from './pwm.js';
import { combinePwm, type PwmProblem } from './pwmElectrical.js';
import { ServoBank, type PwmPoint } from './servos.js';

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
  /**
   * Alpha (Phase D): the session's maximum wall time once running (ms), as enforced: the host
   * configuration, the plan and the client's own stricter limit, whichever is least. Null when
   * unbounded. Clients use it to warn before the session ends; it is never extended.
   */
  lifetimeMs: number | null;
  runtime: { pid: number | null; outcome: Outcome | null };
  revisions: MirrorRevisions;
  /**
   * Sprint 12 (D-10): simulation time per wall time since the handshake, the wall time tick
   * replies were withheld to keep real time, and the wall-clock gaps between ticks (C-5).
   */
  pace: {
    rate: number | null;
    simPerWall: number | null;
    pacedMs: number;
    tickGapMs: { count: number; p99: number | null; max: number };
  };
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
  /** Index of the last published window (its end is (index) x publishNs). */
  private publishedWindow = 0n;
  /** Effective lifetime: the host limit, a stricter client limit, and the plan (Phase 4). */
  readonly lifetimeMs: number;
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
  private gpioWindow = new Map<
    number,
    { drive: 0 | 1; level: 0 | 1; transitions: number; pwm?: PwmPadState }
  >();
  private serialWindow: Buffer[] = [];
  private serialWindowBytes = 0;
  private serialDropped = 0;
  private latest: SolveOutcome | null = null;
  private readonly inputOnlyDiagnosed = new Set<number>();
  /** Mirror revisions (see MirrorRevisions); both start at the snapshot's revision. */
  private acceptedRevision: number;
  private appliedRevision: number;
  private latestPublished: string | null = null;
  /** Sprint 12: the runtime's bridge capabilities (from `H`) and the scheduled-input mirror. */
  private caps: readonly Capability[] = [];
  private readonly schedule = new InputSchedule();
  /** Pacing and tick-gap statistics (D-10, C-5): 1 ms buckets up to 2 s, then the maximum. */
  private readonly gapBuckets = new Uint32Array(2001);
  private gapCount = 0;
  private gapMax = 0;
  private handshakeWall: number | null = null;
  private pacedMs = 0;
  private devices: RuntimeDevices | null = null;
  /** Circuit pads routed to a non-I2C peripheral (refused if still so at the next tick). */
  private readonly periphPads = new Map<number, { func: PadFunction; vns: bigint }>();
  private i2c: I2cDevices | null = null;
  /**
   * R4 (patch 0009): LEDC timers and channels as QEMU reports them, the circuit pads routed to an
   * LEDC signal, what each such pad was last solved as, and a PWM condition the session cannot
   * simulate honestly (refused only if still present a whole command tick later).
   */
  private readonly ledc = new LedcTracker();
  private readonly ledcPads = new Map<number, { signal: number; openDrain: boolean }>();
  private readonly pwmSolved = new Map<number, string>();
  private pwmProblems = new Map<string, { detail: Record<string, unknown>; since: bigint }>();
  /** When each LEDC pad's current waveform took effect (exact; for servo pulse expansion). */
  private readonly pwmSince = new Map<number, Rat>();
  /** Sprint 15 (R4): SG90 servos, and the operating points of the last solve they read. */
  private servos: ServoBank | null = null;
  private lastLow: SolveOutcome | null = null;
  private lastPwmPoints: PwmPoint[] = [];
  /** The backlight token each I2C display's engine model has. */
  private readonly backlights = new Map<string, string>();

  constructor(
    private readonly config: HostConfig,
    private readonly tmpRoot: string,
    private readonly request: CreateSessionRequest,
    /** The principal that created the session: the only one who may use it (Sprint 8). */
    readonly owner: Principal,
    /** The firmware's features, from the verified run ticket (null: not analysed). */
    private readonly features: TicketFeatures | null,
  ) {
    this.token = randomBytes(24).toString('base64url');
    this.tokenHash = SHA(Buffer.from(this.token));
    this.log = new EventLog(config.eventLogCapacity);
    this.acceptedRevision = this.appliedRevision = request.circuit.projectRevision;
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
    const f = this.features;
    const unsupported = {
      ...(f?.internalPull.length ? { internalPull: f.internalPull } : {}),
      ...(f?.gpioInterrupt.length ? { gpioInterrupt: f.gpioInterrupt } : {}),
      ...(f?.restart ? { restart: true } : {}),
      ...(f?.unsupported.length ? { unsupported: f.unsupported } : {}),
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
    if (this.config.sessionRoot) {
      // Sandboxed runtime (Sprint 8): QEMU runs as the runtime unit's own user, which shares only
      // this directory's group; the unit's mount view holds this directory and nothing else.
      chmodSync(this.dir, 0o770);
      chmodSync(this.flash, 0o660);
    }
    if (fileSha(this.flash) !== sha) return this.fail('artifact_hash_mismatch', { sha256: sha });
    if (this.storageBytes() > this.config.maxSessionStorageBytes) return this.fail('storage_limit');

    // Parts the ESP32 runtime does not simulate (catalog `mcuRuntime: false`, Sprint 10: the
    // product's own rule, which the app applies before Run) are refused here too, exactly as the
    // runtime refused them before it carried their models: `unsupported_component`, first in
    // circuit order. In particular a capacitor is never solved at DC under a running board (its
    // time-dependent behaviour is not part of the runtime).
    const notModelled = this.request.circuit.components.find(
      (c) => CATALOG[c.type]?.mcuRuntime === false,
    );
    if (notModelled)
      return this.fail('electrical_error', {
        code: 'unsupported_component',
        components: [notModelled.id],
      });

    // The production engine, with the board pads attached.
    this.engine = new EngineSession(this.request.circuit, { pins: this.request.attachments });
    // Sprint 11 (ADR-010) backstop, independent of the catalog: this host never advances
    // simulated time, so a time-dependent part (a capacitor) would be solved as if at DC — false
    // physics. Refused from the engine's own property, whatever the catalog says.
    const timed = this.engine.timeDependentParts;
    if (timed.length)
      return this.fail('electrical_error', {
        code: 'unsupported_component',
        components: timed,
        detail: { reason: 'time_dependent' },
      });
    // Two I2C parts at one address on one bus would both answer: refused before anything runs.
    const conflict = i2cAddressConflict(this.request.circuit);
    if (conflict)
      return this.fail('electrical_error', {
        code: 'i2c_address_conflict',
        components: conflict,
      });
    this.i2c = new I2cDevices(this.request.circuit, this.request.attachments);
    this.devices = new RuntimeDevices(
      this.request.circuit,
      this.engine,
      this.request.attachments.map((a) => a.gpio),
      this.inputLevels,
      this.schedule,
    );
    const servos = new ServoBank(this.request.circuit);
    this.servos = servos.empty ? null : servos;
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
          schedule: this.schedule,
          ...(this.config.paceRate !== null ? { pace: { rate: this.config.paceRate } } : {}),
          onTickGap: (gap) => {
            this.gapBuckets[Math.min(2000, Math.max(0, Math.floor(gap)))]!++;
            this.gapCount++;
            this.gapMax = Math.max(this.gapMax, gap);
          },
          ...(this.config.launch ? { launch: this.config.launch } : {}),
        },
        {
          hello: (_tick, caps) => this.onHello(caps),
          pad: (e) => this.onPad(e.vns, e.pad, e.drive, e.level),
          func: (e) => this.onFunc(e.vns, e.pad, e.func, e.openDrain),
          pwm: (e) => this.onPwm(e),
          i2c: (e) => this.onI2c(e.vns, e.bus, e.phase),
          tick: (vns) => this.onTick(vns),
          serial: (vns, bytes) => this.onSerial(vns, bytes),
        },
      );
    } catch (e) {
      // Sprint 13 security audit (#6): the client gets the reason code only; the message (it can
      // carry server paths) goes to the service's own log (journald), never to the event stream.
      console.error(`session ${this.id}: internal: ${e instanceof Error ? e.message : String(e)}`);
      this.fail('internal');
      return;
    }
    this.outcome = result.outcome;
    this.pacedMs = result.pacedMs;
    try {
      this.flushWindow(this.simNs); // whatever the runtime produced before it ended
    } catch (e) {
      console.error(`session ${this.id}: internal: ${e instanceof Error ? e.message : String(e)}`);
      this.fail('internal');
      return;
    }
    this.finish(result);
  }

  private finish(r: SessionResult): void {
    if (this.pendingFailure)
      return this.fail(this.pendingFailure.reason, this.pendingFailure.detail);
    // The runtime's error text (spawn errors, handler exceptions: it can name server paths) goes to
    // the service log, never to the client (Sprint 13 security audit #6).
    if (r.error) console.error(`session ${this.id}: ${r.outcome}: ${r.error}`);
    const detail = { outcome: r.outcome, exitCode: r.exitCode, signal: r.signal };
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

  private solveAndInject(vns: bigint): Command[] {
    this.devices?.advance(vns);
    this.servos?.sync(vns);
    let out = this.solvePoints(vns);
    // Sprint 12 (R3): a module's power decides its backlight load; follow it, then re-solve.
    if (out.ok && this.i2c && !this.i2c.empty) {
      const lit = this.i2c.power(out);
      for (const ch of lit) {
        this.engine!.setPartRuntime(ch.id, 'backlight', ch.backlight);
        this.backlights.set(ch.id, ch.backlight);
      }
      if (lit.length) out = this.solvePoints(vns);
    }
    this.latest = out;
    if (!out.ok) {
      // No defined operating point: the inputs cannot be derived honestly. Fail closed.
      this.pendingFailure = { reason: 'electrical_error', detail: jsonSafe(out.error) };
      return [{ type: 'Q' }];
    }
    // Sprint 15 (R4): what the servos' signal wires carry now, from the operating points.
    if (this.servos && this.lastLow?.ok) {
      this.servos.observe(vns, this.lastLow, this.lastPwmPoints);
      for (const d of this.servos.diagnostics.splice(0))
        this.log.append({
          type: 'diagnostic',
          simNs: d.simNs.toString(),
          severity: 'warning',
          code: d.code,
          detail: d.detail,
        });
    }
    const cmds: Command[] = [];
    for (const p of out.pins ?? []) {
      const prev = this.inputLevels.get(p.gpio);
      const next = interpretDigitalInput(p.voltage, prev ?? 0);
      if (prev === next) continue;
      this.inputLevels.set(p.gpio, next);
      cmds.push({ type: 'I', pad: p.gpio, level: next });
    }
    // Sprint 12 (R2): what the sensors saw; their responses are scheduled edges.
    if (this.devices && !this.devices.empty) cmds.push(...this.devices.observe(vns, out));
    this.flushDeviceDiagnostics();
    return cmds;
  }

  // -------------------------------------------------------------------------------------------
  // R4: PWM (LEDC) outputs

  /** The waveform on each attached pad routed to an LEDC signal, in pad order. */
  private pwmPads(): { gpio: number; w: Waveform; openDrain: boolean }[] {
    const attached = new Set(this.request.attachments.map((a) => a.gpio));
    return [...this.ledcPads.entries()]
      .filter(([gpio]) => attached.has(gpio))
      .sort(([a], [b]) => a - b)
      .map(([gpio, { signal, openDrain }]) => ({ gpio, w: this.ledc.waveform(signal), openDrain }));
  }

  /**
   * One operating point for the circuit as it is now. Without switching PWM pads that is a plain
   * solve. With them (architecture A1): every PWM pad low, each one high on its own, and all high,
   * combined into the time-average (pwmElectrical.ts). A pad whose waveform cannot be simulated
   * honestly records a problem; the tick refuses it if it lasts.
   */
  private solvePoints(vns: bigint) {
    const engine = this.engine!;
    const pads = this.pwmPads();
    const problems: { key: string; detail: Record<string, unknown> }[] = [];
    const waves: { gpio: number; w: Extract<Waveform, { kind: 'wave' }> }[] = [];
    const zeros: number[] = [];
    for (const { gpio, w, openDrain } of pads) {
      if (w.kind === 'static' && !openDrain) {
        engine.setPinMode(gpio, w.level ? 'output-high' : 'output-low');
        continue;
      }
      engine.setPinMode(gpio, 'output-low');
      if (openDrain || w.kind === 'unsupported') {
        const why = openDrain ? 'open-drain' : (w as { why: string }).why;
        problems.push({
          key: `u:${gpio}:${why}`,
          detail: { code: 'pwm_unsupported_mode', gpio, why },
        });
      } else if (w.kind === 'zero') zeros.push(gpio);
      else if (w.kind === 'wave') waves.push({ gpio, w });
    }
    const low = engine.solve();
    this.lastLow = low;
    this.lastPwmPoints = [];
    if (!low.ok) return this.pwmDone(vns, problems, low);
    // Duty 0 (O-R4-1): acceptable only where the pad's level changes nothing at all.
    for (const gpio of zeros) {
      engine.setPinMode(gpio, 'output-high');
      const high = engine.solve();
      engine.setPinMode(gpio, 'output-low');
      if (!high.ok) return this.pwmDone(vns, problems, high);
      const c = combinePwm(
        [{ gpio, duty: 0.5, periodNs: 0, highNs: 0 }],
        low,
        [high],
        null,
        this.types,
        this.inputLevels,
      );
      const loads = Object.keys(low.components).filter(
        (id) => !ZERO_NEUTRAL.has(this.types[id] ?? '') && c.outcome.components[id]?.pwm,
      );
      const inputs = c.problems.find((p) => p.code === 'pwm_input_unsupported');
      if (loads.length || inputs)
        problems.push({
          key: `z:${gpio}`,
          detail: {
            code: 'pwm_duty_zero_unverified',
            gpio,
            components: loads,
            ...(inputs && inputs.code === 'pwm_input_unsupported' ? { inputs: inputs.inputs } : {}),
          },
        });
    }
    if (!waves.length) return this.pwmDone(vns, problems, low);
    const single: SolveSuccess[] = [];
    for (const { gpio } of waves) {
      engine.setPinMode(gpio, 'output-high');
      const o = engine.solve();
      engine.setPinMode(gpio, 'output-low');
      if (!o.ok) return this.pwmDone(vns, problems, o);
      single.push(o);
    }
    this.lastPwmPoints = waves.map(({ gpio, w }, i) => ({
      gpio,
      w,
      since: this.pwmSince.get(gpio) ?? ns(vns),
      high: single[i]!,
    }));
    // Three or more pads: each pair high together, for the pairwise superposition check.
    const pairs: { i: number; j: number; o: SolveSuccess }[] = [];
    if (waves.length > 2)
      for (let i = 0; i < waves.length; i++)
        for (let j = i + 1; j < waves.length; j++) {
          engine.setPinMode(waves[i]!.gpio, 'output-high');
          engine.setPinMode(waves[j]!.gpio, 'output-high');
          const o = engine.solve();
          engine.setPinMode(waves[i]!.gpio, 'output-low');
          engine.setPinMode(waves[j]!.gpio, 'output-low');
          if (!o.ok) return this.pwmDone(vns, problems, o);
          pairs.push({ i, j, o });
        }
    let all = null;
    if (waves.length > 1) {
      for (const { gpio } of waves) engine.setPinMode(gpio, 'output-high');
      const o = engine.solve();
      for (const { gpio } of waves) engine.setPinMode(gpio, 'output-low');
      if (!o.ok) return this.pwmDone(vns, problems, o);
      all = o;
    }
    const c = combinePwm(
      waves.map(({ gpio, w }) => ({
        gpio,
        duty: w.duty,
        periodNs: ratToNumber(w.periodNs),
        highNs: ratToNumber(w.highNs),
      })),
      low,
      single,
      all,
      this.types,
      this.inputLevels,
      pairs,
    );
    for (const p of c.problems) problems.push({ key: pwmProblemKey(p), detail: { ...p } });
    return this.pwmDone(vns, problems, c.outcome);
  }

  /** Record the PWM problems of this solve (keeping when an unchanged one started). */
  private pwmDone<T>(
    vns: bigint,
    problems: { key: string; detail: Record<string, unknown> }[],
    out: T,
  ): T {
    // Each problem keeps the time it first appeared while it persists (independently of others).
    const next = new Map<string, { detail: Record<string, unknown>; since: bigint }>();
    for (const p of problems)
      if (!next.has(p.key))
        next.set(p.key, { detail: p.detail, since: this.pwmProblems.get(p.key)?.since ?? vns });
    this.pwmProblems = next;
    return out;
  }

  private get types(): Record<string, string> {
    return Object.fromEntries(this.request.circuit.components.map((c) => [c.id, c.type]));
  }

  /**
   * Apply the LEDC changes due by `vns` (they take effect at counter overflows, between frames),
   * publishing windows up to each instant first, and solve where an LEDC pad's waveform changed.
   */
  private advancePwm(vns: bigint): Command[] {
    const cmds: Command[] = [];
    this.ledc.advance(
      vns,
      (at) => {
        this.closeWindowsBefore(ratCeilNs(at));
        this.servos?.sync(at); // the old waveform's pulses, up to the change exactly
      },
      (at) => {
        if (this.pwmChanged(at)) cmds.push(...this.solveAndInject(ratCeilNs(at)));
      },
    );
    return cmds;
  }

  /** Whether any LEDC pad's waveform differs from what was last solved; records the new ones. */
  private pwmChanged(at: Rat): boolean {
    let changed = false;
    const seen = new Set<number>();
    for (const { gpio, w, openDrain } of this.pwmPads()) {
      seen.add(gpio);
      const key = JSON.stringify([w, openDrain], (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      if (this.pwmSolved.get(gpio) === key) continue;
      this.pwmSolved.set(gpio, key);
      this.pwmSince.set(gpio, at);
      changed = true;
      const prev = this.gpioWindow.get(gpio);
      const pwm = pwmPadState(w);
      this.gpioWindow.set(gpio, {
        drive: openDrain ? 0 : 1,
        level: pwm.kind === 'static' ? pwm.level : 0,
        transitions: (prev?.transitions ?? 0) + 1,
        pwm,
      });
    }
    for (const gpio of [...this.pwmSolved.keys()])
      if (!seen.has(gpio)) {
        this.pwmSolved.delete(gpio);
        this.pwmSince.delete(gpio);
        changed = true;
      }
    return changed;
  }

  /** R4: an LEDC timer (P) or channel (W) state change. */
  private onPwm(e: PwmEvent): Command[] {
    const cmds = this.advancePwm(e.vns);
    this.closeWindowsBefore(e.vns);
    this.simNs = e.vns;
    if ('timer' in e) this.ledc.timer(e.vns, e.timer, e.state);
    else this.ledc.channel(e.vns, e.signal, e.state);
    // Idle levels, held timers and refusals act at once; duty changes wait for the next cycle.
    if (this.pwmChanged(ns(e.vns))) cmds.push(...this.solveAndInject(e.vns));
    return cmds;
  }

  private flushDeviceDiagnostics(): void {
    for (const { simNs, d } of this.devices?.diagnostics.splice(0) ?? [])
      this.log.append({
        type: 'diagnostic',
        simNs: simNs.toString(),
        severity: d.severity,
        code: d.code,
        detail: d.detail,
      });
  }

  private onHello(caps: readonly Capability[]): Command[] {
    this.caps = caps;
    this.handshakeWall = performance.now();
    // ADR-011 §1: capabilities are bound to the session. Firmware that needs a facility this
    // runtime does not announce never executes an instruction: quit inside the handshake reply.
    const missing = (this.features?.requires ?? []).filter((r) => !caps.includes(r as Capability));
    if (missing.length) {
      const detail = { requires: missing, runtimeCapabilities: [...caps] };
      this.log.append({
        type: 'diagnostic',
        simNs: '0',
        severity: 'error',
        code: 'unsupported_feature',
        detail,
      });
      this.pendingFailure = { reason: 'unsupported_feature', detail };
      return [{ type: 'Q' }];
    }
    // Parts that need a runtime capability (Sprint 12): refused, naming them, on a runtime
    // without it (a v1 runtime, or a rolled-back one), before the first guest instruction.
    const needs = this.request.circuit.components.filter((c) =>
      (RUNTIME_DEVICE_TYPES[c.type] ?? []).some((cap) => !caps.includes(cap)),
    );
    if (needs.length) {
      this.pendingFailure = {
        reason: 'electrical_error',
        detail: {
          code: 'unsupported_component',
          components: needs.map((c) => c.id),
          detail: { reason: 'runtime_capability', runtimeCapabilities: [...caps] },
        },
      };
      return [{ type: 'Q' }];
    }
    return this.solveAndInject(0n);
  }

  private onPad(vns: bigint, pad: number, drive: 0 | 1, level: 0 | 1): Command[] {
    const pwm = this.advancePwm(vns);
    if (pwm.length) return [...pwm, ...this.onPad(vns, pad, drive, level)];
    this.closeWindowsBefore(vns);
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
    // Sprint 12: the firmware drives a pad that has sensor edges pending (ADR-011 §2).
    this.devices?.advance(vns);
    const cancel = drive ? (this.devices?.contention(vns, pad) ?? []) : [];
    const mode: RuntimePinMode = drive ? (level ? 'output-high' : 'output-low') : 'input';
    this.engine!.setPinMode(pad, mode);
    return [...cancel, ...this.solveAndInject(vns)];
  }

  /**
   * Sprint 12 (ADR-011 §3, patch 0007): a pad's routed function changed. A pad routed to an I2C
   * signal belongs to the I2C controller: it is open drain, so outside a transaction it is
   * released and the circuit's pull-ups decide its level (bus phases arrive as `B` frames). Any
   * other peripheral on a pad that joins the circuit is a facility V1 does not simulate: refused,
   * never left running with dead behaviour. Pads outside the circuit (flash, UART) are ignored.
   */
  private onFunc(vns: bigint, pad: number, func: PadFunction, openDrain = false): Command[] {
    const pwm = this.advancePwm(vns);
    this.closeWindowsBefore(vns);
    this.simNs = vns;
    this.i2c?.onFunc(pad, func);
    if (!this.request.attachments.some((a) => a.gpio === pad)) return pwm;
    // R4: a pad routed to an LEDC output is driven by its waveform (capability pwm).
    const sig = func.startsWith('periph:') ? Number(func.slice(7)) : -1;
    if (this.caps.includes('pwm') && sig >= LEDC_SIGNALS.first && sig <= LEDC_SIGNALS.last) {
      this.periphPads.delete(pad);
      this.ledcPads.set(pad, { signal: sig, openDrain });
      this.devices?.advance(vns);
      return this.pwmChanged(ns(vns)) ? [...pwm, ...this.solveAndInject(vns)] : pwm;
    }
    if (this.ledcPads.delete(pad)) {
      this.pwmChanged(ns(vns));
      if (func === 'gpio') return pwm; // its state follows as a G frame
    }
    if (pwm.length) return [...pwm, ...this.onFunc(vns, pad, func, openDrain)];
    // A routing that lasts: ESP-IDF configures pins with two register writes, and between them a
    // pad can be routed to signal 0 for a few instructions (pinMode(INPUT): OUT_SEL 0, then
    // OEN_SEL 1). Only a routing still in place at the next command tick refuses the session.
    if (func.startsWith('periph:')) {
      this.periphPads.set(pad, { func, vns });
      return [];
    }
    this.periphPads.delete(pad);
    if (func === 'gpio') return []; // its state follows as a G frame
    this.devices?.advance(vns);
    this.engine!.setPinMode(pad, 'input');
    return this.solveAndInject(vns);
  }

  /**
   * Sprint 12 (ADR-011 §4, patch 0008): one I2C bus phase, answered by the circuit's I2C parts
   * (electrically gated in I2cDevices). A write that switches a backlight changes the module's
   * load: the circuit is solved again and any input it changes is injected in the same reply.
   */
  private onI2c(vns: bigint, bus: 0 | 1, phase: I2cPhase): Command[] {
    const pwm = this.advancePwm(vns);
    if (pwm.length) return [...pwm, ...this.onI2c(vns, bus, phase)];
    this.closeWindowsBefore(vns);
    this.simNs = vns;
    this.devices?.advance(vns);
    const latest = this.latest?.ok ? this.latest : null;
    const r = this.i2c ? this.i2c.phase(vns, bus, phase, latest) : null;
    const reply: Command[] =
      phase.op === 'R'
        ? [{ type: 'D', byte: typeof r === 'number' ? r : 0xff }]
        : phase.op === 'P'
          ? []
          : [{ type: 'K', ack: r === true }];
    const cmds: Command[] = [];
    for (const { simNs, d } of this.i2c?.diagnostics.splice(0) ?? [])
      this.log.append({ type: 'diagnostic', simNs: simNs.toString(), ...d });
    if (phase.op === 'W' && this.i2c) {
      let relit = false;
      for (const id of this.i2c.changed) {
        const token = this.i2c.backlight(id);
        if (this.backlights.get(id) === token) continue;
        this.backlights.set(id, token);
        this.engine!.setPartRuntime(id, 'backlight', token);
        relit = true;
      }
      if (relit) cmds.push(...this.solveAndInject(vns));
    }
    return [...cmds, ...reply];
  }

  private onSerial(vns: bigint, bytes: Buffer): void {
    this.closeWindowsBefore(vns);
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
    const cmds: Command[] = this.advancePwm(vns);
    this.closeWindowsBefore(vns);
    this.simNs = vns;
    const previousTick = this.lastTickNs;
    this.lastTickNs = vns;
    // R4: a PWM condition that has lasted a whole command tick is refused, naming it.
    const lastingPwm = [...this.pwmProblems.values()].find((p) => p.since <= previousTick);
    if (lastingPwm && !this.pendingFailure) {
      const detail: Record<string, unknown> = {
        ...lastingPwm.detail,
        since: lastingPwm.since.toString(),
      };
      this.log.append({
        type: 'diagnostic',
        simNs: vns.toString(),
        severity: 'error',
        code: String(detail.code),
        detail,
      });
      this.pendingFailure = { reason: 'pwm_unsupported', detail };
    }
    const [lasting] = this.periphPads;
    if (lasting && !this.pendingFailure) {
      const [gpio, { func, vns: since }] = lasting;
      const detail = { gpio, function: func, since: since.toString() };
      this.log.append({
        type: 'diagnostic',
        simNs: vns.toString(),
        severity: 'error',
        code: 'unsupported_feature',
        detail,
      });
      this.pendingFailure = { reason: 'unsupported_feature', detail };
    }
    if (this.quitRequested || this.pendingFailure) cmds.push({ type: 'Q' });
    // Apply due commands in client order.
    let applied = false;
    while (this.queue.length && !this.pendingFailure) {
      const head = this.queue[0]!;
      if (head.atNs !== null && head.atNs > vns) break;
      this.queue.shift();
      if (this.apply(head.command, vns)) applied = true;
    }
    // Sensor output changes since the last frame are solved too, so the published operating point
    // shows them (Sprint 12).
    const sensed = this.devices?.dueBy(vns) ?? false;
    if ((applied || sensed) && !this.pendingFailure) cmds.push(...this.solveAndInject(vns));
    if (this.pendingFailure && !cmds.some((c) => c.type === 'Q')) cmds.push({ type: 'Q' });
    // A tick exactly on a window boundary closes that window after its own commands (V1 timing).
    if (vns === (this.publishedWindow + 1n) * this.publishNs) this.closeWindowsBefore(vns + 1n);
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
        ...(c.category === 'mirror' ? { projectRevision: c.projectRevision } : {}),
      });
    if (c.category === 'mirror') {
      // Accepted mirrors are strictly increasing (submit); applying in client order keeps them
      // so. Checked again here so that no path can ever apply an older revision.
      if (c.projectRevision <= this.appliedRevision) {
        ack('rejected', 'stale_revision');
        return false;
      }
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
      this.appliedRevision = c.projectRevision;
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

  /**
   * Publish every window that ends strictly before `vns`, stamped with its boundary, before a frame
   * at `vns` is handled. Windows are attributed by event time, not by when a tick ran: QEMU arms
   * ticks on the quantum grid but reports the virtual clock at which the tick ran, which can be an
   * instruction past the deadline (observed +4 ns). The V1 host flushed only on ticks at exact
   * multiples, so after such a tick it silently stopped publishing, or skipped that window (Gate B
   * G-2). With exact ticks the output is unchanged.
   */
  private closeWindowsBefore(vns: bigint): void {
    for (let end = (this.publishedWindow + 1n) * this.publishNs; end < vns; end += this.publishNs) {
      this.publishedWindow++;
      this.flushWindow(end);
    }
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
      // Sprint 12 (R3): an I2C display's content is part of its result.
      let latest: unknown = this.latest;
      if (this.latest.ok && this.i2c && !this.i2c.empty) {
        const display = this.i2c.displayState();
        const components = { ...this.latest.components };
        for (const [id, st] of Object.entries(display))
          if (components[id])
            components[id] = { ...components[id]!, state: { ...components[id]!.state, ...st } };
        latest = { ...this.latest, components };
        this.i2c.changed.clear();
      }
      // Sprint 15 (R4): servo motion at the window's end (it moves between solves).
      if (this.latest.ok && this.servos) {
        this.servos.sync(vns);
        const base = latest as SolveSuccess;
        const components = { ...base.components };
        for (const id of this.servos.ids) {
          const st = this.servos.state(id);
          if (st && components[id])
            components[id] = {
              ...components[id]!,
              state: {
                ...components[id]!.state,
                powered: st.powered,
                angleDeg: st.angleDeg,
                commandedDeg: st.commandedDeg,
                signal: st.signal,
                ...(st.pulseUs !== null ? { pulseUs: st.pulseUs } : {}),
              },
            };
        }
        latest = { ...base, components };
      }
      const json = JSON.stringify(jsonSafe(latest));
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

  /** Sprint 11: wall-clock times of this session's recent commands (rate limit). */
  private commandTimes: number[] = [];

  submit(c: SessionCommand): {
    accepted: boolean;
    reason?: CommandRejection;
    revisions?: MirrorRevisions;
  } {
    const mirror = c.category === 'mirror';
    const revisions = () => (mirror ? { revisions: this.revisions() } : {});
    const reject = (reason: CommandRejection) => {
      this.log.append({
        type: 'command',
        simNs: this.lastTickNs >= 0n ? this.lastTickNs.toString() : null,
        commandSeq: c.seq,
        result: 'rejected',
        reason,
        ...(mirror ? { projectRevision: c.projectRevision } : {}),
      });
      return { accepted: false, reason, ...revisions() };
    };
    if (c.seq <= this.lastClientSeq) return reject('duplicate');
    this.lastClientSeq = c.seq;
    if (this.sm.state !== 'running' && this.sm.state !== 'ready') return reject('not_running');
    // Sprint 11 (ADR-010): commands per wall-clock second, per session.
    const now = performance.now();
    this.commandTimes = this.commandTimes.filter((t) => now - t < 1000);
    if (this.commandTimes.length >= this.config.maxCommandsPerSecond) return reject('rate_limited');
    this.commandTimes.push(now);
    const target = this.request.circuit.components.find((x) => x.id === c.component);
    if (!target) return reject('unknown_component');
    // Sprint 11 (ADR-010): the control must exist for this component's type (part identity,
    // allowed names), and live part parameters must be of their kind and in range. The same
    // domain rule the engine applies; refused here, explicitly, before anything is queued.
    if (mirror && CATALOG[target.type as keyof typeof CATALOG]) {
      const problem = liveControlProblem(target.type as keyof typeof CATALOG, c.control);
      if (problem) return reject(problem.reason);
    } else if (mirror) return reject('unsupported_control');
    if (mirror && c.projectRevision < this.acceptedRevision) return reject('stale_revision');
    if (mirror && c.projectRevision === this.acceptedRevision) return reject('duplicate_revision');
    const atNs = c.atSimNs === undefined ? null : BigInt(c.atSimNs);
    if (atNs !== null && atNs <= this.lastTickNs) return reject('late');
    const tail = [...this.queue].reverse().find((q) => q.atNs !== null);
    if (atNs !== null && tail && tail.atNs! > atNs) return reject('out_of_order');
    if (this.queue.length >= this.config.maxQueuedCommands) return reject('queue_full');
    this.queue.push({ command: c, atNs });
    if (mirror) this.acceptedRevision = c.projectRevision;
    return { accepted: true, ...revisions() };
  }

  revisions(): MirrorRevisions {
    return {
      snapshot: this.request.circuit.projectRevision,
      accepted: this.acceptedRevision,
      applied: this.appliedRevision,
    };
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
      lifetimeMs: Number.isFinite(this.lifetimeMs) ? this.lifetimeMs : null,
      runtime: { pid: this.pid, outcome: this.outcome },
      revisions: this.revisions(),
      pace: this.pace(),
    };
  }

  private pace(): SessionStatus['pace'] {
    let p99: number | null = null;
    if (this.gapCount) {
      const want = Math.ceil(this.gapCount * 0.99);
      let seen = 0;
      for (let ms = 0; ms < this.gapBuckets.length; ms++) {
        seen += this.gapBuckets[ms]!;
        if (seen >= want) {
          p99 = ms + 1;
          break;
        }
      }
    }
    const wall =
      this.handshakeWall === null
        ? null
        : ((this.endedAt?.getTime() ?? Date.now()) -
            Date.now() +
            performance.now() -
            this.handshakeWall) /
          1000;
    return {
      rate: this.config.paceRate,
      simPerWall: wall && wall > 0 ? Number(this.simNs) / 1e9 / wall : null,
      pacedMs: Math.round(this.pacedMs),
      tickGapMs: { count: this.gapCount, p99, max: Math.round(this.gapMax * 10) / 10 },
    };
  }

  /** For tests and housekeeping: the private directory (never exposed to clients). */
  get privateDir(): string {
    return this.dir;
  }
}

/** Parts that a duty-0 pad (O-R4-1) may touch without the undocumented level mattering: the board
 * itself (its pad terminal), ground, and the servo's signal input (no valid pulse either way). */
const ZERO_NEUTRAL: ReadonlySet<string> = new Set([
  'board.esp32_devkitc_wroom32',
  'component.ground',
  'component.servo_sg90',
]);

function pwmProblemKey(p: PwmProblem): string {
  return `${p.code}:${p.gpios.join(',')}:${'components' in p ? p.components.join(',') : p.inputs.join(',')}`;
}

/** A waveform as published (gpio events): plain numbers, ns. */
function pwmPadState(w: Waveform): PwmPadState {
  switch (w.kind) {
    case 'static':
      return { kind: 'static', level: w.level };
    case 'zero':
      return { kind: 'zero', periodNs: ratToNumber(w.periodNs) };
    case 'unsupported':
      return { kind: 'unsupported', why: w.why };
    default:
      return {
        kind: 'wave',
        periodNs: ratToNumber(w.periodNs),
        highNs: ratToNumber(w.highNs),
        duty: w.duty,
        dutyTicks: w.dutyTicks,
        res: w.res,
      };
  }
}
