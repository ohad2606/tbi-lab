/**
 * TBI-018 slice 3b: SimMeter, ESP32 sim minutes per principal. PURE and INERT: imported by nothing
 * outside runtime/plans in this slice (no host wiring).
 *
 *   open(sessionId, principal, plan)  refuses when the plan's monthly (or daily) sim minutes are used up
 *   heartbeat(sessionId)              the session is alive at now
 *   close(sessionId, reason)          bills  min(now, lastBeat + leaseMs) - openedAt  (R3.3: a crashed host
 *                                     never bills time after its last heartbeat + lease). Idempotent.
 *
 * Same discipline as PlansEngine: one serial mutex, journal events are built first and appended, and only
 * then applied. A journal problem refuses with system_unavailable and changes nothing. A failed append
 * sets the meter's problem state ('append failed'): the meter fails closed until it is reopened
 * (SimMeter.open replays the journal), because a failed append may have written part of the events.
 * Events are explicit facts (leaseMs, billed ms split per Jerusalem day are inside them), so replay needs
 * no config and no clock. Principals are opaque ids; no e-mail, token or other content is stored.
 * metering.enabled=false: every call answers { metered: false } and writes nothing.
 *
 * Allowance: heartbeat answers the ms left (remainingMs); when it is 0 the meter closes the session with
 * reason 'cap' (billed up to that heartbeat, which is the real run time) and refuses with minutes_out /
 * minutes_out_free / sim_daily. The host must stop the run then, and should stop it when remainingMs
 * elapses; the overrun past the allowance is at most one heartbeat interval (or the lease after a crash).
 * At most sim.maxConcurrentPerPrincipal live sessions per principal (sim_concurrent).
 *
 * Keys: session ids and day keys are used as object keys, so every map is a null-prototype object
 * (also after cloning and replay), ids are validated (SESSION_ID, never __proto__/constructor/prototype)
 * and lookups use Object.hasOwn.
 */
import type { PlanId, PlansConfig } from './config.js';
import { PLAN_IDS } from './config.js';
import { limitError, validPrincipal, type LimitError } from './limits.js';
import type { Store, StoreProblem } from './store.js';
import { dayKey, formatDate, localParts, monthStart, zonedToMs, type Clock } from './time.js';

export type CloseReason = 'ended' | 'lease' | 'cap' | 'host';
const CLOSE_REASONS: readonly CloseReason[] = ['ended', 'lease', 'cap', 'host'];

export interface DayPart {
  dayKey: string;
  ms: number;
}

export type SimBody =
  | { t: 'sim_open'; sessionId: string; principal: string; plan: PlanId; leaseMs: number }
  | { t: 'sim_beat'; sessionId: string }
  | {
      t: 'sim_close';
      sessionId: string;
      reason: CloseReason;
      endAt: number;
      billedMs: number;
      parts: DayPart[];
    };
export type SimEvent = SimBody & { seq: number; at: number };

export interface SimSession {
  sessionId: string;
  principal: string;
  plan: PlanId;
  leaseMs: number;
  openedAt: number;
  lastBeat: number;
  closedAt?: number;
  closeReason?: CloseReason;
  billedMs?: number;
}

export interface SimState {
  sessions: Record<string, SimSession>;
  /** principal -> dayKey (zone) -> billed ms of closed sessions */
  usage: Record<string, Record<string, number>>;
  seq: number;
}

const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

export const emptySimState = (): SimState => ({ sessions: dict(), usage: dict(), seq: 0 });

const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** A session id the meter accepts: the SESSION_ID pattern and never a prototype key. */
export function validSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID.test(id) && !RESERVED_KEYS.has(id);
}
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const own = <T>(rec: Record<string, T>, k: string): T | undefined =>
  Object.hasOwn(rec, k) ? rec[k] : undefined;

/** Deep copy that keeps the null-prototype maps (structuredClone would give them Object.prototype). */
export function cloneSimState(s: SimState): SimState {
  const out = emptySimState();
  out.seq = s.seq;
  for (const [k, v] of Object.entries(s.sessions)) out.sessions[k] = { ...v };
  for (const [p, days] of Object.entries(s.usage)) {
    const d = dict<number>();
    for (const [k, ms] of Object.entries(days)) d[k] = ms;
    out.usage[p] = d;
  }
  return out;
}

