/**
 * Sprint 13 OS-08 (Owner Smoke, P0): Run must not be available while a build is in progress or
 * when the firmware is stale. The rule lives in the store (`AppStore.runBlocker`), so the Run
 * button and every other caller of `run()` obey it; the simulation is never asked to start.
 * Also: an edit during a build no longer swallows the next Build click silently.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { setProgramText, sourceKey, type ProjectDocument } from '@tbi-lab/domain';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import type { BuildClient, BuildResult } from '../src/programs/client.js';
import { ProgramBuilds } from '../src/programs/state.js';
import { ProjectStore } from '../src/persistence/store.js';
import type { SimState, SimulationHost } from '../src/sim/controller.js';
import { AppStore, type Preferences } from '../src/state/app.js';

const blink = () =>
  structuredClone(EXAMPLES.find((e) => e.id === 'esp32-blink')!.document) as ProjectDocument;

function result(key: string, ok = true): BuildResult {
  return {
    key,
    profile: 'esp32-arduino-3.3.12',
    profileHash: 'f'.repeat(64),
    ok,
    ...(ok
      ? { artifact: { sha256: 'a'.repeat(64), bytes: 4194304, origin: 'build' as const } }
      : {}),
    features: { internalPull: [], gpioInterrupt: [], restart: false, unsupported: [] },
    diagnostics: [],
    log: { text: '', truncated: false },
    timings: { queuedMs: 0, buildMs: 1 },
  };
}

/** A build service whose builds finish only when the test says so. */
function slowClient(ok = true, cached: Set<string> = new Set()) {
  const pending: (() => void)[] = [];
  const client = {
    async build(profile: string, files: { name: string; text: string }[]) {
      await new Promise<void>((r) => pending.push(r));
      return result(sourceKey(profile, files), ok);
    },
    // A build of exactly this source that already exists in the service (any earlier Build of the
    // same text, e.g. by another session): the service returns it on lookup.
    async lookup(key: string) {
      return cached.has(key) ? result(key, ok) : null;
    },
    async lease() {
      return 'ticket';
    },
  } as unknown as BuildClient;
  return { client, finishOne: () => pending.shift()?.() };
}

/** A simulation host that only records Run requests. */
function recordingSim() {
  const runs: ProjectDocument[] = [];
  const sim: SimulationHost = {
    state: { status: 'stopped' } as SimState,
    active: false,
    subscribe: () => () => {},
    run: async (doc) => void runs.push(doc),
    control: () => true,
    momentary: () => true,
    stop: () => {},
    dispose: () => {},
  };
  return { sim, runs };
}

const prefs = (): Preferences => {
  const d: Record<string, string> = {};
  return { get: (k) => d[k] ?? null, set: (k, v) => void (d[k] = v) };
};

