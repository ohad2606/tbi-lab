/**
 * Runtime R2 Session Host protocol, version `tbi-lab.session/1` (FROZEN for R2).
 *
 * The browser owns the project. A session is ephemeral execution state: the host never becomes
 * the source of truth for any project value, and losing a session never loses project work.
 *
 * Transport (http.ts): JSON over HTTP for lifecycle and commands, Server-Sent Events for the
 * ordered event stream. The WAN only carries these high-level messages; it never participates in
 * the MCU <-> electrical feedback loop, which runs entirely inside the host (bridge + engine).
 *
 * Message categories are MECHANICALLY distinct:
 *   - lifecycle   separate endpoints (create, run, stop, terminate, status); never a "command";
 *   - `mirror`    a PERSISTENT project value the browser has ALREADY persisted at
 *                 `projectRevision` (PSU setpoint / current limit / output, toggle position);
 *                 the runtime only mirrors it. A mirror the runtime cannot apply fails the
 *                 session (it would no longer represent the project), never the project;
 *   - `transient` runtime-only input (push-button press/release); never enters a project.
 * The category is an explicit field; it is never inferred from a name or payload shape.
 *
 * Every function here is pure (no I/O): routine CI covers it without QEMU.
 */
import type { SimulationSnapshot } from '@tbi-lab/domain';

/**
 * `/2` (Sprint 8, D-S8-4): session creation requires a run ticket from the build service; the
 * firmware's features come from that ticket, never from the client.
 */
export const PROTOCOL = 'tbi-lab.session/2';

/** The only host command quantum V1 supports (ADR-007): 1 ms of SIMULATION time. */
export const COMMAND_QUANTUM_US = 1000;

// ---------------------------------------------------------------------------------------------
// Session states

export type SessionState = 'creating' | 'ready' | 'running' | 'stopping' | 'ended' | 'failed';

/** Why a session reached a terminal state. `ended` reasons are orderly; `failed` are not. */
export type EndReason =
  | 'stopped' // stop requested; the runtime quit cleanly
  | 'terminated' // terminate requested (any time)
  | 'lease_expired' // no client for longer than the lease
  | 'lifetime_exceeded' // maximum session lifetime reached
  | 'host_shutdown'; // the host process is shutting down

export type FailReason =
  | 'artifact_unknown'
  | 'artifact_hash_mismatch'
  | 'artifact_missing'
  | 'unsupported_feature' // the firmware declares a feature V1 does not simulate
  | 'invalid_attachment' // an MCU pad attachment the board or circuit does not allow
  | 'electrical_error' // the circuit has no valid operating point (engine error code attached)
  | 'mirror_failed' // a persistent mirror could not be applied: the session is stale
  | 'start_failed'
  | 'start_timeout'
  | 'stalled' // no simulation progress
  | 'runtime_crashed' // QEMU died from a signal
  | 'runtime_protocol_error' // QEMU rejected the host (malformed reply)
  | 'host_protocol_error' // the host rejected QEMU (malformed frame, time going backwards)
  | 'bridge_lost' // QEMU lost the bridge connection
  | 'guest_reset' // the firmware requested a reset: unsupported in V1, never repeated
  | 'storage_limit'
  /**
   * R4: a PWM (LEDC) output the session cannot simulate honestly, still in place a whole command
   * tick later: an unrepresentable LEDC configuration, duty 0 driving a load (O-R4-1), or a load
   * that does not settle instantly (architecture A1). `detail.code` names which.
   */
  | 'pwm_unsupported'
  | 'internal';

// ---------------------------------------------------------------------------------------------
// Requests

export interface McuAttachmentRequest {
  gpio: number;
  component: string;
  terminal: string;
}

export interface CreateSessionRequest {
  protocol: typeof PROTOCOL;
  /** The firmware by content identity. Clients never name files or paths. */
  artifact: { sha256: string };
  board: 'board.esp32_devkitc_wroom32';
  /** The browser's language-neutral projection of the project revision to simulate. */
  circuit: SimulationSnapshot;
  /** Which board GPIO pads connect to which component terminals (until the MCU is a project part). */
  attachments: McuAttachmentRequest[];
  /**
   * The build service's run ticket for this principal and artifact (Sprint 8). It also carries
   * the server-side feature record: V1 does not simulate internal pulls, GPIO interrupts,
   * restarts or the facilities named in `unsupported`, so a ticket declaring any of them refuses
   * the session instead of letting it run with silently wrong behaviour.
   */
  ticket: string;
  /** Engineering controls a client may only make STRICTER than the host's configuration. */
  limits?: { maxLifetimeMs?: number };
  /** Test/diagnostic only: the host command quantum. Default and V1 value: 1000 us. */
  commandQuantumUs?: number;
}

