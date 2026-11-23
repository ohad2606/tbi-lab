/**
 * The Session Host (runtime R2): the registry of isolated sessions and the engineering controls
 * around them. No mutable state is shared between sessions; this object only owns the map, the
 * private temporary root and the housekeeping timer.
 *
 * Leases: a session is kept alive by its client, i.e. by an attached event stream or by any
 * authenticated request. With neither for `leaseMs`, it is terminated (`lease_expired`) and its
 * resources are released: a browser that disappears never leaves infrastructure behind. The
 * lease is wall-clock and host-side only; it never touches the simulated loop, which keeps
 * running unaffected while a client briefly reconnects.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Principal } from '../identity/principal.js';
import { isAuthorized, type AccessView, type EmailTag } from '../identity/access.js';
import { verifyTicket } from '../identity/ticket.js';
import { Refusal } from '../policy/refusal.js';
import { checkResources } from '../policy/resources.js';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PlanId } from '../plans/config.js';
import type { Dropped } from '../plans/queue.js';
import type { CloseReason } from '../plans/simminutes.js';
import {
  closeReasonOf,
  type HostAdmit,
  type HostBeat,
  type HostHousekeeping,
} from '../plans/simhost.js';
import type { HostConfig, SimAdmissionConfig } from './config.js';
import { validateCommand, validateCreate, type EndReason, type FailReason } from './protocol.js';
import { newQueueTicket, type TicketState } from './queueTickets.js';
import { HostSession, SESSION_ID_RE, newSessionId, type SessionStatus } from './session.js';
import {
  simAdmissionResponse,
  simLimitAnswer,
  statusOfLimit,
  type PublicLimit,
} from './simAdmission.js';
import { isTerminal } from './stateMachine.js';

export type HostResult<T> =
  { ok: true; value: T } | { ok: false; status: number; error: string; refusal?: Refusal };

/**
 * TBI-018 s3d-3b: a metered admission answer that is not a legacy refusal (design section 3). `limit`:
 * 400/403/409/429/503 with `{ error, limit }`; `queued`: 202 with the queue ticket.
 */
export type SimAnswer =
  | { kind: 'limit'; status: number; limit: PublicLimit; retryAfterS?: number }
  | { kind: 'queued'; ticket: string; position: number; pollAfterS: number; limit: PublicLimit };

/** `admitCreate`'s result: today's HostResult, or (enabled adapter only) a SimAnswer. */
export type AdmitResult =
  | HostResult<{ session: HostSession }>
  | { ok: false; status: number; error: string; sim: SimAnswer };

/** What `POST /sessions` knows about the request besides body and identity (enabled adapter only). */
export interface AdmitOptions {
  /** `Tbi-Queue: 1`: the client understands 202 + polling */
  queueCapable?: boolean;
  /** a well-formed `Tbi-Queue-Ticket`, or null */
  ticket?: string | null;
  /** true once the HTTP client is gone (checked after the awaited admission) */
  gone?: () => boolean;
}

/** Legacy answer for a queued principal of a client without the queue protocol (today's code). */
const LEGACY_CAPACITY_RETRY_MS = 15_000;

/** s3d-4 ops review MEDIUM-1: the race marker of a heartbeat that did not answer in time. */
const BEAT_TIMEOUT: unique symbol = Symbol('beat_timeout');

const SYSTEM_LIMIT: PublicLimit = {
  code: 'system_unavailable',
  messageKey: 'limit.system.unavailable',
  params: {},
};
const REPLACED_LIMIT: PublicLimit = {
  code: 'queue_replaced',
  messageKey: 'limit.sim.queue_replaced',
  params: {},
};
/** what a poll learns after its own cancel (the entry no longer waits; never re-enqueued) */
const CANCELLED_LIMIT: PublicLimit = simLimitAnswer({
  code: 'queue_timeout',
  messageKey: 'limit.sim.queue_timeout',
  params: {},
}).body;

const simLimit = (limit: PublicLimit, status = statusOfLimit(limit)): AdmitResult => {
  const n = limit.params.n;
  return {
    ok: false,
    status,
    error: limit.code,
    sim: {
      kind: 'limit',
      status,
      limit,
      ...(limit.code === 'sim_cooldown' && typeof n === 'number' ? { retryAfterS: n } : {}),
    },
  };
};

/** TBI-018 s3d-4: meter stop codes that mean "the plan's sim minutes are used up" (end reason sim_minutes) */
const MINUTES_CODES: ReadonlySet<string> = new Set([
  'minutes_out',
  'minutes_out_free',
  'sim_daily',
]);
/** s3d-4: default bounded wait of shutdown for pending `ended` calls (unit TimeoutStopSec=20) */
const DEFAULT_END_WAIT_MS = 8_000;
/**
 * s3d-6 (s3d-4 ops review LOW-4): the most `endWaitMs` may be. Shutdown also stops the runtimes, so the
 * wait plus that must stay below the unit's TimeoutStopSec=20 or systemd kills the host mid-wait.
 */
export const MAX_SIM_END_WAIT_MS = 12_000;

/**
 * s3d-6 (s3d-4 ops review LOW-4): interval bounds of the metered admission, checked at boot
 * (runtime/host/simboot.ts) on the values the host will really use: 1 <= beatMs < leaseMs (a beat at or
 * past the lease would make every run lease_lost), housekeepingMs >= the host housekeeping,
 * 0 <= endWaitMs <= MAX_SIM_END_WAIT_MS. Absent values take their defaults, which satisfy the bounds.
 * Not enforced by the constructor: unit tests build hosts with out-of-bound beats on purpose.
 */
