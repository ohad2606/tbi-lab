/**
 * Sprint 7: program build state and the Run guard. Build results are ephemeral and matched to
 * the CURRENT source by content key; a stale or missing build is refused before any runtime
 * request; nothing builds by itself; Build is refused while an ESP32 session runs.
 */
import { describe, expect, it } from 'vitest';
import { setProgramText, type ProjectDocument } from '@tbi-lab/domain';
import { EXAMPLES } from '../src/examples/catalog.js';
import { BuildTransportError, type BuildClient, type BuildResult } from '../src/programs/client.js';
import { ProgramBuilds, programKey } from '../src/programs/state.js';
import { McuSimulation } from '../src/runtime/controller.js';
import { buildSessionRequest, resolveFirmware } from '../src/runtime/snapshot.js';
import type { RuntimeClient } from '../src/runtime/client.js';

const blink = () =>
  structuredClone(EXAMPLES.find((e) => e.id === 'esp32-blink')!.document) as ProjectDocument;

function result(key: string, over: Partial<BuildResult> = {}): BuildResult {
  return {
    key,
    profile: 'esp32-arduino-3.3.12',
    profileHash: 'f'.repeat(64),
    ok: true,
    artifact: { sha256: 'a'.repeat(64), bytes: 4194304, origin: 'build' },
    features: { internalPull: [], gpioInterrupt: [], restart: false, unsupported: [] },
    diagnostics: [],
    log: { text: '', truncated: false },
    timings: { queuedMs: 0, buildMs: 1 },
    ...over,
  };
}

function fakeBuildClient(opts: { fail?: boolean; lookup?: BuildResult | null } = {}) {
  const calls = { build: 0, lookup: 0, lease: [] as string[] };
  let release: (() => void) | null = null;
  const client = {
    async build(_profile: string, files: { name: string; text: string }[]) {
      calls.build++;
      await new Promise<void>((r) => (release = r));
      if (opts.fail) throw new BuildTransportError('busy');
      const { sourceKey } = await import('@tbi-lab/domain');
      return result(sourceKey('esp32-arduino-3.3.12', files));
    },
    async lookup() {
      calls.lookup++;
      return opts.lookup ?? null;
    },
    async lease(sha: string) {
      calls.lease.push(sha);
      return sha !== 'e'.repeat(64);
    },
  } as unknown as BuildClient;
  return { client, calls, finish: () => release?.() };
}

describe('ProgramBuilds', () => {
  it('required → building → current; an edit makes it required again (stale), never current', async () => {
    const doc = blink();
    const program = doc.programs.U1!;
    const f = fakeBuildClient();
    const builds = new ProgramBuilds({ client: f.client, sessionActive: () => false });
    expect(builds.view(doc.projectId, 'U1', program).phase).toBe('required');
    const done = builds.build(doc.projectId, 'U1', program);
    expect(builds.view(doc.projectId, 'U1', program).phase).toBe('building');
    f.finish();
    await done;
    expect(builds.view(doc.projectId, 'U1', program).phase).toBe('current');
    expect(builds.current(doc.projectId, 'U1', program)?.artifact?.sha256).toBe('a'.repeat(64));
    // One character later the build no longer belongs to the source.
    const edited = setProgramText(doc, 'U1', program.text + ' ');
    if (!edited.ok) throw new Error();
    const v = builds.view(doc.projectId, 'U1', edited.doc.programs.U1!);
    expect(v.phase).toBe('required');
    expect(v.previous?.ok).toBe(true);
    expect(builds.current(doc.projectId, 'U1', edited.doc.programs.U1!)).toBeNull();
    expect(f.calls.build).toBe(1); // nothing rebuilt by itself
  });

  it('Build is refused while an ESP32 session runs (D-S7-9); transport errors are reported, source untouched', async () => {
    const doc = blink();
    const program = doc.programs.U1!;
    let running = true;
    const f = fakeBuildClient({ fail: true });
    const builds = new ProgramBuilds({ client: f.client, sessionActive: () => running });
    expect(await builds.build(doc.projectId, 'U1', program)).toBe(false);
    expect(f.calls.build).toBe(0);
    running = false;
    const done = builds.build(doc.projectId, 'U1', program);
    f.finish();
    await done;
    const v = builds.view(doc.projectId, 'U1', program);
    expect(v).toMatchObject({ phase: 'required', error: 'busy' });
  });

  it('lookup recovers an existing build of exactly this source; forget returns to Build required', async () => {
    const doc = blink();
    const program = doc.programs.U1!;
    const f = fakeBuildClient({ lookup: result(programKey(program)) });
    const builds = new ProgramBuilds({ client: f.client, sessionActive: () => false });
    await builds.lookup(doc.projectId, 'U1', program);
    expect(builds.view(doc.projectId, 'U1', program).phase).toBe('current');
    builds.forget(doc.projectId, 'U1', 'a'.repeat(64));
    expect(builds.view(doc.projectId, 'U1', program).phase).toBe('required');
    // A lookup answer for other source is ignored.
    const g = fakeBuildClient({ lookup: result('0'.repeat(64)) });
    const other = new ProgramBuilds({ client: g.client, sessionActive: () => false });
    await other.lookup(doc.projectId, 'U1', program);
    expect(other.view(doc.projectId, 'U1', program).phase).toBe('required');
  });
});

