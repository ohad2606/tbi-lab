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
import { verifyTicket } from '../identity/ticket.js';
import { Refusal } from '../policy/refusal.js';
import { checkResources } from '../policy/resources.js';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { HostConfig } from './config.js';
import { validateCommand, validateCreate, type EndReason } from './protocol.js';
import { HostSession, type SessionStatus } from './session.js';
import { isTerminal } from './stateMachine.js';

export type HostResult<T> =
  { ok: true; value: T } | { ok: false; status: number; error: string; refusal?: Refusal };

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
  create(body: unknown, principal: Principal): HostResult<{ session: HostSession }> {
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
    const session = new HostSession(this.config, this.tmpRoot, request, principal, ticket.features);
    this.sessions.set(session.id, session);
    session.prepare();
    return { ok: true, value: { session } };
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
