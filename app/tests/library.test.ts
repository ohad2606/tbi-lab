/**
 * Sprint 5: project library, portable export/import and error UX through the real AppStore on
 * the real IndexedDB store (fake-indexeddb). Browser acceptance is app/e2e/sprint5.spec.ts.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  engineeringContent,
  parsePackage,
  projectHash,
  setParam,
  validateProject,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { ProjectStore, type ProjectStorage } from '../src/persistence/store.js';
import { SimulationController } from '../src/sim/controller.js';
import { AppStore, PREF_LAST_PROJECT, type Preferences } from '../src/state/app.js';
import { FakeWorker, settle } from './fakeWorker.js';

const memoryPrefs = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  const prefs: Preferences = { get: (k) => data[k] ?? null, set: (k, v) => void (data[k] = v) };
  return { prefs, data };
};

const t = (component: string, terminal: string) => ({
  kind: 'terminal' as const,
  component,
  terminal,
});

async function setup(
  options: {
    factory?: IDBFactory;
    locale?: string;
    debounceMs?: number;
    wrap?: (s: ProjectStorage) => ProjectStorage;
  } = {},
) {
  const factory = options.factory ?? new IDBFactory();
  const real = await ProjectStore.open(factory);
  const storage = options.wrap ? options.wrap(real) : real;
  let n = 0;
  const { prefs, data } = memoryPrefs(options.locale ? { 'tbi-lab.locale': options.locale } : {});
  const simulation = new SimulationController({ createWorker: () => new FakeWorker() });
  const app = new AppStore({
    storage,
    prefs,
    languages: ['en'],
    newId: () => `lib${++n}${Math.random().toString(36).slice(2, 8)}`,
    simulation,
    autosaveDebounceMs: options.debounceMs ?? 1,
  });
  await app.init();
  return { app, storage: real, prefs: data, factory };
}

/** PSU -> toggle (closed) -> 4.7 kΩ -> GND, user net name, Hebrew project name. */
async function buildCircuit(app: AppStore, name = 'מעגל ✓ Bench') {
  await app.newProject(name);
  let doc = app.state.doc!;
  const step = (r: { ok: boolean; doc?: ProjectDocument }) => {
    if (!r.ok) throw new Error('edit failed');
    doc = r.doc!;
  };
  step(addComponent(doc, 'component.toggle_switch', { x: 0, y: -20 }));
  step(addComponent(doc, 'component.resistor', { x: 140, y: 80 }));
  step(addWire(doc, t('PSU1', 'positive'), t('SW1', 'a')));
  step(addWire(doc, t('SW1', 'b'), t('R1', 'a')));
  step(addWire(doc, t('R1', 'b'), t('GND1', 'ref')));
  step(addWire(doc, t('PSU1', 'negative'), t('GND1', 'ref')));
  step(setParam(doc, 'SW1', 'closed', true));
  step(setParam(doc, 'R1', 'resistance', { value: 4700, unit: 'ohm' }));
  expect(app.apply({ ok: true, doc })).toBe(true);
  await app.flush();
  return app.state.doc!;
}

const stored = async (s: ProjectStorage, id: string) => (await s.load(id)) as ProjectDocument;

