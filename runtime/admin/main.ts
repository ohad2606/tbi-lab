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
 *
 * SIGTERM / SIGINT: stop accepting requests and exit.
 */
import { accessViewFromEnv } from '../identity/access.js';
import { describeListen, listen, parseListen, socketGidFromEnv } from '../identity/listen.js';
import { identityFromEnv } from '../identity/principal.js';
import { AdminSpool, adminConfigFromEnv, createAdminServer } from './accounts.js';
import { healthCapacity } from './capacity.js';

const where = parseListen(process.env.TBI_ADMIN_LISTEN ?? '127.0.0.1:7410');
const socketGid = socketGidFromEnv();
const identity = identityFromEnv();
const access = accessViewFromEnv();
if (!access) throw new Error('TBI_ACCESS_VIEW is required');
const config = adminConfigFromEnv();
if (!config) throw new Error('TBI_ADMIN_DIR is required');
const health = process.env.TBI_RUNTIME_HEALTH ? parseListen(process.env.TBI_RUNTIME_HEALTH) : null;
access.start();

const server = createAdminServer(identity, {
  access,
  spool: new AdminSpool(config),
  capacity: health ? healthCapacity(health) : async () => null,
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  access.stop();
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

await listen(server, where, socketGid);
process.stdout.write(`tbi-admin listening on ${describeListen(where)}\n`);