describe('firmware resolution (the Run guard)', () => {
  const plan = (doc: ProjectDocument, build: BuildResult | null, prebuilt?: { sha256: string }) =>
    buildSessionRequest(doc, (b) =>
      resolveFirmware(doc, b, {
        build,
        ...(prebuilt
          ? { prebuilt: { ...prebuilt, bytes: 4194304, origin: 'prebuilt' as const } }
          : {}),
      }),
    );

  it('uses the current build; refuses a missing build and unmodelled features by name', () => {
    const doc = blink();
    const key = programKey(doc.programs.U1!);
    const r = plan(doc, result(key));
    expect(r.ok && r.plan.request.artifact.sha256).toBe('a'.repeat(64));
    expect(r.ok && r.plan.firmware.origin).toBe('program');
    expect(plan(doc, null)).toMatchObject({ ok: false, error: { code: 'mcu_build_required' } });
    expect(plan(doc, result(key, { ok: false, artifact: undefined }))).toMatchObject({
      ok: false,
      error: { code: 'mcu_build_required' },
    });
    const featured = result(key, {
      features: { internalPull: [4], gpioInterrupt: [], restart: true, unsupported: ['wifi'] },
    });
    expect(plan(doc, featured)).toMatchObject({
      ok: false,
      error: { code: 'mcu_unsupported_features', features: ['internal_pull', 'restart', 'wifi'] },
    });
  });

  it('an Advanced prebuilt image runs as given (no feature declaration: not analysed)', () => {
    const doc = blink();
    const r = plan(doc, null, { sha256: 'b'.repeat(64) });
    expect(r.ok && r.plan.request.artifact.sha256).toBe('b'.repeat(64));
    expect(r.ok && r.plan.firmware.origin).toBe('prebuilt');
    expect(r.ok && r.plan.request.firmwareFeatures).toBeUndefined();
  });

  it('the artifact is leased before the session is created; an evicted one means Build required', async () => {
    const doc = blink();
    const key = programKey(doc.programs.U1!);
    const creates: string[] = [];
    const client = {
      async create(req: { artifact: { sha256: string } }) {
        creates.push(req.artifact.sha256);
        throw new Error('stop here');
      },
    } as unknown as RuntimeClient;
    const leased: string[] = [];
    const run = async (sha: string) => {
      const sim = new McuSimulation({
        client,
        resolve: (d, b) =>
          resolveFirmware(d, b, {
            build: result(key, { artifact: { sha256: sha, bytes: 4194304, origin: 'build' } }),
          }),
        lease: async (fw) => {
          leased.push(fw.sha256);
          return sha !== 'e'.repeat(64);
        },
      });
      await sim.run(doc);
      return sim.state;
    };
    const evicted = await run('e'.repeat(64));
    expect(evicted).toMatchObject({ status: 'failed', failure: { code: 'mcu_build_required' } });
    expect(creates).toEqual([]); // never reached the runtime
    await run('c'.repeat(64));
    expect(leased).toEqual(['e'.repeat(64), 'c'.repeat(64)]);
    expect(creates).toEqual(['c'.repeat(64)]); // lease first, then create
  });
});
