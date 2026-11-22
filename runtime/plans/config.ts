/**
 * TBI-018 slice 1: configuration of plans, credits and the spend guard.
 * Strict parse: an unknown key, a negative number, a non-integer where an integer is required, or a
 * dayAlertMicro above dayStopMicro is an error. Every PLACEHOLDER default is a config value, never code.
 * Plan numbers live ONLY here (defaults) and in tests.
 */

export type PlanId = 'free' | 'advanced' | 'pro' | 'legacy';
export const PLAN_IDS: readonly PlanId[] = ['free', 'advanced', 'pro', 'legacy'];
export type Mode = 'standard' | 'deep';
export type PeriodAnchor = 'calendar' | 'billing';
export type PackType = 'ai300' | 'ai1000';
export type FreeCapMode = 'fixed' | 'liftUntilFirstPaid';

/** Sim-minute allowance of one plan. null = not metered by this limit (only the global caps apply). */
export interface SimPlanConfig {
  monthlyMinutes: number | null;
  dailyMinutes: number | null;
}

export interface PlanConfig {
  /** null = unmetered (credits are not deducted; daily and rate limits still apply). */
  monthlyCredits: number | null;
  dailyCredits: number;
  perMinute: number;
  deepAllowed: boolean;
  rolloverMonths: number;
  periodAnchor: PeriodAnchor;
}

export interface PlansConfig {
  metering: { enabled: boolean };
  meter: { timezone: string };
  plans: Record<PlanId, PlanConfig>;
  credits: Record<Mode, number>;
  ai: { maxInputTokens: number };
  packs: {
    ai300: { credits: number; validityDays: number };
    ai1000: { credits: number; validityDays: number };
    refund: { windowDays: number; maxUsedFraction: number };
  };
  reservation: { ttlMs: number };
  spend: {
    dayAlertMicro: number;
    dayStopMicro: number;
    monthStopMicro: number;
    worstMicro: Record<Mode, number>;
    failedCallCounts: 'worstCase' | 'zero';
    autoClearNextDay: boolean;
    monthAlertPercents: number[];
  };
  killSwitch: { autoTrigger: { enabled: boolean; multiple: number; minMicro: number } };
  /**
   * Sim minutes (slice 3b). leaseMs must equal the Session Host lease: billing stops at lastBeat + leaseMs.
   * maxConcurrentPerPrincipal: live sessions one principal may hold at once (>= 1).
   */
  sim: { leaseMs: number; maxConcurrentPerPrincipal: number; plans: Record<PlanId, SimPlanConfig> };
  /** Fair queue (slice 3b). Memory only. rank: lower = served first. The host cap is NOT here (host config). */
  queue: {
    freeSlotCap: number;
    freeCapMode: FreeCapMode;
    maxWaitMs: number;
    vanishMs: number;
    maxLength: number;
    /** most waiting Free entries; at most maxLength - 1, so a paid user can always join the queue */
    maxFree: number;
    freeCooldownMs: number;
    rank: Record<PlanId, number>;
  };
}

