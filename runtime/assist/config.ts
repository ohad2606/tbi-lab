/**
 * Sprint 28: the AI provider service's configuration (`/etc/tbi/assist.json`, root-owned, read
 * once at start). The service is INACTIVE unless every owner approval the pilot requires is
 * recorded here AND matches the configured provider. Fail closed: a malformed file, an unknown
 * key or a missing approval leaves it disabled, with the reasons named in its status.
 *
 * Activation requires, in this order (the Sprint 28 owner conditions):
 *   1. providerAndModel  — the provider and the model approved by the owner (must equal `provider`);
 *   2. dataTerms         — the provider's data-sharing and retention terms reviewed;
 *   3. spendCap          — a hard monthly spending cap in USD (> 0);
 *   4. securityReview    — the security review of this integration passed;
 *   5. ownerActivation   — the owner's explicit activation.
 * A live provider also needs its credential (a systemd credential file, never in this file, the
 * repository, the browser bundle or the environment of any other process).
 *
 * `provider.kind: "mock"` is the deterministic template provider (nothing leaves the host). It is
 * accepted only where the service is started with TBI_ASSIST_ALLOW_MOCK=1 (tests, staging), and
 * then needs no approvals: it can never reach a network.
 */
import { readFileSync } from 'node:fs';

export const ASSIST_SERVICE_PROTOCOL = 'tbi-lab.assist-service/1';
export const PROVIDER_KINDS = ['none', 'mock', 'anthropic'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface Approval {
  by: string;
  at: string;
  reference?: string;
}

export interface AssistServiceConfig {
  version: 1;
  provider: { kind: ProviderKind; model?: string };
  /** USD per million tokens; required for a live provider (cost ceilings use it). */
  pricing?: { inputPerMTok: number; outputPerMTok: number };
  /** Principals (opaque, `p_…`) allowed to use the pilot. No emails here. */
  pilot: { principals: string[] };
  approvals: {
    providerAndModel?: Approval & { provider: string; model: string };
    dataTerms?: Approval & { providerRetentionDays?: number };
    spendCap?: Approval & { usdPerMonth: number };
    securityReview?: Approval;
    ownerActivation?: Approval;
  };
  limits: {
    perPrincipalPerMinute: number;
    perPrincipalPerDay: number;
    /** Requests in flight at once (service-wide). */
    concurrency: number;
    timeoutMs: number;
    maxRetries: number;
    maxOutputTokens: number;
    /** Monthly token ceiling (input + output), independent of price. */
    monthlyTokens: number;
  };
  retention: { auditDays: number; ledgerDays: number };
  /** The consent text version the user must have accepted (the app shows that version). */
  consentVersion: string;
}

export const DEFAULT_CONFIG: AssistServiceConfig = {
  version: 1,
  provider: { kind: 'none' },
  pilot: { principals: [] },
  approvals: {},
  limits: {
    perPrincipalPerMinute: 3,
    perPrincipalPerDay: 30,
    concurrency: 1,
    timeoutMs: 20_000,
    maxRetries: 1,
    maxOutputTokens: 1_200,
    monthlyTokens: 2_000_000,
  },
  retention: { auditDays: 30, ledgerDays: 90 },
  consentVersion: '2026-11-02',
};

export const APPROVAL_ORDER = [
  'providerAndModel',
  'dataTerms',
  'spendCap',
  'securityReview',
  'ownerActivation',
] as const;
export type ApprovalId = (typeof APPROVAL_ORDER)[number];

export type Activation =
  { state: 'active'; mode: 'mock' | 'live' } | { state: 'disabled'; reasons: string[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: readonly string[], where: string) => {
  for (const k of Object.keys(o))
    if (!keys.includes(k)) throw new Error(`${where}: unknown key ${k}`);
};
const posInt = (v: unknown, where: string, max: number) => {
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max)
    throw new Error(`${where}: an integer 1..${max}`);
  return v as number;
};

function approval(v: unknown, where: string, extra: Record<string, 'string' | 'number'> = {}) {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new Error(`${where}: an object`);
  only(v, ['by', 'at', 'reference', ...Object.keys(extra)], where);
  if (typeof v.by !== 'string' || !v.by) throw new Error(`${where}.by: required`);
  if (typeof v.at !== 'string' || Number.isNaN(Date.parse(v.at)))
    throw new Error(`${where}.at: an ISO date`);
  for (const [k, t] of Object.entries(extra))
    if (v[k] !== undefined && typeof v[k] !== t) throw new Error(`${where}.${k}: a ${t}`);
  return v as unknown as Approval;
}

/** Parse and validate; throws on anything unexpected (the caller then stays disabled). */
export function parseConfig(raw: unknown): AssistServiceConfig {
  if (!isObj(raw)) throw new Error('config: an object');
  only(
    raw,
    [
      'version',
      'provider',
      'pricing',
      'pilot',
      'approvals',
      'limits',
      'retention',
      'consentVersion',
    ],
    'config',
  );
  if (raw.version !== 1) throw new Error('config.version: 1');
  const c = structuredClone(DEFAULT_CONFIG);
  if (raw.provider !== undefined) {
    if (!isObj(raw.provider)) throw new Error('provider: an object');
    only(raw.provider, ['kind', 'model'], 'provider');
    if (!PROVIDER_KINDS.includes(raw.provider.kind as ProviderKind))
      throw new Error(`provider.kind: one of ${PROVIDER_KINDS.join(', ')}`);
    if (
      raw.provider.model !== undefined &&
      (typeof raw.provider.model !== 'string' || !/^[\w.:-]{1,80}$/.test(raw.provider.model))
    )
      throw new Error('provider.model: an id');
    c.provider = raw.provider as AssistServiceConfig['provider'];
  }
  if (raw.pricing !== undefined) {
    if (!isObj(raw.pricing)) throw new Error('pricing: an object');
    only(raw.pricing, ['inputPerMTok', 'outputPerMTok'], 'pricing');
    for (const k of ['inputPerMTok', 'outputPerMTok'])
      if (
        typeof raw.pricing[k] !== 'number' ||
        !((raw.pricing[k] as number) > 0) ||
        (raw.pricing[k] as number) > 1000
      )
        throw new Error(`pricing.${k}: a positive number`);
    c.pricing = raw.pricing as AssistServiceConfig['pricing'];
  }
  if (raw.pilot !== undefined) {
    if (!isObj(raw.pilot)) throw new Error('pilot: an object');
    only(raw.pilot, ['principals'], 'pilot');
    const p = raw.pilot.principals;
    if (
      !Array.isArray(p) ||
      p.length > 10 ||
      !p.every((x) => typeof x === 'string' && /^p_[A-Za-z0-9_-]{26}$/.test(x))
    )
      throw new Error('pilot.principals: at most 10 principals (p_…)');
    c.pilot = { principals: [...p] as string[] };
  }
  if (raw.approvals !== undefined) {
    if (!isObj(raw.approvals)) throw new Error('approvals: an object');
    only(raw.approvals, APPROVAL_ORDER, 'approvals');
    const a = raw.approvals;
    c.approvals = {
      providerAndModel: approval(a.providerAndModel, 'approvals.providerAndModel', {
        provider: 'string',
        model: 'string',
      }) as AssistServiceConfig['approvals']['providerAndModel'],
      dataTerms: approval(a.dataTerms, 'approvals.dataTerms', { providerRetentionDays: 'number' }),
      spendCap: approval(a.spendCap, 'approvals.spendCap', {
        usdPerMonth: 'number',
      }) as AssistServiceConfig['approvals']['spendCap'],
      securityReview: approval(a.securityReview, 'approvals.securityReview'),
      ownerActivation: approval(a.ownerActivation, 'approvals.ownerActivation'),
    };
  }
  if (raw.limits !== undefined) {
    if (!isObj(raw.limits)) throw new Error('limits: an object');
    only(raw.limits, Object.keys(DEFAULT_CONFIG.limits), 'limits');
    const l = { ...DEFAULT_CONFIG.limits, ...raw.limits } as Record<string, unknown>;
    c.limits = {
      perPrincipalPerMinute: posInt(l.perPrincipalPerMinute, 'limits.perPrincipalPerMinute', 10),
      perPrincipalPerDay: posInt(l.perPrincipalPerDay, 'limits.perPrincipalPerDay', 500),
      concurrency: posInt(l.concurrency, 'limits.concurrency', 4),
      timeoutMs: posInt(l.timeoutMs, 'limits.timeoutMs', 60_000),
      maxRetries:
        Number.isInteger(l.maxRetries) &&
        (l.maxRetries as number) >= 0 &&
        (l.maxRetries as number) <= 2
          ? (l.maxRetries as number)
          : (() => {
              throw new Error('limits.maxRetries: 0..2');
            })(),
      maxOutputTokens: posInt(l.maxOutputTokens, 'limits.maxOutputTokens', 4_000),
      monthlyTokens: posInt(l.monthlyTokens, 'limits.monthlyTokens', 100_000_000),
    };
  }
  if (raw.retention !== undefined) {
    if (!isObj(raw.retention)) throw new Error('retention: an object');
    only(raw.retention, ['auditDays', 'ledgerDays'], 'retention');
    const r = { ...DEFAULT_CONFIG.retention, ...raw.retention } as Record<string, unknown>;
    c.retention = {
      auditDays: posInt(r.auditDays, 'retention.auditDays', 365),
      ledgerDays: posInt(r.ledgerDays, 'retention.ledgerDays', 400),
    };
  }
  if (raw.consentVersion !== undefined) {
    if (typeof raw.consentVersion !== 'string' || !/^[\w.-]{1,40}$/.test(raw.consentVersion))
      throw new Error('consentVersion: an id');
    c.consentVersion = raw.consentVersion;
  }
  return c;
}

/** Whether the service may answer explain requests, and if not, every reason (stable ids). */
export function activation(
  c: AssistServiceConfig,
  env: { allowMock: boolean; credentialPresent: boolean },
): Activation {
  const kind = c.provider.kind;
  if (kind === 'none') return { state: 'disabled', reasons: ['no_provider'] };
  if (kind === 'mock')
    return env.allowMock
      ? { state: 'active', mode: 'mock' }
      : { state: 'disabled', reasons: ['mock_not_allowed'] };
  const reasons: string[] = [];
  const a = c.approvals;
  if (!c.provider.model) reasons.push('no_model');
  if (!a.providerAndModel) reasons.push('approval_missing:providerAndModel');
  else if (a.providerAndModel.provider !== kind || a.providerAndModel.model !== c.provider.model)
    reasons.push('approval_mismatch:providerAndModel');
  if (!a.dataTerms) reasons.push('approval_missing:dataTerms');
  if (!a.spendCap) reasons.push('approval_missing:spendCap');
  else if (!(a.spendCap.usdPerMonth > 0) || a.spendCap.usdPerMonth > 1000)
    reasons.push('approval_invalid:spendCap');
  if (!a.securityReview) reasons.push('approval_missing:securityReview');
  if (!a.ownerActivation) reasons.push('approval_missing:ownerActivation');
  if (!c.pricing) reasons.push('no_pricing');
  if (!env.credentialPresent) reasons.push('no_credential');
  return reasons.length ? { state: 'disabled', reasons } : { state: 'active', mode: 'live' };
}

/** Load the file; any problem -> the safe default (disabled) with the error as the reason. */
export function loadConfig(path: string | undefined): {
  config: AssistServiceConfig;
  error?: string;
} {
  if (!path) return { config: DEFAULT_CONFIG, error: 'no_config' };
  try {
    return { config: parseConfig(JSON.parse(readFileSync(path, 'utf8'))) };
  } catch (e) {
    return { config: DEFAULT_CONFIG, error: `config_invalid: ${(e as Error).message}` };
  }
}
