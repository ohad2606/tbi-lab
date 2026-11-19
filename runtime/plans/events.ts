/**
 * TBI-018 slice 1: journal events and the deterministic reducer. Events are explicit FACTS (every number
 * is in the event), so replay needs no config and no clock: live state == replayed state.
 * No e-mail, prompt, reply or token text appears in any event.
 */
import type { Mode, PackType, PlanId } from './config.js';
import type { Entitlement } from './plans.js';
import type { Part, PackBucket, RolloverBucket } from './ledger.js';
import { applySpend, initialSpend, type SpendDelta, type SpendState } from './spend.js';

export interface PackRecord extends PackBucket {
  type: PackType;
  /** credits when bought */
  total: number;
  boughtAt: number;
}

export interface Account {
  principal: string;
  plan: PlanId;
  /** increments with every period change; reservations remember theirs */
  periodSeq: number;
  periodStart: number;
  periodEnd: number;
  allowance: number;
  rollover: RolloverBucket | null;
  packs: PackRecord[];
  granted: number;
  consumed: number;
  reserved: number;
  expired: number;
  entitlements: Entitlement[];
  /** dayKey -> credits reserved or settled that day, minus released (only the latest day is kept) */
  daily: Record<string, number>;
  /** ms of admitted requests in the trailing minute */
  admits: number[];
}

export interface Reservation {
  reqId: string;
  principal: string;
  mode: Mode;
  /** credits of the request (counts for the daily limit even when unmetered) */
  credits: number;
  usdMicro: number;
  plan: PlanId;
  createdAt: number;
  ttlAt: number;
  state: 'open' | 'settled' | 'released';
  parts: Part[];
  periodSeq: number;
  dayKey: string;
}

export interface PlansState {
  accounts: Record<string, Account>;
  reservations: Record<string, Reservation>;
  /** idempotency refs of grants and packs */
  refs: Record<string, true>;
  spend: SpendState;
  seq: number;
}

export function emptyState(): PlansState {
  return { accounts: {}, reservations: {}, refs: {}, spend: initialSpend(), seq: 0 };
}

export type EventBody =
  | {
      t: 'account';
      principal: string;
      plan: PlanId;
      periodStart: number;
      periodEnd: number;
      allowance: number;
      rollover: RolloverBucket | null;
      granted: number;
      expired: number;
    }
  | {
      t: 'grant';
      principal: string;
      plan: PlanId;
      periodStart: number;
      periodEnd: number;
      ref: string;
    }
  | { t: 'revoke'; principal: string }
  | {
      t: 'pack';
      principal: string;
      ref: string;
      pack: { id: string; type: PackType; credits: number; boughtAt: number; expiresAt: number };
    }
  | {
      t: 'reserve';
      principal: string;
      reqId: string;
      mode: Mode;
      credits: number;
      usdMicro: number;
      plan: PlanId;
      ttlAt: number;
      parts: Part[];
      periodSeq: number;
      dayKey: string;
    }
  | { t: 'settle'; principal: string; reqId: string; deducted: number; spend: SpendDelta }
  | {
      t: 'release';
      principal: string;
      reqId: string;
      reason: 'failed' | 'ttl';
      credits: number;
      parts: Part[];
      periodSeq: number;
      dayKey: string;
      spend: SpendDelta;
    }
  | { t: 'spend'; spend: SpendDelta };

export type PlanEvent = EventBody & { seq: number; at: number };
export type PendingEvent = EventBody & { at: number; seq?: number };

const sum = (parts: Part[]): number => parts.reduce((a, p) => a + p.credits, 0);

