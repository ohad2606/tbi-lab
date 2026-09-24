/**
 * Firmware artifact handling (runtime R1, ADR-007 mechanism 6, V1-ARCHITECTURE §11).
 *
 * A firmware artifact is immutable and content-addressed: its identity is its sha256. It is
 * never attached to QEMU. Each session gets its own private, writable copy in a fresh 0700
 * directory; the guest may write it (NVS, a panic core dump), and those writes are discarded
 * with the directory at the end of the session. The artifact is verified before every use.
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class ArtifactError extends Error {
  constructor(
    readonly code: 'artifact_missing' | 'artifact_hash_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactError';
  }
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface SessionOverlay {
  /** Private session directory (0700), removed by `discard()`. */
  dir: string;
  /** The session's writable flash image (0600): a copy of the verified artifact. */
  flash: string;
  /** Wall time to verify the artifact and create the private copy. */
  prepareMs: number;
  /** Whether the guest changed its private copy (diagnostic; never affects the artifact). */
  guestWrote(): boolean;
  /** Delete the private copy and directory. Session writes are discarded here. */
  discard(): void;
}

export function createSessionOverlay(artifact: string, expectedSha256: string): SessionOverlay {
  const t0 = performance.now();
  let actual: string;
  try {
    actual = sha256File(artifact);
  } catch {
    throw new ArtifactError('artifact_missing', `firmware artifact not found: ${artifact}`);
  }
  if (actual !== expectedSha256) {
    throw new ArtifactError(
      'artifact_hash_mismatch',
      `firmware artifact ${artifact} is ${actual}, expected ${expectedSha256}`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'tbi-session-'));
  chmodSync(dir, 0o700);
  const flash = join(dir, 'flash.bin');
  copyFileSync(artifact, flash);
  chmodSync(flash, 0o600);
  const prepareMs = performance.now() - t0;
  return {
    dir,
    flash,
    prepareMs,
    guestWrote: () => sha256File(flash) !== expectedSha256,
    discard: () => rmSync(dir, { recursive: true, force: true }),
  };
}