/** Pure reducer. Throws on a sequence gap or an event that does not fit the state (= corrupt journal). */
export function applySimEvent(s: SimState, ev: SimEvent): void {
  if (ev.seq !== s.seq + 1)
    throw new Error(`journal sequence gap: expected ${s.seq + 1}, got ${ev.seq}`);
  if (!validSessionId(ev.sessionId)) throw new Error('invalid session id in event');
  s.seq = ev.seq;
  if (ev.t === 'sim_open') {
    if (!validPrincipal(ev.principal)) throw new Error('invalid principal in event');
    if (own(s.sessions, ev.sessionId)) throw new Error('sim_open for an existing session');
    s.sessions[ev.sessionId] = {
      sessionId: ev.sessionId,
      principal: ev.principal,
      plan: ev.plan,
      leaseMs: ev.leaseMs,
      openedAt: ev.at,
      lastBeat: ev.at,
    };
    return;
  }
  const ss = own(s.sessions, ev.sessionId);
  if (!ss || ss.closedAt !== undefined) throw new Error(`${ev.t} for a session that is not open`);
  if (ev.t === 'sim_beat') {
    ss.lastBeat = Math.max(ss.lastBeat, ev.at);
    return;
  }
  ss.closedAt = ev.endAt;
  ss.closeReason = ev.reason;
  ss.billedMs = ev.billedMs;
  for (const p of ev.parts)
    if (typeof p.dayKey !== 'string' || !DAY_KEY.test(p.dayKey) || !Number.isFinite(p.ms))
      throw new Error('invalid day part in event');
  const u = own(s.usage, ss.principal) ?? (s.usage[ss.principal] = dict<number>());
  for (const p of ev.parts) u[p.dayKey] = (own(u, p.dayKey) ?? 0) + p.ms;
}

/** Split [start, end) at the zone's midnights. The parts sum to exactly end - start. */
export function splitByDay(start: number, end: number, tz: string): DayPart[] {
  const out: DayPart[] = [];
  let t = start;
  while (t < end) {
    const p = localParts(t, tz);
    const next = zonedToMs(tz, p.year, p.month, p.day + 1);
    const stop = Math.min(end, next > t ? next : end);
    out.push({ dayKey: dayKey(t, tz), ms: stop - t });
    t = stop;
  }
  return out;
}

/**
 * Billing end of an open session at `now`: never later than lastBeat + leaseMs, never before open.
 * A non-finite clock or session time throws (the meter answers system_unavailable before it gets here).
 */
export function billEnd(ss: SimSession, now: number): number {
  if (![now, ss.openedAt, ss.lastBeat, ss.leaseMs].every(Number.isFinite))
    throw new RangeError('billEnd: non-finite time');
  return Math.max(ss.openedAt, Math.min(now, ss.lastBeat + ss.leaseMs));
}

export interface SimRemaining {
  /** ms left this calendar month (zone); null = plan has no monthly sim meter */
  monthMs: number | null;
  /** ms left today (zone); null = plan has no daily sim cap */
  dayMs: number | null;
  usedTodayMs: number;
  usedMonthMs: number;
}

export type SimResult<T extends object = object> =
  | ({ ok: true; metered: true; duplicate?: boolean } & T)
  | { ok: true; metered: false }
  | { ok: false; error: LimitError };

export interface SimMeterOptions {
  config: PlansConfig;
  clock: Clock;
}

const unavailable = (): { ok: false; error: LimitError } => ({
  ok: false,
  error: limitError('system_unavailable'),
});
const bad = (
  code: 'invalid_request' | 'invalid_principal' | 'invalid_state' | 'lease_lost' | 'sim_concurrent',
) => ({
  ok: false as const,
  error: limitError(code),
});

