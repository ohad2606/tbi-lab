/**
 * Build service process entry (Sprint 7).
 *
 *   TBI_BUILD_LISTEN       `unix:/path.sock` (deployment: reachable only by the internal proxy) or
 *                          `host:port` (development; default 127.0.0.1:7420)
 *   TBI_SOCKET_GID         group id given to the unix socket (mode 0660), e.g. the proxy's group
 *   TBI_IDENTITY_KEY_FILE, TBI_IDENTITY_ISSUER, TBI_IDENTITY_HEADER   gate identity (identity/)
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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ESP32_ARDUINO_PROFILE } from '@tbi-lab/domain';
import { describeListen, listen, parseListen } from '../identity/listen.js';
import { identityFromEnv } from '../identity/principal.js';
import { ArduinoEsp32Provider, type ArduinoProfileRecord } from './arduino.js';
import { createBuildHttpServer } from './http.js';
import { BuildService, DEFAULT_LIMITS } from './service.js';
import { ArtifactStore } from './store.js';
import record from './profiles/esp32-arduino-3.3.12.json' with { type: 'json' };

const RUNTIME_HOME =
  process.env.TBI_RUNTIME_HOME ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'tbi-lab-runtime');
const where = parseListen(process.env.TBI_BUILD_LISTEN ?? '127.0.0.1:7420');
const socketGid = process.env.TBI_SOCKET_GID ? Number(process.env.TBI_SOCKET_GID) : undefined;
const identity = identityFromEnv();
const arduinoHome = process.env.TBI_ARDUINO_HOME ?? join(RUNTIME_HOME, 'arduino');
const storeDir = process.env.TBI_ARTIFACT_STORE ?? join(RUNTIME_HOME, 'artifacts');
const workRoot = process.env.TBI_BUILD_WORK ?? join(RUNTIME_HOME, 'build-jobs');
const capBytes = Number(process.env.TBI_ARTIFACT_CAP_MB ?? 256) * 1024 * 1024;
const leaseMs = Number(process.env.TBI_ARTIFACT_LEASE_MS ?? 600_000);

const provider = new ArduinoEsp32Provider({
  profile: ESP32_ARDUINO_PROFILE,
  record: record as ArduinoProfileRecord,
  home: arduinoHome,
  retainedOutputBytes: 256 * 1024,
});
await provider.verifyToolchain();
const store = new ArtifactStore({ dir: storeDir, capBytes, graceMs: leaseMs });
await store.load();
const service = new BuildService([provider], store, workRoot, DEFAULT_LIMITS);
await service.sweep();
const server = createBuildHttpServer(service, { leaseMs, identity });
await listen(server, where, socketGid);
process.stdout.write(
  `tbi-build listening on ${describeListen(where)} (profiles: ${service.profiles().join(', ')})\n`,
);
const stop = () => {
  server.close();
  server.closeAllConnections();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
