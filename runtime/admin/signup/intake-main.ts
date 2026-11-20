/**
 * TBI-022: process entry of the public sign-up intake (docs/alpha/SIGNUP-AUTOMATION-DESIGN.md).
 * Disabled unless TBI_SIGNUP_INTAKE=1 (exit 0, one log line). Enabled but misconfigured or with a
 * missing secret: one log line with a class code (never a path or a value) and exit 1; nothing
 * listens. SIGTERM / SIGINT: stop accepting, close connections, exit.
 */
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
try {
  const running = await startIntake(cfg.config, { fetch: (u, i) => fetch(u, i), log });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log(`listening on ${cfg.config.host}:${running.port}`);
} catch (e) {
  log(`refusing to start: ${errorClass(e)}`);
  process.exit(1);
}
