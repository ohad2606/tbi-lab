/**
 * Sprint 13 Task D (overnight audit, H1): one project open in two tabs or windows. Before: every
 * save was an unconditional put, so the last writer silently won (the other tab's work vanished)
 * and a tab could write a project another tab had deleted back into existence. Now a save
 * succeeds only over exactly the version the tab opened or last wrote; otherwise nothing is
 * written, the tab says so, and Export keeps that tab's version.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createProject, parsePackage } from '@tbi-lab/domain';
import { ProjectConflictError, ProjectStore, versionOf } from '../src/persistence/store.js';
import { AppStore, type Preferences } from '../src/state/app.js';

const prefs = (): Preferences => {
  const d: Record<string, string> = {};
  return { get: (k) => d[k] ?? null, set: (k, v) => void (d[k] = v) };
};

/** A "tab": an app store on the shared browser database. */
async function tab(factory: IDBFactory, id: string) {
  let n = 0;
  const app = new AppStore({
    storage: await ProjectStore.open(factory),
    prefs: prefs(),
    languages: ['en'],
    newId: () => `${id}${n++}`,
    autosaveDebounceMs: 1,
  });
  await app.init();
  return app;
}

describe('ProjectStore.save with an expected version', () => {
  it('writes over exactly that version; refuses a changed or deleted project and writes nothing', async () => {
    const store = await ProjectStore.open(new IDBFactory());
    const v1 = createProject({ projectId: 'prj_mt1', deviceId: 'd', name: 'v1', appVersion: '0' });
    await store.add(v1);
    const v2 = {
      ...v1,
      name: 'v2',
      revision: { ...v1.revision, localRevision: 2, updatedAt: '2026-10-13T00:00:02.000Z' },
    };
    await store.save(v2, versionOf(v1));
    // A writer still based on v1 is refused; v2 stays.
    const stale = {
      ...v1,
      name: 'stale',
      revision: { ...v1.revision, localRevision: 9, updatedAt: '2026-10-13T00:00:09.000Z' },
    };
    await expect(store.save(stale, versionOf(v1))).rejects.toMatchObject({ kind: 'changed' });
    expect(((await store.load('prj_mt1')) as { name: string }).name).toBe('v2');
    // Deleted meanwhile: refused, not resurrected.
    await store.delete('prj_mt1');
    await expect(store.save(stale, versionOf(v2))).rejects.toBeInstanceOf(ProjectConflictError);
    expect(await store.load('prj_mt1')).toBeUndefined();
    expect((await store.list()).map((e) => e.projectId)).toEqual([]);
  });
});

describe('two tabs on one project', () => {
  it('the second writer is refused, told, and can Export its own version; the first writer is kept', async () => {
    const browser = new IDBFactory();
    const a = await tab(browser, 'a');
    await a.newProject('Shared');
    const id = a.state.doc!.projectId;
    const b = await tab(browser, 'b');
    await b.openProject(id);
    expect(b.state.doc!.name).toBe('Shared');

    expect(a.rename('Renamed in A')).toBe(true);
    await a.flush();
    expect(a.state.saveState).toBe('saved');

    expect(b.rename('Renamed in B')).toBe(true);
    await b.flush();
    expect(b.state.saveState).toBe('error');
    expect(b.state.saveError).toBe('conflict');
    expect(b.hasUnsavedChanges).toBe(true);
    // A's work is intact.
    const stored = (await (await ProjectStore.open(browser)).load(id)) as { name: string };
    expect(stored.name).toBe('Renamed in A');
    // B keeps its version through Export.
    const file = await b.exportProject(id);
    const pkg = parsePackage(file!.text);
    expect(pkg.ok && pkg.doc.name).toBe('Renamed in B');
    // After a reload, B continues with A's version and saves normally again.
    const b2 = await tab(browser, 'b2');
    await b2.openProject(id);
    expect(b2.rename('Then B again')).toBe(true);
    await b2.flush();
    expect(b2.state.saveState).toBe('saved');
  });

  it('a project deleted in one tab is not written back by the other', async () => {
    const browser = new IDBFactory();
    const a = await tab(browser, 'a');
    await a.newProject('Doomed');
    const id = a.state.doc!.projectId;
    const b = await tab(browser, 'b');
    await b.openProject(id);
    await a.deleteProject(id);
    expect(b.rename('Edited after the delete')).toBe(true);
    await b.flush();
    expect(b.state.saveError).toBe('conflict');
    const store = await ProjectStore.open(browser);
    expect(await store.load(id)).toBeUndefined();
    expect((await store.list()).some((e) => e.projectId === id)).toBe(false);
  });

  it('one tab alone: many edits, reopen, rename from the library — all save normally', async () => {
    const browser = new IDBFactory();
    const a = await tab(browser, 'a');
    await a.newProject('Solo');
    const id = a.state.doc!.projectId;
    for (let i = 0; i < 5; i++) a.rename(`Solo ${i}`);
    await a.flush();
    expect(a.state.saveState).toBe('saved');
    await a.newProject('Other');
    expect(await a.renameInLibrary(id, 'Solo renamed')).toBe(true);
    await a.openProject(id);
    expect(a.state.doc!.name).toBe('Solo renamed');
    a.rename('Solo final');
    await a.flush();
    expect(a.state.saveState).toBe('saved');
  });
});
