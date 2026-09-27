/**
 * Product Alpha maintenance, through the real AppStore on the real IndexedDB store
 * (fake-indexeddb): unambiguous project names and the PSU output default. Browser acceptance
 * is app/e2e/maintenance.spec.ts.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  addComponent,
  addWire,
  createProject,
  projectNameKey,
  setParam,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { ProjectStore } from '../src/persistence/store.js';
import { SimulationController } from '../src/sim/controller.js';
import { AppStore, type Preferences } from '../src/state/app.js';
import { FakeWorker, settle } from './fakeWorker.js';

async function setup(options: { factory?: IDBFactory; locale?: string } = {}) {
  const factory = options.factory ?? new IDBFactory();
  const storage = await ProjectStore.open(factory);
  const data: Record<string, string> = options.locale ? { 'tbi-lab.locale': options.locale } : {};
  const prefs: Preferences = { get: (k) => data[k] ?? null, set: (k, v) => void (data[k] = v) };
  let n = 0;
  const app = new AppStore({
    storage,
    prefs,
    languages: ['en'],
    newId: () => `m${++n}${Math.random().toString(36).slice(2, 8)}`,
    simulation: new SimulationController({ createWorker: () => new FakeWorker() }),
    autosaveDebounceMs: 1,
  });
  await app.init();
  return { app, storage, factory };
}

const names = async (storage: ProjectStore) => (await storage.list()).map((p) => p.name).sort();

/** No two projects in the library read the same. */
async function expectUnambiguous(storage: ProjectStore) {
  const keys = (await storage.list()).map((p) => projectNameKey(p.name));
  expect(new Set(keys).size).toBe(keys.length);
}

describe('project names: create', () => {
  it('refuses whitespace-, case- and Unicode-equivalent names, writing nothing', async () => {
    const { app, storage } = await setup();
    expect(await app.newProject('Café Bench')).toBe(true);
    await app.goHome();
    for (const typed of ['  café bench ', 'CAFÉ   BENCH', '‏Café Bench']) {
      expect(await app.newProject(typed), typed).toBe(false);
      expect(app.state.nameConflict).toEqual({ scope: 'create', name: typed.trim() });
      expect(app.state.screen).toBe('home');
    }
    expect(await names(storage)).toEqual(['Café Bench']);
  });

  it('stores the name exactly as typed (only surrounding whitespace is dropped)', async () => {
    const { app, storage } = await setup();
    await app.newProject('  My  BENCH ✓  ');
    expect(app.state.doc!.name).toBe('My  BENCH ✓');
    expect(await names(storage)).toEqual(['My  BENCH ✓']);
  });

  it('an empty name takes the first free default name; a conflict clears when fixed', async () => {
    const { app, storage } = await setup();
    await app.newProject('');
    await app.goHome();
    await app.newProject('   ');
    await app.goHome();
    expect(await names(storage)).toEqual(['Untitled project', 'Untitled project 2']);
    expect(app.defaultProjectName()).toBe('Untitled project 3');
    expect(await app.newProject('untitled PROJECT')).toBe(false);
    app.clearNameConflict();
    expect(app.state.nameConflict).toBeNull();
    expect(await app.newProject('Untitled project 3')).toBe(true);
  });
});

describe('project names: rename', () => {
  it('a conflicting library rename changes nothing: same name, same revision', async () => {
    const { app, storage } = await setup();
    await app.newProject('Alpha');
    await app.goHome();
    await app.newProject('Beta');
    const beta = app.state.doc!.projectId;
    await app.goHome();
    const before = await storage.load(beta);
    expect(await app.renameInLibrary(beta, ' ALPHA ')).toBe(false);
    expect(app.state.nameConflict).toEqual({ scope: 'rename', projectId: beta, name: 'ALPHA' });
    expect(await storage.load(beta)).toEqual(before); // no revision for a failed rename
    // A case change of its own name is not a conflict; the id is preserved.
    expect(await app.renameInLibrary(beta, 'BETA')).toBe(true);
    expect(((await storage.load(beta)) as ProjectDocument).name).toBe('BETA');
    expect(app.state.nameConflict).toBeNull();
  });

  it('the open project cannot be renamed to another project name either', async () => {
    const { app } = await setup();
    await app.newProject('Alpha');
    await app.goHome();
    await app.newProject('Beta');
    await app.flush();
    await app.refreshProjects();
    const doc = app.state.doc;
    expect(app.rename('alpha')).toBe(false);
    expect(app.state.doc).toBe(doc);
    expect(app.state.notice?.key).toBe('library.error.nameTaken');
    expect(app.rename('Gamma')).toBe(true);
    expect(app.state.doc!.projectId).toBe(doc!.projectId);
  });
});

