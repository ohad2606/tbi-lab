/**
 * TBI-018 slice 1: the engine. admit / settle / release / grant / revoke / addPack, owner pause/resume, sweep.
 * Every command runs inside one serial mutex, builds its journal events FIRST from a read-only view,
 * appends them, and only then applies them to the in-memory state. If append throws, the in-memory
 * state is exactly what it was before the call and nothing was consumed (system_unavailable), and the
 * engine refuses every command until the journal is replayed (open / recover).
 * Imported by nothing outside runtime/plans in this slice; metering.enabled=false writes nothing.
 */
import type { Mode, PackType, PlanId, PlansConfig } from './config.js';
import {
  applyEvent,
  applyToAccount,
  emptyState,
  safeKey,
  stateJson,
  type Account,
  type EventBody,
  type PendingEvent,
  type PlanEvent,
  type PlansState,
  type Reservation,
} from './events.js';
import { closePeriod, consume, type Part } from './ledger.js';
import { limitError, validPrincipal, type LimitError } from './limits.js';
import {
  effectivePlan,
  periodFor,
  renewDate,
  winningEntitlement,
  type Entitlement,
} from './plans.js';
import {
  applySpend,
  evaluate,
  reserveCheck,
  rollSpend,
  type AlertSink,
  type SpendDelta,
  type SpendState,
} from './spend.js';
import type { LoadResult, Store, StoreProblem } from './store.js';
import { dayKey, monthKey, type Clock } from './time.js';

export interface AdmitRequest {
  reqId: string;
  principal: string;
  mode: Mode;
  inputTokens: number;
}

export type AdmitResult =
  | { ok: true; metered: false }
  | { ok: true; metered: true; duplicate: boolean; reservation: Reservation }
  | { ok: false; error: LimitError };

export type CommandResult =
  { ok: true; duplicate?: boolean; noop?: boolean } | { ok: false; error: LimitError };

const DAY_MS = 86_400_000;
const REQ_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const unavailable = (): { ok: false; error: LimitError } => ({
  ok: false,
  error: limitError('system_unavailable'),
});

export interface EngineOptions {
  config: PlansConfig;
  clock: Clock;
  alerts?: AlertSink;
}

