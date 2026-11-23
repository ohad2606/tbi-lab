/**
 * ARC-MAILER: process entry of the mailer service (DRAFT; not built, packaged or installed yet).
 * Disabled unless TBI_MAILER=1 (exit 0, one log line). Enabled but misconfigured, or with an unsafe
 * queue / status directory: one log line with a reason or class code and exit 1. Runs the queue
 * once a minute; SIGTERM / SIGINT finish the run in progress, then exit.
 */
import { errorClass } from '../admin/signup/errors.js';
import { readSecretFile } from '../admin/signup/secret-file.js';
import { mailerConfigFromEnv } from './config.js';
import { Mailer } from './mailer.js';
import { ResendTransport } from './transport.js';

export const MAILER_INTERVAL_MS = 60_000;

const log = (line: string) => process.stdout.write(`tbi-mailer: ${line}\n`);
const cfg = mailerConfigFromEnv();
if (!cfg.enabled) {
  if (cfg.error) {
    log(`refusing to start: ${cfg.reason}`);
    process.exit(1);
  }
  log(`disabled: ${cfg.reason}`);
  process.exit(0);
}
const c = cfg.config;
const mailer = new Mailer(c, {
  transport: new ResendTransport({
    readKey: () => readSecretFile(c.keyFile),
    fetch: (u, i) => fetch(u, i),
  }),
  log: (line) => log(line.replace(/^mailer: /, '')),
});
try {
  await mailer.init();
} catch (e) {
  const cls = errorClass(e);
  log(`refusing to start: ${cls}`);
  // 78 (EX_CONFIG) with RestartPreventExitStatus=78 in the unit: no 10 s restart loop.
  process.exit(cls === 'status_dir_over_cap' ? 78 : 1);
}
let running: Promise<void> | null = null;
const tick = () => {
  if (running) return;
  running = mailer
    .runOnce()
    .then(
      () => undefined,
      (e: unknown) => {
        log(`run failed (${errorClass(e)})`);
      },
    )
    .finally(() => {
      running = null;
    });
};
tick();
const timer = setInterval(tick, MAILER_INTERVAL_MS);
const stop = () => {
  clearInterval(timer);
  void Promise.resolve(running).then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
log('started');
