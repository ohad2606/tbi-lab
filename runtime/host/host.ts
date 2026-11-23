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
import type { HostAdmit } from '../plans/simhost.js';
import type { HostConfig, SimAdmissionConfig } from './config.js';
import { validateCommand, validateCreate, type EndReason } from './protocol.js';
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
    this.applyDropped(sim, a);
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
      await this.safeEnded(adapter, r.sessionId, principal);
      await this.safeEnded(adapter, sessionId, principal);
      if (poll !== null) sim.tickets.markDropped(poll, principal, SYSTEM_LIMIT);
      return simLimit(SYSTEM_LIMIT, 503);
    }
    if (gone || this.closing) {
      // a lost request must not bill a whole lease: the run never becomes a host session
      await this.safeEnded(adapter, sessionId, principal);
      if (poll !== null) sim.tickets.markDropped(poll, principal, SYSTEM_LIMIT);
      return { ok: false, status: 503, error: 'host shutting down' };
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
      session.prepare();
    } catch {
      // the meter session ends at once (bills the few ms the run existed; no leaked slot)
      logSimFault('start');
      if (session && this.sessions.get(session.id) === session)
        void session.failNow('start_failed');
      await this.safeEnded(adapter, sessionId, principal);
      if (poll !== null) sim.tickets.markDropped(poll, principal, SYSTEM_LIMIT);
      return { ok: false, status: 500, error: 'internal error' };
    }
    if (capable) {
      if (poll === null) this.issueTicket(adapter, sim, principal, ticket);
      sim.tickets.markStarted(ticket, principal, sessionId);
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
  private applyDropped(sim: SimAdmissionConfig, a: HostAdmit): void {
    if (a === null || typeof a !== 'object') return;
    const dropped = (a as { dropped?: unknown }).dropped;
    if (!Array.isArray(dropped)) return;
    for (const d of dropped as { ticket?: unknown; principal?: unknown; error?: unknown }[]) {
      if (typeof d?.principal !== 'string') continue;
      sim.tickets.markDropped(d.ticket, d.principal, simLimitAnswer(d.error as never).body);
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

  /** M1: `ended` never throws into the host; a refusal is one line (no principal, no id). */
  private async safeEnded(
    adapter: NonNullable<HostConfig['simPlans']>,
    sessionId: string,
    principal: Principal,
  ): Promise<void> {
    try {
      const r = await adapter.ended(sessionId, 'ended', principal);
      if (r.metered && !r.ok) logQueueFault('ended');
    } catch {
      logQueueFault('ended');
    }
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
        if (Date.now() - ended > this.config.retainEndedMs) this.sessions.delete(id);
        continue;
      }
      if (s.streams === 0 && now - s.lastActivity > this.config.leaseMs) {
        void s.terminate('lease_expired');
        continue;
      }
      if (s.storageBytes() > this.config.maxSessionStorageBytes) void s.failNow('storage_limit');
    }
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

  /** Sprint 23B: live (non-terminal) sessions, and the host's effective ceiling. */
  capacity(): { live: number; max: number } {
    const live = [...this.sessions.values()].filter((s) => !isTerminal(s.state)).length;
    const policy = this.config.policy;
    const max = policy
      ? Math.min(policy.maxLiveSessions, this.config.maxSessions)
      : this.config.maxSessions;
    return { live, max };
  }

  /** Stop admitting sessions, terminate every live one, release every resource. */
  async shutdown(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    await Promise.all([...this.sessions.values()].map((s) => s.terminate('host_shutdown')));
    await Promise.all([...this.sessions.values()].map((s) => s.done()));
    if (this.config.sessionRoot)
      for (const name of readdirSync(this.tmpRoot))
        rmSync(join(this.tmpRoot, name), { recursive: true, force: true });
    else rmSync(this.tmpRoot, { recursive: true, force: true });
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
function logQueueFault(op: 'peek' | 'cancel' | 'ended'): void {
  try {
    process.stderr.write(`${JSON.stringify({ event: 'sim_queue_fault', op })}\n`);
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
