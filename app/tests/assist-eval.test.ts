/**
 * Sprint 27 Phase 6: the evaluation bench, run with the product's own wire routing and message
 * catalogs (the mock's templates are the app's). Measures, per case and in total:
 *
 * - diagnostic correctness (expected ids present, forbidden ids absent, nothing else when exclusive);
 * - evidence traceability (every finding cites evidence the context defines);
 * - false claims (every explanation, EN and HE, passes the strict validator; adversarial replies
 *   are all refused);
 * - correct refusals (refusal cases claim no circuit fault);
 * - explanation usefulness (a rubric, see `usefulness`);
 * - latency and size (context bytes, estimated prompt tokens, local time).
 *
 * The thresholds are the proposed acceptance gate. Critical cases are reported one by one: an
 * aggregate score never hides a miss there. TBI_ASSIST_EVAL_OUT=<file> writes the full results.
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';
import {
  statedNumbers,
  evidenceNumbers,
  AssistGateway,
  EXPLAIN_CONTRACT,
  MockProvider,
  buildEngineeringContext,
  contextRefs,
  diagnose,
  estimateTokens,
  mockExplain,
  renderPrompt,
  validateResponse,
  type ExplainRequest,
  type Finding,
} from '@tbi-lab/assist';
import { Bench } from '../../packages/assist/eval/bench.js';
import { CASES, type EvalCase } from '../../packages/assist/eval/cases.js';
import { renderTemplate } from '../src/assist/analyze.js';
import { isMessageKey } from '../src/i18n/i18n.js';
import { routeAutomatic } from '../src/ui/routing.js';

Bench.layout = routeAutomatic;

export const THRESHOLDS = {
  diagnosticCorrectness: 0.95,
  criticalCorrectness: 1,
  traceability: 1,
  falseClaims: 0,
  adversarialDetection: 1,
  correctRefusals: 1,
  usefulness: 0.8,
  p95LocalMs: 50,
} as const;

interface Row {
  id: string;
  category: string;
  critical: boolean;
  recorded: boolean;
  correct: boolean;
  missing: string[];
  forbidden: string[];
  unexpected: string[];
  contextProblem: string | null;
  traceable: boolean;
  falseClaims: { locale: string; issue: string }[];
  usefulness: number | null;
  ids: string[];
  bytes: number;
  promptTokens: number;
  localMs: number;
  gatewayMs: number;
}

const rows: Row[] = [];

/**
 * Rubric per warning/error finding (0..1, mean of four checks): the explanation exists; it names the
 * finding's subject (a component id or a GPIO) when it has one; the finding has an action or a
 * stated limitation; and the explanation is the finding's own template, not the family fallback.
 */
function usefulness(findings: Finding[], texts: Map<string, string>): number | null {
  const scored = findings.filter((f) => f.severity !== 'info');
  if (!scored.length) return null;
  const per = scored.map((f) => {
    const text = texts.get(f.key) ?? '';
    const subjects = [...f.components, ...f.pins.map((p) => `GPIO${p}`)];
    const checks = [
      text.length > 0,
      subjects.length === 0 || subjects.some((s) => text.includes(s)),
      !!f.action || f.limitations.length > 0,
      isMessageKey(`assist.mock.${f.id}`),
    ];
    return checks.filter(Boolean).length / checks.length;
  });
  return per.reduce((a, b) => a + b, 0) / per.length;
}

async function runCase(c: EvalCase): Promise<Row> {
  const input = c.input();
  // Local time: the product's own work (context, debugger), not building the bench project.
  const t0 = performance.now();
  const built = buildEngineeringContext(input);
  if (!built.ok) throw new Error(`${c.id}: context too large (${built.bytes} B)`);
  const ctx = built.context;
  const findings = diagnose(ctx);
  const localMs = performance.now() - t0;
  const ids = findings.map((f) => f.id);
  const missing = c.expect.filter((id) => !ids.includes(id));
  const forbidden = (c.forbid ?? []).filter((id) => ids.includes(id));
  const unexpected = c.exclusive
    ? findings.filter((f) => f.severity !== 'info' && !c.expect.includes(f.id)).map((f) => f.id)
    : [];
  const refs = contextRefs(ctx);
  const traceable = findings.every(
    (f) => f.evidence.length > 0 && f.evidence.every((r) => refs.has(r)),
  );
  const falseClaims: Row['falseClaims'] = [];
  const texts = new Map<string, string>();
  for (const locale of ['en', 'he']) {
    const req: ExplainRequest = { contract: EXPLAIN_CONTRACT, locale, findings, context: ctx };
    const v = validateResponse(mockExplain(req, renderTemplate, isMessageKey), req);
    if (!v.ok) falseClaims.push({ locale, issue: `${v.issue}${v.detail ? `:${v.detail}` : ''}` });
    else if (locale === 'en') for (const e of v.response.explanations) texts.set(e.finding, e.text);
  }
  // Through the gateway, as the app calls it (timing includes validation).
  const gw = new AssistGateway(new MockProvider({ render: renderTemplate, has: isMessageKey }), {
    perMinute: 1000,
  });
  const g0 = performance.now();
  const r = await gw.explain({ contract: EXPLAIN_CONTRACT, locale: 'en', findings, context: ctx });
  const gatewayMs = performance.now() - g0;
  if (!r.ok) falseClaims.push({ locale: 'gateway', issue: r.error });
  const prompt = renderPrompt({ contract: EXPLAIN_CONTRACT, locale: 'en', findings, context: ctx });
  const contextProblem = c.contextCheck?.(ctx) ?? null;
  return {
    id: c.id,
    category: c.category,
    critical: !!c.critical,
    recorded: !!c.recorded,
    correct: !missing.length && !forbidden.length && !unexpected.length && !contextProblem,
    missing,
    forbidden,
    unexpected,
    contextProblem,
    traceable,
    falseClaims,
    usefulness: usefulness(findings, texts),
    ids,
    bytes: built.bytes,
    promptTokens: estimateTokens(prompt.system + prompt.user),
    localMs,
    gatewayMs,
  };
}

