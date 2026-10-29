/**
 * Build service process entry (Sprint 7).
 *
 *   TBI_BUILD_LISTEN       `unix:/path.sock` (deployment: reachable only by the internal proxy) or
 *                          `host:port` (development; default 127.0.0.1:7420)
 *   TBI_SOCKET_GID         group id given to the unix socket (mode 0660): Sprint 23B, the build
 *                          socket's own group (tbi-sock-build), shared with the proxy only
 *   TBI_IDENTITY_KEY_FILE, TBI_IDENTITY_ISSUER, TBI_IDENTITY_HEADER   gate identity (identity/)
 *   TBI_TICKET_KEY_FILE    run-ticket key shared with the Session Host (identity/ticket.ts)
 *   TBI_BUILD_STATE        private state directory (grants.db)
 *   TBI_POLICY_FILE        plans, quotas and global limits (runtime/policy; default: built-in)
 *   TBI_RUNTIME_JSON       Sprint 12: the provisioned runtime.json of the runtime tickets are
 *                          issued for; its `capabilities` turn e.g. Wire into `requires: [i2c]`
 *   TBI_RUNTIME_HEALTH     the Session Host's (health-only, Sprint 23B) socket: its live sessions defer new
 *                          builds (sessions first); stale/unreachable: no new build starts
 *                          (fail closed); unset: no runtime on this host, never deferred
 *   TBI_BUILD_JOB_UNIT     template unit prefix of the per-job sandbox (e.g. tbi-build-job);
 *                          unset: tools run as child processes (development only)
 *   TBI_ARDUINO_HOME       provisioned Arduino home (bin/arduino-cli, data/), read-only
 *   TBI_ARTIFACT_STORE     shared content-addressed store (<sha>.bin), read by the Session Host
 *   TBI_BUILD_WORK         private root for per-build job directories
 *   TBI_ARTIFACT_CAP_MB    managed artifact cache size (default 256)
 *   TBI_ARTIFACT_LEASE_MS  lease length before a Run (default 600000)
 *   TBI_ACCESS_VIEW        Sprint 23B: the helper's view/access.json; every request but health
 *                          needs an authorized account (fail closed). Unset: off (RC4).
 *
 * The toolchain is verified against its pins at start; the service refuses to run otherwise.
 * SIGTERM: stop accepting requests; job directories are removed by each job's cleanup and by the
 * sweep at the next start.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ESP32_ARDUINO_PROFILE } from '@tbi-lab/domain';
import { describeListen, listen, parseListen, socketGidFromEnv } from '../identity/listen.js';
import { identityFromEnv } from '../identity/principal.js';
import { accessViewFromEnv } from '../identity/access.js';
import { loadTicketKey } from '../identity/ticket.js';
import { Policy } from '../policy/policy.js';
import { RateLimiter } from '../policy/rate.js';
import { Grants } from './grants.js';
import { watchLiveSessions } from './live-sessions.js';
import { SandboxToolRunner } from './runner.js';
import { systemSourceKeys } from './system-sources.js';
import { ArduinoEsp32Provider, type ArduinoProfileRecord } from './arduino.js';
import { createBuildHttpServer } from './http.js';
import { BuildService, DEFAULT_LIMITS, revokeBuildsOnReload } from './service.js';
import { ArtifactStore } from './store.js';
import record from './profiles/esp32-arduino-3.3.12.json' with { type: 'json' };

/** The `capabilities` of a provisioned runtime.json: known tokens only, sorted (fail closed). */
function runtimeCapabilitiesFrom(file: string | undefined): string[] {
  if (!file) return [];
  const caps = (JSON.parse(readFileSync(file, 'utf8')) as { capabilities?: unknown }).capabilities;
  // A runtime provisioned before Sprint 12 records no capabilities: a v1 bridge has none.
  if (caps === undefined) return [];
  if (
    !Array.isArray(caps) ||
    !caps.every((c) => typeof c === 'string' && ['i2c', 'pad-func', 'sched-input'].includes(c))
  )
    throw new Error(`${file}: no valid "capabilities" list`);
  return [...caps].sort();
}