export function checkSimBounds(config: HostConfig): void {
  const sim = config.simAdmission;
  if (!sim) return;
  const int = (v: number) => Number.isSafeInteger(v);
  const beat = sim.beatMs;
  if (beat !== undefined && (!int(beat) || beat < 1 || beat >= config.leaseMs))
    throw new Error('sim beatMs must be >= 1 and < leaseMs');
  const hk = sim.housekeepingMs;
  if (hk !== undefined && (!int(hk) || hk < 1 || hk < config.housekeepingMs))
    throw new Error('sim housekeepingMs must be >= the host housekeepingMs');
  const wait = sim.endWaitMs;
  if (wait !== undefined && (!int(wait) || wait < 0 || wait > MAX_SIM_END_WAIT_MS))
    throw new Error(`sim endWaitMs must be between 0 and ${MAX_SIM_END_WAIT_MS}`);
}
const DEFAULT_SIM_HOUSEKEEPING_MS = 5_000;

type Adapter = NonNullable<HostConfig['simPlans']>;

const refused = (r: Refusal): { ok: false; status: number; error: string; refusal: Refusal } => ({
  ok: false,
  status: r.status,
  error: r.code,
  refusal: r,
});

export class SessionHost {
  private readonly sessions = new Map<string, HostSession>();
  readonly tmpRoot: string;
  private readonly timer: ReturnType<typeof setInterval>;
  private closing = false;
  /** TBI-018 s3d-4: metered sessions that are not terminal yet: their beat timer and log subscription */
  private readonly metered = new Map<
    string,
    { timer: ReturnType<typeof setTimeout> | null; unsubscribe: () => void }
  >();
  /** s3d-4: the one `adapter.ended` call per meter session id (idempotent: a second path reuses it) */
  private readonly settles = new Map<string, Promise<void>>();
  /** s3d-4: `ended` calls still in flight (shutdown waits for them, bounded) */
  private readonly pendingEnds = new Set<Promise<void>>();
  private simHkInFlight = false;
  private simHkLast = performance.now();

  constructor(readonly config: HostConfig) {
    // TBI-018 s3d-3b: the "not wired" guard moved to boot (main.ts refuses every TBI_HOST_SIM_* flag
    // until s3d-6). What stays here is consistency: an enabled adapter without a policy or without
    // the admission wiring could not admit correctly, so it is refused before anything is created.
    if (config.simPlans?.enabled && (!config.policy || !config.simAdmission))
      throw new Error('an enabled sim adapter needs a policy and the sim admission config');
    // A host that was killed outright cannot clean up: its runtimes exit on their own (the
    // bridge connection drops), but its private root would remain. Remove any root whose
    // owning host process no longer exists.
    if (config.sessionRoot) {
      // A fixed root this host owns alone (deployment): anything in it is left over from a
      // previous host process and is removed.
      this.tmpRoot = config.sessionRoot;
      for (const name of readdirSync(this.tmpRoot))
        rmSync(join(this.tmpRoot, name), { recursive: true, force: true });
    } else {
      removeStaleRoots(config.tmpParent);
      // Private (0700) root for every session directory of this host process.
      this.tmpRoot = mkdtempSync(join(config.tmpParent, `tbi-host-${process.pid}-`));
    }
    this.timer = setInterval(() => this.housekeeping(), config.housekeepingMs);
    this.timer.unref();
  }

  /**
   * Validate, authorize, admit and prepare a new session for `principal`. The run ticket must be
   * the build service's, for this principal and exactly this artifact, and unexpired (D-S8-4);
   * the session's firmware features come from it. Artifact problems yield a FAILED session.
   */
  create(
    body: unknown,
    principal: Principal,
    emailTag: string | null = null,
    opts: { sessionId?: string } = {},
  ): HostResult<{ session: HostSession }> {
    // TBI-018 s3d-2: a pre-generated id is host-internal (never client text); a malformed or
    // already registered one is a host bug and throws before anything is admitted or consumed.
    if (opts.sessionId !== undefined) {
      if (typeof opts.sessionId !== 'string' || !SESSION_ID_RE.test(opts.sessionId))
        throw new Error('malformed session id');
      if (this.sessions.has(opts.sessionId)) throw new Error('duplicate session id');
    }
    if (this.closing) return { ok: false, status: 503, error: 'host shutting down' };
    const v = validateCreate(body);
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    const ticket = verifyTicket(this.config.ticketKey, v.value.ticket);
    if (!ticket || ticket.principal !== principal || ticket.sha256 !== v.value.artifact.sha256)
      return { ok: false, status: 403, error: 'ticket invalid' };
    const live = [...this.sessions.values()].filter((s) => !isTerminal(s.state));
    const policy = this.config.policy;
    let request = v.value;
    if (policy) {
      // Phase 4 admission, in order: the user's own limit, the host's capacity (another user's
      // session is never stopped, nor named), host resources, then the user's creation rate —
      // taken last, so a refused request does not consume it.
      const plan = policy.plan(principal);
      if (live.filter((s) => s.owner === principal).length >= plan.runtime.maxSessions)
        return refused(new Refusal('session_quota'));
      if (live.length >= Math.min(policy.maxLiveSessions, this.config.maxSessions))
        return refused(new Refusal('runtime_capacity', 15_000));
      try {
        checkResources(policy.config.global.resources, this.tmpRoot, this.config.probe);
      } catch (e) {
        if (e instanceof Refusal) return refused(e);
        throw e;
      }
      const rate = this.config.rates?.take(principal, 'session-create', plan.runtime.creations);
      if (rate && !rate.ok) return refused(new Refusal('rate_limited', rate.retryAfterMs));
      // The plan's lifetime caps the session (a client may only make it stricter).
      const lifetime = Math.min(
        request.limits?.maxLifetimeMs ?? Infinity,
        plan.runtime.maxLifetimeMs,
      );
      request = { ...request, limits: { ...request.limits, maxLifetimeMs: lifetime } };
    } else if (live.length >= this.config.maxSessions)
      return { ok: false, status: 429, error: 'session limit' };
    const session = new HostSession(
      this.config,
      this.tmpRoot,
      request,
      principal,
      ticket.features,
      opts.sessionId === undefined ? {} : { id: opts.sessionId },
    );
    session.emailTag = emailTag;
    this.sessions.set(session.id, session);
    session.prepare();
    return { ok: true, value: { session } };
  }