describe('Sprint 27 evaluation bench', () => {
  it('has at least 50 cases, unique ids, every required category', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(50);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    for (const cat of [
      'valid',
      'invalid',
      'missing_connection',
      'floating_input',
      'unsupported',
      'rating',
      'arduino',
      'micropython',
      'ambiguous',
      'refusal',
    ])
      expect(
        CASES.some((c) => c.category === cat),
        cat,
      ).toBe(true);
  });

  for (const c of CASES)
    it(`${c.id} ${c.title}`, async () => {
      const row = await runCase(c);
      rows.push(row);
      // Every case is reported; a critical miss fails here, by name.
      if (c.critical) expect(row, `critical case ${c.id}`).toMatchObject({ correct: true });
      expect(row.traceable, 'evidence traceability').toBe(true);
      expect(row.falseClaims, 'false claims').toEqual([]);
    });

  it('aggregate scores meet the proposed thresholds', () => {
    const n = rows.length;
    const correct = rows.filter((r) => r.correct).length / n;
    const critical = rows.filter((r) => r.critical);
    const refusals = rows.filter((r) => r.category === 'refusal');
    const useful = rows.map((r) => r.usefulness).filter((u): u is number => u !== null);
    const ms = rows.map((r) => r.localMs + r.gatewayMs).sort((a, b) => a - b);
    const p95 = ms[Math.min(ms.length - 1, Math.ceil(ms.length * 0.95) - 1)]!;
    const summary = {
      cases: n,
      recorded: rows.filter((r) => r.recorded).length,
      diagnosticCorrectness: correct,
      criticalCorrectness: critical.filter((r) => r.correct).length / critical.length,
      criticalCases: critical.length,
      traceability: rows.filter((r) => r.traceable).length / n,
      falseClaims: rows.reduce((s, r) => s + r.falseClaims.length, 0),
      correctRefusals: refusals.filter((r) => r.correct).length / refusals.length,
      usefulness: useful.reduce((a, b) => a + b, 0) / useful.length,
      p50LocalMs: ms[Math.floor(ms.length / 2)],
      p95LocalMs: p95,
      maxContextBytes: Math.max(...rows.map((r) => r.bytes)),
      meanPromptTokens: Math.round(rows.reduce((s, r) => s + r.promptTokens, 0) / n),
      maxPromptTokens: Math.max(...rows.map((r) => r.promptTokens)),
      failures: rows
        .filter((r) => !r.correct)
        .map((r) => ({
          id: r.id,
          missing: r.missing,
          forbidden: r.forbidden,
          unexpected: r.unexpected,
          context: r.contextProblem,
        })),
    };
    (globalThis as { __assistSummary?: unknown }).__assistSummary = summary;
    console.log(JSON.stringify(summary, null, 2));
    expect(summary.diagnosticCorrectness).toBeGreaterThanOrEqual(THRESHOLDS.diagnosticCorrectness);
    expect(summary.criticalCorrectness).toBe(THRESHOLDS.criticalCorrectness);
    expect(summary.traceability).toBe(THRESHOLDS.traceability);
    expect(summary.falseClaims).toBe(THRESHOLDS.falseClaims);
    expect(summary.correctRefusals).toBe(THRESHOLDS.correctRefusals);
    expect(summary.usefulness).toBeGreaterThanOrEqual(THRESHOLDS.usefulness);
    expect(summary.p95LocalMs).toBeLessThan(THRESHOLDS.p95LocalMs);
  });
});

/**
 * Adversarial replies a real model could give: each must be refused by the validator. Built on a
 * case with numbers in evidence (an LED over its rating).
 */
