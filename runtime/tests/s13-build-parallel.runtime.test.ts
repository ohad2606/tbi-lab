/**
 * Sprint 13 (H5) heavy check with the REAL pinned Arduino toolchain: parallel build workers
 * (`global.build.maxActive`) give exactly the images serial builds give, refuse nothing for a full
 * queue, and record per-build wait and compile times (benchmark scenarios B-1 / B-4 on whatever
 * host runs it; the host's CPU count is recorded). TBI_RUNTIME_HOME must point at a provisioned
 * runtime. Four users submit four different curated sketches at the same moment.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ESP32_ARDUINO_PROFILE } from '@tbi-lab/domain';
import { ArduinoEsp32Provider, type ArduinoProfileRecord } from '../builder/arduino.js';
import { Grants } from '../builder/grants.js';
import type { BuildResult } from '../builder/protocol.js';
import { BuildService, DEFAULT_LIMITS } from '../builder/service.js';
import { ArtifactStore } from '../builder/store.js';
import { recordEvidence } from '../harness/env.js';
import { TEST_TICKET_KEY, principalFor } from '../identity/test-gate.js';
import { Policy } from '../policy/policy.js';
import { RateLimiter } from '../policy/rate.js';
import { openPolicyConfig } from '../policy/testing.js';
import record from '../builder/profiles/esp32-arduino-3.3.12.json' with { type: 'json' };

const RT = process.env.TBI_RUNTIME_HOME ?? '';
const SKETCHES = ['TbiHcSr04', 'TbiDht22', 'TbiLcd', 'TbiGpioProof'];
const text = (name: string) =>
  readFileSync(new URL(`../firmware/arduino/${name}/${name}.ino`, import.meta.url), 'utf8');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function batch(maxActive: number) {
  const store = mkdtempSync(join('/var/tmp', 's13-store-'));
  const work = mkdtempSync(join('/var/tmp', 's13-work-'));
  dirs.push(store, work);
  const grants = new Grants(':memory:');
  const c = openPolicyConfig();
  c.global.build.maxQueued = 10;
  c.global.build.maxActive = maxActive;
  const service = new BuildService(
    [
      new ArduinoEsp32Provider({
        profile: ESP32_ARDUINO_PROFILE,
        record: record as ArduinoProfileRecord,
        home: join(RT, 'arduino'),
        retainedOutputBytes: 256 * 1024,
      }),
    ],
    new ArtifactStore({
      dir: store,
      capBytes: 256 * 1024 * 1024,
      graceMs: 0,
      onEvicted: (s) => grants.dropArtifact(s),
    }),
    work,
    DEFAULT_LIMITS,
    {
      grants,
      ticketKey: TEST_TICKET_KEY,
      systemKeys: new Set(),
      policy: new Policy(c),
      rates: new RateLimiter(':memory:'),
    },
  );
  const t0 = performance.now();
  const submitted = SKETCHES.map((name, i) => {
    const who = principalFor(`tester-${i + 1}`);
    const out = service.submit(
      {
        protocol: 'tbi-lab.build/1',
        profile: ESP32_ARDUINO_PROFILE.id,
        files: [{ name: 'sketch.ino', text: text(name) }],
      },
      who,
    );
    if ('cached' in out) throw new Error('unexpected cache hit');
    return { name, who, ...out };
  });
  await service.whenIdle();
  const wallMs = Math.round(performance.now() - t0);
  const results = submitted.map((s) => ({
    name: s.name,
    result: service.status(s.buildId, s.token, s.who)!.result as BuildResult,
  }));
  service.close();
  return { wallMs, results };
}

describe('H5: parallel real builds', () => {
  it('four simultaneous builds, serial vs two workers: same images, none refused, timings recorded', async () => {
    const serial = await batch(1);
    const parallel = await batch(2);
    const row = (b: Awaited<ReturnType<typeof batch>>) =>
      b.results.map((r) => ({
        sketch: r.name,
        ok: r.result.ok,
        sha256: r.result.artifact?.sha256 ?? null,
        queuedMs: r.result.timings.queuedMs,
        buildMs: r.result.timings.buildMs,
      }));
    const evidence = {
      cpus: availableParallelism(),
      serial: { wallMs: serial.wallMs, builds: row(serial) },
      twoWorkers: { wallMs: parallel.wallMs, builds: row(parallel) },
    };
    recordEvidence('s13-build-parallel', evidence);
    console.log(JSON.stringify(evidence, null, 1));
    for (const b of [serial, parallel]) for (const r of b.results) expect(r.result.ok).toBe(true);
    // Parallel compilation changes nothing in the output: the same bytes as serial builds.
    expect(row(parallel).map((r) => r.sha256)).toEqual(row(serial).map((r) => r.sha256));
  }, 1_200_000);
});
