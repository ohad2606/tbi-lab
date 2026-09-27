/**
 * Test support: a fake build provider (no toolchain) that produces a deterministic "image" from
 * the source, or fails, stalls or fills its job directory on request (markers in the source).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ESP32_ARDUINO_PROFILE } from '@tbi-lab/domain';
import type { BuildProvider, JobContext, ProviderOutput } from '../provider.js';

export const IMAGE_BYTES = 4 * 1024 * 1024;

/** A merged-image-shaped buffer: 4 MiB, ESP image magic at 0x1000 and 0x10000. */
export function fakeImage(seed: string): Buffer {
  const b = Buffer.alloc(IMAGE_BYTES, 0xff);
  b[0x1000] = 0xe9;
  b[0x10000] = 0xe9;
  createHash('sha256').update(seed).digest().copy(b, 0x10010);
  return b;
}

export class FakeProvider implements BuildProvider {
  readonly profile = ESP32_ARDUINO_PROFILE;
  readonly profileHash = 'f'.repeat(64);
  builds = 0;
  dirs: string[] = [];

  async verifyToolchain(): Promise<void> {}

  async build(job: JobContext): Promise<ProviderOutput> {
    this.builds++;
    this.dirs.push(job.dir);
    const text = job.files[0]!.text;
    if (text.includes('#stall')) {
      await new Promise<void>((resolve) => job.signal.addEventListener('abort', () => resolve()));
      return {
        ok: false,
        failure: 'internal',
        diagnostics: [],
        log: { text: '', truncated: false },
      };
    }
    if (text.includes('#fill')) {
      await writeFile(join(job.dir, 'big'), Buffer.alloc(3 * 1024 * 1024));
      await new Promise<void>((resolve) => job.signal.addEventListener('abort', () => resolve()));
      return {
        ok: false,
        failure: 'internal',
        diagnostics: [],
        log: { text: '', truncated: false },
      };
    }
    if (text.includes('#error'))
      return {
        ok: false,
        failure: 'compile_error',
        diagnostics: [
          { severity: 'error', file: 'sketch.ino', line: 2, column: 3, message: 'boom' },
        ],
        log: { text: 'sketch.ino:2:3: error: boom', truncated: false },
      };
    const image = join(job.dir, 'image.bin');
    await writeFile(image, fakeImage(text));
    return {
      ok: true,
      imagePath: image,
      features: { internalPull: [], gpioInterrupt: [], restart: false, unsupported: [] },
      diagnostics: [],
      log: { text: 'ok', truncated: false },
    };
  }
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export const sketch = (text: string) => ({
  protocol: 'tbi-lab.build/1' as const,
  profile: ESP32_ARDUINO_PROFILE.id,
  files: [{ name: 'sketch.ino', text }],
});
