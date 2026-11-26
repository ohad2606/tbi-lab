/**
 * TBI-022: process entry of the public sign-up intake (docs/alpha/SIGNUP-AUTOMATION-DESIGN.md).
 * Disabled unless TBI_SIGNUP_INTAKE=1 (exit 0, one log line). Enabled but misconfigured or with a
 * missing secret: one log line with a class code (never a path or a value) and exit 1; nothing
 * listens. SIGTERM / SIGINT: stop accepting, close connections, (counters on) flush, exit.
 * K12: TBI_FUNNEL_COUNTERS=1 + TBI_FUNNEL_DIR (absolute, private) count `signup_submitted` and
 * `signup_form_view` (form tokens issued) (funnel/counters.ts); off by default, and a bad setting
 * only turns the counters off.
 */
import { funnelCountersFromEnv } from '../funnel/counters.js';
import { closeThenFlush } from '../funnel/shutdown.js';
import { errorClass } from './errors.js';
import { intakeConfigFromEnv, startIntake } from './intake-server.js';

const log = (line: string) => process.stdout.write(`tbi-signup: ${line}\n`);
const cfg = intakeConfigFromEnv();
if (!cfg.enabled) {
  if (cfg.error) {
    log(`refusing to start: ${cfg.reason}`);
    process.exit(1);
  }
  log(`disabled: ${cfg.reason}`);
  process.exit(0);
}
// K12: funnel counters, off unless TBI_FUNNEL_COUNTERS=1; a bad setting only turns them off.
const counters = await funnelCountersFromEnv(process.env, { log });
try {
  const running = await startIntake(cfg.config, { fetch: (u, i) => fetch(u, i), log, counters });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // close() first (counts made by requests still in flight are included), then the flush, under
    // one 1.5 s deadline (funnel/shutdown.ts); a hanging close() still reaches the flush and exit.
    void closeThenFlush(() => running.close(), counters).then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log(`listening on ${cfg.config.host}:${running.port}`);
} catch (e) {
  log(`refusing to start: ${errorClass(e)}`);
  process.exit(1);
}