  /**
   * TBI-018 s3d-2/s3d-3b: the async admission path of `POST /sessions` (docs/plans/S3D-HOST-WIRING-DESIGN.md
   * section 2). Without an enabled sim adapter (absent or `metering.enabled=false`) it is exactly
   * `create`: same result, same refusals, same order of checks; `opts` is ignored. With an enabled one
   * it is the metered admission (`admitMetered`).
   */
  async admitCreate(
    body: unknown,
    principal: Principal,
    emailTag: string | null = null,
    opts: AdmitOptions = {},
  ): Promise<AdmitResult> {
    const adapter = this.queueAdapter;
    if (!adapter) return this.create(body, principal, emailTag);
    return this.admitMetered(adapter, body, principal, emailTag, opts);
  }

  /**
   * TBI-018 s3d-3b: steps 1-9 of design section 2 with an enabled adapter. Nothing is metered before
   * `adapter.admit`; every adapter call is caught (M1). Out of scope here (s3d-4): the beat timer and
   * `ended` on every terminal path; this method calls `ended` only when a started run never became a
   * host session (construction failed, client gone, host closing).
   */
  private async admitMetered(
    adapter: NonNullable<HostConfig['simPlans']>,
    body: unknown,
    principal: Principal,
    emailTag: string | null,
    opts: AdmitOptions,
  ): Promise<AdmitResult> {
    // 1, 2: unchanged checks
    if (this.closing) return { ok: false, status: 503, error: 'host shutting down' };
    const v = validateCreate(body);
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    const sim = this.config.simAdmission;
    const policy = this.config.policy;
    const capable = opts.queueCapable === true;
    // a legacy request carries no ticket (design section 3): its header, if any, is ignored
    const asked = capable && typeof opts.ticket === 'string' ? opts.ticket : null;
    const known = asked !== null && sim ? sim.tickets.lookup(asked, principal) : null;
    const runTicket = verifyTicket(this.config.ticketKey, v.value.ticket);
    if (
      !runTicket ||
      runTicket.principal !== principal ||
      runTicket.sha256 !== v.value.artifact.sha256
    ) {
      // a run ticket that expired while waiting ends the wait (design section 2 step 2)
      if (known?.kind === 'waiting') await this.cancelQueued(asked, principal);
      return { ok: false, status: 403, error: 'ticket invalid' };
    }
    if (!policy || !sim) {
      logSimFault('config');
      return simLimit(SYSTEM_LIMIT, 503);
    }
    // 5 (part, before 3): a started ticket replays its own session (O-5). It must come before the
    // session_quota check, which would otherwise count the replayed session against itself.
    const replay = this.replayStarted(known, principal);
    if (replay) return replay;
    // 3, 4: the host's own per-principal limit and resources (legacy refusals, unchanged)
    const plan = policy.plan(principal);
    const live = [...this.sessions.values()].filter((s) => !isTerminal(s.state));
    if (live.filter((s) => s.owner === principal).length >= plan.runtime.maxSessions)
      return refused(new Refusal('session_quota'));
    try {
      checkResources(policy.config.global.resources, this.tmpRoot, this.config.probe);
    } catch (e) {
      if (e instanceof Refusal) return refused(e);
      throw e;
    }
    // 5: ticket resolution (queue-capable clients only)
    if (known?.kind === 'dropped')
      return known.reason === 'replaced' ? simLimit(REPLACED_LIMIT, 409) : simLimit(known.limit);
    const poll = known?.kind === 'waiting' ? asked : null;
    // legacy client whose principal waits (M3): the waiting tab's entry is left alone
    if (!capable && this.hasWaiting(principal))
      return refused(new Refusal('runtime_capacity', LEGACY_CAPACITY_RETRY_MS));
    // 6: the creation rate, once per new admission (never on a poll; O-6)
    if (poll === null) {
      const rate = this.config.rates?.take(principal, 'session-create', plan.runtime.creations);
      if (rate && !rate.ok) return refused(new Refusal('rate_limited', rate.retryAfterMs));
    }
    // 7: admission (plan resolution fails closed, m13)
    let planId: PlanId | undefined;
    try {
      planId = sim.planMap.get(policy.planName(principal));
    } catch {
      planId = undefined;
    }
    if (planId === undefined) {
      logSimFault('plan');
      return simLimit(SYSTEM_LIMIT, 503);
    }
    const sessionId = newSessionId();
    const ticket = poll ?? newQueueTicket();
    let a: HostAdmit;
    try {
      a = await adapter.admit({
        ticket,
        sessionId,
        principal,
        plan: planId,
        slots: {
          capacity: Math.min(policy.maxLiveSessions, this.config.maxSessions),
          running: live.length,
        },
        mode: capable ? (poll !== null ? 'poll' : 'join') : 'legacy',
      });
    } catch {
      // M1: nothing starts and nothing stays queued
      logSimFault('admit');
      await this.withdraw(adapter, sim, ticket, principal, poll !== null);
      return simLimit(SYSTEM_LIMIT, 503);
    }
    this.applyDropped(
      sim,
      a !== null && typeof a === 'object' && a.metered ? a.dropped : undefined,
    );
    // 8: the answer table (design section 3)
    const r = simAdmissionResponse(a);
    if (r.kind === 'unmetered') {
      // enabled adapter answering unmetered: a contradiction, fails closed (never "start unmetered")
      logSimFault('unmetered');
      await this.withdraw(adapter, sim, ticket, principal, poll !== null);
      return simLimit(SYSTEM_LIMIT, 503);
    }
    if (r.kind === 'refused') {
      if (poll !== null) {
        // a concurrent poll of the same ticket may have started it meanwhile: same 201 (O-5)
        const again = this.replayStarted(sim.tickets.lookup(poll, principal), principal);
        if (again) return again;
      }
      simAdmissionEvent(r.cause, principal);
      if (poll !== null) sim.tickets.markDropped(poll, principal, r.body);
      else if (capable && !this.hasWaiting(principal)) sim.tickets.dropWaitingOf(principal, r.body);
      return simLimit(r.body, r.status);
    }
    const gone = opts.gone?.() === true;
    if (r.kind === 'queued') {
      // legacy: the adapter already removed its own entry in the same serial step
      if (!capable) return refused(new Refusal('runtime_capacity', LEGACY_CAPACITY_RETRY_MS));
      if (gone || this.closing) {
        await this.withdraw(adapter, sim, ticket, principal, poll !== null);
        return { ok: false, status: 503, error: 'host shutting down' };
      }
      if (poll === null) this.issueTicket(adapter, sim, principal, ticket);
      simAdmissionEvent('queued', principal);
      return {
        ok: false,
        status: 202,
        error: 'queued',
        sim: {
          kind: 'queued',
          ticket,
          position: r.position,
          pollAfterS: sim.pollAfterS,
          limit: r.body,
        },
      };
    }
    // 9: start
    if (r.sessionId !== sessionId) {
      // the adapter opened a run under another id: a contract break, close it and fail closed
      logSimFault('admit');
      await this.settle(adapter, r.sessionId, principal, 'ended');
      await this.settle(adapter, sessionId, principal, 'ended');
      if (poll !== null) sim.tickets.markDropped(poll, principal, SYSTEM_LIMIT);
      return simLimit(SYSTEM_LIMIT, 503);
    }
    if (gone || this.closing) {
      // a lost request must not bill a whole lease: the run never becomes a host session
      await this.settle(adapter, sessionId, principal, 'ended');
      if (poll !== null) sim.tickets.markDropped(poll, principal, SYSTEM_LIMIT);
      return { ok: false, status: 503, error: 'host shutting down' };
    }
    // s3d-3b review (a): the per-principal limit again, after the awaited admission (another path may
    // have registered a session for this principal meanwhile); violated -> the run is ended, never started
    if (
      [...this.sessions.values()].filter((s) => s.owner === principal && !isTerminal(s.state))
        .length >= plan.runtime.maxSessions
    ) {
      await this.settle(adapter, sessionId, principal, 'ended');
      if (poll !== null) sim.tickets.markDropped(poll, principal, SYSTEM_LIMIT);
      return refused(new Refusal('session_quota'));
    }
    let session: HostSession | undefined;
    try {
      const lifetime = Math.min(
        v.value.limits?.maxLifetimeMs ?? Infinity,
        plan.runtime.maxLifetimeMs,
      );
      const request = { ...v.value, limits: { ...v.value.limits, maxLifetimeMs: lifetime } };
      session = new HostSession(this.config, this.tmpRoot, request, principal, runTicket.features, {
        id: sessionId,
      });
      session.emailTag = emailTag;
      session.simAdmitted = { plan: r.plan, remainingMs: r.remainingMs };
      this.sessions.set(session.id, session);
      // s3d-4: subscribed before prepare, so a synchronous prepare failure is ended (billed) too
      this.track(adapter, session, r.remainingMs);
      session.prepare();
      // s3d-3b review (b): ticket bookkeeping inside the guarded block
      if (capable) {
        if (poll === null) this.issueTicket(adapter, sim, principal, ticket);
        sim.tickets.markStarted(ticket, principal, sessionId);
      }
    } catch {
      // the meter session ends at once (bills the few ms the run existed; no leaked slot)
      logSimFault('start');
      if (session && this.sessions.get(session.id) === session)
        void session.failNow('start_failed');
      await this.settle(adapter, sessionId, principal, 'ended');
      if (poll !== null) sim.tickets.markDropped(poll, principal, SYSTEM_LIMIT);
      return { ok: false, status: 500, error: 'internal error' };
    }
    simAdmissionEvent('admitted', principal);
    return { ok: true, value: { session } };
  }

