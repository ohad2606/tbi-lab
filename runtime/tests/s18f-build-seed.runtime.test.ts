/**
 * Sprint 18F, build performance on the REAL pinned toolchain: the Arduino core seed.
 *
 * Every job runs in the SAME directory path, as in the sandbox (`/job`): the provider with a seed
 * directory, the local runner, one job at a time.
 * - cold: the first curated build compiles the core (no seed yet) and leaves the seed;
 * - seeded: every curated example (and a user sketch) built again from the seed gives exactly the
 *   bytes of its cold build in a fresh seed-less configuration;
 * - a user's (non-curated) build never leaves a seed;
 * - a different configuration (another profile hash) does not take the seed;
 * - latency: cold, seeded unchanged, seeded after a one-line edit (recorded as evidence).
 * Skipped unless TBI_RUNTIME_HOME is set (needs the provisioned toolchain).
 */
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ESP32_ARDUINO_PROFILE } from '@tbi-lab/domain';
import { ArduinoEsp32Provider, type ArduinoProfileRecord } from '../builder/arduino.js';
import record from '../builder/profiles/esp32-arduino-3.3.12.json' with { type: 'json' };
import { systemBuildRequests } from '../builder/system-sources.js';
import { recordEvidence } from '../harness/env.js';

const RT = process.env.TBI_RUNTIME_HOME ?? '';
const root = RT ? join('/var/tmp', `s18f-seed-${process.pid}`) : '';
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function provider(seeds: string | undefined, rec = record as ArduinoProfileRecord) {
  return new ArduinoEsp32Provider({
    profile: ESP32_ARDUINO_PROFILE,
    record: rec,
    home: join(RT, 'arduino'),
    retainedOutputBytes: 256 * 1024,
    ...(seeds ? { coreSeeds: seeds } : {}),
  });
}

/** One build in the fixed job path; returns the image hash, the time and the seed state. */
async function build(
  p: ArduinoEsp32Provider,
  text: string,
  curated: boolean,
): Promise<{ sha: string; ms: number; seed: string | undefined }> {
  const dir = join(root, 'job');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const out = await p.build({
    dir,
    files: [{ name: 'sketch.ino', text }],
    signal: new AbortController().signal,
    curated,
  });
  const ms = Date.now() - t0;
  expect(out.ok, JSON.stringify(out.diagnostics)).toBe(true);
  const sha = createHash('sha256').update(readFileSync(out.imagePath!)).digest('hex');
  rmSync(dir, { recursive: true, force: true });
  return { sha, ms, seed: out.coreSeed };
}

const USER =
  'void setup() {\n  pinMode(2, OUTPUT);\n}\nvoid loop() {\n  digitalWrite(2, !digitalRead(2));\n  delay(250);\n}\n';

describe.skipIf(!RT)('S18F core seed on the real toolchain', () => {
  it('seeded builds are byte-identical to cold builds for every curated example; latency', async () => {
    const seeds = join(root, 'seeds');
    mkdirSync(seeds, { recursive: true });
    // The Arduino toolchain's seed: the curated Arduino sketches (the MicroPython examples, curated
    // since Sprint 24, are built by the MicroPython profile, which has no core to seed).
    const curated = systemBuildRequests()
      .filter((r) => r.profile === ESP32_ARDUINO_PROFILE.id)
      .map((r) => r.files[0]!.text);
    const sweep = curated.find((t) => t.includes('servo'))!;
    const seeded = provider(seeds);
    const evidence: Record<string, unknown> = {};

    // A user's build with no seed: cold, and it leaves none.
    const userCold = await build(seeded, USER, false);
    expect(userCold.seed).toBe('cold');
    expect(readdirSync(seeds)).toEqual([]);
    expect(await seeded.hasCoreSeed(join(root, 'job'))).toBe(false);
    // The first curated build: cold, leaves the seed.
    const first = await build(seeded, sweep, true);
    expect(first.seed).toBe('cold');
    expect(readdirSync(seeds).filter((n) => !n.startsWith('.'))).toHaveLength(1);
    expect(await seeded.hasCoreSeed(join(root, 'job'))).toBe(true);
    // The local runner's job path varies with the directory: another path has no seed.
    expect(await seeded.hasCoreSeed(join(root, 'job-elsewhere'))).toBe(false);
    evidence.coldMs = [userCold.ms, first.ms];

    // Seeded, unchanged and after a one-line edit.
    const again = await build(seeded, sweep, true);
    expect(again).toMatchObject({ sha: first.sha, seed: 'seeded' });
    const edited = sweep.replace('delay(1000);', 'delay(900);');
    const edit = await build(seeded, edited, false);
    expect(edit.seed).toBe('seeded');
    evidence.seededUnchangedMs = again.ms;
    evidence.seededEditMs = edit.ms;

    // Every curated example and the user sketch: seeded bytes == cold bytes (no seed directory).
    const cold = provider(undefined);
    const pairs: { seededMs: number; coldMs: number; sha: string }[] = [];
    for (const text of [...curated, USER, edited]) {
      const s = await build(seeded, text, false);
      const c = await build(cold, text, false);
      expect(s.seed).toBe('seeded');
      expect(c.seed).toBe('cold');
      expect(s.sha).toBe(c.sha);
      pairs.push({ seededMs: s.ms, coldMs: c.ms, sha: s.sha.slice(0, 16) });
    }
    evidence.pairs = pairs;

    // Another configuration (a different profile hash) never takes this seed.
    const other = provider(seeds, { ...(record as ArduinoProfileRecord), sourceDateEpoch: 1 });
    const o = await build(other, USER, false);
    expect(o.seed).toBe('cold');
    recordEvidence('s18f-build-seed', evidence);
  });
});