export class PlansEngine {
  private state: PlansState = emptyState();
  private problem: StoreProblem | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly store: Store,
    private readonly opts: EngineOptions,
  ) {}

  /** Rebuild from the journal. A torn tail or corruption leaves the engine refusing with system_unavailable. */
  static async open(store: Store, opts: EngineOptions): Promise<PlansEngine> {
    const e = new PlansEngine(store, opts);
    await e.reload();
    if (opts.config.metering.enabled && !e.problem) await e.sweep();
    return e;
  }

  private async reload(): Promise<void> {
    let loaded: LoadResult;
    try {
      loaded = await this.store.load();
    } catch (err) {
      this.problem = {
        kind: 'corrupt',
        detail: err instanceof Error ? err.message : 'load failed',
      };
      return;
    }
    const s = emptyState();
    try {
      for (const ev of loaded.events) applyEvent(s, ev);
    } catch (err) {
      this.problem = {
        kind: 'corrupt',
        detail: err instanceof Error ? err.message : 'replay failed',
      };
      return;
    }
    this.state = s;
    this.problem = loaded.problem;
  }

  /** Explicit recovery of a torn tail (drops the partial last record), then reloads. */
  async recover(): Promise<{ ok: boolean; problem?: StoreProblem }> {
    return this.run(async () => {
      if (this.problem?.kind === 'torn_tail' && this.store.recoverTornTail)
        await this.store.recoverTornTail();
      await this.reload();
      return this.problem ? { ok: false, problem: this.problem } : { ok: true };
    });
  }

  /** The clock reading as journal time (non-negative safe integer ms), or null: callers fail closed. */
  private now(): number | null {
    const t = this.opts.clock.now();
    return Number.isSafeInteger(t) && t >= 0 ? t : null;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => undefined);
    return p;
  }

  // ---------------------------------------------------------------- read-only views

  get cfg(): PlansConfig {
    return this.opts.config;
  }
  get storeProblem(): StoreProblem | undefined {
    return this.problem;
  }
  spendState(): SpendState {
    return structuredClone(this.state.spend);
  }
  account(principal: string): Account | undefined {
    const a = this.state.accounts[principal];
    return a ? structuredClone(a) : undefined;
  }
  reservation(reqId: string): Reservation | undefined {
    const r = Object.hasOwn(this.state.reservations, reqId)
      ? this.state.reservations[reqId]
      : undefined;
    return r ? structuredClone(r) : undefined;
  }
  /** Credits in all buckets (raw, including time-expired ones not yet purged) and the conservation terms. */
  conservation(principal: string): {
    balance: number;
    reserved: number;
    consumed: number;
    expired: number;
    granted: number;
  } {
    const a = this.state.accounts[principal];
    if (!a) return { balance: 0, reserved: 0, consumed: 0, expired: 0, granted: 0 };
    const balance =
      a.allowance + (a.rollover?.credits ?? 0) + a.packs.reduce((n, p) => n + p.credits, 0);
    return {
      balance,
      reserved: a.reserved,
      consumed: a.consumed,
      expired: a.expired,
      granted: a.granted,
    };
  }
  principals(): string[] {
    return Object.keys(this.state.accounts);
  }
  stateJson(): string {
    return stateJson(this.state);
  }

  // ---------------------------------------------------------------- commit

  private async commit(pending: PendingEvent[]): Promise<boolean> {
    if (pending.length === 0) return true;
    const events = pending.map((p, i) => ({ ...p, seq: this.state.seq + 1 + i }) as PlanEvent);
    // Replay validation BEFORE writing: an event the next replay would reject (a bad number, a
    // duplicate id) is never written (system_unavailable, nothing consumed, state unchanged).
    const next = structuredClone(this.state);
    try {
      for (const ev of events) applyEvent(next, structuredClone(ev));
    } catch {
      return false;
    }
    try {
      await this.store.append(events);
    } catch {
      // Part of the batch may be on disk; the next append would reuse its sequence numbers. Fail
      // closed until the journal is replayed (open / recover), as SimMeter does (s3b follow-up).
      this.problem = { kind: 'corrupt', detail: 'append failed' };
      return false;
    }
    this.state = next;
    this.dispatchAlerts(events);
    return true;
  }

  private dispatchAlerts(events: PlanEvent[]): void {
    const sink = this.opts.alerts;
    if (!sink) return;
    for (const ev of events) {
      const d = 'spend' in ev ? ev.spend : undefined;
      if (!d || !('alerts' in d)) continue;
      for (const code of d.alerts) {
        try {
          const r = sink.alert({
            code,
            at: ev.at,
            dayMicro: this.state.spend.dayMicro,
            monthMicro: this.state.spend.monthMicro,
            dayStopMicro: this.opts.config.spend.dayStopMicro,
            monthStopMicro: this.opts.config.spend.monthStopMicro,
          });
          if (r instanceof Promise) r.catch(() => undefined);
        } catch {
          // an alert channel failure must never break metering
        }
      }
    }
  }

  // ---------------------------------------------------------------- account transitions

  /** The account event needed so the account matches the effective plan and period at `now`, or null. */
  private transition(
    acc: Account | undefined,
    ents: Entitlement[],
    now: number,
  ): Extract<EventBody, { t: 'account' }> | null {
    const cfg = this.cfg;
    const ent = winningEntitlement(ents, now);
    const plan: PlanId = ent?.plan ?? 'free';
    const period = periodFor(plan, ent, now, cfg);
    const monthly = cfg.plans[plan].monthlyCredits ?? 0;
    const base = {
      t: 'account' as const,
      principal: acc?.principal ?? '',
      plan,
      periodStart: period.start,
      periodEnd: period.end,
    };
    if (!acc) return { ...base, allowance: monthly, rollover: null, granted: monthly, expired: 0 };
    if (acc.plan === plan && acc.periodEnd === period.end && acc.periodStart === period.start)
      return null;
    const live = acc.rollover && acc.rollover.expiresAt > now ? acc.rollover : null;
    const deadRollover = (acc.rollover?.credits ?? 0) - (live?.credits ?? 0);
    if (acc.plan === plan) {
      const c = closePeriod({ allowance: acc.allowance, rollover: live }, plan, period, cfg);
      return {
        ...base,
        principal: acc.principal,
        allowance: c.allowance,
        rollover: c.rollover,
        granted: c.grantedCredits,
        expired: c.expiredCredits + deadRollover,
      };
    }
    const keepRollover = cfg.plans[plan].rolloverMonths > 0 ? live : null;
    const dropped = deadRollover + (live && !keepRollover ? live.credits : 0);
    if (plan === 'free') {
      const allowance = Math.min(acc.allowance, monthly);
      return {
        ...base,
        principal: acc.principal,
        allowance,
        rollover: keepRollover,
        granted: 0,
        expired: acc.allowance - allowance + dropped,
      };
    }
    return {
      ...base,
      principal: acc.principal,
      allowance: monthly,
      rollover: keepRollover,
      granted: monthly,
      expired: acc.allowance + dropped,
    };
  }

  /** Events that bring one principal's account up to date, plus the resulting account view. */
  private ensure(principal: string, now: number): { events: PendingEvent[]; acc: Account } {
    const cur = this.state.accounts[principal];
    const ev = this.transition(cur, cur?.entitlements ?? [], now);
    if (!ev) return { events: [], acc: cur as Account };
    const full: PendingEvent = { ...ev, principal, at: now };
    return { events: [full], acc: applyToAccount(cur, full) as Account };
  }

  private rolled(now: number): { spend: SpendState; events: PendingEvent[] } {
    const tz = this.cfg.meter.timezone;
    const r = rollSpend(this.state.spend, dayKey(now, tz), monthKey(now, tz), this.cfg);
    return { spend: r.spend, events: r.delta ? [{ t: 'spend', spend: r.delta, at: now }] : [] };
  }

  // ---------------------------------------------------------------- admit

  admit(req: AdmitRequest): Promise<AdmitResult> {
    return this.run(() => this.admitLocked(req));
  }

  private async admitLocked(req: AdmitRequest): Promise<AdmitResult> {
    const cfg = this.cfg;
    if (!cfg.metering.enabled) return { ok: true, metered: false };
    if (!validPrincipal(req.principal))
      return { ok: false, error: limitError('invalid_principal') };
    if (typeof req.reqId !== 'string' || !REQ_ID.test(req.reqId) || !safeKey(req.reqId))
      return { ok: false, error: limitError('invalid_request') };
    if (
      (req.mode !== 'standard' && req.mode !== 'deep') ||
      !Number.isSafeInteger(req.inputTokens) ||
      req.inputTokens < 0
    )
      return { ok: false, error: limitError('invalid_request') };
    if (this.problem) return unavailable();
    const existing = Object.hasOwn(this.state.reservations, req.reqId)
      ? this.state.reservations[req.reqId]
      : undefined;
    if (existing) {
      if (existing.principal !== req.principal)
        return { ok: false, error: limitError('invalid_request') };
      // a finished reservation must not be re-admitted as if it were live (the caller would run unmetered)
      if (existing.state !== 'open') return { ok: false, error: limitError('invalid_state') };
      return { ok: true, metered: true, duplicate: true, reservation: structuredClone(existing) };
    }
    const now = this.now();
    if (now === null) return unavailable();
    const pre: PendingEvent[] = [];
    // Writes that happen even when the request is refused: period/day roll-overs and a cap trip.
    const refuse = async (error: LimitError): Promise<AdmitResult> =>
      (await this.commit(pre)) ? { ok: false, error } : unavailable();

    const { spend, events: rollEvents } = this.rolled(now);
    pre.push(...rollEvents);
    if (spend.state !== 'on') return refuse(limitError('global_off'));
    if (req.inputTokens > cfg.ai.maxInputTokens) return refuse(limitError('too_long'));

    const { events: accEvents, acc } = this.ensure(req.principal, now);
    pre.push(...accEvents);
    const plan = acc.plan;
    const pc = cfg.plans[plan];
    if (req.mode === 'deep' && !pc.deepAllowed) return refuse(limitError('deep_not_in_plan'));

    const recent = acc.admits.filter((t) => t > now - 60_000);
    if (recent.length >= pc.perMinute) {
      const oldest = Math.min(...recent);
      return refuse(limitError('rate', { n: Math.ceil((oldest + 60_000 - now) / 1000) }));
    }

    const cost = cfg.credits[req.mode];
    const dk = dayKey(now, cfg.meter.timezone);
    if ((acc.daily[dk] ?? 0) + cost > pc.dailyCredits) return refuse(limitError('daily'));

    const c = consume(acc, cost, now, plan, cfg);
    if (!c.ok) return refuse(limitError(c.code, { date: renewDate(acc.entitlements, now, cfg) }));

    const worst = cfg.spend.worstMicro[req.mode];
    const check = reserveCheck(spend, worst, cfg);
    if (!check.ok) {
      const code = check.stop === 'monthly_cap' ? 'month_100' : 'day_100';
      pre.push({
        t: 'spend',
        at: now,
        spend: {
          k: 'trip',
          stop: check.stop,
          alerts: spend.alertsFired.includes(code) ? [] : [code],
        },
      });
      return refuse(limitError('global_off'));
    }

    const body: PendingEvent = {
      t: 'reserve',
      at: now,
      principal: req.principal,
      reqId: req.reqId,
      mode: req.mode,
      credits: cost,
      usdMicro: worst,
      plan,
      ttlAt: now + cfg.reservation.ttlMs,
      parts: c.parts,
      periodSeq: acc.periodSeq,
      dayKey: dk,
    };
    pre.push(body);
    if (!(await this.commit(pre))) return unavailable();
    return {
      ok: true,
      metered: true,
      duplicate: false,
      reservation: structuredClone(this.state.reservations[req.reqId] as Reservation),
    };
  }

  // ---------------------------------------------------------------- settle / release / sweep

  /** Replace the worst case by the real spend. Second settle is a no-op. */
  settle(reqId: string, actualMicro: number): Promise<CommandResult> {
    return this.run(async () => {
      if (!this.cfg.metering.enabled) return { ok: true, noop: true };
      if (!Number.isSafeInteger(actualMicro) || actualMicro < 0)
        return { ok: false, error: limitError('invalid_request') };
      if (this.problem) return unavailable();
      const r = Object.hasOwn(this.state.reservations, reqId)
        ? this.state.reservations[reqId]
        : undefined;
      if (!r) return { ok: false, error: limitError('invalid_state') };
      if (r.state === 'settled') return { ok: true, noop: true };
      if (r.state === 'released') return { ok: false, error: limitError('invalid_state') };
      const now = this.now();
      if (now === null) return unavailable();
      const { spend, events } = this.rolled(now);
      events.push(this.spendEvent(r, 'settle', spend, actualMicro, now));
      return (await this.commit(events)) ? { ok: true } : unavailable();
    });
  }

  /** Provider failed (or the reservation timed out): credits return to the buckets they came from. */
  release(reqId: string, reason: 'failed' | 'ttl' = 'failed'): Promise<CommandResult> {
    return this.run(async () => {
      if (!this.cfg.metering.enabled) return { ok: true, noop: true };
      if (this.problem) return unavailable();
      const r = Object.hasOwn(this.state.reservations, reqId)
        ? this.state.reservations[reqId]
        : undefined;
      if (!r) return { ok: false, error: limitError('invalid_state') };
      if (r.state === 'released') return { ok: true, noop: true };
      if (r.state === 'settled') return { ok: false, error: limitError('invalid_state') };
      const now = this.now();
      if (now === null) return unavailable();
      const { spend, events } = this.rolled(now);
      events.push(this.spendEvent(r, reason, spend, 0, now));
      return (await this.commit(events)) ? { ok: true } : unavailable();
    });
  }

  /** Build the settle or release event for an open reservation against a (rolled) spend view. */
  private spendEvent(
    r: Reservation,
    kind: 'settle' | 'failed' | 'ttl',
    spendView: SpendState,
    actualMicro: number,
    now: number,
  ): PendingEvent {
    const counted =
      kind === 'settle'
        ? actualMicro
        : this.cfg.spend.failedCallCounts === 'worstCase'
          ? r.usdMicro
          : 0;
    const probe: SpendDelta =
      kind === 'settle'
        ? { k: 'settle', reservedMicro: r.usdMicro, actualMicro, alerts: [] }
        : { k: 'release', reservedMicro: r.usdMicro, countedMicro: counted, alerts: [] };
    const after = applySpend(spendView, probe);
    const ev = evaluate(after, this.cfg);
    const delta = {
      ...probe,
      alerts: ev.alerts,
      ...(ev.stop ? { stop: ev.stop } : {}),
    } as SpendDelta;
    const deducted = r.parts.reduce((n, p) => n + p.credits, 0);
    if (kind === 'settle')
      return {
        t: 'settle',
        at: now,
        principal: r.principal,
        reqId: r.reqId,
        deducted,
        spend: delta,
      };
    return {
      t: 'release',
      at: now,
      principal: r.principal,
      reqId: r.reqId,
      reason: kind,
      credits: r.credits,
      parts: r.parts as Part[],
      periodSeq: r.periodSeq,
      dayKey: r.dayKey,
      spend: delta,
    };
  }

  /** Auto-release reservations past their ttl (a crashed caller). Counted like a failed call. */
  sweep(): Promise<number> {
    return this.run(async () => {
      if (!this.cfg.metering.enabled || this.problem) return 0;
      const now = this.now();
      if (now === null) return 0;
      const open = Object.values(this.state.reservations).filter(
        (r) => r.state === 'open' && r.ttlAt <= now,
      );
      if (open.length === 0) return 0;
      const { events } = this.rolled(now);
      // spend views must chain across several releases in one append
      let view = this.rolled(now).spend;
      for (const r of open) {
        const ev = this.spendEvent(r, 'ttl', view, 0, now);
        if (ev.t === 'release') view = applySpend(view, ev.spend);
        events.push(ev);
      }
      return (await this.commit(events)) ? open.length : 0;
    });
  }

  // ---------------------------------------------------------------- entitlements, packs

  grant(
    principal: string,
    plan: Exclude<PlanId, 'free'>,
    period: { start: number; end: number },
    ref: string,
  ): Promise<CommandResult> {
    return this.run(async () => {
      if (!validPrincipal(principal)) return { ok: false, error: limitError('invalid_principal') };
      const count = (n: unknown): boolean => Number.isSafeInteger(n) && (n as number) >= 0;
      if (
        !safeKey(ref) ||
        !period ||
        !count(period.start) ||
        !count(period.end) ||
        (plan !== 'legacy' && !(period.end > period.start)) ||
        !(plan in this.cfg.plans) ||
        plan === ('free' as PlanId)
      )
        return { ok: false, error: limitError('invalid_request') };
      if (this.problem) return unavailable();
      if (Object.hasOwn(this.state.refs, ref)) return { ok: true, duplicate: true };
      const now = this.now();
      if (now === null) return unavailable();
      const { events: pre, acc } = this.ensure(principal, now);
      const grant: PendingEvent = {
        t: 'grant',
        at: now,
        principal,
        plan,
        periodStart: period.start,
        periodEnd: period.end,
        ref,
      };
      const withGrant = applyToAccount(acc, grant) as Account;
      const tr = this.transition(withGrant, withGrant.entitlements, now);
      const events = [
        ...pre,
        grant,
        ...(tr ? [{ ...tr, principal, at: now } as PendingEvent] : []),
      ];
      return (await this.commit(events)) ? { ok: true } : unavailable();
    });
  }

  /** Revoke every active entitlement: effective plan becomes free; allowance drops to free's; packs kept, not consumable. */
  revoke(principal: string): Promise<CommandResult> {
    return this.run(async () => {
      if (!validPrincipal(principal)) return { ok: false, error: limitError('invalid_principal') };
      if (this.problem) return unavailable();
      const now = this.now();
      if (now === null) return unavailable();
      const { events: pre, acc } = this.ensure(principal, now);
      if (!acc.entitlements.some((e) => e.status === 'active')) return { ok: true, noop: true };
      const rev: PendingEvent = { t: 'revoke', at: now, principal };
      const after = applyToAccount(acc, rev) as Account;
      const tr = this.transition(after, after.entitlements, now);
      const events = [...pre, rev, ...(tr ? [{ ...tr, principal, at: now } as PendingEvent] : [])];
      return (await this.commit(events)) ? { ok: true } : unavailable();
    });
  }

  addPack(principal: string, type: PackType, ref: string): Promise<CommandResult> {
    return this.run(async () => {
      if (!validPrincipal(principal)) return { ok: false, error: limitError('invalid_principal') };
      if (!safeKey(ref) || !Object.hasOwn(this.cfg.packs, type) || type === ('refund' as PackType))
        return { ok: false, error: limitError('invalid_request') };
      if (this.problem) return unavailable();
      if (Object.hasOwn(this.state.refs, ref)) return { ok: true, duplicate: true };
      const now = this.now();
      if (now === null) return unavailable();
      const { events: pre, acc } = this.ensure(principal, now);
      const plan = effectivePlan(acc.entitlements, now);
      if (plan !== 'advanced' && plan !== 'pro') {
        if (pre.length > 0 && !(await this.commit(pre))) return unavailable();
        return { ok: false, error: limitError('pack_needs_plan') };
      }
      const pk = this.cfg.packs[type];
      const events: PendingEvent[] = [
        ...pre,
        {
          t: 'pack',
          at: now,
          principal,
          ref,
          pack: {
            id: `pk_${this.state.seq + pre.length + 1}`,
            type,
            credits: pk.credits,
            boughtAt: now,
            expiresAt: now + pk.validityDays * DAY_MS,
          },
        },
      ];
      return (await this.commit(events)) ? { ok: true } : unavailable();
    });
  }

  // ---------------------------------------------------------------- owner controls

  /** Owner turns the AI back on; `extraDayMicro` adds headroom to today's cap. With none, the next request trips again. */
  ownerResume(opts: { extraDayMicro?: number } = {}): Promise<CommandResult> {
    const extra = opts.extraDayMicro ?? 0;
    if (!Number.isSafeInteger(extra) || extra < 0)
      return Promise.resolve({ ok: false, error: limitError('invalid_request') });
    return this.ownerSpend({ k: 'resume', extraDayMicro: extra });
  }
  /** Owner pauses the AI for everyone (Free and paid alike). */
  ownerPause(): Promise<CommandResult> {
    return this.ownerSpend({ k: 'pause' });
  }
  /** Test seam: journaled patch of the spend counters (e.g. preload monthMicro). Never used by production code. */
  testSeedSpend(patch: Partial<SpendState>): Promise<CommandResult> {
    return this.ownerSpend({ k: 'seed', patch });
  }

  private ownerSpend(delta: SpendDelta): Promise<CommandResult> {
    return this.run(async () => {
      if (this.problem) return unavailable();
      const now = this.now();
      if (now === null) return unavailable();
      const { events } = this.rolled(now);
      events.push({ t: 'spend', spend: delta, at: now });
      return (await this.commit(events)) ? { ok: true } : unavailable();
    });
  }
}