  /** O-5: a started ticket's own live session (the same 201 again), or null. */
  private replayStarted(
    known: TicketState | null,
    principal: Principal,
  ): { ok: true; value: { session: HostSession } } | null {
    if (known?.kind !== 'started') return null;
    const s = this.sessions.get(known.sessionId);
    if (!s || s.owner !== principal || isTerminal(s.state)) return null;
    s.lastActivity = performance.now(); // the client is there, like any authenticated request
    return { ok: true, value: { session: s } };
  }

  /** Register a new waiting ticket; waiting tickets it evicted lose their queue entry too (3a note 2). */
  private issueTicket(
    adapter: NonNullable<HostConfig['simPlans']>,
    sim: SimAdmissionConfig,
    principal: Principal,
    ticket: string,
  ): void {
    const { evicted } = sim.tickets.issue(principal, ticket);
    for (const e of evicted) void this.safeCancel(adapter, e.ticket, e.principal);
  }

  /** Drops the adapter reported (other waiters' timeouts, vanished) reach the registry. */
  private applyDropped(sim: SimAdmissionConfig, dropped: readonly Dropped[] | undefined): void {
    if (!Array.isArray(dropped)) return;
    for (const d of dropped) {
      // defensive: the adapter is a trust boundary for shape (M1), never for another principal's entry
      if (d === null || typeof d !== 'object' || typeof d.principal !== 'string') continue;
      sim.tickets.markDropped(d.ticket, d.principal, simLimitAnswer(d.error).body);
    }
  }

