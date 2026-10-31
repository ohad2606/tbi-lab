/**
 * Build service process entry (Sprint 7).
 *
 *   TBI_BUILD_LISTEN       `unix:/path.sock` (deployment: reachable only by the internal proxy) or
 *                          `host:port` (development; default 127.0.0.1:7420)
 *   TBI_SOCKET_GID         group id given to the unix socket (mode 0660), e.g. the proxy's group
 *   TBI_IDENTITY_KEY_FILE, TBI_IDENTITY_ISSUER, TBI_IDENTITY_HEADER   gate identity (identity/)
 *   TBI_TICKET_KEY_FILE    run-ticket key shared with the Session Host (identity/ticket.ts)
 *   TBI_BUILD_STATE        private state directory (grants.db)
 *   TBI_POLICY_FILE        plans, quotas and global limits (runtime/policy; default: built-in)
 *   TBI_RUNTIME_JSON       Sprint 12: the provisioned runtime.json of the runtime tickets are
 *                          issued for; its `capabilities` turn e.g. Wire into `requires: [i2c]`
 *   TBI_RUNTIME_HEALTH     the Session Host's socket (`unix:/path`): its live sessions defer new
 *                          builds (sessions first); stale/unreachable: no new build starts
 *                          (fail closed); unset: no runtime on this host, never deferred
 *   TBI_BUILD_JOB_UNIT     template unit prefix of the per-job sandbox (e.g. tbi-build-job);
 *                          unset: tools run as child processes (development only)
 *   TBI_ARDUINO_HOME       provisioned Arduino home (bin/arduino-cli, data/), read-only
 *   TBI_ARTIFACT_STORE     shared content-addressed store (<sha>.bin), read by the Session Host
 *   TBI_BUILD_WORK         private root for per-build job directories
 *   TBI_ARTIFACT_CAP_MB    managed artifact cache size (default 256)
 *   TBI_ARTIFACT_LEASE_MS  lease length before a Run (default 600000)
 *
 * The toolchain is verified against its pins at start; the service refuses to run otherwise.
 * SIGTERM: stop accepting requests; job directories are removed by each job's cleanup and by the
 * sweep at the next start.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ESP32_ARDUINO_PROFILE, ESP32_MICROPYTHON_PROFILE } from '@tbi-lab/domain';
import { describeListen, listen, parseListen } from '../identity/listen.js';
import { identityFromEnv } from '../identity/principal.js';
import { loadTicketKey } from '../identity/ticket.js';
import { Policy } from '../policy/policy.js';
import { RateLimiter } from '../policy/rate.js';
import { Grants } from './grants.js';
import { watchLiveSessions } from './live-sessions.js';
import { SandboxToolRunner } from './runner.js';
import { systemBuildRequests, systemSourceKeys } from './system-sources.js';
import { pruneCoreSeeds } from './coreSeed.js';
import { ArduinoEsp32Provider, type ArduinoProfileRecord } from './arduino.js';
import {
  MICROPYTHON_REQUIRES,
  MicroPythonProvider,
  type MicroPythonProfileRecord,
} from './micropython.js';
import micropythonRecord from './profiles/esp32-micropython-1.29.json' with { type: 'json' };
import { createBuildHttpServer } from './http.js';
import { BuildService, DEFAULT_LIMITS } from './service.js';
import { ArtifactStore } from './store.js';
import { runtimeCapabilitiesFrom } from './runtimeJson.js';
import record from './profiles/esp32-arduino-3.3.12.json' with { type: 'json' };

const RUNTIME_HOME =
  process.env.TBI_RUNTIME_HOME ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'tbi-lab-runtime');
const where = parseListen(process.env.TBI_BUILD_LISTEN ?? '127.0.0.1:7420');
const socketGid = process.env.TBI_SOCKET_GID ? Number(process.env.TBI_SOCKET_GID) : undefined;
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
// Sprint 18F: the Arduino core seed, where every job sees the same path (the sandbox's /job).
const coreSeeds = jobUnit
  ? (process.env.TBI_BUILD_CORE_SEEDS ?? join(stateDir, 'core-seeds'))
  : null;
if (coreSeeds) {
  mkdirSync(coreSeeds, { recursive: true, mode: 0o750 });
  await pruneCoreSeeds(coreSeeds, new Set(), true).catch(() => undefined);
}
const provider = new ArduinoEsp32Provider({
  profile: ESP32_ARDUINO_PROFILE,
  record: record as ArduinoProfileRecord,
  home: arduinoHome,
  retainedOutputBytes: 256 * 1024,
  runtimeCapabilities,
  ...(jobUnit ? { runner: new SandboxToolRunner({ unit: jobUnit }) } : {}),
  ...(coreSeeds ? { coreSeeds } : {}),
});
// Sprint 19B (MicroPython M1): the genuine interpreter's profile, offered only where its build
// home is provisioned and matches its pins (provision.sh micropython-tools) AND the runtime this
// service issues tickets for announces `unmodelled` (Runtime v4): on an older runtime every
// MicroPython session would be refused at hello. Absent otherwise, with the reason logged; a
// MicroPython problem never stops the Arduino profile (independent review, findings 3 and 4).
const micropythonHome = process.env.TBI_MICROPYTHON_HOME ?? join(RUNTIME_HOME, 'micropython');
async function micropythonProvider(): Promise<MicroPythonProvider | null> {
  if (!existsSync(join(micropythonHome, 'micropython.json'))) return null;
  const missing = MICROPYTHON_REQUIRES.filter((c) => !runtimeCapabilities.includes(c));
  if (missing.length) {
    console.error(`MicroPython profile not offered: the runtime lacks ${missing.join(', ')}`);
    return null;
  }
  const p = new MicroPythonProvider({
    profile: ESP32_MICROPYTHON_PROFILE,
    record: micropythonRecord as MicroPythonProfileRecord,
    home: micropythonHome,
    runtimeCapabilities,
    ...(jobUnit
      ? { runner: new SandboxToolRunner({ unit: jobUnit }), viewHome: '/opt/tbi-micropython' }
      : {}),
  });
  try {
    await p.verifyToolchain();
    return p;
  } catch (e) {
    console.error(`MicroPython profile not offered: ${(e as Error).message}`);
    return null;
  }
}
const micropython = await micropythonProvider();
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
const service = new BuildService(
  micropython ? [provider, micropython] : [provider],
  store,
  workRoot,
  DEFAULT_LIMITS,
  {
    grants,
    ticketKey,
    systemKeys: systemSourceKeys(),
    policy,
    rates,
    ...(liveSessions ? { liveSessions } : {}),
  },
);
// Retention (policy): unused private grants and the artifacts nobody holds any more.
setInterval(
  () => void service.sweepRetention().catch(() => undefined),
  policy.config.global.retention.sweepIntervalMs,
).unref();
await service.sweep();
const server = createBuildHttpServer(service, { leaseMs, identity });
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
// Sprint 18F: in the background, the curated examples' shared builds (and the core seed), so
// the first user after a deploy is not the one who waits. TBI_BUILD_PREWARM=0 turns it off.
if (process.env.TBI_BUILD_PREWARM !== '0')
  void service
    .prewarm(systemBuildRequests())
    .then((n) => process.stdout.write(`${JSON.stringify({ event: 'prewarm', built: n })}\n`))
    .catch((e: Error) => process.stderr.write(`prewarm: ${e.message}\n`));
