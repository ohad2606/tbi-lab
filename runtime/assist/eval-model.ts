/**
 * Sprint 28: the REAL-model evaluation runner. It has not been run: it refuses unless the AI
 * provider service's configuration is fully owner-approved (the same activation rule as the
 * service) and a hard cost limit for the run is given and fits under the approved monthly cap.
 *
 *   vite-node runtime/assist/eval-model.ts --config /etc/tbi/assist.json \
 *     --credential <file> --max-usd 0.50 [--locales en,he] [--out <dir>]
 *
 * The result is a `model` report (packages/assist/eval/harness.ts), written next to, never into,
 * the mock baseline. The run stops before the next case once --max-usd is reached.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bench } from '../../packages/assist/eval/bench.js';
import { CASES } from '../../packages/assist/eval/cases.js';
import { evaluateProvider, meetsPilotThresholds } from '../../packages/assist/eval/harness.js';
import { routeAutomatic } from '../../app/src/ui/routing.js';
import { activation, loadConfig, type AssistServiceConfig } from './config.js';
import { createProvider } from './providers.js';

export interface ModelRunPlan {
  ok: boolean;
  reasons: string[];
}

/** Whether a paid evaluation may run with this configuration and limit (never assumed). */
export function planModelRun(
  config: AssistServiceConfig,
  configError: string | undefined,
  credentialPresent: boolean,
  maxUsd: number | undefined,
): ModelRunPlan {
  if (configError) return { ok: false, reasons: [configError.split(':')[0]!] };
  const act = activation(config, { allowMock: false, credentialPresent });
  const reasons =
    act.state === 'disabled' ? [...act.reasons] : act.mode !== 'live' ? ['not_live'] : [];
  if (!(typeof maxUsd === 'number' && maxUsd > 0)) reasons.push('no_run_cost_limit');
  else if (maxUsd > (config.approvals.spendCap?.usdPerMonth ?? 0))
    reasons.push('run_limit_above_cap');
  return { ok: reasons.length === 0, reasons };
}

async function main(argv: string[]) {
  const arg = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const { config, error } = loadConfig(arg('--config'));
  const cred = arg('--credential');
  const maxUsd = arg('--max-usd') ? Number(arg('--max-usd')) : undefined;
  const plan = planModelRun(config, error, !!cred && existsSync(cred), maxUsd);
  if (!plan.ok) {
    console.error(`refused: ${plan.reasons.join(', ')}`);
    return 3;
  }
  const provider = createProvider(config, 'live', () =>
    cred ? readFileSync(cred, 'utf8').trim() : null,
  );
  if (!provider) {
    console.error('refused: no provider');
    return 3;
  }
  Bench.layout = routeAutomatic;
  let spent = 0;
  const report = await evaluateProvider(provider, CASES, {
    kind: 'model',
    locales: (arg('--locales') ?? 'en,he').split(','),
    gateway: {
      timeoutMs: config.limits.timeoutMs,
      maxRetries: 0,
      perMinute: config.limits.perPrincipalPerMinute,
    },
    onRow: (row) => {
      spent += row.costUsd;
      console.log(`${row.id} ${row.locale} ${row.ok ? 'ok' : row.error} $${spent.toFixed(4)}`);
      return spent < maxUsd!;
    },
  });
  const dir =
    arg('--out') ?? new URL('../../packages/assist/eval/results/models', import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${provider.id}-${provider.model}-${report.startedAt.slice(0, 10)}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ ...report, pilotThresholds: meetsPilotThresholds(report) }, null, 2)}\n`,
  );
  console.log(`model report: ${file} (cost $${spent.toFixed(4)})`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`)
  process.exitCode = await main(process.argv.slice(2));
