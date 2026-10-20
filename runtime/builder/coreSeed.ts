/**
 * Core seed (Sprint 18F): the compiled Arduino-ESP32 core objects, reused by every build.
 *
 * Measured (docs/sprints/SPRINT-18F.md): ~22 s of a ~30 s build is arduino-cli compiling the
 * Arduino core (118 objects), which every job did again in its empty build directory. The core
 * does not depend on the sketch, so the service keeps ONE copy per exact compile configuration
 * and copies it into each new job's build directory before compiling.
 *
 * Correctness (never a stale object):
 * - the seed's key is a hash of everything the core compile sees from us: the profile hash
 *   (pinned toolchain files, FQBN, options), the exact compile argv and the arduino-cli
 *   configuration in the tools' view, and the environment. Any change selects another seed;
 * - the seed carries arduino-cli's own `build.options.json`: if the build options differ,
 *   arduino-cli discards the whole build directory (its own rule), and it recompiles any object
 *   whose dependency file names another path or an older object (its incremental check). A seed
 *   from another job path is measured to recompile everything, byte-identical;
 * - a seed is harvested only from a successful build of a CURATED source (the product's own
 *   sketches; a user's source never produces a seed), written to a temporary directory and
 *   renamed into place complete, and owned by the service: a job only ever gets a copy.
 * A seeded build is byte-identical to a cold one (tested on every curated example).
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, cp, lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '@tbi-lab/domain';

/** Bump when the seed's layout or harvesting rule changes. */
export const CORE_SEED_FORMAT = 1;
/** What a seed holds, relative to the build directory. */
const SEED_ENTRIES = ['core', 'build.options.json'] as const;
const MARKER = 'seed.json';

export function coreSeedKey(input: {
  profileHash: string;
  argv: readonly string[];
  config: string;
  env: Readonly<Record<string, string>>;
}): string {
  return createHash('sha256')
    .update(canonicalJson({ format: CORE_SEED_FORMAT, ...input }))
    .digest('hex');
}

const seedDir = (seeds: string, key: string) => join(seeds, key);

async function complete(seeds: string, key: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(seedDir(seeds, key), MARKER), 'utf8')) as {
      key?: string;
      format?: number;
    };
    return marker.key === key && marker.format === CORE_SEED_FORMAT;
  } catch {
    return false;
  }
}

/** Set the modes of a copied tree: directories `dir`, files `file` (symbolic links left alone). */
async function modes(path: string, dir: number, file: number): Promise<void> {
  const st = await lstat(path);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    await chmod(path, dir);
    for (const name of await readdir(path)) await modes(join(path, name), dir, file);
  } else await chmod(path, file);
}
/** Group read/write on a job's copy (the sandboxed tools share only the job's group). */
const groupWritable = (path: string) => modes(path, 0o770, 0o660);

/**
 * Copy the seed for `key` into a new job's build directory (timestamps kept: arduino-cli's
 * incremental check compares them). Returns whether a seed was applied.
 */
export async function applyCoreSeed(
  seeds: string,
  key: string,
  buildDir: string,
): Promise<boolean> {
  if (!(await complete(seeds, key))) return false;
  for (const entry of SEED_ENTRIES)
    await cp(join(seedDir(seeds, key), entry), join(buildDir, entry), {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
    });
  for (const entry of SEED_ENTRIES) await groupWritable(join(buildDir, entry));
  return true;
}

/**
 * After a successful build of a curated source: keep its core objects as the seed for `key`
 * (no-op when one exists). Written aside and renamed into place, so a seed is never partial.
 */
export async function harvestCoreSeed(
  seeds: string,
  key: string,
  buildDir: string,
): Promise<boolean> {
  if (await complete(seeds, key)) return false;
  for (const entry of SEED_ENTRIES)
    if (!(await lstat(join(buildDir, entry)).catch(() => null))) return false;
  const tmp = join(seeds, `.tmp-${randomBytes(6).toString('hex')}`);
  try {
    for (const entry of SEED_ENTRIES)
      await cp(join(buildDir, entry), join(tmp, entry), {
        recursive: true,
        preserveTimestamps: true,
      });
    await writeFile(
      join(tmp, MARKER),
      JSON.stringify({ key, format: CORE_SEED_FORMAT, createdAt: new Date().toISOString() }),
    );
    // The seed itself: the service's alone to change (it arrives with the job's group-writable
    // modes); the group may read it, never write.
    await modes(tmp, 0o750, 0o640);
    await rm(seedDir(seeds, key), { recursive: true, force: true });
    await rename(tmp, seedDir(seeds, key));
    return true;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Remove every seed but `keep` (older configurations). With `temporary`, also the leftovers of
 * an interrupted harvest (only when no harvest can be running: at service start).
 */
export async function pruneCoreSeeds(
  seeds: string,
  keep: ReadonlySet<string>,
  temporary = false,
): Promise<void> {
  for (const name of await readdir(seeds).catch(() => [] as string[]))
    if (!keep.has(name) && (temporary || !name.startsWith('.tmp-')))
      await rm(join(seeds, name), { recursive: true, force: true });
}

/** Undo a partly applied seed (the build then runs cold). */
export async function removeCoreSeed(buildDir: string): Promise<void> {
  for (const entry of SEED_ENTRIES)
    await rm(join(buildDir, entry), { recursive: true, force: true });
}