  /** Nothing of this request stays queued: cancel its entry; a poll's ticket no longer waits. */
  private async withdraw(
    adapter: NonNullable<HostConfig['simPlans']>,
    sim: SimAdmissionConfig,
    ticket: string,
    principal: Principal,
    poll: boolean,
  ): Promise<void> {
    await this.safeCancel(adapter, ticket, principal);
    if (poll) sim.tickets.markDropped(ticket, principal, SYSTEM_LIMIT);
  }

  private async safeCancel(
    adapter: NonNullable<HostConfig['simPlans']>,
    ticket: string,
    principal: string,
  ): Promise<void> {
    try {
      await adapter.cancel(ticket, principal);
    } catch {
      logQueueFault('cancel');
    }
  }

  /**
   * TBI-018 s3d-4: the ONE `adapter.ended` call of a meter session id (every terminal path, design
   * section 5). A second call for the same id returns the first promise, so no path bills twice. M1:
   * never throws into the host; a refusal or fault is one line (no principal, no id).
   */
  private settle(
    adapter: Adapter,
    sessionId: string,
    principal: Principal,
    reason: CloseReason,
  ): Promise<void> {
    const had = this.settles.get(sessionId);
    if (had) return had;
    const p = (async () => {
      try {
        const r = await adapter.ended(sessionId, reason, principal);
        if (r === null || typeof r !== 'object' || (r.metered && !r.ok)) logQueueFault('ended');
      } catch {
        logQueueFault('ended');
      }
    })();
    this.settles.set(sessionId, p);
    this.pendingEnds.add(p);
    void p.finally(() => {
      this.pendingEnds.delete(p);
      // a run that never became a host session has no retention entry to clear this later
      if (!this.sessions.has(sessionId)) this.settles.delete(sessionId);
    });
    return p;
  }

  /**
   * TBI-018 s3d-4: meter a registered session: the first terminal state event ends its meter session
   * (`closeReasonOf`), and a beat timer runs until then.
   */
  private track(adapter: Adapter, s: HostSession, remainingMs: number | null): void {
    const entry = { timer: null as ReturnType<typeof setTimeout> | null, unsubscribe: () => {} };
    this.metered.set(s.id, entry);
    const unsubscribe = s.log.subscribe((e) => {
      if (e.type === 'state' && isTerminal(e.state)) this.onTerminal(adapter, s, e.reason);
    });
    entry.unsubscribe = () => void unsubscribe();
    this.scheduleBeat(adapter, s, remainingMs);
  }

  private onTerminal(
    adapter: Adapter,
    s: HostSession,
    reason: EndReason | FailReason | undefined,
  ): void {
    const m = this.metered.get(s.id);
    if (m) {
      if (m.timer) clearTimeout(m.timer);
      m.unsubscribe();
      this.metered.delete(s.id);
    }
    void this.settle(adapter, s.id, s.owner, closeReasonOf(reason ?? 'ended'));
  }

  private get simBeatMs(): number {
    const v = this.config.simAdmission?.beatMs;
    return v !== undefined && Number.isSafeInteger(v) && v >= 1
      ? v
      : Math.max(1, Math.floor(this.config.leaseMs / 3));
  }

  /** Next beat at min(simBeatMs, remainingMs); remainingMs null = no sim limit (design section 5). */
  private scheduleBeat(adapter: Adapter, s: HostSession, remainingMs: number | null): void {
    const m = this.metered.get(s.id);
    if (!m || this.closing) return;
    const every = this.simBeatMs;
    const wait = remainingMs === null ? every : Math.max(0, Math.min(every, remainingMs));
    m.timer = setTimeout(() => void this.beat(adapter, s), wait);
    m.timer.unref();
  }

