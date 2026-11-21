/**
 * TBI-018 slice 3a: opt-in construction of the plans engine for tbi-assist.
 *
 *   TBI_PLANS_CONFIG  path of a plans config file (JSON overrides, strict parse). Unset: no engine, nothing
 *                     is read or created. Set: the file must parse and metering.enabled must be true,
 *                     otherwise this throws (fail closed; metering never turns off silently).
 *   TBI_PLANS_STATE   journal directory; default `${TBI_ASSIST_STATE ?? /var/lib/tbi-assist}/plans`.
 *
 * Error messages never carry file content, keys or principals.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from './config.js';
import { PlansEngine } from './reserve.js';
import type { AlertSink, SpendAlert } from './spend.js';
import { JournalStore } from './store.js';
import type { Clock } from './time.js';

export class PlansBootError extends Error {}

export interface BootDeps {
  clock?: Clock;
  alerts?: AlertSink;
}

/** Alert sink: one JSON line on stderr (journal). No network. */
export function stderrAlertSink(
  write: (s: string) => void = (s) => void process.stderr.write(s),
): AlertSink {
  return {
    alert(a: SpendAlert) {
      write(`${JSON.stringify({ event: 'plans_alert', ...a })}\n`);
    },
  };
}

export async function bootPlans(
  env: Record<string, string | undefined>,
  deps: BootDeps = {},
): Promise<PlansEngine | undefined> {
  const file = env.TBI_PLANS_CONFIG;
  if (!file) return undefined;
  let cfg;
  try {
    cfg = parseConfig(JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    const why = e instanceof Error ? e.constructor.name : 'error';
    throw new PlansBootError(`plans config unusable (${why}); refusing to start`);
  }
  if (!cfg.metering.enabled)
    throw new PlansBootError('plans config opted in but metering.enabled is not true');
  const dir = env.TBI_PLANS_STATE ?? join(env.TBI_ASSIST_STATE ?? '/var/lib/tbi-assist', 'plans');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return await PlansEngine.open(new JournalStore(join(dir, 'journal.log')), {
      config: cfg,
      clock: deps.clock ?? { now: () => Date.now() },
      alerts: deps.alerts ?? stderrAlertSink(),
    });
  } catch {
    throw new PlansBootError('plans state unusable; refusing to start');
  }
}
