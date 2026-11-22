/**
 * TBI-018 slice 1: journal events and the deterministic reducer. Events are explicit FACTS (every number
 * is in the event), so replay needs no config and no clock: live state == replayed state.
 * No e-mail, prompt, reply or token text appears in any event.
 */
import { PLAN_IDS, type Mode, type PackType, type PlanId } from './config.js';
import { validPrincipal } from './limits.js';
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

// ---------------------------------------------------------------- replay validation
// Every number in an event is a count (credits, micro-USD, ms, sequence): a non-negative safe integer.
// NaN, Infinity, negatives, fractions and unsafe integers are a corrupt journal, never coerced. Ids used
// as object keys must not be prototype keys. Events must fit the state (no second reserve for an id, no
// settle/release of a reservation that is not open, no second use of a grant/pack ref), so a replayed
// duplicate can never charge or grant twice.

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** An id that may be used as an object key in the state. */
export const safeKey = (k: unknown): k is string =>
  typeof k === 'string' && k.length > 0 && k.length <= 128 && !RESERVED_KEYS.has(k);
const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;

function need(ok: boolean, what: string): asserts ok {
  if (!ok) throw new Error(`invalid ${what} in event`);
}

function checkParts(parts: unknown): number {
  need(Array.isArray(parts), 'parts');
  let total = 0;
  for (const raw of parts as unknown[]) {
    const p = raw as Partial<Part> & Record<string, unknown>;
    need(typeof p === 'object' && p !== null, 'part');
    need(count(p.credits), 'part credits');
    if (p.bucket === 'rollover') need(count(p.expiresAt), 'part expiry');
    else if (p.bucket === 'pack') need(count(p.expiresAt) && safeKey(p.packId), 'pack part');
    else need(p.bucket === 'allowance', 'part bucket');
    total += p.credits as number;
  }
  need(Number.isSafeInteger(total), 'parts total');
  return total;
}

function checkSpend(d: unknown): void {
  const x = d as Record<string, unknown> | null;
  need(typeof x === 'object' && x !== null, 'spend');
  const alerts = (): void =>
    need(Array.isArray(x.alerts) && x.alerts.every((a) => typeof a === 'string'), 'alerts');
  const stop = (): void =>
    need(
      x.stop === undefined ||
        x.stop === 'daily_cap' ||
        x.stop === 'monthly_cap' ||
        x.stop === 'auto_trigger',
      'stop reason',
    );
  switch (x.k) {
    case 'roll':
      need(typeof x.dayKey === 'string' && DAY_KEY.test(x.dayKey), 'roll day');
      need(typeof x.monthKey === 'string' && MONTH_KEY.test(x.monthKey), 'roll month');
      need(typeof x.clearState === 'boolean', 'roll flag');
      return;
    case 'reserve':
      need(count(x.micro), 'spend micro');
      return;
    case 'settle':
      need(count(x.reservedMicro) && count(x.actualMicro), 'settle micro');
      stop();
      alerts();
      return;
    case 'release':
      need(count(x.reservedMicro) && count(x.countedMicro), 'release micro');
      stop();
      alerts();
      return;
    case 'trip':
      need(x.stop !== undefined, 'trip stop');
      stop();
      alerts();
      return;
    case 'resume':
      need(count(x.extraDayMicro), 'resume micro');
      return;
    case 'pause':
      return;
    case 'seed': {
      const patch = x.patch as Record<string, unknown> | null;
      need(typeof patch === 'object' && patch !== null, 'seed patch');
      for (const k of ['dayMicro', 'monthMicro', 'reservedMicro', 'dayExtraMicro'])
        if (k in patch) need(count(patch[k]), `seed ${k}`);
      return;
    }
    default:
      need(false, 'spend kind');
  }
}