export type MirrorControl = {
  setpointVoltage?: number;
  currentLimit?: number;
  outputEnabled?: boolean;
  closed?: boolean;
  /**
   * Sprint 11 (ADR-010, additive within `/2`): a part model's declared LIVE parameters (a PIR's
   * `motion`, a photoresistor's `illuminance`), in SI units. Bounded here; the host then checks
   * them against the component's catalog type when the command arrives, and the engine again
   * when it applies.
   */
  params?: Record<string, number | boolean | string>;
};

interface CommandBase {
  /** Client sequence number: strictly increasing per session. Duplicates are rejected. */
  seq: number;
  /**
   * When to apply, in SIMULATION time (decimal string of nanoseconds). Absent: at the next
   * command tick after the host receives it. A time already passed is rejected as `late`.
   */
  atSimNs?: string;
}

export interface MirrorCommand extends CommandBase {
  category: 'mirror';
  /**
   * The project revision in which the browser persisted this value (the browser is the
   * authority). Per session, accepted mirrors carry STRICTLY increasing revisions, each greater
   * than the snapshot revision the session was created from; gaps are allowed. A lower revision
   * is rejected `stale_revision`, an equal one `duplicate_revision`: an older edit can never
   * mutate the runtime, and one persisted edit can never become a second runtime mutation.
   * One persisted edit = one mirror (several controls of one component fit in one `control`).
   */
  projectRevision: number;
  component: string;
  control: MirrorControl;
}

export interface TransientCommand extends CommandBase {
  category: 'transient';
  action: 'press' | 'release';
  component: string;
}

export type SessionCommand = MirrorCommand | TransientCommand;

// ---------------------------------------------------------------------------------------------
// Events (server -> client, in `seq` order)

export interface EventBase {
  /** Host event sequence number: strictly increasing per session, starting at 1. */
  seq: number;
  /**
   * Simulation time (decimal ns) for runtime events; null for lifecycle events that happen
   * outside simulation time. Non-decreasing along `seq` among runtime events.
   */
  simNs: string | null;
}

/** R4: what an LEDC-driven pad does (gpio events). Times in ns (decimal, exact to 1e-3 ns). */
export type PwmPadState =
  | { kind: 'wave'; periodNs: number; highNs: number; duty: number; dutyTicks: number; res: number }
  | { kind: 'static'; level: 0 | 1 }
  /** Duty 0: the hardware's level is not established (O-R4-1). */
  | { kind: 'zero'; periodNs: number }
  | { kind: 'unsupported'; why: string };

export type SessionEvent = EventBase &
  (
    | { type: 'state'; state: SessionState; reason?: EndReason | FailReason; detail?: unknown }
    | { type: 'serial'; data: string /* base64 */; dropped?: number }
    | {
        type: 'gpio';
        /** Pads whose (drive, level) changed in this publish window: final state + count. */
        changes: {
          gpio: number;
          drive: 0 | 1;
          level: 0 | 1;
          transitions: number;
          /**
           * R4: the pad is driven by an LEDC channel with this waveform (absent for simple GPIO).
           * `level` is then the static level, or 0 while it switches.
           */
          pwm?: PwmPadState;
        }[];
      }
    | {
        type: 'electrical';
        /** The latest operating point in this publish window (engine outcome, JSON-safe). */
        outcome: unknown;
      }
    | {
        type: 'command';
        commandSeq: number;
        result: 'applied' | 'rejected';
        reason?: CommandRejection;
        /** Mirrors only: the command's project revision (absent for transient commands). */
        projectRevision?: number;
      }
    | { type: 'diagnostic'; severity: 'warning' | 'error'; code: string; detail?: unknown }
    | { type: 'resync'; missed: number }
  );