/** Pure: the account after an event (or the new account). Events that are not about accounts return it unchanged. */
export function applyToAccount(prev: Account | undefined, ev: PendingEvent): Account | undefined {
  if (ev.t === 'spend') return prev;
  if (ev.t === 'account') {
    const a: Account = prev
      ? { ...prev, packs: prev.packs.map((p) => ({ ...p })), entitlements: [...prev.entitlements] }
      : {
          principal: ev.principal,
          plan: ev.plan,
          periodSeq: 0,
          periodStart: 0,
          periodEnd: 0,
          allowance: 0,
          rollover: null,
          packs: [],
          granted: 0,
          consumed: 0,
          reserved: 0,
          expired: 0,
          entitlements: [],
          daily: {},
          admits: [],
        };
    a.plan = ev.plan;
    a.periodSeq += 1;
    a.periodStart = ev.periodStart;
    a.periodEnd = ev.periodEnd;
    a.allowance = ev.allowance;
    a.rollover = ev.rollover ? { ...ev.rollover } : null;
    a.granted += ev.granted;
    a.expired += ev.expired;
    return a;
  }
  if (!prev) throw new Error(`event ${ev.t} for unknown account`);
  const a: Account = {
    ...prev,
    packs: prev.packs.map((p) => ({ ...p })),
    entitlements: prev.entitlements.map((e) => ({ ...e })),
    daily: { ...prev.daily },
    admits: [...prev.admits],
    rollover: prev.rollover ? { ...prev.rollover } : null,
  };
  switch (ev.t) {
    case 'grant':
      a.entitlements.push({
        principal: ev.principal,
        plan: ev.plan,
        periodStart: ev.periodStart,
        periodEnd: ev.periodEnd,
        status: 'active',
        grantRefs: [ev.ref],
        ...(ev.seq === undefined ? {} : { seq: ev.seq }),
      });
      return a;
    case 'revoke':
      for (const e of a.entitlements) if (e.status === 'active') e.status = 'revoked';
      return a;
    case 'pack':
      a.packs.push({
        id: ev.pack.id,
        type: ev.pack.type,
        total: ev.pack.credits,
        credits: ev.pack.credits,
        boughtAt: ev.pack.boughtAt,
        expiresAt: ev.pack.expiresAt,
      });
      a.granted += ev.pack.credits;
      return a;
    case 'reserve': {
      for (const p of ev.parts) {
        if (p.bucket === 'allowance') a.allowance -= p.credits;
        else if (p.bucket === 'rollover' && a.rollover) {
          a.rollover.credits -= p.credits;
          if (a.rollover.credits === 0) a.rollover = null;
        } else if (p.bucket === 'pack') {
          const pk = a.packs.find((x) => x.id === p.packId);
          if (pk) pk.credits -= p.credits;
        }
      }
      a.reserved += sum(ev.parts);
      a.daily = { [ev.dayKey]: (prev.daily[ev.dayKey] ?? 0) + ev.credits };
      a.admits = [...a.admits.filter((t) => t > ev.at - 60_000), ev.at];
      return a;
    }
    case 'settle':
      a.reserved -= ev.deducted;
      a.consumed += ev.deducted;
      return a;
    case 'release': {
      for (const p of ev.parts) {
        if (p.bucket === 'allowance') {
          if (a.periodSeq === ev.periodSeq) a.allowance += p.credits;
          else a.expired += p.credits;
        } else if (p.bucket === 'rollover') {
          if (a.rollover && a.rollover.expiresAt === p.expiresAt) a.rollover.credits += p.credits;
          else if (!a.rollover && p.expiresAt > ev.at) {
            // the reserve drained the bucket fully (set to null): same bucket, still live
            a.rollover = { credits: p.credits, expiresAt: p.expiresAt };
          } else a.expired += p.credits;
        } else {
          const pk = a.packs.find((x) => x.id === p.packId);
          if (pk) pk.credits += p.credits;
          else a.expired += p.credits;
        }
      }
      a.reserved -= sum(ev.parts);
      if (ev.dayKey in a.daily)
        a.daily[ev.dayKey] = Math.max(0, (a.daily[ev.dayKey] ?? 0) - ev.credits);
      return a;
    }
  }
}

export function applyEvent(s: PlansState, ev: PlanEvent): void {
  if (ev.seq !== s.seq + 1)
    throw new Error(`journal sequence gap: expected ${s.seq + 1}, got ${ev.seq}`);
  s.seq = ev.seq;
  if (ev.t === 'spend') {
    s.spend = applySpend(s.spend, ev.spend);
    return;
  }
  const acc = applyToAccount(s.accounts[ev.principal], ev);
  if (acc) s.accounts[ev.principal] = acc;
  switch (ev.t) {
    case 'grant':
      s.refs[ev.ref] = true;
      break;
    case 'pack':
      s.refs[ev.ref] = true;
      break;
    case 'reserve':
      s.reservations[ev.reqId] = {
        reqId: ev.reqId,
        principal: ev.principal,
        mode: ev.mode,
        credits: ev.credits,
        usdMicro: ev.usdMicro,
        plan: ev.plan,
        createdAt: ev.at,
        ttlAt: ev.ttlAt,
        state: 'open',
        parts: ev.parts,
        periodSeq: ev.periodSeq,
        dayKey: ev.dayKey,
      };
      s.spend = applySpend(s.spend, { k: 'reserve', micro: ev.usdMicro });
      break;
    case 'settle': {
      const r = s.reservations[ev.reqId];
      if (r) r.state = 'settled';
      s.spend = applySpend(s.spend, ev.spend);
      break;
    }
    case 'release': {
      const r = s.reservations[ev.reqId];
      if (r) r.state = 'released';
      s.spend = applySpend(s.spend, ev.spend);
      break;
    }
    default:
      break;
  }
}

/** Deterministic JSON of the state (sorted keys) for equality checks and privacy scans. */
export function stateJson(s: PlansState): string {
  const sort = (_k: string, v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v;
  return JSON.stringify(s, sort);
}