describe('project names: duplicate', () => {
  it('always succeeds with deterministic copy numbering in the active locale', async () => {
    const { app, storage } = await setup();
    await app.newProject('Project');
    const id = app.state.doc!.projectId;
    await app.goHome();
    for (let i = 0; i < 3; i++) expect(await app.duplicate(id)).not.toBeNull();
    expect(await names(storage)).toEqual([
      'Project',
      'Project (copy 2)',
      'Project (copy 3)',
      'Project (copy)',
    ]);
    // A freed name is reused first: the rule depends only on the names present.
    const copy = (await storage.list()).find((p) => p.name === 'Project (copy)')!;
    await app.deleteProject(copy.projectId);
    await app.duplicate(id);
    expect(await names(storage)).toContain('Project (copy)');
    app.setLocale('he');
    await app.duplicate(id);
    await app.duplicate(id);
    expect(await names(storage)).toEqual(
      expect.arrayContaining(['Project (עותק)', 'Project (עותק 2)']),
    );
    await expectUnambiguous(storage);
  });

  it('Hebrew names number the same way', async () => {
    const { app, storage } = await setup({ locale: 'he' });
    await app.newProject('פרויקט');
    const id = app.state.doc!.projectId;
    await app.goHome();
    for (let i = 0; i < 3; i++) await app.duplicate(id);
    expect(await names(storage)).toEqual(
      ['פרויקט', 'פרויקט (עותק)', 'פרויקט (עותק 2)', 'פרויקט (עותק 3)'].sort(),
    );
  });
});

describe('project names: import', () => {
  it('a conflicting display name is imported under a copy-style name, and the user is told', async () => {
    const a = await setup();
    await a.app.newProject('Bench');
    const file = (await a.app.exportProject(a.app.state.doc!.projectId))!;

    // A different library that already has its own, unrelated "bench".
    const b = await setup();
    await b.app.newProject('bench');
    await b.app.goHome();
    expect(await b.app.importPackage(file.text)).toBe(true);
    expect(b.app.state.doc!.name).toBe('Bench (copy)');
    expect(b.app.state.notice).toMatchObject({ key: 'import.doneRenamed', tone: 'info' });
    expect(await names(b.storage)).toEqual(['Bench (copy)', 'bench']);
  });

  it('importing the same file repeatedly never creates an ambiguous name', async () => {
    const { app, storage } = await setup();
    await app.newProject('Bench');
    const file = (await app.exportProject(app.state.doc!.projectId))!;
    await app.goHome();
    for (let i = 0; i < 3; i++) expect(await app.importPackage(file.text)).toBe(true);
    expect(app.state.notice?.key).toBe('import.doneCopyRenamed');
    expect(await names(storage)).toEqual([
      'Bench',
      'Bench (copy 2)',
      'Bench (copy 3)',
      'Bench (copy)',
    ]);
    await expectUnambiguous(storage);
  });

  it('opening an example twice gives the second instance a copy-style name', async () => {
    const { app, storage } = await setup();
    await app.openExample('ohms-law');
    await app.goHome();
    await app.openExample('ohms-law');
    await expectUnambiguous(storage);
    expect((await names(storage)).length).toBe(2);
  });
});

describe('project names: legacy duplicates', () => {
  it('existing duplicate names are left untouched and remain openable', async () => {
    const factory = new IDBFactory();
    const storage = await ProjectStore.open(factory);
    const make = (id: string) =>
      createProject({ projectId: id, deviceId: 'd', name: 'Same name', appVersion: '0.1.0' });
    await storage.add(make('prj_legacy1'));
    await storage.add(make('prj_legacy2'));
    const before = [await storage.load('prj_legacy1'), await storage.load('prj_legacy2')];

    const { app } = await setup({ factory });
    expect(app.state.projects.map((p) => p.name)).toEqual(['Same name', 'Same name']);
    for (const id of ['prj_legacy1', 'prj_legacy2']) {
      await app.openProject(id);
      expect(app.state.screen).toBe('editor');
      expect(app.state.doc!.projectId).toBe(id);
      await app.goHome();
    }
    // Startup and opening rewrote nothing.
    expect([await storage.load('prj_legacy1'), await storage.load('prj_legacy2')]).toEqual(before);
    // Saving a legacy duplicate under its own name is not a conflict.
    expect(await app.renameInLibrary('prj_legacy1', 'Same name')).toBe(true);
    // The rule applies to NEW names: a third "Same name" cannot be created.
    expect(await app.newProject('same NAME')).toBe(false);
  });
});