/** Throws when `ev` has a bad number or does not fit `s` (a corrupt journal; replay stops). */
export function checkEvent(s: PlansState, ev: PlanEvent): void {
  const e = ev as PlanEvent & Record<string, unknown>;
  need(count(e.seq) && e.seq >= 1, 'seq');
  need(count(e.at), 'time');
  if (ev.t === 'spend') return checkSpend(ev.spend);
  need(validPrincipal(ev.principal) && safeKey(ev.principal), 'principal');
  switch (ev.t) {
    case 'account': {
      need(PLAN_IDS.includes(ev.plan), 'plan');
      need(count(ev.periodStart) && count(ev.periodEnd), 'period');
      need(count(ev.allowance) && count(ev.granted) && count(ev.expired), 'account credits');
      if (ev.rollover !== null) {
        const r = ev.rollover as Partial<RolloverBucket> | undefined;
        need(typeof r === 'object' && r !== null, 'rollover');
        need(count(r.credits) && count(r.expiresAt), 'rollover');
      }
      return;
    }
    case 'grant':
      need(PLAN_IDS.includes(ev.plan) && ev.plan !== 'free', 'plan');
      need(count(ev.periodStart) && count(ev.periodEnd), 'period');
      need(safeKey(ev.ref) && !Object.hasOwn(s.refs, ev.ref), 'grant ref (duplicate?)');
      need(Object.hasOwn(s.accounts, ev.principal), 'grant account');
      return;
    case 'revoke':
      need(Object.hasOwn(s.accounts, ev.principal), 'revoke account');
      return;
    case 'pack': {
      need(safeKey(ev.ref) && !Object.hasOwn(s.refs, ev.ref), 'pack ref (duplicate?)');
      const pk = ev.pack as Partial<PackRecord> | undefined;
      need(typeof pk === 'object' && pk !== null && safeKey(pk.id), 'pack');
      need(count(pk.credits) && count(pk.boughtAt) && count(pk.expiresAt), 'pack numbers');
      need(Object.hasOwn(s.accounts, ev.principal), 'pack account');
      return;
    }
    case 'reserve': {
      need(safeKey(ev.reqId) && !Object.hasOwn(s.reservations, ev.reqId), 'reqId (duplicate?)');
      need(ev.mode === 'standard' || ev.mode === 'deep', 'mode');
      need(PLAN_IDS.includes(ev.plan), 'plan');
      need(count(ev.credits) && count(ev.usdMicro) && count(ev.ttlAt), 'reserve numbers');
      need(count(ev.periodSeq), 'period seq');
      need(typeof ev.dayKey === 'string' && DAY_KEY.test(ev.dayKey), 'day key');
      checkParts(ev.parts);
      need(Object.hasOwn(s.accounts, ev.principal), 'reserve account');
      return;
    }
    case 'settle':
    case 'release': {
      need(safeKey(ev.reqId) && Object.hasOwn(s.reservations, ev.reqId), 'reqId (unknown)');
      const r = s.reservations[ev.reqId] as Reservation;
      need(r.state === 'open', `${ev.t} of a reservation that is not open`);
      need(r.principal === ev.principal, `${ev.t} principal`);
      checkSpend(ev.spend);
      need(ev.spend.k === ev.t, `${ev.t} spend kind`);
      const reserved = r.parts.reduce((n, p) => n + p.credits, 0);
      if (ev.t === 'settle') {
        need(count(ev.deducted) && ev.deducted === reserved, 'settle deducted');
        return;
      }
      need(ev.reason === 'failed' || ev.reason === 'ttl', 'release reason');
      need(count(ev.credits) && ev.credits === r.credits, 'release credits');
      need(checkParts(ev.parts) === reserved, 'release parts');
      need(count(ev.periodSeq) && ev.periodSeq === r.periodSeq, 'release period seq');
      need(ev.dayKey === r.dayKey, 'release day key');
      return;
    }
  }
}

export function applyEvent(s: PlansState, ev: PlanEvent): void {
  if (ev.seq !== s.seq + 1)
    throw new Error(`journal sequence gap: expected ${s.seq + 1}, got ${ev.seq}`);
  checkEvent(s, ev);
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