  private async beat(adapter: Adapter, s: HostSession): Promise<void> {
    const m = this.metered.get(s.id);
    if (!m || isTerminal(s.state)) return;
    m.timer = null;
    // no client: no beat; the host lease ends the run and the meter bills at most lastBeat + leaseMs
    if (!(s.streams > 0 || performance.now() - s.lastActivity <= this.config.leaseMs))
      return this.scheduleBeat(adapter, s, null);
    // s3d-4 ops review MEDIUM-1: a beat that does not answer within max(1, leaseMs - beatMs) stops
    // the run (fail closed). The previous answered beat was at most beatMs before this one, so a hung
    // adapter never leaves a run unmetered for longer than one host lease; a late answer is ignored.
    const timeoutMs = Math.max(1, this.config.leaseMs - this.simBeatMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let b: HostBeat | typeof BEAT_TIMEOUT;
    try {
      b = await Promise.race([
        Promise.resolve().then(() => adapter.heartbeat(s.id, s.owner)),
        new Promise<typeof BEAT_TIMEOUT>((r) => {
          timer = setTimeout(() => r(BEAT_TIMEOUT), timeoutMs);
          timer.unref();
        }),
      ]);
    } catch {
      clearTimeout(timer);
      logBeatFault('error');
      return this.stopRun(s, 'sim_unavailable', SYSTEM_LIMIT);
    }
    clearTimeout(timer);
    // an answer for a session that is terminal by now is ignored (design section 8)
    if (isTerminal(s.state) || this.metered.get(s.id) !== m) return;
    if (b === BEAT_TIMEOUT) {
      logBeatFault('timeout');
      return this.stopRun(s, 'sim_unavailable', SYSTEM_LIMIT);
    }
    if (b === null || typeof b !== 'object' || b.metered !== true) {
      // an enabled adapter answering unmetered: a contradiction, fail closed
      logBeatFault('unmetered');
      return this.stopRun(s, 'sim_unavailable', SYSTEM_LIMIT);
    }
    switch (b.decision) {
      case 'continue':
        if (
          b.remainingMs !== null &&
          !(Number.isSafeInteger(b.remainingMs) && b.remainingMs >= 0)
        ) {
          logBeatFault('malformed');
          return this.stopRun(s, 'sim_unavailable', SYSTEM_LIMIT);
        }
        return this.scheduleBeat(adapter, s, b.remainingMs);
      case 'refused':
        // only possible through a host bug (the caller is the owner): logged, the run is NOT stopped
        logBeatFault('refused');
        return this.scheduleBeat(adapter, s, null);
      case 'stop': {
        const code = b.error?.code;
        if (typeof code === 'string' && MINUTES_CODES.has(code)) {
          const answer = simLimitAnswer(b.error);
          if (answer.body.code !== 'system_unavailable')
            return this.stopRun(s, 'sim_minutes', answer.body);
        }
        // system_unavailable, lease_lost, invalid_state, anything else: the meter cannot bill this run
        return this.stopRun(s, 'sim_unavailable', SYSTEM_LIMIT);
      }
      default: {
        const unhandled: never = b;
        void unhandled;
        logBeatFault('malformed');
        return this.stopRun(s, 'sim_unavailable', SYSTEM_LIMIT);
      }
    }
  }

  private stopRun(s: HostSession, reason: 'sim_minutes' | 'sim_unavailable', limit: PublicLimit) {
    if (isTerminal(s.state)) return;
    void s.terminate(reason, structuredClone(limit));
  }

  /**
   * TBI-018 s3d-4: `adapter.housekeeping()` every simHousekeepingMs, never two at once (the host timer
   * is synchronous and runs every housekeepingMs). Dropped waiters reach the registry; `pruned` is
   * logged as a count; a fault is one line and swallowed (M1).
   */
  private simHousekeeping(): void {
    const adapter = this.queueAdapter;
    const sim = this.config.simAdmission;
    if (!adapter || !sim || this.simHkInFlight || this.closing) return;
    const now = performance.now();
    if (now - this.simHkLast < (sim.housekeepingMs ?? DEFAULT_SIM_HOUSEKEEPING_MS)) return;
    this.simHkLast = now;
    this.simHkInFlight = true;
    let p: Promise<HostHousekeeping>;
    try {
      p = Promise.resolve(adapter.housekeeping());
    } catch {
      logQueueFault('housekeeping');
      this.simHkInFlight = false;
      return;
    }
    void p
      .then(
        (r) => {
          if (r === null || typeof r !== 'object' || r.metered !== true) return;
          this.applyDropped(sim, r.dropped);
          if (!r.ok) logQueueFault('housekeeping');
          else if (Number.isSafeInteger(r.pruned) && r.pruned > 0) logSimCount('pruned', r.pruned);
        },
        () => logQueueFault('housekeeping'),
      )
      .finally(() => {
        this.simHkInFlight = false;
      });
  }

  /** TBI-018 s3d-3a: the sim adapter's queue surface, only when the adapter is enabled. */
  private get queueAdapter(): NonNullable<HostConfig['simPlans']> | null {
    const a = this.config.simPlans;
    return a?.enabled === true ? a : null;
  }

  /**
   * TBI-018 s3d-3a: does the queue exist on this host (an enabled sim adapter)? False = flag-off:
   * `DELETE /sessions/queue` and the `Tbi-Queue*` headers are not served (design section 10 R-1).
   */
  get queueEnabled(): boolean {
    return this.queueAdapter !== null;
  }

  /**
   * TBI-018 s3d-3a (design section 3, M3): read-only peek whether `principal` waits in the queue.
   * Flag-off: false. A throwing adapter answers true (fail closed: a legacy request then gets
   * runtime_capacity and never touches the queue) with one log line (no principal, no ticket).
   */
  hasWaiting(principal: Principal): boolean {
    const a = this.queueAdapter;
    if (!a) return false;
    try {
      return a.hasWaiting(principal) !== false;
    } catch {
      logQueueFault('peek');
      return true;
    }
  }

  /**
   * TBI-018 s3d-3a: cancel `principal`'s waiting entry for `ticket` (`DELETE /sessions/queue`). The
   * adapter acts only on the caller's own entry; nothing is returned, so an own, foreign, unknown or
   * missing ticket cannot be told apart. Flag-off or no ticket: no adapter call. A throw or rejection
   * is logged (one line, no principal, no ticket) and swallowed (ops review M1).
   */
  async cancelQueued(ticket: string | null, principal: Principal): Promise<void> {
    const a = this.queueAdapter;
    if (!a || ticket === null) return;
    await this.safeCancel(a, ticket, principal);
    // s3d-3a review note 1: the registry ticket no longer waits either, so a poll after the cancel is
    // answered (queue_timeout) and never re-enqueued; a started or foreign ticket is unchanged
    this.config.simAdmission?.tickets.markDropped(ticket, principal, CANCELLED_LIMIT);
  }

  /**
   * The session for an id, only for its owner and with its own token (constant-time
   * comparison). Another principal's session is indistinguishable from none (Sprint 8).
   */
  get(sessionId: string, token: string | null, principal: Principal): HostResult<HostSession> {
    const s = /^[0-9a-f]{32}$/.test(sessionId) ? this.sessions.get(sessionId) : undefined;
    if (!s || token === null || s.owner !== principal)
      return { ok: false, status: 404, error: 'no such session' };
    const given = createHash('sha256').update(token).digest();
    const want = Buffer.from(s.tokenHash, 'hex');
    if (given.length !== want.length || !timingSafeEqual(given, want))
      return { ok: false, status: 404, error: 'no such session' }; // never reveal existence
    s.lastActivity = performance.now();
    return { ok: true, value: s };
  }

  /**
   * Sprint 14 problem reports: the status of `principal`'s OWN session, read-only (no token: the
   * gate's principal alone may only see its own sessions; it renews no lease). Unknown ids and
   * other principals' sessions are both null, so the caller cannot tell them apart.
   */
  statusFor(sessionId: string, principal: Principal): SessionStatus | null {
    const s = /^[0-9a-f]{32}$/.test(sessionId) ? this.sessions.get(sessionId) : undefined;
    return s && s.owner === principal ? s.status() : null;
  }

  command(s: HostSession, body: unknown): HostResult<{ accepted: boolean; reason?: string }> {
    const v = validateCommand(body);
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    return { ok: true, value: s.submit(v.value) };
  }

  private housekeeping(): void {
    const now = performance.now();
    for (const [id, s] of this.sessions) {
      if (isTerminal(s.state)) {
        const ended = s.endedAt?.getTime() ?? Date.now();
        if (Date.now() - ended > this.config.retainEndedMs) {
          this.sessions.delete(id);
          this.settles.delete(id);
        }
        continue;
      }
      if (s.streams === 0 && now - s.lastActivity > this.config.leaseMs) {
        void s.terminate('lease_expired');
        continue;
      }
      if (s.storageBytes() > this.config.maxSessionStorageBytes) void s.failNow('storage_limit');
    }
    this.simHousekeeping();
  }

  /** Terminate one session (idempotent). */
  terminate(s: HostSession, reason: EndReason = 'terminated'): Promise<void> {
    return s.terminate(reason);
  }

  /**
   * Sprint 23B: end every live session whose account is no longer authorized (`allowed` decides
   * from the owner principal and the recorded email tag), with reason `account_disabled`, and
   * close its event streams. Other accounts' sessions are untouched. Returns how many were ended.
   */
  revokeUnauthorized(allowed: (owner: Principal, emailTag: string | null) => boolean): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (isTerminal(s.state) || allowed(s.owner, s.emailTag)) continue;
      n++;
      // The terminal state event reaches the streams first; whatever is still open after the
      // runtime is gone (or after a bounded wait) is closed by the host.
      const fallback = setTimeout(() => s.closeStreams(), 5_000);
      fallback.unref();
      void s.terminate('account_disabled').finally(() => {
        clearTimeout(fallback);
        s.closeStreams();
      });
    }
    return n;
  }

  /**
   * Sprint 23B: live (non-terminal) sessions, and the host's effective ceiling. TBI-018 s3d-6 (design
   * §10 R-1b, m8): with an ENABLED sim adapter also two coarse counts, `waiting` (queue entries) and
   * `metered` (metered runs not terminal yet); never a principal, ticket or session id. Flag-off: the
   * exact Sprint 23B body.
   */
  capacity(): { live: number; max: number; waiting?: number; metered?: number } {
    const live = [...this.sessions.values()].filter((s) => !isTerminal(s.state)).length;
    const policy = this.config.policy;
    const max = policy
      ? Math.min(policy.maxLiveSessions, this.config.maxSessions)
      : this.config.maxSessions;
    const adapter = this.queueAdapter;
    if (!adapter) return { live, max };
    const w = (adapter as { waiting?: unknown }).waiting;
    const waiting = typeof w === 'number' && Number.isSafeInteger(w) && w >= 0 ? w : undefined;
    return { live, max, ...(waiting !== undefined ? { waiting } : {}), metered: this.metered.size };
  }

  /** Stop admitting sessions, terminate every live one, release every resource. */
  async shutdown(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    for (const m of this.metered.values()) if (m.timer) clearTimeout(m.timer);
    await Promise.all([...this.sessions.values()].map((s) => s.terminate('host_shutdown')));
    // s3d-4 ops review LOW-3: a metered session still `creating` reaches its terminal state only
    // after prepare returns; end its meter session now so it is inside the bounded wait (settle is
    // idempotent: the later terminal event gets the same promise)
    const adapter = this.queueAdapter;
    if (adapter)
      for (const s of this.sessions.values())
        if (s.state === 'creating' && this.metered.has(s.id))
          void this.settle(adapter, s.id, s.owner, 'host');
    await Promise.all([...this.sessions.values()].map((s) => s.done()));
    await this.awaitPendingEnds();
    if (this.config.sessionRoot)
      for (const name of readdirSync(this.tmpRoot))
        rmSync(join(this.tmpRoot, name), { recursive: true, force: true });
    else rmSync(this.tmpRoot, { recursive: true, force: true });
  }

  /**
   * TBI-018 s3d-4 (design section 5, m3): wait for the `ended` calls still in flight, bounded below the
   * unit's TimeoutStopSec. On timeout one line with the count; the meter sweep and boot recovery close
   * what is left.
   */
  private async awaitPendingEnds(): Promise<void> {
    if (this.pendingEnds.size === 0) return;
    const ms = this.config.simAdmission?.endWaitMs ?? DEFAULT_END_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled([...this.pendingEnds]).then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), ms);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) logSimCount('end_wait_timeout', this.pendingEnds.size);
  }

  /** Session count by state (health endpoint; no identifiers). */
  health(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.sessions.values()) out[s.state] = (out[s.state] ?? 0) + 1;
    return out;
  }

  /** Test support: sessions currently registered (terminal ones until retention expires). */
  get size(): number {
    return this.sessions.size;
  }
}

