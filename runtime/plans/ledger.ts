/** TBI-018 slice 1: credit buckets, consumption order, period close (rollover), pack refund rule. Pure. */
import type { PlanId, PlansConfig } from './config.js';
import type { LimitCode } from './limits.js';
import { addMonths } from './time.js';
import type { Period } from './plans.js';

export interface RolloverBucket {
  credits: number;
  expiresAt: number;
}
export interface PackBucket {
  id: string;
  /** remaining credits */
  credits: number;
  expiresAt: number;
}
export interface Buckets {
  allowance: number;
  rollover: RolloverBucket | null;
  packs: PackBucket[];
}

export type Part =
  | { bucket: 'allowance'; credits: number }
  | { bucket: 'rollover'; credits: number; expiresAt: number }
  | { bucket: 'pack'; credits: number; packId: string; expiresAt: number };

export type ConsumeResult =
  | { ok: true; metered: boolean; parts: Part[] }
  | { ok: false; code: Extract<LimitCode, 'credits_out' | 'credits_out_free'> };

/**
 * Deduct `cost` in the order allowance, rollover, packs (oldest expiry first). All-or-nothing; the input is
 * not mutated. Packs are consumable only with an active paid plan (not free). Unmetered plans deduct nothing.
 */
export function consume(
  buckets: Buckets,
  cost: number,
  now: number,
  plan: PlanId,
  cfg: PlansConfig,
): ConsumeResult {
  if (cfg.plans[plan].monthlyCredits === null) return { ok: true, metered: false, parts: [] };
  const parts: Part[] = [];
  let need = cost;
  const take = (avail: number): number => {
    const n = Math.min(avail, need);
    need -= n;
    return n;
  };
  const a = take(buckets.allowance);
  if (a > 0) parts.push({ bucket: 'allowance', credits: a });
  if (need > 0 && buckets.rollover && buckets.rollover.expiresAt > now) {
    const r = take(buckets.rollover.credits);
    if (r > 0)
      parts.push({ bucket: 'rollover', credits: r, expiresAt: buckets.rollover.expiresAt });
  }
  if (need > 0 && plan !== 'free') {
    const packs = buckets.packs
      .filter((p) => p.expiresAt > now && p.credits > 0)
      .sort((x, y) => x.expiresAt - y.expiresAt || (x.id < y.id ? -1 : 1));
    for (const p of packs) {
      if (need === 0) break;
      const n = take(p.credits);
      if (n > 0) parts.push({ bucket: 'pack', credits: n, packId: p.id, expiresAt: p.expiresAt });
    }
  }
  if (need > 0) return { ok: false, code: plan === 'free' ? 'credits_out_free' : 'credits_out' };
  return { ok: true, metered: true, parts };
}

export interface CloseResult {
  /** new period's allowance */
  allowance: number;
  rollover: RolloverBucket | null;
  /** credits that left the ledger unused (old rollover, or unused allowance that does not roll) */
  expiredCredits: number;
  /** credits newly granted (the new allowance) */
  grantedCredits: number;
}

/**
 * End of a period (renewal). Only the unused ALLOWANCE rolls, and only if the plan's rolloverMonths > 0;
 * the old rollover always expires (it never rolls twice). The new rollover expires at the end of the
 * `rolloverMonths`-th period after the closed one.
 */
export function closePeriod(
  state: { allowance: number; rollover: RolloverBucket | null },
  plan: PlanId,
  next: Period,
  cfg: PlansConfig,
): CloseResult {
  const pc = cfg.plans[plan];
  const monthly = pc.monthlyCredits ?? 0;
  const rolls = pc.rolloverMonths > 0 && state.allowance > 0;
  const rollover: RolloverBucket | null = rolls
    ? {
        credits: state.allowance,
        expiresAt: addMonths(next.end, pc.rolloverMonths - 1, cfg.meter.timezone),
      }
    : null;
  return {
    allowance: monthly,
    rollover,
    expiredCredits: (state.rollover?.credits ?? 0) + (rolls ? 0 : state.allowance),
    grantedCredits: monthly,
  };
}

const DAY_MS = 86_400_000;

/** Refund rule (config-driven; subject to legal review): inside the window and used share at most the cap. */
export function refundEligible(
  pack: { credits: number; boughtAt: number },
  usedCredits: number,
  now: number,
  cfg: PlansConfig,
): boolean {
  const { windowDays, maxUsedFraction } = cfg.packs.refund;
  if (now < pack.boughtAt) return false;
  if (now - pack.boughtAt > windowDays * DAY_MS) return false;
  const ppm = Math.round(maxUsedFraction * 1_000_000);
  return usedCredits * 1_000_000 <= pack.credits * ppm;
}
