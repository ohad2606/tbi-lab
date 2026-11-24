/**
 * Sprint 23C: the dedicated admin service's process entry (docs/alpha/ADMIN-AND-FEEDBACK.md),
 * running as its own user `tbi-admin`. It serves the owner's ACCOUNT administration only
 * (accounts.ts), behind the gate at `/admin-api/*`, and is the only writer of the root helper's
 * spool. No QEMU, no build, no user content, no network: a unix socket in, the helper's files
 * and the Session Host's health-only socket out.
 *
 *   TBI_ADMIN_LISTEN       `unix:/run/<N>-admin/api.sock` (deployment) or `host:port` (development;
 *                          default 127.0.0.1:7410)
 *   TBI_SOCKET_GID         the socket's group (tbi-sock-admin: this service and the proxy only)
 *   TBI_IDENTITY_KEY_FILE, TBI_IDENTITY_ISSUER, TBI_IDENTITY_HEADER   gate identity (identity/)
 *   TBI_ACCESS_VIEW        the helper's view/access.json (required): authorization and the owner
 *   TBI_ADMIN_DIR          the helper's base directory (required): spool/, results/, view/accounts.json
 *   TBI_RUNTIME_HEALTH     the Session Host's health-only socket, for the live-session count
 *                          (`unix:/run/<N>-runtime/health.sock`); unset: capacity answers 503
 *   TBI_ADMIN_USAGE        admin app: the usage exporter's file (default <TBI_ADMIN_DIR>/usage/usage.json)
 *   TBI_ADMIN_AUDIT_VIEW   admin app: the helper's audit view (default <TBI_ADMIN_DIR>/view/audit.json)
 *
 *   TBI_SIGNUP_ADMIN       `1` enables the sign-up approval routes + purge (TBI-022; see signup/admin-wiring.ts); off by default.
 *                          A bad sign-up setting or store directory disables ONLY those routes (one log line
 *                          with a class code); the account administration starts regardless.
 *   TBI_FUNNEL_COUNTERS    `1` counts `signup_approved` per day (K12, funnel/counters.ts) into TBI_FUNNEL_DIR
 *                          (absolute, 0700, this service's own); off by default; a bad setting turns only them off.
 *
 * SIGTERM / SIGINT: stop accepting requests, wait (at most 5 s) for an approval email being sent
 * by the drain, and exit.
 */
import { accessViewFromEnv } from '../identity/access.js';
import { describeListen, listen, parseListen, socketGidFromEnv } from '../identity/listen.js';
import { identityFromEnv } from '../identity/principal.js';
import { AdminSpool, adminConfigFromEnv, createAdminServer } from './accounts.js';
import { healthCapacity } from './capacity.js';
import { funnelCountersFromEnv } from './funnel/counters.js';
import { signupWiringFromEnv } from './signup/admin-wiring.js';
import { AdminViews, viewPathsFromEnv } from './views.js';

const where = parseListen(process.env.TBI_ADMIN_LISTEN ?? '127.0.0.1:7410');
const socketGid = socketGidFromEnv();
const identity = identityFromEnv();
const access = accessViewFromEnv();
if (!access) throw new Error('TBI_ACCESS_VIEW is required');
const config = adminConfigFromEnv();
if (!config) throw new Error('TBI_ADMIN_DIR is required');
const health = process.env.TBI_RUNTIME_HEALTH ? parseListen(process.env.TBI_RUNTIME_HEALTH) : null;
access.start();

const spool = new AdminSpool(config);
const log = (l: string) => process.stdout.write(`tbi-admin: ${l}\n`);
// K12: funnel counters (`signup_approved`), off unless TBI_FUNNEL_COUNTERS=1; never fatal.
const counters = await funnelCountersFromEnv(process.env, { log });
// TBI-022: sign-up approval routes and the retention purge, off unless TBI_SIGNUP_ADMIN=1.
// Never throws: a broken sign-up setup is logged and leaves only the sign-up routes out (404).
const signupWiring = await signupWiringFromEnv(process.env, spool, {
  fetch: (u, i) => fetch(u, i),
  log,
  counters,
  // BETA-G1 (off unless TBI_SIGNUP_AUTO_APPROVE=1): auto-approve submits as the recorded owner.
  autoActor: () => access.current?.owner.principal ?? null,
});
const stopPurge = signupWiring?.startPurge();
const stopDrain = signupWiring?.startDrain();
const stopAuto = signupWiring?.startAutoApprove();

const server = createAdminServer(identity, {
  access,
  spool,
  ...(signupWiring ? { signups: signupWiring.signups } : {}),
  capacity: health ? healthCapacity(health) : async () => null,
  views: new AdminViews(viewPathsFromEnv(config.dir)),
});

const DRAIN_STOP_WAIT_MS = 5_000;
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  access.stop();
  stopPurge?.();
  // An approval email being sent now is allowed to finish and be saved (bounded: 5 s).
  const drained = Promise.race([
    Promise.all([stopDrain?.(), stopAuto?.()]).then(() => counters?.flush()),
    new Promise<void>((r) => setTimeout(r, DRAIN_STOP_WAIT_MS).unref()),
  ]);
  server.close(() => void drained.then(() => process.exit(0)));
  server.closeAllConnections();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

await listen(server, where, socketGid);
process.stdout.write(`tbi-admin listening on ${describeListen(where)}\n`);