export const DEFAULT_CONFIG: PlansConfig = {
  metering: { enabled: false },
  meter: { timezone: 'Asia/Jerusalem' },
  plans: {
    free: {
      monthlyCredits: 30,
      dailyCredits: 10,
      perMinute: 2,
      deepAllowed: false,
      rolloverMonths: 0,
      periodAnchor: 'calendar',
    },
    advanced: {
      monthlyCredits: 400,
      dailyCredits: 40,
      perMinute: 3,
      deepAllowed: true,
      rolloverMonths: 1,
      periodAnchor: 'billing',
    },
    pro: {
      monthlyCredits: 1500,
      dailyCredits: 150,
      perMinute: 5,
      deepAllowed: true,
      rolloverMonths: 1,
      periodAnchor: 'billing',
    },
    legacy: {
      monthlyCredits: null,
      dailyCredits: 30,
      perMinute: 3,
      deepAllowed: false,
      rolloverMonths: 0,
      periodAnchor: 'calendar',
    },
  },
  credits: { standard: 1, deep: 15 },
  ai: { maxInputTokens: 12000 },
  packs: {
    ai300: { credits: 300, validityDays: 365 },
    ai1000: { credits: 1000, validityDays: 365 },
    refund: { windowDays: 14, maxUsedFraction: 0.2 },
  },
  reservation: { ttlMs: 120000 },
  spend: {
    dayAlertMicro: 1500000,
    dayStopMicro: 3000000,
    monthStopMicro: 60000000,
    worstMicro: { standard: 2250, deep: 45000 },
    failedCallCounts: 'worstCase',
    autoClearNextDay: true,
    monthAlertPercents: [50, 80],
  },
  killSwitch: { autoTrigger: { enabled: false, multiple: 3, minMicro: 1000000 } },
  // PLACEHOLDER defaults from limits-spec 1 (MKT-007): Free 60, Advanced 900, Pro 2400 min/month;
  // legacy has no monthly meter. No daily sim cap is specified: null.
  sim: {
    leaseMs: 30000,
    maxConcurrentPerPrincipal: 1,
    plans: {
      free: { monthlyMinutes: 60, dailyMinutes: null },
      advanced: { monthlyMinutes: 900, dailyMinutes: null },
      pro: { monthlyMinutes: 2400, dailyMinutes: null },
      legacy: { monthlyMinutes: null, dailyMinutes: null },
    },
  },
  // D-3: Free at most 4 slots, max wait 10 min. PROPOSAL: bound 20, Free cooldown 60 s. Lease 30 s (R4.3).
  queue: {
    freeSlotCap: 4,
    freeCapMode: 'fixed',
    maxWaitMs: 600000,
    vanishMs: 30000,
    maxLength: 20,
    // PROPOSAL: maxLength - 4 (4 places always kept for paid users)
    maxFree: 16,
    freeCooldownMs: 60000,
    rank: { pro: 0, advanced: 1, legacy: 1, free: 2 },
  },
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keys whose numbers must be integers (credits, micro-USD, ms, days, counts, token counts). */
const NON_INTEGER_OK = new Set(['maxUsedFraction']);
/** Number keys that may also be null (= not metered by that limit). */
const NULLABLE = new Set(['monthlyCredits', 'monthlyMinutes', 'dailyMinutes']);

function merge(base: unknown, over: unknown, path: string): unknown {
  if (over === undefined) return structuredClone(base);
  if (isObj(base)) {
    if (!isObj(over)) throw new ConfigError(`${path}: expected an object`);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(over)) {
      if (!(k in base)) throw new ConfigError(`${path}.${k}: unknown config key`);
    }
    for (const k of Object.keys(base)) out[k] = merge(base[k], over[k], `${path}.${k}`);
    return out;
  }
  if (Array.isArray(base)) {
    if (!Array.isArray(over)) throw new ConfigError(`${path}: expected an array`);
    return over.map((x, i) => merge(base[0], x, `${path}[${i}]`));
  }
  if (base === null) {
    if (over === null) return null;
    return merge(0, over, path);
  }
  if (over === null && NULLABLE.has(path.split('.').pop() ?? '')) return null;
  if (typeof base !== typeof over) throw new ConfigError(`${path}: expected ${typeof base}`);
  if (typeof over === 'number') {
    const key = path.split('.').pop() ?? '';
    if (!Number.isFinite(over)) throw new ConfigError(`${path}: must be finite`);
    if (over < 0) throw new ConfigError(`${path}: must not be negative`);
    if (!NON_INTEGER_OK.has(key) && !Number.isInteger(over))
      throw new ConfigError(`${path}: must be an integer`);
  }
  return over;
}

/** Strict parse of an override object over the defaults. */
export function parseConfig(overrides: unknown = {}): PlansConfig {
  if (overrides !== undefined && !isObj(overrides))
    throw new ConfigError('config: expected an object');
  const cfg = merge(DEFAULT_CONFIG, overrides ?? {}, 'config') as PlansConfig;
  if (cfg.spend.dayAlertMicro > cfg.spend.dayStopMicro)
    throw new ConfigError('spend.dayAlertMicro must not exceed spend.dayStopMicro');
  if (cfg.packs.refund.maxUsedFraction > 1)
    throw new ConfigError('packs.refund.maxUsedFraction must be at most 1');
  for (const p of cfg.spend.monthAlertPercents)
    if (p < 1 || p > 99) throw new ConfigError('spend.monthAlertPercents: values must be 1..99');
  if (cfg.spend.failedCallCounts !== 'worstCase' && cfg.spend.failedCallCounts !== 'zero')
    throw new ConfigError('spend.failedCallCounts: must be worstCase or zero');
  for (const [id, p] of Object.entries(cfg.plans)) {
    if (p.periodAnchor !== 'calendar' && p.periodAnchor !== 'billing')
      throw new ConfigError(`plans.${id}.periodAnchor: must be calendar or billing`);
  }
  if (cfg.queue.freeCapMode !== 'fixed' && cfg.queue.freeCapMode !== 'liftUntilFirstPaid')
    throw new ConfigError('queue.freeCapMode: must be fixed or liftUntilFirstPaid');
  for (const k of ['leaseMs', 'maxConcurrentPerPrincipal'] as const)
    if (cfg.sim[k] < 1) throw new ConfigError(`sim.${k}: must be at least 1`);
  for (const k of ['maxWaitMs', 'vanishMs', 'maxLength'] as const)
    if (cfg.queue[k] < 1) throw new ConfigError(`queue.${k}: must be at least 1`);
  if (cfg.queue.maxFree > cfg.queue.maxLength - 1)
    throw new ConfigError('queue.maxFree: must be at most queue.maxLength - 1');
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: cfg.meter.timezone });
  } catch {
    throw new ConfigError('meter.timezone: unknown time zone');
  }
  return cfg;
}