describe('PSU output default', () => {
  const psuEnabled = (doc: ProjectDocument, id: string) =>
    doc.components.find((c) => c.id === id)!.params.outputEnabled;

  it('a new project and a newly placed supply have the output enabled', async () => {
    const { app } = await setup();
    await app.newProject('New');
    expect(psuEnabled(app.state.doc!, 'PSU1')).toBe(true);
    const placed = addComponent(app.state.doc!, 'instrument.lab_psu', { x: 200, y: 0 });
    expect(app.apply(placed)).toBe(true);
    expect(psuEnabled(app.state.doc!, 'PSU2')).toBe(true);
    expect(app.state.doc!.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('the first Run of a brand-new simple circuit sees the supply on', async () => {
    const { app } = await setup();
    await app.newProject('First run');
    let doc = app.state.doc!;
    const step = (r: { ok: boolean; doc?: ProjectDocument }) => {
      if (!r.ok) throw new Error('edit failed');
      doc = r.doc!;
    };
    const t = (component: string, terminal: string) => ({
      kind: 'terminal' as const,
      component,
      terminal,
    });
    step(addComponent(doc, 'component.resistor', { x: 140, y: 0 }));
    step(addWire(doc, t('PSU1', 'positive'), t('R1', 'a')));
    step(addWire(doc, t('R1', 'b'), t('GND1', 'ref')));
    step(addWire(doc, t('PSU1', 'negative'), t('GND1', 'ref')));
    expect(app.apply({ ok: true, doc })).toBe(true);
    app.run();
    await settle();
    const sim = app.state.sim;
    expect(sim.status).toBe('running');
    if (sim.status === 'running' && sim.outcome.ok) {
      expect(sim.outcome.components.PSU1!.mode).toBe('cv');
      expect(sim.outcome.components.R1!.current).toBeCloseTo(5 / 1000, 12);
    } else throw new Error('expected a solved circuit');
  });

  it('a stored project with the output OFF stays OFF through open, locale, export/import, duplicate and undo/redo', async () => {
    const factory = new IDBFactory();
    const storage = await ProjectStore.open(factory);
    const old = createProject({
      projectId: 'prj_old',
      deviceId: 'd',
      name: 'Old',
      appVersion: '0.1.0',
    });
    old.components[0]!.params.outputEnabled = false; // as saved before this change
    await storage.add(old);

    const { app } = await setup({ factory });
    await app.openProject('prj_old');
    expect(psuEnabled(app.state.doc!, 'PSU1')).toBe(false);
    app.setLocale('he');
    app.setLocale('en');
    expect(app.hasUnsavedChanges).toBe(false);
    expect(psuEnabled((await storage.load('prj_old')) as ProjectDocument, 'PSU1')).toBe(false);

    // Undo/redo of the output switch.
    expect(app.apply(setParam(app.state.doc!, 'PSU1', 'outputEnabled', true))).toBe(true);
    expect(app.undo()).toBe(true);
    expect(psuEnabled(app.state.doc!, 'PSU1')).toBe(false);
    expect(app.redo()).toBe(true);
    expect(psuEnabled(app.state.doc!, 'PSU1')).toBe(true);
    expect(app.undo()).toBe(true);
    await app.flush();
    expect(psuEnabled((await storage.load('prj_old')) as ProjectDocument, 'PSU1')).toBe(false);

    // Export/import and duplicate carry the stored OFF state.
    const file = (await app.exportProject('prj_old'))!;
    await app.goHome();
    const dupId = (await app.duplicate('prj_old'))!;
    expect(psuEnabled((await storage.load(dupId)) as ProjectDocument, 'PSU1')).toBe(false);
    expect(await app.importPackage(file.text)).toBe(true);
    expect(psuEnabled(app.state.doc!, 'PSU1')).toBe(false);
  });
});
