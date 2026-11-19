/** TBI-018 slice 1: entitlements -> effective plan, periods, renewal date. Pure. */
import type { PlanId, PlansConfig } from './config.js';
import { formatDate, monthStart } from './time.js';

export type EntitlementStatus = 'active' | 'lapsed' | 'revoked';

export interface Entitlement {
  principal: string;
  plan: PlanId;
  /** ms UTC */
  periodStart: number;
  /** ms UTC, exclusive */
  periodEnd: number;
  status: EntitlementStatus;
  grantRefs: string[];
  /** Journal sequence of the grant; breaks ties. */
  seq?: number;
}

function live(e: Entitlement, now: number): boolean {
  if (e.status !== 'active') return false;
  if (e.plan === 'legacy') return true;
  return now >= e.periodStart && now < e.periodEnd;
}

/** The entitlement that decides the plan: live, latest periodEnd, ties by higher seq. */
export function winningEntitlement(
  ents: Entitlement | readonly Entitlement[] | undefined,
  now: number,
): Entitlement | undefined {
  const list = ents === undefined ? [] : Array.isArray(ents) ? ents : [ents as Entitlement];
  let best: Entitlement | undefined;
  for (const e of list as Entitlement[]) {
    if (!live(e, now)) continue;
    if (
      !best ||
      e.periodEnd > best.periodEnd ||
      (e.periodEnd === best.periodEnd && (e.seq ?? 0) > (best.seq ?? 0))
    )
      best = e;
  }
  return best;
}

export function effectivePlan(
  ents: Entitlement | readonly Entitlement[] | undefined,
  now: number,
): PlanId {
  return winningEntitlement(ents, now)?.plan ?? 'free';
}

export interface Period {
  start: number;
  end: number;
}

/** Current period of a plan for a principal: calendar month in the zone, or the entitlement's own. */
export function periodFor(
  plan: PlanId,
  ent: Entitlement | undefined,
  now: number,
  cfg: PlansConfig,
): Period {
  const tz = cfg.meter.timezone;
  if (cfg.plans[plan].periodAnchor === 'billing' && ent)
    return { start: ent.periodStart, end: ent.periodEnd };
  return { start: monthStart(now, tz), end: monthStart(now, tz, 1) };
}

/** `{date}` parameter, dd.mm.yyyy in the zone: when credits renew. */
export function renewDate(
  ents: Entitlement | readonly Entitlement[] | undefined,
  now: number,
  cfg: PlansConfig,
): string {
  const ent = winningEntitlement(ents, now);
  const plan = ent?.plan ?? 'free';
  return formatDate(periodFor(plan, ent, now, cfg).end, cfg.meter.timezone);
}
