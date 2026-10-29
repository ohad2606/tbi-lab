/**
 * Session Host process entry (runtime R2).
 *
 *   TBI_HOST_PORT      listening port (default 7400)
 *   TBI_HOST_BIND      bind address (default 127.0.0.1; the host is not meant to face the
 *                      internet directly: a pilot puts an authenticating proxy in front)
 *   TBI_RUNTIME_HOME   provisioned runtime (R1 provision.sh); QEMU and artifacts come from here
 *   TBI_ARTIFACTS      artifact directory override (Sprint 7: the content-addressed store the
 *                      build service publishes to); default $TBI_RUNTIME_HOME/artifacts. Only
 *                      the location changes: lookup, re-hash and private copy are unchanged.
 *   TBI_HOST_*_MS etc. operator-tunable limits (see TUNABLE below)
 *   TBI_SOCKET_GID     the API socket's group (Sprint 23B: tbi-sock-runtime, shared with the proxy only)
 *   TBI_HOST_HEALTH_LISTEN, TBI_HOST_HEALTH_SOCKET_GID   a GET /health-only socket (build service)
 *   TBI_REPORTS_DIR    Sprint 14 problem reports (reports.ts); unset: the feature is off
 *   TBI_ACCESS_VIEW    Sprint 23B access enforcement: the helper's view/access.json; unset: off
 *                      (RC4). Set: unauthorized accounts get 403, a bad view 503 (fail closed),
 *                      and the live sessions of accounts no longer authorized are ended.
 *   TBI_ADMIN_DIR      Sprint 23B owner administration and identity observations (admin.ts):
 *                      the helper's base directory; needs TBI_ACCESS_VIEW. Unset: off.
 *   TBI_ADMIN_MODE     Sprint 23C: off | reports | full (admin.ts AdminMode). Unset: the Sprint
 *                      23B rule (full with TBI_ACCESS_VIEW, off without). `reports`: the owner's
 *                      feedback only, owner from TBI_OWNER_PRINCIPAL_FILE (owner.ts); refuses
 *                      TBI_ADMIN_DIR. Inconsistent combinations refuse to start.
 *   TBI_OWNER_PRINCIPAL_FILE   `reports` mode: root:<host group> 0640, exactly one principal
 *
 * SIGTERM / SIGINT: stop accepting requests, terminate every session (host_shutdown), release
 * every child process and temporary file, then exit.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describeListen, listen, parseListen, socketGidFromEnv } from '../identity/listen.js';
import { identityFromEnv } from '../identity/principal.js';
import { loadTicketKey } from '../identity/ticket.js';
import { systemdLauncher } from '../harness/launcher.js';
import { Policy } from '../policy/policy.js';
import { RateLimiter } from '../policy/rate.js';
import { stopTemplateInstances } from '../builder/runner.js';
import { defaultConfig, type HostConfig } from './config.js';
import { SessionHost, revokeOnReload } from './host.js';
import { createHealthServer, createHttpServer } from './http.js';
import { ReportStore, reportsConfigFromEnv } from './reports.js';
import { accessViewFromEnv } from '../identity/access.js';
import { AdminSpool, IdentityObserver, adminEnvFromEnv } from './admin.js';
import { OwnerReference } from './owner.js';

// Same locations as runtime/provision/provision.sh (and harness/env.ts).
const RUNTIME_HOME =
  process.env.TBI_RUNTIME_HOME ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'tbi-lab-runtime');
const QEMU = join(RUNTIME_HOME, 'qemu-current', 'bin', 'qemu-system-xtensa');

// `unix:/path.sock` in deployment (reachable only by the internal proxy), `host:port` locally.
const where = parseListen(
  process.env.TBI_HOST_LISTEN ??
    `${process.env.TBI_HOST_BIND ?? '127.0.0.1'}:${process.env.TBI_HOST_PORT ?? 7400}`,
);
const socketGid = socketGidFromEnv();
// Sprint 23B (review H1): a health-only socket for the build service's admission check (it no
// longer shares the API socket's group). Answers GET /health only; no identity, no other route.
//   TBI_HOST_HEALTH_LISTEN       `unix:/path.sock` (or host:port); unset: none
//   TBI_HOST_HEALTH_SOCKET_GID   its group (e.g. the artifact group the build service is in)
const healthWhere = process.env.TBI_HOST_HEALTH_LISTEN
  ? parseListen(process.env.TBI_HOST_HEALTH_LISTEN)
  : null;
const healthGid = socketGidFromEnv('TBI_HOST_HEALTH_SOCKET_GID');
const identity = identityFromEnv();
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
const ticketFile = process.env.TBI_TICKET_KEY_FILE;
if (!ticketFile) throw new Error('TBI_TICKET_KEY_FILE is required');
// Sprint 8 containment: QEMU as a sandboxed per-session unit, sessions on disk.
//   TBI_HOST_SESSION_ROOT   fixed session root (e.g. /var/lib/tbi-runtime/sessions)
//   TBI_HOST_RUNTIME_UNIT   template unit prefix (e.g. tbi-qemu → tbi-qemu@<session>.service)
const sessionRoot = process.env.TBI_HOST_SESSION_ROOT;
const runtimeUnit = process.env.TBI_HOST_RUNTIME_UNIT;
// A previous host process's runtimes end with it (their sessions are gone).
if (runtimeUnit) stopTemplateInstances('/usr/bin/systemctl', runtimeUnit);
// Phase 4: plans, quotas and global limits; session-creation rates survive a restart.
//   TBI_POLICY_FILE    policy (default: built-in)    TBI_HOST_STATE   directory for rates.db
const policy = Policy.fromEnv();
const stateDir = process.env.TBI_HOST_STATE;
const config = defaultConfig({
  policy,
  ...(stateDir ? { rates: new RateLimiter(join(stateDir, 'rates.db')) } : {}),
  ...(sessionRoot ? { sessionRoot } : {}),
  ...(runtimeUnit ? { launch: systemdLauncher({ unit: runtimeUnit }) } : {}),
  ticketKey: loadTicketKey(ticketFile),
  qemu: process.env.TBI_QEMU ?? QEMU,
  artifactsDir: process.env.TBI_ARTIFACTS ?? join(RUNTIME_HOME, 'artifacts'),
  ...overrides,
});
// Sprint 12 (D-10): interactive sessions are capped at real time unless TBI_HOST_PACE says
// otherwise (`off`, or a rate such as `2` for twice real time).
const pace = process.env.TBI_HOST_PACE ?? '1';
config.paceRate = pace === 'off' ? null : Number(pace);
if (config.paceRate !== null && !(config.paceRate > 0))
  throw new Error(`TBI_HOST_PACE must be 'off' or a positive rate, not ${pace}`);
const host = new SessionHost(config);
const reportsConfig = reportsConfigFromEnv();
const reports = reportsConfig ? new ReportStore(reportsConfig) : null;
reports?.start();
// Sprint 23B: access enforcement, revocation of live sessions, administration, observations.
// Checked first: an inconsistent combination of the admin switches refuses to start.
const adminEnv = adminEnvFromEnv();
const adminConfig = adminEnv.config;
const access = accessViewFromEnv();
if (access) {
  revokeOnReload(host, access);
  access.start();
}
const server = createHttpServer(host, identity, reports, {
  access,
  adminMode: adminEnv.mode,
  owner: adminEnv.ownerFile ? new OwnerReference(adminEnv.ownerFile) : null,
  admin: adminConfig ? new AdminSpool(adminConfig) : null,
  observer: adminConfig ? new IdentityObserver(join(adminConfig.dir, 'observations')) : null,
});

// Signal handlers first: a supervisor may stop the host the moment it reports "listening", and
// an unhandled SIGTERM would skip the cleanup of its sessions and temporary root.
let stopping = false;
const healthServer = healthWhere ? createHealthServer(host) : null;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  healthServer?.close();
  healthServer?.closeAllConnections();
  access?.stop();
  void host.shutdown().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

await listen(server, where, socketGid);
if (healthServer && healthWhere) await listen(healthServer, healthWhere, healthGid);
process.stdout.write(`tbi-session-host listening on ${describeListen(where)}\n`);
