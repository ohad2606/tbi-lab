/**
 * Session Host process entry (runtime R2).
 *
 *   TBI_HOST_PORT      listening port (default 7400)
 *   TBI_HOST_BIND      bind address (default 127.0.0.1; the host is not meant to face the
 *                      internet directly: a pilot puts an authenticating proxy in front)
 *   TBI_RUNTIME_HOME   provisioned runtime (R1 provision.sh); QEMU and artifacts come from here
 *   TBI_HOST_*_MS etc. operator-tunable limits (see TUNABLE below)
 *
 * SIGTERM / SIGINT: stop accepting requests, terminate every session (host_shutdown), release
 * every child process and temporary file, then exit.
 */
import { join } from 'node:path';
import { QEMU, RUNTIME_HOME } from '../harness/env.js';
import { defaultConfig, type HostConfig } from './config.js';
import { SessionHost } from './host.js';
import { createHttpServer } from './http.js';

const port = Number(process.env.TBI_HOST_PORT ?? 7400);
const bind = process.env.TBI_HOST_BIND ?? '127.0.0.1';
/** Operator-tunable engineering controls (never client-controlled). */
const TUNABLE: Record<string, keyof HostConfig> = {
  TBI_HOST_LEASE_MS: 'leaseMs',
  TBI_HOST_MAX_SESSIONS: 'maxSessions',
  TBI_HOST_STARTUP_TIMEOUT_MS: 'startupTimeoutMs',
  TBI_HOST_STALL_TIMEOUT_MS: 'stallTimeoutMs',
  TBI_HOST_RETAIN_ENDED_MS: 'retainEndedMs',
  TBI_HOST_MAX_LIFETIME_MS: 'maxLifetimeMs',
};
const overrides: Partial<HostConfig> = {};
for (const [env, key] of Object.entries(TUNABLE)) {
  const v = process.env[env];
  if (v !== undefined && /^\d+$/.test(v)) (overrides as Record<string, number>)[key] = Number(v);
}
const config = defaultConfig({
  qemu: process.env.TBI_QEMU ?? QEMU,
  artifactsDir: join(RUNTIME_HOME, 'artifacts'),
  ...overrides,
});
const host = new SessionHost(config);
const server = createHttpServer(host);
server.listen(port, bind, () => {
  process.stdout.write(`tbi-session-host listening on ${bind}:${port}\n`);
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  void host.shutdown().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
