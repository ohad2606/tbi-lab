/**
 * Fake build service for ROUTINE browser tests (Sprint 7). No toolchain.
 *
 * The transport, queue, limits, cache and artifact store are the REAL ones (runtime/builder);
 * only the provider is scripted: the two curated example sketches build to fixed stand-in
 * images that the fake Session Host runs with the curated scripted MCU behaviours; a sketch
 * without `setup()` fails with a diagnostic on line 1; feature analysis is the real analyser over
 * the source (symbols inferred from tokens). Builds take ~0.4 s so "Building…" is observable.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ESP32_ARDUINO_PROFILE } from '@tbi-lab/domain';
import { analyzeFeatures } from '../../../runtime/builder/features.js';
import { createBuildHttpServer } from '../../../runtime/builder/http.js';
import type {
  BuildProvider,
  JobContext,
  ProviderOutput,
} from '../../../runtime/builder/provider.js';
import { BuildService, DEFAULT_LIMITS } from '../../../runtime/builder/service.js';
import { ArtifactStore } from '../../../runtime/builder/store.js';

const IMAGE_BYTES = 4 * 1024 * 1024;

/** A merged-image-shaped stand-in for a curated sketch's firmware. */
export function standInImage(name: string): Buffer {
  const b = Buffer.alloc(IMAGE_BYTES, 0xff);
  b[0x1000] = 0xe9;
  b[0x10000] = 0xe9;
  createHash('sha256').update(`tbi-fake-firmware:${name}`).digest().copy(b, 0x10010);
  return b;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** Artifact identities of the stand-ins, by curated sketch. */
export const STAND_IN = {
  gpioProof: sha(standInImage('TbiGpioProof')),
  banks: sha(standInImage('TbiBanks')),
};

const SKETCHES: Record<string, string> = {
  TbiGpioProof: readFileSync(
    new URL('../../../runtime/firmware/arduino/TbiGpioProof/TbiGpioProof.ino', import.meta.url),
    'utf8',
  ),
  TbiBanks: readFileSync(
    new URL('../../../runtime/firmware/arduino/TbiBanks/TbiBanks.ino', import.meta.url),
    'utf8',
  ),
};

class ScriptedProvider implements BuildProvider {
  readonly profile = ESP32_ARDUINO_PROFILE;
  readonly profileHash = sha(Buffer.from('fake-profile'));
  async verifyToolchain(): Promise<void> {}
  async build(job: JobContext): Promise<ProviderOutput> {
    await new Promise((r) => setTimeout(r, 400));
    const text = job.files[0]!.text;
    if (!/\bvoid\s+setup\s*\(/.test(text))
      return {
        ok: false,
        failure: 'compile_error',
        diagnostics: [
          {
            severity: 'error',
            file: 'sketch.ino',
            line: 1,
            column: 1,
            message: "'setup' was not declared",
          },
        ],
        log: { text: "sketch.ino:1:1: error: 'setup' was not declared", truncated: false },
      };
    const name = Object.entries(SKETCHES).find(([, src]) => src === text)?.[0];
    const image = join(job.dir, 'image.bin');
    await writeFile(image, standInImage(name ?? `custom:${sha(Buffer.from(text))}`));
    const symbols = [
      ...(/attachInterrupt/.test(text) ? ['attachInterrupt'] : []),
      ...(/WiFi\./.test(text) ? ['esp_wifi_init'] : []),
    ];
    return {
      ok: true,
      imagePath: image,
      features: analyzeFeatures({ source: text, symbols, libraries: [] }),
      sizes: { program: 272136, programMax: 1310720, data: 22116, dataMax: 327680 },
      diagnostics: [],
      log: { text: 'Sketch uses 272136 bytes (20%) of program storage space.', truncated: false },
    };
  }
}

let current: ReturnType<typeof createBuildHttpServer> | null = null;

/**
 * Temporary directories. Everything this process creates lives under one parent named after its
 * pid, removed on reset, on exit and on SIGINT/SIGTERM; a parent left by a process that was killed
 * outright (SIGKILL) is swept by the next start. `TBI_TEST_TMPDIR` moves it off a RAM-backed /tmp.
 */
const TMP_BASE = process.env.TBI_TEST_TMPDIR ?? tmpdir();
const PARENT_PREFIX = 'tbi-fake-build-service-';
let parent: string | null = null;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Remove parents left by fake build services that are no longer running. */
export function sweepStaleFakeBuildDirs(base = TMP_BASE): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(base)) {
    const m = new RegExp(`^${PARENT_PREFIX}(\\d+)-`).exec(name);
    if (!m || alive(Number(m[1]))) continue;
    rmSync(join(base, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** Remove every directory this process created (the store and job directories). */
export function removeFakeBuildDirs(): void {
  if (parent) rmSync(parent, { recursive: true, force: true });
  parent = null;
}

/**
 * A fresh service: empty store, no build records (test control, before each test). `capImages`
 * shrinks the store so that publishing more images evicts the least recently used (no grace).
 * The previous service's directories are removed.
 */
export function resetFakeBuildService(capImages?: number): { store: string; work: string } {
  removeFakeBuildDirs();
  parent = mkdtempSync(join(TMP_BASE, `${PARENT_PREFIX}${process.pid}-`));
  const dirs = {
    store: mkdtempSync(join(parent, 'store-')),
    work: mkdtempSync(join(parent, 'build-')),
  };
  const store = new ArtifactStore({
    dir: dirs.store,
    capBytes: (capImages ?? 16) * IMAGE_BYTES,
    graceMs: capImages ? 0 : 60_000,
  });
  const service = new BuildService([new ScriptedProvider()], store, dirs.work, DEFAULT_LIMITS);
  current = createBuildHttpServer(service, { leaseMs: 60_000 });
  return dirs;
}

let exitHooks = false;
export async function startFakeBuildService(port: number): Promise<void> {
  sweepStaleFakeBuildDirs();
  if (!exitHooks) {
    exitHooks = true;
    process.on('exit', removeFakeBuildDirs);
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => {
        removeFakeBuildDirs();
        process.exit(130);
      });
  }
  resetFakeBuildService();
  const server = createServer((req, res) => current!.emit('request', req, res));
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
}