/** One operator line for a failed queue call: the operation only (never a principal, ticket or error text). */
function logQueueFault(op: 'peek' | 'cancel' | 'ended' | 'housekeeping'): void {
  try {
    process.stderr.write(`${JSON.stringify({ event: 'sim_queue_fault', op })}\n`);
  } catch {
    // logging never changes the outcome
  }
}

/** s3d-4: one operator line for a beat the host could not use (never a principal, id or text). */
function logBeatFault(op: 'error' | 'timeout' | 'unmetered' | 'malformed' | 'refused'): void {
  try {
    process.stderr.write(`${JSON.stringify({ event: 'sim_beat_fault', op })}\n`);
  } catch {
    // logging never changes the outcome
  }
}

/** s3d-4: one operator line with a count only. */
function logSimCount(what: 'pruned' | 'end_wait_timeout', n: number): void {
  try {
    const line =
      what === 'pruned'
        ? { event: 'sim_housekeeping', pruned: n }
        : { event: 'sim_end_wait_timeout', pending: n };
    process.stderr.write(`${JSON.stringify(line)}\n`);
  } catch {
    // logging never changes the outcome
  }
}

/** s3d-3b: one operator line for a failed metered admission step (never a principal, ticket or text). */
function logSimFault(op: 'config' | 'plan' | 'admit' | 'unmetered' | 'start'): void {
  try {
    process.stderr.write(`${JSON.stringify({ event: 'sim_admission_fault', op })}\n`);
  } catch {
    // logging never changes the outcome
  }
}

