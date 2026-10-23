import { openAccessPolicy } from '../../../runtime/policy/testing.js';
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
import { mkdtempSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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
import { Grants } from '../../../runtime/builder/grants.js';
import { systemSourceKeys } from '../../../runtime/builder/system-sources.js';
import { E2E_IDENTITY, E2E_TICKET_KEY } from './identity.js';
import { ownedTempDir, removeOwnedTempDir, sweepStaleTempDirs } from './temp-dirs.js';

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
  // Exploration Foundation L3: the esp32-logic-quad-and example's sketch.
  logicQuad: sha(standInImage('LogicQuadAnd')),
  // Sprint 20 logic example D: the esp32-logic-override example's sketch.
  logicOverride: sha(standInImage('LogicOrOverride')),
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
  LogicQuadAnd: readFileSync(
    new URL('../../tests/exampleSketches/LogicQuadAnd.ino', import.meta.url),
    'utf8',
  ),
  LogicOrOverride: readFileSync(
    new URL('../../tests/exampleSketches/LogicOrOverride.ino', import.meta.url),
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

/** Everything this process creates lives under one owned parent (fixtures/temp-dirs.ts). */
const PARENT_PREFIX = 'tbi-fake-build-service-';
let parent: string | null = null;

/** Remove parents left by fake build services that are no longer running. */
export const sweepStaleFakeBuildDirs = (base?: string) => sweepStaleTempDirs(PARENT_PREFIX, base);

/** Remove every directory this process created (the store and job directories). */
export function removeFakeBuildDirs(): void {
  if (parent) removeOwnedTempDir(parent);
  parent = null;
}

/**
 * A fresh service: empty store, no build records (test control, before each test). `capImages`
 * shrinks the store so that publishing more images evicts the least recently used (no grace).
 * The previous service's directories are removed.
 */
let currentGrants: Grants | null = null;
export function resetFakeBuildService(capImages?: number): { store: string; work: string } {
  currentGrants?.close();
  currentGrants = null;
  removeFakeBuildDirs();
  parent = ownedTempDir(PARENT_PREFIX);
  const dirs = {
    store: mkdtempSync(join(parent, 'store-')),
    work: mkdtempSync(join(parent, 'build-')),
  };
  let grantsRef: Grants | null = null;
  const store = new ArtifactStore({
    dir: dirs.store,
    capBytes: (capImages ?? 16) * IMAGE_BYTES,
    graceMs: capImages ? 0 : 60_000,
    onEvicted: (sha) => grantsRef?.dropArtifact(sha),
  });
  const grants = new Grants(join(parent, 'grants.db'));
  const service = new BuildService([new ScriptedProvider()], store, dirs.work, DEFAULT_LIMITS, {
    grants,
    ticketKey: E2E_TICKET_KEY,
    systemKeys: systemSourceKeys(), // as deployed: the curated examples are shared records
    ...openAccessPolicy(),
  });
  grantsRef = grants;
  currentGrants = grants;
  current = createBuildHttpServer(service, {
    leaseMs: 60_000,
    identity: E2E_IDENTITY,
  });
  return dirs;
}

export async function startFakeBuildService(port: number): Promise<void> {
  resetFakeBuildService(); // sweeps parents of processes that no longer run
  const server = createServer((req, res) => current!.emit('request', req, res));
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
}