export type CommandRejection =
  | 'duplicate'
  | 'late'
  | 'out_of_order'
  | 'queue_full'
  | 'not_running'
  | 'unknown_component'
  | 'unsupported_control'
  | 'stale_revision' // mirror: projectRevision below the latest accepted mirror revision
  | 'duplicate_revision' // mirror: projectRevision equal to it (retry of an accepted edit)
  // Sprint 11 (ADR-010), additive:
  | 'invalid_value' // mirror: a live parameter of the wrong kind or outside its catalog range
  | 'rate_limited'; // more commands than the session accepts per second

/**
 * Mirror revisions of a session (status `revisions`). `snapshot`: the revision the session was
 * created from. `accepted`: the highest mirror revision accepted (queued or applied).
 * `applied`: the highest revision the runtime actually represents. The runtime is in sync with
 * browser revision R when `applied >= R` and the session is not failed; `accepted > applied`
 * means mirrors are still queued for a later command tick.
 */
export interface MirrorRevisions {
  snapshot: number;
  accepted: number;
  applied: number;
}

// ---------------------------------------------------------------------------------------------
// Validation: strict, structural, total (never throws). Unknown fields are refused.

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: string[]) =>
  Object.keys(o).every((k) => keys.includes(k));
const ID = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEC = /^(0|[1-9][0-9]{0,19})$/;
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Sprint 11 (ADR-010): bounds of a mirror's `params` (live part parameters). */
export const MAX_LIVE_PARAMS = 8;
export const MAX_LIVE_PARAMS_BYTES = 512;
const PARAM_KEY = /^[a-z][a-zA-Z0-9]{0,31}$/;

function validParams(p: unknown): string | null {
  if (!isObj(p)) return 'control.params';
  const keys = Object.keys(p);
  if (keys.length === 0 || keys.length > MAX_LIVE_PARAMS) return 'control.params';
  for (const k of keys) {
    if (!PARAM_KEY.test(k)) return 'control.params';
    const v = p[k];
    const ok = typeof v === 'boolean' || finite(v) || (typeof v === 'string' && v.length <= 32);
    if (!ok) return 'control.params';
  }
  if (Buffer.byteLength(JSON.stringify(p)) > MAX_LIVE_PARAMS_BYTES) return 'control.params';
  return null;
}

/** Hard structural bounds on a snapshot (the engine validates semantics). */
export const MAX_COMPONENTS = 500;

function validSnapshot(v: unknown): string | null {
  if (!isObj(v)) return 'circuit must be an object';
  if (v.format !== 'tbi-lab.snapshot') return 'circuit.format';
  if (!Array.isArray(v.components) || v.components.length > MAX_COMPONENTS)
    return 'circuit.components';
  if (!Array.isArray(v.nets) || v.nets.length > 4 * MAX_COMPONENTS) return 'circuit.nets';
  if (!Array.isArray(v.connections) || v.connections.length > 8 * MAX_COMPONENTS)
    return 'circuit.connections';
  for (const c of v.components) {
    if (!isObj(c) || typeof c.id !== 'string' || !ID.test(c.id) || typeof c.type !== 'string')
      return 'circuit.components[]';
    if (!isObj(c.params)) return 'circuit.components[].params';
  }
  for (const n of v.nets) if (!isObj(n) || typeof n.id !== 'string') return 'circuit.nets[]';
  for (const k of v.connections) {
    if (!isObj(k) || typeof k.component !== 'string' || typeof k.terminal !== 'string')
      return 'circuit.connections[]';
    if (typeof k.net !== 'string') return 'circuit.connections[].net';
  }
  if (typeof v.projectId !== 'string' || !isInt(v.projectRevision, 0, Number.MAX_SAFE_INTEGER))
    return 'circuit identity';
  if (typeof v.snapshotId !== 'string' || !isInt(v.schemaVersion, 1, 1000))
    return 'circuit identity';
  return null;
}

