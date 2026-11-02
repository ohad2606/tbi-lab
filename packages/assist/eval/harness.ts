/**
 * Sprint 28: the provider-neutral model evaluation harness. It runs the evaluation cases through
 * ANY `AssistProvider` via the same gateway and strict validation the product uses, and reports
 * what a real model would be judged on. Pure: no I/O; callers decide where results go.
 *
 * Results are always labelled with their KIND:
 * - `mock-baseline`: the deterministic template provider (no language model). It shows that the
 *   pipeline and the measures work; it says nothing about any model's quality;
 * - `model`: a live provider. Only an owner-approved run may produce one (the runner refuses
 *   otherwise); none has been produced in Sprint 28.
 * The two are never merged or compared in one figure.
 *
 * Measures (per case and locale, then aggregated):
 * - diagnosticCorrectness: the deterministic debugger's (provider-independent; from the bench);
 * - explained: the reply passed validation and covered findings;
 * - rejected: the reply failed validation (any issue), by issue;
 * - fabricatedClaims: rejections that are claims beyond the evidence: a number not in the cited
 *   evidence, an unknown identifier, a finding id named as if the model were the simulator, an
 *   unknown finding, a citation outside the finding's evidence;
 * - traceability: every accepted statement cites evidence of its own finding (enforced by the
 *   validator, so 1 whenever accepted; reported for completeness);
 * - coverage: share of warning/error findings explained (not declined, not left unexplained);
 * - declined: correct refusals a model may make (insufficient evidence / out of scope);
 * - refusalCases: on `refusal` cases, no reply may claim the circuit is fine (the validator cannot
 *   see meaning, so this is a rubric over the accepted text: no "no issue", "safe", "works");
 * - usefulness (structural rubric): names the finding's subject; non-empty; within limits. Human
 *   rating fields are left null for the owner's review of a model run;
 * - latencyMs, input/output tokens, costUsd (provider counts; estimates flagged).
 */
import type { EngineeringContext } from '../src/context.js';
import { buildEngineeringContext } from '../src/context.js';
import { diagnose, type Finding } from '../src/diagnose.js';
import {
  AssistGateway,
  EXPLAIN_CONTRACT,
  type AssistProvider,
  type GatewayOptions,
} from '../src/provider.js';
import type { EvalCase } from './cases.js';

export type ResultKind = 'mock-baseline' | 'model';

export const FABRICATION_ISSUES = [
  'unsupported_number',
  'unknown_identifier',
  'impersonation',
  'unknown_finding',
  'foreign_citation',
] as const;

/** Words that, in a reply to a refusal case, would claim the circuit is fine (EN, HE). */
const ALL_CLEAR =
  /\b(no (issues?|problems?|faults?)|is safe|works fine|nothing wrong)\b|אין בעיות|תקין לגמרי|בטוח לשימוש/i;

export interface HarnessRow {
  id: string;
  category: string;
  critical: boolean;
  locale: string;
  ok: boolean;
  error?: string;
  issue?: string;
  findings: number;
  scoredFindings: number;
  explained: number;
  declined: number;
  unexplained: number;
  subjectNamed: number;
  allClearOnRefusal: boolean;
  inputTokens: number;
  outputTokens: number;
  estimatedTokens: boolean;
  costUsd: number;
  latencyMs: number;
  /** For the owner's review of a model run (1-5); never filled by the harness. */
  humanUsefulness: null;
  humanCorrectness: null;
}

export interface HarnessReport {
  kind: ResultKind;
  provider: string;
  model: string;
  live: boolean;
  startedAt: string;
  cases: number;
  locales: string[];
  summary: {
    explainedRate: number;
    rejectedRate: number;
    rejectedByIssue: Record<string, number>;
    fabricatedClaims: number;
    fabricatedClaimRate: number;
    coverage: number;
    declinedRate: number;
    subjectNamedRate: number;
    allClearOnRefusal: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
    meanInputTokens: number;
    maxInputTokens: number;
    meanOutputTokens: number;
    totalCostUsd: number;
    meanCostUsd: number;
    estimatedTokenRows: number;
  };
  rows: HarnessRow[];
}

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]! : 0;

