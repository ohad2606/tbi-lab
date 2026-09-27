/**
 * Build service process entry (Sprint 7).
 *
 *   TBI_BUILD_PORT         listening port (default 7420)
 *   TBI_BUILD_BIND         bind address (default 127.0.0.1: never faces the internet directly)
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
import { ArduinoEsp32Provider, type ArduinoProfileRecord } from './arduino.js';
import { createBuildHttpServer } from './http.js';
import { BuildService, DEFAULT_LIMITS } from './service.js';
import { ArtifactStore } from './store.js';
import record from './profiles/esp32-arduino-3.3.12.json' with { type: 'json' };

const RUNTIME_HOME =
  process.env.TBI_RUNTIME_HOME ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'tbi-lab-runtime');
const port = Number(process.env.TBI_BUILD_PORT ?? 7420);
const bind = process.env.TBI_BUILD_BIND ?? '127.0.0.1';
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
const server = createBuildHttpServer(service, { leaseMs });
server.listen(port, bind, () => {
  process.stdout.write(
    `tbi-build listening on ${bind}:${port} (profiles: ${service.profiles().join(', ')})\n`,
  );
});
const stop = () => {
  server.close();
  server.closeAllConnections();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