async function setup(ok = true, cached: Set<string> = new Set()) {
  const f = slowClient(ok, cached);
  const builds = new ProgramBuilds({ client: f.client, sessionActive: () => false });
  const { sim, runs } = recordingSim();
  const app = new AppStore({
    storage: await ProjectStore.open(new IDBFactory()),
    prefs: prefs(),
    languages: ['en'],
    newId: () => 'x1',
    simulation: sim,
    builds,
    buildClient: f.client,
    autosaveDebounceMs: 1,
  });
  await app.init();
  await app.newProject('OS-08');
  app.apply({ ok: true, doc: { ...blink(), projectId: app.state.doc!.projectId } });
  return { app, builds, runs, finishOne: f.finishOne };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('OS-08: Run availability follows the build state', () => {
  it('never built: Run is unavailable (build required), and run() does not start a session', async () => {
    const { app, runs } = await setup();
    expect(app.runBlocker()).toMatchObject({
      key: 'run.blocked.buildRequired',
      params: { components: '\u2066U1\u2069' }, // isolated LTR (Hebrew)
    });
    app.run();
    expect(runs).toHaveLength(0);
    expect(app.state.notice?.key).toBe('run.blocked.buildRequired');
  });

  it('during a build: unavailable; after it: available; after an edit: unavailable (stale)', async () => {
    const { app, runs, finishOne } = await setup();
    const building = app.buildProgram('U1');
    await flush();
    expect(app.runBlocker()?.key).toBe('run.blocked.building');
    app.run();
    expect(runs).toHaveLength(0);
    finishOne();
    await building;
    expect(app.runBlocker()).toBeNull();
    app.run();
    expect(runs).toHaveLength(1);
    // One character changes the code: the build is no longer of this code.
    const edited = setProgramText(app.state.doc!, 'U1', app.state.doc!.programs.U1!.text + ' ');
    if (!edited.ok) throw new Error(edited.error);
    app.apply(edited);
    expect(app.runBlocker()?.key).toBe('run.blocked.buildRequired');
    app.run();
    expect(runs).toHaveLength(1);
  });

  it('a rebuild of the same code also blocks Run until it ends', async () => {
    const { app, runs, finishOne } = await setup();
    const first = app.buildProgram('U1');
    await flush();
    finishOne();
    await first;
    const again = app.buildProgram('U1');
    await flush();
    expect(app.runBlocker()?.key).toBe('run.blocked.building');
    finishOne();
    await again;
    app.run();
    expect(runs).toHaveLength(1);
  });

  it('a failed build: unavailable, with the failure named', async () => {
    const { app, finishOne } = await setup(false);
    const b = app.buildProgram('U1');
    await flush();
    finishOne();
    await b;
    expect(app.runBlocker()).toMatchObject({ key: 'run.blocked.buildFailed' });
  });

  it('an advanced prebuilt Run is refused while a build is in progress', async () => {
    const { app, runs } = await setup();
    void app.buildProgram('U1');
    await flush();
    const file = new File([new Uint8Array(16)], 'x.bin');
    expect(await app.runPrebuilt(file)).toBe(false);
    expect(app.state.notice?.key).toBe('run.blocked.building');
    expect(runs).toHaveLength(0);
  });
});

describe('OS-08: an edit during a build', () => {
  it('shows that an older build is running; Build is refused until it ends, then works', async () => {
    const doc = blink();
    const f = slowClient();
    const builds = new ProgramBuilds({ client: f.client, sessionActive: () => false });
    const first = builds.build(doc.projectId, 'U1', doc.programs.U1!);
    const edited = setProgramText(doc, 'U1', doc.programs.U1!.text + ' ');
    if (!edited.ok) throw new Error(edited.error);
    const now = edited.doc.programs.U1!;
    expect(builds.view(doc.projectId, 'U1', now)).toMatchObject({
      phase: 'required',
      olderBuildRunning: true,
    });
    expect(await builds.build(doc.projectId, 'U1', now)).toBe(false);
    f.finishOne();
    await first;
    // The finished build is of the older code: kept as previous, never current.
    const v = builds.view(doc.projectId, 'U1', now);
    expect(v.phase).toBe('required');
    expect(v.olderBuildRunning).toBeUndefined();
    expect(v.previous?.ok).toBe(true);
    const second = builds.build(doc.projectId, 'U1', now);
    f.finishOne();
    expect(await second).toBe(true);
    expect(builds.view(doc.projectId, 'U1', now).phase).toBe('current');
  });
});

describe('OS-08: a valid cached build vs an active build vs stale firmware (DEV live finding)', () => {
  // On DEV the live check expected "no build -> Run unavailable" for an example whose exact text
  // had just been built by another run: the build service legitimately returned that build on
  // lookup, so Run was available. That is correct; these cases pin the distinction.
  it('an existing build of exactly this code (recovered by lookup) makes Run available', async () => {
    const text = blink().programs.U1!;
    const key = sourceKey(text.profile, [{ name: text.fileName, text: text.text }]);
    const { app, builds, runs } = await setup(true, new Set([key]));
    // As opening a project does (AppStore.lookupBuilds): recover an existing build, never build.
    await builds.lookup(app.state.doc!.projectId, 'U1', app.state.doc!.programs.U1!);
    expect(app.runBlocker()).toBeNull();
    app.run();
    expect(runs).toHaveLength(1);
  });

  it('a cached build of OTHER code is never used: an edit makes Run unavailable (stale)', async () => {
    const text = blink().programs.U1!;
    const key = sourceKey(text.profile, [{ name: text.fileName, text: text.text }]);
    const { app, builds } = await setup(true, new Set([key]));
    await builds.lookup(app.state.doc!.projectId, 'U1', app.state.doc!.programs.U1!);
    expect(app.runBlocker()).toBeNull();
    const edited = setProgramText(app.state.doc!, 'U1', `${text.text}// changed\n`);
    if (!edited.ok) throw new Error(edited.error);
    app.apply(edited);
    expect(app.runBlocker()?.key).toBe('run.blocked.buildRequired');
  });

  it('rebuilding code that already has a cached build blocks Run while the build is active', async () => {
    const text = blink().programs.U1!;
    const key = sourceKey(text.profile, [{ name: text.fileName, text: text.text }]);
    const { app, builds, finishOne } = await setup(true, new Set([key]));
    await builds.lookup(app.state.doc!.projectId, 'U1', app.state.doc!.programs.U1!);
    expect(app.runBlocker()).toBeNull();
    const again = app.buildProgram('U1');
    await flush();
    expect(app.runBlocker()?.key).toBe('run.blocked.building');
    finishOne();
    await again;
    expect(app.runBlocker()).toBeNull();
  });
});