describe('project library (A1, A2, A3)', () => {
  it('rename from the library keeps the identity and advances the revision', async () => {
    const { app, storage } = await setup();
    const before = await buildCircuit(app);
    await app.goHome();
    expect(await app.renameInLibrary(before.projectId, '  Renamed — שם ✓  ')).toBe(true);
    const after = await stored(storage, before.projectId);
    expect(after.projectId).toBe(before.projectId);
    expect(after.name).toBe('Renamed — שם ✓');
    expect(after.revision.localRevision).toBe(before.revision.localRevision + 1);
    expect(engineeringContent(after)).toEqual(engineeringContent(before));
    expect(app.state.projects.find((p) => p.projectId === before.projectId)?.name).toBe(
      'Renamed — שם ✓',
    );
    expect(await app.renameInLibrary(before.projectId, '   ')).toBe(false);
    expect((await stored(storage, before.projectId)).name).toBe('Renamed — שם ✓');
  });

  it('duplicate: new identity and history; engineering state (toggle too) copied exactly', async () => {
    const { app, storage } = await setup();
    const source = await buildCircuit(app);
    await app.goHome();
    const copyId = await app.duplicate(source.projectId);
    expect(copyId).not.toBeNull();
    expect(copyId).not.toBe(source.projectId);
    const copy = await stored(storage, copyId!);
    expect(validateProject(copy)).toEqual([]);
    expect(copy.name).toBe(`${source.name} (copy)`);
    expect(copy.revision.localRevision).toBe(1);
    expect(copy.createdAt >= source.createdAt).toBe(true);
    expect(engineeringContent(copy)).toEqual(engineeringContent(source));
    expect(copy.components.find((c) => c.id === 'SW1')!.params.closed).toBe(true);
    // Independent: editing the copy never touches the source.
    await app.openProject(copyId!);
    app.apply(setParam(app.state.doc!, 'R1', 'resistance', { value: 10, unit: 'ohm' }));
    await app.flush();
    expect(await stored(storage, source.projectId)).toEqual(source);
    expect(app.state.notice).toBeNull();
  });

  it('duplicate uses the current locale for the copy name; the source name stays verbatim', async () => {
    const { app, storage } = await setup({ locale: 'he' });
    const source = await buildCircuit(app, 'Bench A');
    await app.goHome();
    const copy = await stored(storage, (await app.duplicate(source.projectId))!);
    expect(copy.name).toBe('Bench A (עותק)'); // stored exactly, no bidi control characters
    // The confirmation isolates the user's text so mixed-direction names read correctly.
    expect(app.state.notice?.params?.name).toBe('\u2068Bench A (עותק)\u2069');
  });

  it('delete removes only that project; deleting the open project returns to the library', async () => {
    const { app, storage, prefs } = await setup();
    const a = await buildCircuit(app, 'A');
    const b = await buildCircuit(app, 'B');
    expect(app.state.doc!.projectId).toBe(b.projectId);
    expect(await app.deleteProject(b.projectId)).toBe(true);
    expect(app.state.screen).toBe('home');
    expect(app.state.doc).toBeNull();
    expect(await storage.load(b.projectId)).toBeUndefined();
    expect(await stored(storage, a.projectId)).toEqual(a);
    expect(app.state.projects.map((p) => p.projectId)).toEqual([a.projectId]);
    expect(prefs[PREF_LAST_PROJECT]).toBe('');
    expect(app.state.notice).toMatchObject({ key: 'library.deleted', tone: 'info' });
  });

  it('delete while an autosave is pending never resurrects the project (A16)', async () => {
    const { app, storage } = await setup({ debounceMs: 40 });
    const doc = await buildCircuit(app, 'Pending');
    // An edit queues an autosave that has not fired yet...
    app.apply(setParam(app.state.doc!, 'R1', 'resistance', { value: 10, unit: 'ohm' }));
    expect(app.hasUnsavedChanges).toBe(true);
    // ... and the project is deleted before it fires.
    await app.deleteProject(doc.projectId);
    await new Promise((r) => setTimeout(r, 120)); // longer than the debounce: prove absence
    expect(await storage.load(doc.projectId)).toBeUndefined();
    expect((await storage.list()).some((p) => p.projectId === doc.projectId)).toBe(false);
  });

  it('projects survive a restart of the app on the same storage (A1)', async () => {
    const factory = new IDBFactory();
    const first = await setup({ factory });
    const a = await buildCircuit(first.app, 'Persistent');
    await first.app.goHome();
    const second = await setup({ factory });
    expect(second.app.state.projects.map((p) => p.name)).toContain('Persistent');
    await second.app.openProject(a.projectId);
    expect(second.app.state.doc).toEqual(a);
  });
});