export class SimMeter {
  private state: SimState = emptySimState();
  private problem: StoreProblem | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly store: Store<SimEvent>,
    private readonly opts: SimMeterOptions,
  ) {}

  /** Rebuild from the journal; when metering is on, sessions whose lease ran out are closed at lastBeat + lease. */
  static async open(store: Store<SimEvent>, opts: SimMeterOptions): Promise<SimMeter> {
    const m = new SimMeter(store, opts);
    await m.reload();
    if (opts.config.metering.enabled && !m.problem) await m.sweep();
    return m;
  }

  private async reload(): Promise<void> {
    let events: SimEvent[];
    let problem: StoreProblem | undefined;
    try {
      const r = await this.store.load();
      events = r.events;
      problem = r.problem;
    } catch {
      this.problem = { kind: 'corrupt', detail: 'load failed' };
      return;
    }
    const s = emptySimState();
    try {
      for (const ev of events) applySimEvent(s, ev);
    } catch {
      this.problem = { kind: 'corrupt', detail: 'replay failed' };
      return;
    }
    this.state = s;
    this.problem = problem;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => undefined);
    return p;
  }

  /** The clock reading, or null when it is not a finite number (callers answer system_unavailable). */
  private now(): number | null {
    const t = this.opts.clock.now();
    return Number.isFinite(t) ? t : null;
  }

  private get cfg(): PlansConfig {
    return this.opts.config;
  }
  get storeProblem(): StoreProblem | undefined {
    return this.problem;
  }
  session(sessionId: string): SimSession | undefined {
    const s = typeof sessionId === 'string' ? own(this.state.sessions, sessionId) : undefined;
    return s ? structuredClone(s) : undefined;
  }
  stateJson(): string {
    return JSON.stringify(this.state);
  }

  private async commit(bodies: (SimBody & { at: number })[]): Promise<boolean> {
    if (bodies.length === 0) return true;
    const events = bodies.map((b, i) => ({ ...b, seq: this.state.seq + 1 + i }) as SimEvent);
    // apply to a copy first: an event that does not fit is never written
    const next = cloneSimState(this.state);
    try {
      for (const ev of events) applySimEvent(next, ev);
    } catch {
      return false;
    }
    try {
      await this.store.append(events);
    } catch {
      // part of the batch may be on disk: fail closed until the journal is replayed (SimMeter.open)
      this.problem = { kind: 'corrupt', detail: 'append failed' };
      return false;
    }
    this.state = next;
    return true;
  }

  // ---------------------------------------------------------------- reads

  private usedMs(principal: string, now: number): { today: number; month: number } {
    const tz = this.cfg.meter.timezone;
    const dk = dayKey(now, tz);
    const mk = dk.slice(0, 7);
    let today = 0;
    let month = 0;
    const add = (k: string, ms: number): void => {
      if (k === dk) today += ms;
      if (k.slice(0, 7) === mk) month += ms;
    };
    for (const [k, ms] of Object.entries(own(this.state.usage, principal) ?? {})) add(k, ms);
    for (const ss of Object.values(this.state.sessions)) {
      if (ss.principal !== principal || ss.closedAt !== undefined) continue;
      for (const p of splitByDay(ss.openedAt, billEnd(ss, now), tz)) add(p.dayKey, p.ms);
    }
    return { today, month };
  }

  private remainingAt(principal: string, plan: PlanId, now: number): SimRemaining {
    const pc = this.cfg.sim.plans[plan];
    const used = this.usedMs(principal, now);
    const left = (limitMin: number | null, usedMs: number): number | null =>
      limitMin === null ? null : Math.max(0, limitMin * 60_000 - usedMs);
    return {
      monthMs: left(pc.monthlyMinutes, used.month),
      dayMs: left(pc.dailyMinutes, used.today),
      usedTodayMs: used.today,
      usedMonthMs: used.month,
    };
  }

  /** Remaining sim time of a principal on a plan, open sessions included up to their billing end. */
  remaining(principal: string, plan: PlanId): SimResult<SimRemaining> {
    if (!this.cfg.metering.enabled) return { ok: true, metered: false };
    if (!validPrincipal(principal)) return bad('invalid_principal');
    if (!PLAN_IDS.includes(plan)) return bad('invalid_request');
    if (this.problem) return unavailable();
    const now = this.now();
    if (now === null) return unavailable();
    return { ok: true, metered: true, ...this.remainingAt(principal, plan, now) };
  }

  /** Billed sim ms of a principal today (zone); the fair queue's second key. */
  usedTodayMs(principal: string): SimResult<{ ms: number }> {
    if (!this.cfg.metering.enabled) return { ok: true, metered: false };
    if (!validPrincipal(principal)) return bad('invalid_principal');
    if (this.problem) return unavailable();
    const now = this.now();
    if (now === null) return unavailable();
    return { ok: true, metered: true, ms: this.usedMs(principal, now).today };
  }

  // ---------------------------------------------------------------- commands

  /** The refusal for a used-up allowance at `now`, or null while time is left. */
  private exhausted(r: SimRemaining, plan: PlanId, now: number): LimitError | null {
    const tz = this.cfg.meter.timezone;
    if (r.monthMs !== null && r.monthMs <= 0)
      return limitError(plan === 'free' ? 'minutes_out_free' : 'minutes_out', {
        date: formatDate(monthStart(now, tz, 1), tz),
      });
    if (r.dayMs !== null && r.dayMs <= 0) return limitError('sim_daily');
    return null;
  }

  /** Live (open, lease not run out) sessions of a principal at `now`. */
  private liveSessions(principal: string, now: number): number {
    let n = 0;
    for (const ss of Object.values(this.state.sessions))
      if (
        ss.principal === principal &&
        ss.closedAt === undefined &&
        now <= ss.lastBeat + ss.leaseMs
      )
        n++;
    return n;
  }

  open(sessionId: string, principal: string, plan: PlanId): Promise<SimResult<SimRemaining>> {
    return this.run(async () => {
      if (!this.cfg.metering.enabled) return { ok: true, metered: false };
      if (!validPrincipal(principal)) return bad('invalid_principal');
      if (!validSessionId(sessionId)) return bad('invalid_request');
      if (!PLAN_IDS.includes(plan)) return bad('invalid_request');
      if (this.problem) return unavailable();
      const now = this.now();
      if (now === null) return unavailable();
      const existing = own(this.state.sessions, sessionId);
      if (existing) {
        if (existing.principal !== principal) return bad('invalid_request');
        if (existing.closedAt !== undefined) return bad('invalid_state');
        return {
          ok: true,
          metered: true,
          duplicate: true,
          ...this.remainingAt(principal, existing.plan, now),
        };
      }
      const r = this.remainingAt(principal, plan, now);
      const err = this.exhausted(r, plan, now);
      if (err) return { ok: false, error: err };
      if (this.liveSessions(principal, now) >= this.cfg.sim.maxConcurrentPerPrincipal)
        return bad('sim_concurrent');
      const ok = await this.commit([
        { t: 'sim_open', sessionId, principal, plan, leaseMs: this.cfg.sim.leaseMs, at: now },
      ]);
      return ok ? { ok: true, metered: true, duplicate: false, ...r } : unavailable();
    });
  }

  /**
   * Alive at now. Answers the time left (remainingMs = the smaller of month and day, null = no limit).
   * When the allowance is used up the session is closed here with reason 'cap' (billed up to now) and the
   * beat is refused with minutes_out / minutes_out_free / sim_daily: the host must stop the run. A later
   * close() is a duplicate that reports the billed time. After the lease ran out the session is lost
   * (lease_lost): the caller closes it.
   */
  heartbeat(sessionId: string): Promise<SimResult<SimRemaining & { remainingMs: number | null }>> {
    return this.run(async () => {
      if (!this.cfg.metering.enabled) return { ok: true, metered: false };
      if (!validSessionId(sessionId)) return bad('invalid_request');
      if (this.problem) return unavailable();
      const ss = own(this.state.sessions, sessionId);
      if (!ss || ss.closedAt !== undefined) return bad('invalid_state');
      const now = this.now();
      if (now === null) return unavailable();
      if (now > ss.lastBeat + ss.leaseMs) return bad('lease_lost');
      const r = this.remainingAt(ss.principal, ss.plan, now);
      const err = this.exhausted(r, ss.plan, now);
      if (err)
        return (await this.commit([this.closeBody(ss, now, 'cap')]))
          ? { ok: false, error: err }
          : unavailable();
      const left = [r.monthMs, r.dayMs].filter((x): x is number => x !== null);
      const out = { ...r, remainingMs: left.length ? Math.min(...left) : null };
      if (now <= ss.lastBeat) return { ok: true, metered: true, duplicate: true, ...out };
      const ok = await this.commit([{ t: 'sim_beat', sessionId, at: now }]);
      return ok ? { ok: true, metered: true, ...out } : unavailable();
    });
  }

  /** Bill and close. A second close is a no-op that reports the same billed time. */
  close(
    sessionId: string,
    reason: CloseReason = 'ended',
  ): Promise<SimResult<{ billedMs: number }>> {
    return this.run(async () => {
      if (!this.cfg.metering.enabled) return { ok: true, metered: false };
      if (!validSessionId(sessionId)) return bad('invalid_request');
      if (!CLOSE_REASONS.includes(reason)) return bad('invalid_request');
      if (this.problem) return unavailable();
      const ss = own(this.state.sessions, sessionId);
      if (!ss) return bad('invalid_state');
      if (ss.closedAt !== undefined)
        return { ok: true, metered: true, duplicate: true, billedMs: ss.billedMs ?? 0 };
      const now = this.now();
      if (now === null) return unavailable();
      const body = this.closeBody(ss, now, reason);
      return (await this.commit([body]))
        ? { ok: true, metered: true, duplicate: false, billedMs: body.billedMs }
        : unavailable();
    });
  }

  private closeBody(
    ss: SimSession,
    now: number,
    reason: CloseReason,
  ): Extract<SimBody, { t: 'sim_close' }> & { at: number } {
    const endAt = billEnd(ss, now);
    return {
      t: 'sim_close',
      sessionId: ss.sessionId,
      reason,
      endAt,
      billedMs: endAt - ss.openedAt,
      parts: splitByDay(ss.openedAt, endAt, this.cfg.meter.timezone),
      at: now,
    };
  }

  /** Close every open session whose lease ran out (reason 'lease'). Returns how many were closed. */
  sweep(): Promise<SimResult<{ closed: number }>> {
    return this.run(async () => {
      if (!this.cfg.metering.enabled) return { ok: true, metered: false };
      if (this.problem) return unavailable();
      const now = this.now();
      if (now === null) return unavailable();
      const bodies = Object.values(this.state.sessions)
        .filter((ss) => ss.closedAt === undefined && now > ss.lastBeat + ss.leaseMs)
        .map((ss) => this.closeBody(ss, now, 'lease'));
      return (await this.commit(bodies))
        ? { ok: true, metered: true, closed: bodies.length }
        : unavailable();
    });
  }
}