const RUNTIME_HOME =
  process.env.TBI_RUNTIME_HOME ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'tbi-lab-runtime');
const where = parseListen(process.env.TBI_BUILD_LISTEN ?? '127.0.0.1:7420');
const socketGid = socketGidFromEnv();
const identity = identityFromEnv();
const ticketFile = process.env.TBI_TICKET_KEY_FILE;
if (!ticketFile) throw new Error('TBI_TICKET_KEY_FILE is required');
const ticketKey = loadTicketKey(ticketFile);
const stateDir = process.env.TBI_BUILD_STATE ?? join(RUNTIME_HOME, 'build-state');
const policy = Policy.fromEnv();
const rates = new RateLimiter(join(stateDir, 'rates.db'));
const liveSessions = process.env.TBI_RUNTIME_HEALTH
  ? watchLiveSessions(parseListen(process.env.TBI_RUNTIME_HEALTH))
  : undefined;
const arduinoHome = process.env.TBI_ARDUINO_HOME ?? join(RUNTIME_HOME, 'arduino');
const storeDir = process.env.TBI_ARTIFACT_STORE ?? join(RUNTIME_HOME, 'artifacts');
const workRoot = process.env.TBI_BUILD_WORK ?? join(RUNTIME_HOME, 'build-jobs');
const capBytes = Number(process.env.TBI_ARTIFACT_CAP_MB ?? 256) * 1024 * 1024;
const leaseMs = Number(process.env.TBI_ARTIFACT_LEASE_MS ?? 600_000);

// Sprint 12 (ADR-011 §5): the bridge capabilities of the runtime this service issues tickets
// for, read from that runtime's provisioned runtime.json (TBI_RUNTIME_JSON). Without it: none,
// and every facility a capability would provide stays `unsupported` (the Sprint 11 behaviour).
const runtimeCapabilities = runtimeCapabilitiesFrom(process.env.TBI_RUNTIME_JSON);
const jobUnit = process.env.TBI_BUILD_JOB_UNIT;
const provider = new ArduinoEsp32Provider({
  profile: ESP32_ARDUINO_PROFILE,
  record: record as ArduinoProfileRecord,
  home: arduinoHome,
  retainedOutputBytes: 256 * 1024,
  runtimeCapabilities,
  ...(jobUnit ? { runner: new SandboxToolRunner({ unit: jobUnit }) } : {}),
});
// Jobs of a previous process never outlive it (they would write into swept directories).
if (jobUnit) new SandboxToolRunner({ unit: jobUnit }).stopAll();
await provider.verifyToolchain();
const grants = new Grants(join(stateDir, 'grants.db'));
const store = new ArtifactStore({
  dir: storeDir,
  capBytes,
  graceMs: leaseMs,
  onEvicted: (sha) => grants.dropArtifact(sha),
});
await store.load();
// Grants recorded before Phase 4 learn their sizes (storage quota).
grants.backfillBytes(
  (sha) => store.manifest(sha)?.bytes ?? (store.isReference(sha) ? 4 * 1024 * 1024 : undefined),
);
const service = new BuildService([provider], store, workRoot, DEFAULT_LIMITS, {
  grants,
  ticketKey,
  systemKeys: systemSourceKeys(),
  policy,
  rates,
  ...(liveSessions ? { liveSessions } : {}),
});
// Retention (policy): unused private grants and the artifacts nobody holds any more.
setInterval(
  () => void service.sweepRetention().catch(() => undefined),
  policy.config.global.retention.sweepIntervalMs,
).unref();
await service.sweep();
// Sprint 23B: on every reload of the access view, the builds of accounts it no longer authorizes
// stop (deny wins, the Session Host's rule). One line with the count only.
const access = accessViewFromEnv();
if (access) revokeBuildsOnReload(service, access);
access?.start();
const server = createBuildHttpServer(service, { leaseMs, identity, access });
// Signal handlers first (see the Session Host): stop cleanly even right after start.
const stop = () => {
  server.close();
  server.closeAllConnections();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

await listen(server, where, socketGid);
process.stdout.write(
  `tbi-build listening on ${describeListen(where)} (profiles: ${service.profiles().join(', ')})\n`,
);