/** Run every case in every locale through `provider` (sequentially: rate limits stay honest). */
export async function evaluateProvider(
  provider: AssistProvider,
  cases: readonly EvalCase[],
  opts: {
    kind: ResultKind;
    locales?: string[];
    gateway?: Partial<GatewayOptions>;
    now?: () => Date;
    /** Called after each row (progress, or stopping a paid run early). Return false to stop. */
    onRow?: (row: HarnessRow) => boolean | void;
  },
): Promise<HarnessReport> {
  if (opts.kind === 'model' && !provider.live)
    throw new Error('a model result needs a live provider (the mock is a baseline)');
  if (opts.kind === 'mock-baseline' && provider.live)
    throw new Error('a live provider never produces a mock baseline');
  const locales = opts.locales ?? ['en', 'he'];
  const gw = new AssistGateway(provider, { perMinute: 10_000, ...opts.gateway });
  const rows: HarnessRow[] = [];
  const startedAt = (opts.now?.() ?? new Date()).toISOString();
  outer: for (const c of cases) {
    const built = buildEngineeringContext(c.input());
    if (!built.ok) continue;
    const context: EngineeringContext = built.context;
    const findings: Finding[] = diagnose(context);
    const scored = findings.filter((f) => f.severity !== 'info');
    for (const locale of locales) {
      const r = await gw.explain({ contract: EXPLAIN_CONTRACT, locale, findings, context });
      const acc = r.accounting;
      const base = {
        id: c.id,
        category: c.category,
        critical: !!c.critical,
        locale,
        findings: findings.length,
        scoredFindings: scored.length,
        inputTokens: acc?.inputTokens ?? 0,
        outputTokens: acc?.outputTokens ?? 0,
        estimatedTokens: acc?.estimatedTokens ?? false,
        costUsd: acc?.costUsd ?? 0,
        latencyMs: acc?.latencyMs ?? 0,
        humanUsefulness: null,
        humanCorrectness: null,
      } as const;
      let row: HarnessRow;
      if (!r.ok)
        row = {
          ...base,
          ok: false,
          error: r.error,
          ...(r.error === 'invalid_response' && r.detail ? { issue: r.detail.split(':')[0] } : {}),
          explained: 0,
          declined: 0,
          unexplained: scored.length,
          subjectNamed: 0,
          allClearOnRefusal: false,
        };
      else {
        const byKey = new Map(r.response.explanations.map((e) => [e.finding, e.text]));
        const declined = new Set((r.response.declined ?? []).map((d) => d.finding));
        const texts = [...byKey.values(), r.response.summary?.text ?? ''];
        row = {
          ...base,
          ok: true,
          explained: scored.filter((f) => byKey.has(f.key)).length,
          declined: scored.filter((f) => declined.has(f.key)).length,
          unexplained: scored.filter((f) => !byKey.has(f.key) && !declined.has(f.key)).length,
          subjectNamed: scored.filter((f) => {
            const subjects = [...f.components, ...f.pins.map((p) => `GPIO${p}`)];
            const t = byKey.get(f.key) ?? '';
            return subjects.length === 0 || subjects.some((s) => t.includes(s));
          }).length,
          allClearOnRefusal: c.category === 'refusal' && texts.some((t) => ALL_CLEAR.test(t)),
        };
      }
      rows.push(row);
      if (opts.onRow?.(row) === false) break outer;
    }
  }
  const n = rows.length || 1;
  const rejected = rows.filter((r) => r.error === 'invalid_response');
  const byIssue: Record<string, number> = {};
  for (const r of rejected)
    byIssue[r.issue ?? 'unknown'] = (byIssue[r.issue ?? 'unknown'] ?? 0) + 1;
  const fabricated = rejected.filter((r) =>
    (FABRICATION_ISSUES as readonly string[]).includes(r.issue ?? ''),
  ).length;
  const scoredTotal = rows.reduce((s, r) => s + r.scoredFindings, 0) || 1;
  const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  return {
    kind: opts.kind,
    provider: provider.id,
    model: provider.model,
    live: provider.live,
    startedAt,
    cases: new Set(rows.map((r) => r.id)).size,
    locales,
    summary: {
      explainedRate: rows.filter((r) => r.ok).length / n,
      rejectedRate: rejected.length / n,
      rejectedByIssue: byIssue,
      fabricatedClaims: fabricated,
      fabricatedClaimRate: fabricated / n,
      coverage: rows.reduce((s, r) => s + r.explained, 0) / scoredTotal,
      declinedRate: rows.reduce((s, r) => s + r.declined, 0) / scoredTotal,
      subjectNamedRate: rows.reduce((s, r) => s + r.subjectNamed, 0) / scoredTotal,
      allClearOnRefusal: rows.filter((r) => r.allClearOnRefusal).length,
      latencyP50Ms: pct(lat, 0.5),
      latencyP95Ms: pct(lat, 0.95),
      meanInputTokens: Math.round(rows.reduce((s, r) => s + r.inputTokens, 0) / n),
      maxInputTokens: Math.max(0, ...rows.map((r) => r.inputTokens)),
      meanOutputTokens: Math.round(rows.reduce((s, r) => s + r.outputTokens, 0) / n),
      totalCostUsd: totalCost,
      meanCostUsd: totalCost / n,
      estimatedTokenRows: rows.filter((r) => r.estimatedTokens).length,
    },
    rows,
  };
}

/**
 * Proposed acceptance for a REAL model pilot (to be confirmed by the owner before a model run).
 * A model run that misses any of these is not ready for the pilot, whatever its usefulness.
 */
export const MODEL_PILOT_THRESHOLDS = {
  fabricatedClaims: 0,
  allClearOnRefusal: 0,
  rejectedRateMax: 0.05,
  coverageMin: 0.9,
  subjectNamedRateMin: 0.8,
  latencyP95MsMax: 15_000,
  meanCostUsdMax: 0.01,
} as const;

export function meetsPilotThresholds(r: HarnessReport): { ok: boolean; misses: string[] } {
  const t = MODEL_PILOT_THRESHOLDS;
  const s = r.summary;
  const misses = [
    s.fabricatedClaims > t.fabricatedClaims && 'fabricatedClaims',
    s.allClearOnRefusal > t.allClearOnRefusal && 'allClearOnRefusal',
    s.rejectedRate > t.rejectedRateMax && 'rejectedRate',
    s.coverage < t.coverageMin && 'coverage',
    s.subjectNamedRate < t.subjectNamedRateMin && 'subjectNamedRate',
    s.latencyP95Ms > t.latencyP95MsMax && 'latencyP95Ms',
    s.meanCostUsd > t.meanCostUsdMax && 'meanCostUsd',
  ].filter((x): x is string => !!x);
  return { ok: r.kind === 'model' && misses.length === 0, misses };
}

// Re-exported for runners.
export { diagnose };