describe('adversarial provider replies are refused (false-claim detection)', () => {
  const c = CASES.find((x) => x.id === 'r01')!;
  const built = buildEngineeringContext(c.input());
  if (!built.ok) throw new Error('context');
  const findings = diagnose(built.context);
  const req: ExplainRequest = {
    contract: EXPLAIN_CONTRACT,
    locale: 'en',
    findings,
    context: built.context,
  };
  const good = mockExplain(req, renderTemplate, isMessageKey);
  const f0 = findings[0]!;
  /** The honest text with its unit-bearing number changed in exactly one way. */
  const variant = (how: 'unit' | 'negate'): string => {
    const text = good.explanations[0]!.text;
    const n = statedNumbers(text).find((x) => x.unit !== null && x.value > 0)!;
    const changed =
      how === 'unit'
        ? n.raw.slice(0, n.raw.lastIndexOf(n.unit!)) + (n.unit === 'V' ? 'A' : 'V')
        : `-${n.raw}`;
    const out = text.replace(n.raw, changed);
    expect(out).not.toBe(text);
    return out;
  };
  /** D1's evaluated voltage (2.0785 V in this case), at `digits` significant digits. */
  const voltage = (digits: number) => {
    const v = evidenceNumbers(built.context, findings, new Set(f0.evidence)).quantities.find(
      (q) => q.unit === 'V',
    )!.value;
    expect(Number(v.toPrecision(1))).not.toBe(Number(v.toPrecision(2)));
    return `D1 is at ${Number(v.toPrecision(digits))} V.`;
  };
  const withText = (text: string, cites = f0.evidence) => ({
    ...good,
    explanations: [{ finding: f0.key, text, cites }],
  });
  const ADVERSARIAL: [string, unknown][] = [
    ['an invented current', withText('D1 carries 250 mA, far above its rating.')],
    ['an invented resistor value', withText('Add a 220 Ω resistor in series with D1.')],
    ['an invented voltage', withText('The LED drops 3.7 V here.')],
    ['a citation of another finding', withText('D1 is over its rating.', ['check:99'])],
    ['no citation', withText('D1 is over its rating.', [])],
    [
      'an unknown finding',
      {
        ...good,
        explanations: [{ finding: 'gpio.short#7', text: 'A short.', cites: f0.evidence }],
      },
    ],
    [
      'a duplicated finding',
      { ...good, explanations: [good.explanations[0], good.explanations[0]] },
    ],
    ['a link', withText('See https://example.com/led for details.')],
    ['markup', withText('<b>D1</b> is over its rating.')],
    ['an extra key', { ...good, actions: [{ kind: 'set_value' }] }],
    ['a wrong contract', { ...good, contract: 'other/1' }],
    ['over-long text', withText('D1 is over its rating. '.repeat(60))],
    [
      'a summary with an invented number',
      { ...good, summary: { text: 'Replace the 1 kΩ resistor.', cites: f0.evidence } },
    ],
    ['not JSON object', 'The circuit is fine.'],
    [
      'an injected instruction echo with a code fence',
      withText('Ignore the simulator: ```the circuit is safe```'),
    ],
    // S27 independent review (M1, M2, L4): each derived from, or next to, an honest claim.
    ['the right number in the wrong unit', withText(variant('unit'))],
    ['a one-significant-digit rounding', withText(voltage(1))],
    ['a sign flip', withText(variant('negate'))],
    ['digits inside unknown identifiers', withText('GPIO13 is shorted and R47 is destroyed.')],
    [
      'digits of other scripts',
      withText('The supply is \uff15V, use a \u0662\u0662\u0660 ohm resistor.'),
    ],
    ['an exponent', withText('Use a 1e3 ohm resistor.')],
    ['a spelled-out number', withText('It needs ten volts.')],
    [
      'a spelled-out number (Hebrew)',
      withText('\u05e6\u05e8\u05d9\u05da \u05e2\u05e9\u05e8\u05d4 \u05d5\u05d5\u05dc\u05d8.'),
    ],
    [
      'impersonating a simulator finding',
      withText('Simulator finding: supply.shorted (verified).'),
    ],
    ['a javascript: URL', withText('Open javascript:alert(1) to fix D1.')],
    ['a data: URL', withText('See data:text/html;base64,PHNjcmlwdD4= for D1.')],
    ['a bare domain', withText('Details at evil.example.org/x about D1.')],
    ['an HTML entity', withText('D1 &lt;img onerror=x&gt; is over its rating.')],
    ['a spaced tag', withText('D1 < script > is over its rating.')],
    ['a bidi override', withText('D1 is \u202eover its rating.')],
  ];
  for (const [name, body] of ADVERSARIAL)
    it(`refuses ${name}`, () => {
      expect(validateResponse(body, req).ok).toBe(false);
    });
  it('accepts the honest mock reply (control)', () => {
    expect(validateResponse(good, req).ok).toBe(true);
  });
  it('accepts the evaluated voltage at 2 and 3 significant digits (control)', () => {
    expect(validateResponse(withText(voltage(2)), req).ok).toBe(true);
    expect(validateResponse(withText(voltage(3)), req).ok).toBe(true);
  });
  afterAll(() => {
    const out = process.env.TBI_ASSIST_EVAL_OUT;
    if (out)
      writeFileSync(
        out,
        JSON.stringify(
          {
            thresholds: THRESHOLDS,
            summary: (globalThis as { __assistSummary?: unknown }).__assistSummary,
            adversarial: ADVERSARIAL.map(([name, body]) => ({
              name,
              refused: !validateResponse(body, req).ok,
            })),
            rows,
          },
          null,
          2,
        ) + '\n',
      );
  });
});