export function validateCreate(v: unknown): Validation<CreateSessionRequest> {
  const bad = (error: string): Validation<CreateSessionRequest> => ({ ok: false, error });
  if (!isObj(v)) return bad('body must be an object');
  const allowed = [
    'protocol',
    'artifact',
    'board',
    'circuit',
    'attachments',
    'ticket',
    'limits',
    'commandQuantumUs',
  ];
  if (!onlyKeys(v, allowed)) return bad('unknown field');
  if (v.protocol !== PROTOCOL) return bad('protocol');
  if (
    !isObj(v.artifact) ||
    !onlyKeys(v.artifact, ['sha256']) ||
    typeof v.artifact.sha256 !== 'string' ||
    !SHA256.test(v.artifact.sha256)
  )
    return bad('artifact.sha256');
  if (v.board !== 'board.esp32_devkitc_wroom32') return bad('board');
  const snap = validSnapshot(v.circuit);
  if (snap) return bad(snap);
  if (!Array.isArray(v.attachments) || v.attachments.length > 40) return bad('attachments');
  for (const a of v.attachments) {
    if (!isObj(a) || !onlyKeys(a, ['gpio', 'component', 'terminal'])) return bad('attachments[]');
    if (!isInt(a.gpio, 0, 39) || typeof a.component !== 'string' || !ID.test(a.component))
      return bad('attachments[]');
    if (typeof a.terminal !== 'string' || !ID.test(a.terminal))
      return bad('attachments[].terminal');
  }
  // Verified by the host (MAC, principal, artifact, expiry); here only its outer form.
  if (typeof v.ticket !== 'string' || v.ticket.length === 0 || v.ticket.length > 4096)
    return bad('ticket');
  if (v.limits !== undefined) {
    if (!isObj(v.limits) || !onlyKeys(v.limits, ['maxLifetimeMs'])) return bad('limits');
    if (
      v.limits.maxLifetimeMs !== undefined &&
      !isInt(v.limits.maxLifetimeMs, 1, 7 * 24 * 3600_000)
    )
      return bad('limits.maxLifetimeMs');
  }
  if (v.commandQuantumUs !== undefined && !isInt(v.commandQuantumUs, 100, 100_000))
    return bad('commandQuantumUs');
  return { ok: true, value: v as unknown as CreateSessionRequest };
}

export function validateCommand(v: unknown): Validation<SessionCommand> {
  const bad = (error: string): Validation<SessionCommand> => ({ ok: false, error });
  if (!isObj(v)) return bad('body must be an object');
  if (!isInt(v.seq, 0, Number.MAX_SAFE_INTEGER)) return bad('seq');
  if (v.atSimNs !== undefined && (typeof v.atSimNs !== 'string' || !DEC.test(v.atSimNs)))
    return bad('atSimNs');
  if (v.category === 'mirror') {
    if (!onlyKeys(v, ['category', 'seq', 'atSimNs', 'projectRevision', 'component', 'control']))
      return bad('unknown field');
    if (!isInt(v.projectRevision, 0, Number.MAX_SAFE_INTEGER)) return bad('projectRevision');
    if (typeof v.component !== 'string' || !ID.test(v.component)) return bad('component');
    const c = v.control;
    if (
      !isObj(c) ||
      !onlyKeys(c, ['setpointVoltage', 'currentLimit', 'outputEnabled', 'closed', 'params']) ||
      Object.keys(c).length === 0
    )
      return bad('control');
    if (c.setpointVoltage !== undefined && !finite(c.setpointVoltage))
      return bad('control.setpointVoltage');
    if (c.currentLimit !== undefined && !finite(c.currentLimit)) return bad('control.currentLimit');
    if (c.outputEnabled !== undefined && typeof c.outputEnabled !== 'boolean')
      return bad('control.outputEnabled');
    if (c.closed !== undefined && typeof c.closed !== 'boolean') return bad('control.closed');
    if (c.params !== undefined) {
      const p = validParams(c.params);
      if (p) return bad(p);
    }
    return { ok: true, value: v as unknown as MirrorCommand };
  }
  if (v.category === 'transient') {
    if (!onlyKeys(v, ['category', 'seq', 'atSimNs', 'action', 'component']))
      return bad('unknown field');
    if (v.action !== 'press' && v.action !== 'release') return bad('action');
    if (typeof v.component !== 'string' || !ID.test(v.component)) return bad('component');
    return { ok: true, value: v as unknown as TransientCommand };
  }
  return bad('category');
}

/** JSON-safe copy (bigint -> decimal string). */
export function jsonSafe<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}
