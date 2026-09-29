/**
 * Sprint 7 heavy acceptance: the build service with the REAL pinned Arduino toolchain
 * (TBI_RUNTIME_HOME must point at a provisioned runtime; run with `npm run test:runtime --
 * s7-build`). Not part of routine CI: a cold build takes ~30 s on the dev host.
 *
 * - Reproducibility gate: the same input built three times, each through a FRESH service with an
 *   empty store and new job directories, must give bit-identical artifacts. Whether they equal
 *   the R1-provisioned reference images is recorded, not required (the sketch name and build
 *   path differ from provisioning).
 * - After eviction, the same source compiles afresh into a bit-identical artifact.
 * - A compiler error gives line-mapped diagnostics and no artifact.
 * - A build over the hard timeout is killed with every process and temporary file gone.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ESP32_ARDUINO_PROFILE } from '@tbi-lab/domain';
import { ArduinoEsp32Provider, type ArduinoProfileRecord } from '../builder/arduino.js';
import type { BuildResult } from '../builder/protocol.js';
import { BuildService, DEFAULT_LIMITS, type ServiceLimits } from '../builder/service.js';
import { ArtifactStore } from '../builder/store.js';
import record from '../builder/profiles/esp32-arduino-3.3.12.json' with { type: 'json' };

const RT = process.env.TBI_RUNTIME_HOME ?? '';
const HOME = join(RT, 'arduino');
const LOCK = JSON.parse(
  readFileSync(new URL('../firmware/artifacts.lock.json', import.meta.url), 'utf8'),
) as { artifacts: Record<string, { sha256: string }> };
const sketch = (name: string) =>
  readFileSync(new URL(`../firmware/arduino/${name}/${name}.ino`, import.meta.url), 'utf8');

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshService(limits: Partial<ServiceLimits> = {}, capBytes = 256 * 1024 * 1024) {
  // Disk-backed, like the job directories: 4 MiB images do not belong on the RAM-backed /tmp.
  const store = mkdtempSync(join('/var/tmp', 's7-store-'));
  const work = mkdtempSync(join('/var/tmp', 's7-work-'));
  dirs.push(store, work);
  const provider = new ArduinoEsp32Provider({
    profile: ESP32_ARDUINO_PROFILE,
    record: record as ArduinoProfileRecord,
    home: HOME,
    retainedOutputBytes: 256 * 1024,
  });
  const service = new BuildService(
    [provider],
    new ArtifactStore({ dir: store, capBytes, graceMs: 0 }),
    work,
    { ...DEFAULT_LIMITS, ...limits },
  );
  return { service, provider, store, work };
}

async function build(service: BuildService, text: string): Promise<BuildResult> {
  const out = service.submit({
    protocol: 'tbi-lab.build/1',
    profile: ESP32_ARDUINO_PROFILE.id,
    files: [{ name: 'sketch.ino', text }],
  });
  if ('cached' in out) return out.cached;
  await service.whenIdle();
  return service.status(out.buildId, out.token)!.result!;
}

/** Toolchain processes still alive: those whose program (argv[0]) lives in the toolchain. */
function toolchainProcesses(): string[] {
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => (l.split(/\s+/)[1] ?? '').startsWith(`${HOME}/`));
}

const evidence: Record<string, unknown> = {};

describe.skipIf(!RT)('S7 build service with the real pinned toolchain', () => {
  it('verifies the installed toolchain against its pins', async () => {
    await expect(freshService().provider.verifyToolchain()).resolves.toBeUndefined();
  });

  for (const [name, lockName] of [
    ['TbiGpioProof', 'TbiGpioProof'],
    ['TbiBanks', 'TbiBanks'],
  ] as const) {
    it(`reproducibility gate: ${name} built three times from clean state is bit-identical`, async () => {
      const shas: string[] = [];
      const ms: number[] = [];
      for (let i = 0; i < 3; i++) {
        const { service, work } = freshService();
        const t0 = Date.now();
        const r = await build(service, sketch(name));
        ms.push(Date.now() - t0);
        expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
        expect(r.artifact!.bytes).toBe(4 * 1024 * 1024);
        expect(r.features).toEqual({
          internalPull: [],
          gpioInterrupt: [],
          restart: false,
          unsupported: [],
        });
        expect(readdirSync(work)).toEqual([]); // job directory removed
        shas.push(r.artifact!.sha256);
      }
      expect(new Set(shas).size).toBe(1);
      const lock = LOCK.artifacts[lockName]!.sha256;
      evidence[name] = {
        sha256: shas[0],
        buildMs: ms,
        equalsR1Lock: shas[0] === lock,
        r1Lock: lock,
      };
      writeFileSync(
        join(RT, 's7-reproducibility.json'),
        JSON.stringify({ measuredAt: new Date().toISOString(), ...evidence }, null, 2),
      );
    });
  }

  it('after eviction the same source is compiled afresh into a bit-identical artifact', async () => {
    // One service with a store of one image: the second sketch's artifact evicts the first.
    const { service, store } = freshService({}, 4 * 1024 * 1024);
    const blink = sketch('TbiGpioProof');
    const first = await build(service, blink);
    expect(first.ok, JSON.stringify(first.diagnostics)).toBe(true);
    const sha = first.artifact!.sha256;
    expect((await build(service, sketch('TbiBanks'))).ok).toBe(true);
    expect(existsSync(join(store, `${sha}.bin`))).toBe(false);
    expect(service.lookup(first.key)).toBeNull();
    const out = service.submit({
      protocol: 'tbi-lab.build/1',
      profile: ESP32_ARDUINO_PROFILE.id,
      files: [{ name: 'sketch.ino', text: blink }],
    });
    expect('cached' in out).toBe(false); // a real compile, not the old record
    await service.whenIdle();
    const rebuilt = 'cached' in out ? out.cached : service.status(out.buildId, out.token)!.result!;
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.artifact).toEqual(first.artifact);
    const onDisk = createHash('sha256')
      .update(readFileSync(join(store, `${sha}.bin`)))
      .digest('hex');
    expect(onDisk).toBe(sha);
    evidence['rebuildAfterEviction'] = { sha256: sha, identical: true };
  });

  it('a compiler error is reported by line with no artifact', async () => {
    const { service } = freshService();
    const r = await build(service, 'void setup() {\n  pinMode(2, OUTPUT)\n}\nvoid loop() {}\n');
    expect(r.ok).toBe(false);
    expect(r.failure).toBe('compile_error');
    expect(r.artifact).toBeUndefined();
    expect(r.diagnostics[0]).toMatchObject({ severity: 'error', file: 'sketch.ino', line: 2 });
    expect(JSON.stringify(r)).not.toContain('/var/tmp'); // no server paths leak
  });

  it('a build over the hard timeout is killed: no toolchain process and no temporary file remain', async () => {
    const { service, work } = freshService({ timeoutMs: 4_000 });
    const r = await build(service, sketch('TbiBanks'));
    expect(r).toMatchObject({ ok: false, failure: 'timeout' });
    expect(readdirSync(work)).toEqual([]);
    // The whole process group was killed; give the kernel a moment to reap it.
    await expect.poll(toolchainProcesses, { timeout: 5_000 }).toEqual([]);
  });
});