describe('export / import (A4-A9)', () => {
  it('export right after an edit includes that edit, and matches the stored document', async () => {
    const { app, storage } = await setup({ debounceMs: 60 });
    await buildCircuit(app);
    app.apply(setParam(app.state.doc!, 'SW1', 'closed', false));
    const file = (await app.exportProject(app.state.doc!.projectId))!;
    const parsed = parsePackage(file.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.components.find((c) => c.id === 'SW1')!.params.closed).toBe(false);
    expect(parsed.doc).toEqual(await stored(storage, parsed.doc.projectId));
    expect(file.fileName).toBe('מעגל ✓ Bench.tbilab');
  });

  it('round trip: export -> delete -> import restores the project exactly (A5)', async () => {
    const { app, storage } = await setup();
    const doc = await buildCircuit(app);
    const file = (await app.exportProject(doc.projectId))!;
    await app.deleteProject(doc.projectId);
    expect(await storage.load(doc.projectId)).toBeUndefined();
    expect(await app.importPackage(file.text)).toBe(true);
    expect(await stored(storage, doc.projectId)).toEqual(doc);
    expect(app.state.screen).toBe('editor');
    expect(app.state.doc).toEqual(doc);
    expect(app.state.notice).toMatchObject({ key: 'import.done', tone: 'info' });
  });

  it('a colliding project id is imported as an independent copy, never overwritten (A8)', async () => {
    const { app, storage } = await setup();
    const doc = await buildCircuit(app);
    const file = (await app.exportProject(doc.projectId))!;
    app.apply(setParam(app.state.doc!, 'R1', 'resistance', { value: 1, unit: 'ohm' }));
    await app.flush();
    const local = await stored(storage, doc.projectId);
    await app.goHome();
    expect(await app.importPackage(file.text)).toBe(true);
    expect(await stored(storage, doc.projectId)).toEqual(local); // untouched
    const copy = app.state.doc!;
    expect(copy.projectId).not.toBe(doc.projectId);
    // The local project still has the same name, so the copy takes a copy-style name
    // (Product Alpha maintenance: no two projects may read the same).
    expect(copy.name).toBe(`${doc.name} (copy)`);
    expect(engineeringContent(copy)).toEqual(engineeringContent(doc));
    expect(app.state.notice).toMatchObject({ key: 'import.doneCopyRenamed', tone: 'info' });
    expect(app.state.projects).toHaveLength(2);
  });

  it('a refused package writes nothing and explains itself without internals (A7)', async () => {
    const { app, storage } = await setup();
    const doc = await buildCircuit(app);
    await app.goHome();
    const good = JSON.parse((await app.exportProject(doc.projectId))!.text);
    const before = await storage.list();
    const cases: [string, string][] = [
      ['not json', 'import.error.not_package'],
      [JSON.stringify({ ...good, formatVersion: 99 }), 'import.error.newer'],
      [
        JSON.stringify({ ...good, project: { ...good.project, name: 'tampered' } }),
        'import.error.damaged',
      ],
      [JSON.stringify({ ...good, firmware: [{}] }), 'import.error.newer'],
    ];
    for (const [text, key] of cases) {
      expect(await app.importPackage(text)).toBe(false);
      expect(app.state.notice?.key).toBe(key);
      expect(app.state.notice?.tone ?? 'error').toBe('error');
    }
    expect(await storage.list()).toEqual(before);
    expect(app.state.screen).toBe('home');
  });

  it('the project hash is the same whichever UI language exported it (A9)', async () => {
    const factory = new IDBFactory();
    const en = await setup({ factory, locale: 'en' });
    const doc = await buildCircuit(en.app);
    const fromEn = JSON.parse((await en.app.exportProject(doc.projectId))!.text);
    const he = await setup({ factory, locale: 'he' });
    expect(he.app.state.locale.code).toBe('he');
    const fromHe = JSON.parse((await he.app.exportProject(doc.projectId))!.text);
    expect(fromHe.integrity.project).toBe(fromEn.integrity.project);
    expect(fromHe.project).toEqual(fromEn.project);
    expect(fromEn.integrity.project).toBe(projectHash(doc));
  });

  it('a storage failure during import writes nothing and says so (A12)', async () => {
    const { app } = await setup({
      wrap: (s) =>
        Object.assign(Object.create(Object.getPrototypeOf(s)), s, {
          add: () => Promise.reject(Object.assign(new Error('x'), { name: 'QuotaExceededError' })),
        }),
    });
    const doc = await buildCircuit(app);
    const file = (await app.exportProject(doc.projectId))!;
    await app.deleteProject(doc.projectId);
    expect(await app.importPackage(file.text)).toBe(false);
    expect(app.state.notice?.key).toBe('storage.error.quota');
    expect(app.state.projects).toHaveLength(0);
  });
});

