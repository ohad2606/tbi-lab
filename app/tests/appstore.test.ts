import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { addComponent, emptySelection, validateProject } from '@tbi-lab/domain';
import { ProjectStore } from '../src/persistence/store.js';
import { AppStore, PREF_LOCALE, type Preferences } from '../src/state/app.js';

function memoryPrefs(
  initial: Record<string, string> = {},
): Preferences & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, get: (k) => data[k] ?? null, set: (k, v) => void (data[k] = v) };
}

async function setup(prefs = memoryPrefs(), factory = new IDBFactory()) {
  let n = 0;
  const storage = await ProjectStore.open(factory);
  const app = new AppStore({
    storage,
    prefs,
    languages: ['en-US'],
    newId: () => `id${++n}`,
    autosaveDebounceMs: 1,
  });
  await app.init();
  return { app, storage, prefs, factory };
}

describe('AppStore', () => {
  it('creates a valid project, persists it and lists it', async () => {
    const { app, storage } = await setup();
    expect(app.state.screen).toBe('home');
    await app.newProject('  My bench  ');
    expect(app.state.screen).toBe('editor');
    expect(app.state.doc!.name).toBe('My bench');
    expect(validateProject(await storage.load(app.state.doc!.projectId))).toEqual([]);
    await app.goHome();
    expect(app.state.projects.map((p) => p.name)).toEqual(['My bench']);
  });

  it('advances the revision on each accepted edit and autosaves it', async () => {
    const { app, storage } = await setup();
    await app.newProject('R');
    const r = addComponent(app.state.doc!, 'component.resistor', { x: 0, y: 0 });
    expect(app.apply(r)).toBe(true);
    expect(app.state.doc!.revision.localRevision).toBe(2);
    await app.flush();
    const stored = (await storage.load(app.state.doc!.projectId)) as {
      revision: { localRevision: number };
    };
    expect(stored.revision.localRevision).toBe(2);
  });

  it('a refused edit changes nothing and surfaces a localized notice code', async () => {
    const { app } = await setup();
    await app.newProject('R');
    const before = app.state.doc;
    expect(app.rename('   ')).toBe(false);
    expect(app.state.doc).toBe(before);
    expect(app.state.notice).toEqual({ key: 'error.edit.name_empty' });
  });

  it('switching locale is a device preference and never touches the project', async () => {
    const { app, prefs } = await setup();
    await app.newProject('Same');
    await app.flush();
    const doc = app.state.doc;
    app.setLocale('he');
    expect(app.state.locale.dir).toBe('rtl');
    expect(prefs.data[PREF_LOCALE]).toBe('he');
    expect(app.state.doc).toBe(doc);
    expect(app.hasUnsavedChanges).toBe(false);
  });

  it('reopens the last project after a restart', async () => {
    const first = await setup();
    await first.app.newProject('Persistent');
    await first.app.flush();
    const id = first.app.state.doc!.projectId;
    const second = await setup(first.prefs, first.factory);
    expect(second.app.state.screen).toBe('editor');
    expect(second.app.state.doc!.projectId).toBe(id);
  });

  it('opens a newer-schema project read-only and refuses every edit', async () => {
    const { app, storage } = await setup();
    await app.newProject('Future');
    await app.flush();
    const doc = app.state.doc!;
    await storage.save({ ...doc, schemaVersion: 99 });
    await app.openProject(doc.projectId);
    expect(app.state.readOnly).toEqual({ schemaVersion: 99 });
    expect(app.apply(addComponent(app.state.doc!, 'component.resistor', { x: 0, y: 0 }))).toBe(
      false,
    );
    expect(((await storage.load(doc.projectId)) as { schemaVersion: number }).schemaVersion).toBe(
      99,
    );
  });

  it('reports a newer project it cannot display instead of guessing', async () => {
    const { app, storage } = await setup();
    await app.newProject('Future');
    await app.flush();
    const doc = app.state.doc!;
    await storage.save({ ...doc, schemaVersion: 99, components: 'reshaped' } as never);
    await app.openProject(doc.projectId);
    expect(app.state.screen).toBe('home');
    expect(app.state.unreadable).toEqual({ schemaVersion: 99, name: 'Future' });
  });

  it('reports a damaged project and stays usable', async () => {
    const { app, storage } = await setup();
    await app.newProject('Damaged');
    await app.flush();
    const doc = app.state.doc!;
    await storage.save({ ...doc, layout: { components: {}, wires: [{}], junctions: [] } } as never);
    await app.goHome();
    await app.openProject(doc.projectId);
    expect(app.state.notice).toEqual({ key: 'open.error.invalid' });
    expect(app.state.screen).toBe('home');
    expect(app.state.selection).toEqual(emptySelection());
  });
});