/**
 * s3d-3b: the metered admission's decision, `admissionEvent`-style (runtime/policy/refusal.ts): the
 * internal cause and a SHORT principal reference only (never a ticket, token or address).
 */
function simAdmissionEvent(outcome: string, principal: Principal): void {
  try {
    process.stderr.write(
      `${JSON.stringify({
        event: 'admission',
        service: 'runtime',
        action: 'session-create',
        outcome: outcome === 'admitted' ? outcome : `sim_${outcome}`,
        who: principal.slice(0, 10),
      })}\n`,
    );
  } catch {
    // logging never changes the outcome
  }
}

function removeStaleRoots(parent: string): void {
  for (const name of readdirSync(parent)) {
    const m = /^tbi-host-(\d+)-/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      alive = (e as NodeJS.ErrnoException).code === 'EPERM';
    }
    if (!alive) rmSync(join(parent, name), { recursive: true, force: true });
  }
}

/**
 * Sprint 23B: on every reload of the access view, end the live sessions of accounts the view no
 * longer authorizes. One line with the count only (no principal, tag or address).
 */
export function revokeOnReload(
  host: SessionHost,
  access: AccessView,
  log: (line: string) => void = (l) => void process.stderr.write(`${l}\n`),
): () => void {
  return access.onReload((view) => {
    const n = host.revokeUnauthorized((owner, tag) =>
      isAuthorized(view, owner, tag as EmailTag | null),
    );
    if (n > 0) {
      try {
        log(JSON.stringify({ event: 'access_revoked', sessions: n }));
      } catch {
        // logging never changes the outcome
      }
    }
  });
}
