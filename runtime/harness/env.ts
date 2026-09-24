/**
 * Where the provisioned runtime lives (runtime/provision/provision.sh). No developer-specific
 * path is assumed: everything is under $TBI_RUNTIME_HOME, defaulting to the same location the
 * provisioning script uses.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_HOME =
  process.env.TBI_RUNTIME_HOME ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'tbi-lab-runtime');

export const QEMU =
  process.env.TBI_QEMU ?? join(RUNTIME_HOME, 'qemu-current', 'bin', 'qemu-system-xtensa');

export interface RuntimeInfo {
  runtimeId: string;
  commit: string;
  tag: string;
  patches: { file: string; sha256: string }[];
}

export function runtimeInfo(): RuntimeInfo {
  return JSON.parse(readFileSync(join(RUNTIME_HOME, 'qemu-current', 'runtime.json'), 'utf8'));
}

/**
 * The pinned firmware artifacts (runtime/firmware/artifacts.lock.json): name -> sha256. The lock,
 * not the provisioned directory, defines each artifact's identity: a rebuilt firmware that is not
 * byte-identical is a different artifact and fails verification (artifacts.ts).
 */
export const ARTIFACT_LOCK: Record<string, { sha256: string; source: string }> = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'firmware', 'artifacts.lock.json'),
    'utf8',
  ),
).artifacts;

/** A pinned firmware artifact: its content-addressed path and its sha256 (the identity). */
export function artifact(name: string): { path: string; sha256: string } {
  const pinned = ARTIFACT_LOCK[name];
  if (!pinned) throw new Error(`firmware artifact '${name}' is not in artifacts.lock.json`);
  const path = join(RUNTIME_HOME, 'artifacts', `${pinned.sha256}.bin`);
  if (!existsSync(path)) {
    throw new Error(
      `firmware artifact '${name}' (${pinned.sha256}) is not provisioned (provision.sh firmware)`,
    );
  }
  return { path, sha256: pinned.sha256 };
}

/** Write measured evidence for the R1 report to $TBI_RUNTIME_HOME/results/<name>.json. */
export function recordEvidence(name: string, data: unknown): void {
  const dir = join(RUNTIME_HOME, 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n',
  );
}

export function assertProvisioned(): void {
  if (!existsSync(QEMU)) {
    throw new Error(
      `the classic-ESP32 runtime is not provisioned at ${RUNTIME_HOME} (run runtime/provision/provision.sh all)`,
    );
  }
}