describe('error UX (A12)', () => {
  it('a failing save keeps the document, reports quota specifically and recovers on retry', async () => {
    let fail = false;
    const { app, storage } = await setup({
      wrap: (s) =>
        Object.assign(Object.create(Object.getPrototypeOf(s)), s, {
          save: (d: ProjectDocument) =>
            fail
              ? Promise.reject(Object.assign(new Error('x'), { name: 'QuotaExceededError' }))
              : s.save(d),
        }),
    });
    const doc = await buildCircuit(app);
    fail = true;
    app.apply(setParam(app.state.doc!, 'R1', 'resistance', { value: 10, unit: 'ohm' }));
    await app.flush();
    expect(app.state.saveState).toBe('error');
    expect(app.state.saveError).toBe('quota');
    expect(app.state.doc!.components.find((c) => c.id === 'R1')!.params.resistance).toEqual({
      value: 10,
      unit: 'ohm',
    });
    fail = false;
    await app.retrySave();
    expect(app.state.saveState).toBe('saved');
    expect(app.state.saveError).toBeNull();
    expect((await stored(storage, doc.projectId)).revision.localRevision).toBe(
      app.state.doc!.revision.localRevision,
    );
  });

  it('a delete that fails leaves the project in place with an actionable message', async () => {
    const { app, storage } = await setup({
      wrap: (s) =>
        Object.assign(Object.create(Object.getPrototypeOf(s)), s, {
          delete: () => Promise.reject(new Error('boom: /internal/path')),
        }),
    });
    const doc = await buildCircuit(app);
    await app.goHome();
    expect(await app.deleteProject(doc.projectId)).toBe(false);
    expect(app.state.notice).toEqual({ key: 'library.error.delete' });
    expect(await stored(storage, doc.projectId)).toEqual(doc);
  });

  it('a stored project that is damaged opens with a notice and leaves others usable', async () => {
    const { app, storage } = await setup();
    const good = await buildCircuit(app, 'Good');
    const bad = await buildCircuit(app, 'Bad');
    await storage.save({ ...bad, connections: [{ component: 'R99', terminal: 'a', net: 'N_1' }] });
    await app.goHome();
    await app.openProject(bad.projectId);
    expect(app.state.screen).toBe('home');
    expect(app.state.notice).toEqual({ key: 'open.error.invalid' });
    await app.openProject(good.projectId);
    expect(app.state.screen).toBe('editor');
  });

  it('unreadable storage at start-up shows the storage screen, not a crash', async () => {
    const { prefs } = memoryPrefs();
    const broken: ProjectStorage = {
      save: async () => undefined,
      add: async () => undefined,
      load: async () => undefined,
      delete: async () => undefined,
      list: () => Promise.reject(new Error('InvalidStateError')),
      getOrCreateDeviceId: async () => 'd',
    };
    const app = new AppStore({ storage: broken, prefs, languages: ['en'], newId: () => 'x' });
    await app.init();
    expect(app.state.screen).toBe('unavailable');
  });
});

describe('examples through the store (A10)', () => {
  it('each opens as a fresh, stored, valid project with suggested probes only in UI state', async () => {
    const { app, storage } = await setup();
    const ids = [
      'ohms-law',
      'voltage-divider',
      'led-current',
      'diode-polarity',
      'push-button',
      'cc-mode',
    ];
    const seen = new Set<string>();
    for (const id of ids) {
      expect(await app.openExample(id)).toBe(true);
      const doc = app.state.doc!;
      expect(seen.has(doc.projectId)).toBe(false);
      seen.add(doc.projectId);
      expect(doc.revision.localRevision).toBe(1);
      expect(await stored(storage, doc.projectId)).toEqual(doc);
      expect(app.state.suggestedProbes?.projectId).toBe(doc.projectId);
      expect(JSON.stringify(doc)).not.toContain('probe');
      // Runs immediately through the (fake-hosted) production engine.
      app.run();
      await settle();
      expect(app.state.sim.status).toBe('running');
      app.stop();
    }
    // Opening the same example again gives another independent project.
    await app.openExample('ohms-law');
    expect(seen.has(app.state.doc!.projectId)).toBe(false);
    expect(app.state.projects).toHaveLength(7);
  });

  it('the example name follows the UI language at creation; the circuit does not', async () => {
    const en = await setup({ locale: 'en' });
    const he = await setup({ locale: 'he' });
    await en.app.openExample('voltage-divider');
    await he.app.openExample('voltage-divider');
    expect(en.app.state.doc!.name).toBe('Voltage divider');
    expect(he.app.state.doc!.name).toBe('מחלק מתח');
    expect(engineeringContent(he.app.state.doc!)).toEqual(engineeringContent(en.app.state.doc!));
  });
});
