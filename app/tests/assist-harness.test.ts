/**
 * Sprint 28: the model evaluation harness (packages/assist/eval/harness.ts).
 *
 * - The MOCK BASELINE over every case, EN and HE, with the app's own templates. It proves the
 *   pipeline and the measures; it is not a model result. TBI_ASSIST_BASELINE_OUT=<file> writes it.
 * - The harness detects what a bad model would do, shown with SIMULATED live providers (local
 *   functions; no network): invented numbers, claiming the circuit is fine on a refusal case,
 *   declining everything. A real model has NOT been run (no owner approval).
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXPLAIN_CONTRACT,
  MockProvider,
  type AssistProvider,
  type ExplainRequest,
} from '@tbi-lab/assist';
import { Bench } from '../../packages/assist/eval/bench.js';
import { CASES } from '../../packages/assist/eval/cases.js';
import {
  evaluateProvider,
  meetsPilotThresholds,
  MODEL_PILOT_THRESHOLDS,
} from '../../packages/assist/eval/harness.js';
import { renderTemplate } from '../src/assist/analyze.js';
import { isMessageKey } from '../src/i18n/i18n.js';
import { routeAutomatic } from '../src/ui/routing.js';

Bench.layout = routeAutomatic;

/** A simulated live model (a local function): `answer` writes each explanation's text. */
function simulated(
  answer: (req: ExplainRequest, f: ExplainRequest['findings'][number]) => string,
  declineAll = false,
): AssistProvider {
  return {
    id: 'simulated',
    model: 'simulated-model',
    live: true,
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
    async complete(req) {
      const scored = req.findings;
      return {
        body: {
          contract: EXPLAIN_CONTRACT,
          explanations: declineAll
            ? []
            : scored.map((f) => ({
                finding: f.key,
                text: answer(req, f),
                cites: f.evidence.slice(0, 2),
              })),
          ...(declineAll
            ? { declined: scored.map((f) => ({ finding: f.key, reason: 'insufficient_evidence' })) }
            : {}),
        },
        usage: { inputTokens: 1400, outputTokens: 300 },
      };
    },
  };
}

describe('Sprint 28 model evaluation harness', () => {
  it('mock baseline (labelled as such): no rejection, no fabricated claim, no all-clear on refusals', async () => {
    const report = await evaluateProvider(
      new MockProvider({ render: renderTemplate, has: isMessageKey }),
      CASES,
      {
        kind: 'mock-baseline',
      },
    );
    const out = process.env.TBI_ASSIST_BASELINE_OUT;
    if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      JSON.stringify({ kind: report.kind, cases: report.cases, ...report.summary }, null, 2),
    );
    expect(report.kind).toBe('mock-baseline');
    expect(report.live).toBe(false);
    expect(report.cases).toBe(CASES.length);
    expect(report.rows).toHaveLength(CASES.length * 2);
    expect(report.summary.rejectedRate).toBe(0);
    expect(report.summary.fabricatedClaims).toBe(0);
    expect(report.summary.allClearOnRefusal).toBe(0);
    expect(report.summary.coverage).toBe(1);
    // A baseline can never pass as model readiness.
    expect(meetsPilotThresholds(report).ok).toBe(false);
  });

  it('kinds cannot be mixed: a mock is never a model result, a live provider never a baseline', async () => {
    await expect(
      evaluateProvider(
        new MockProvider({ render: renderTemplate, has: isMessageKey }),
        CASES.slice(0, 1),
        { kind: 'model' },
      ),
    ).rejects.toThrow(/live provider/);
    await expect(
      evaluateProvider(
        simulated(() => 'x'),
        CASES.slice(0, 1),
        { kind: 'mock-baseline' },
      ),
    ).rejects.toThrow(/never produces a mock baseline/);
  });

  const subset = CASES.filter((c) =>
    ['v01', 'r01', 'i01', 't04', 't05', 't06', 'g05'].includes(c.id),
  );

  it('detects invented numbers (a simulated model adds a value not in the evidence)', async () => {
    const r = await evaluateProvider(
      simulated(() => 'The current is 42 mA, far too high.'),
      subset,
      {
        kind: 'model',
        locales: ['en'],
      },
    );
    expect(r.summary.fabricatedClaims).toBeGreaterThan(0);
    expect(r.summary.rejectedByIssue.unsupported_number).toBeGreaterThan(0);
    expect(meetsPilotThresholds(r)).toMatchObject({ ok: false });
    expect(meetsPilotThresholds(r).misses).toContain('fabricatedClaims');
  });

  it('detects an all-clear on a refusal case (a simulated model reassures)', async () => {
    const r = await evaluateProvider(
      simulated(() => 'There are no issues; it works fine.'),
      subset,
      {
        kind: 'model',
        locales: ['en'],
      },
    );
    expect(r.summary.allClearOnRefusal).toBeGreaterThan(0);
    expect(meetsPilotThresholds(r).misses).toContain('allClearOnRefusal');
  });

  it('measures coverage: declining everything is a correct refusal per item but not useful', async () => {
    const r = await evaluateProvider(
      simulated(() => '', true),
      subset,
      { kind: 'model', locales: ['en'] },
    );
    expect(r.summary.fabricatedClaims).toBe(0);
    expect(r.summary.coverage).toBe(0);
    expect(meetsPilotThresholds(r).misses).toContain('coverage');
  });

  it('a well-behaved simulated model meets the proposed pilot thresholds (the bar is reachable)', async () => {
    const r = await evaluateProvider(
      simulated(
        (_, f) =>
          `${[...f.components, ...f.pins.map((p) => `GPIO${p}`)][0] ?? 'This part'}: see the cited evidence and the suggested action.`,
      ),
      subset,
      { kind: 'model', locales: ['en', 'he'] },
    );
    expect(r.summary.fabricatedClaims).toBe(0);
    expect(meetsPilotThresholds(r)).toEqual({ ok: true, misses: [] });
    expect(r.summary.meanCostUsd).toBeLessThanOrEqual(MODEL_PILOT_THRESHOLDS.meanCostUsdMax);
  });

  it('stops a run early when asked (a paid run can be capped by cost)', async () => {
    let spent = 0;
    const r = await evaluateProvider(
      simulated(() => 'See the cited evidence.'),
      subset,
      {
        kind: 'model',
        locales: ['en'],
        onRow: (row) => (spent += row.costUsd) < 0.004,
      },
    );
    expect(r.rows.length).toBeLessThan(subset.length);
  });
});
