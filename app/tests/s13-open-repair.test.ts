/**
 * Sprint 13 Task D (overnight audit, H3): wire routes repaired when a project opens (e.g. OS-05:
 * a stored route over a display) were rewritten silently and permanently. Now the repair is a
 * recorded edit with a notice; one Undo restores the stored routes. Connections never change.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { ProjectDocument } from '@tbi-lab/domain';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import { ProjectStore } from '../src/persistence/store.js';
import { AppStore, type Preferences } from '../src/state/app.js';

const prefs = (): Preferences => {
  const d: Record<string, string> = {};
  return { get: (k) => d[k] ?? null, set: (k, v) => void (d[k] = v) };
};

describe('open-time route repair is visible and undoable', () => {
  it('notice, saved repaired, one Undo restores the stored routes; connectivity untouched', async () => {
    const storage = await ProjectStore.open(new IDBFactory());
    const stored = {
      ...structuredClone(EXAMPLES.find((e) => e.id === 'voltage-divider')!.document),
      projectId: 'prj_repair1',
    } as ProjectDocument;
    await storage.add(stored);
    const wire = stored.layout.wires[0]!;
    // A repair that re-routes the first wire (as the router does for a route over a display).
    const repairLayout = (d: ProjectDocument): ProjectDocument => ({
      ...d,
      layout: {
        ...d.layout,
        wires: d.layout.wires.map((w) =>
          w.id === wire.id ? { ...w, vertices: [...(w.vertices ?? []), { x: 9000, y: 9000 }] } : w,
        ),
      },
    });
    const app = new AppStore({
      storage,
      prefs: prefs(),
      languages: ['en'],
      newId: () => 'x',
      autosaveDebounceMs: 1,
      repairLayout,
    });
    await app.init();
    await app.openProject('prj_repair1');
    expect(app.state.notice).toMatchObject({ key: 'open.routesAdjusted' });
    const repairedWire = app.state.doc!.layout.wires.find((w) => w.id === wire.id)!;
    expect(repairedWire.vertices).toContainEqual({ x: 9000, y: 9000 });
    expect(app.state.doc!.connections).toEqual(stored.connections);
    await app.flush();
    expect(
      ((await storage.load('prj_repair1')) as ProjectDocument).layout.wires[0]!.vertices,
    ).toContainEqual({
      x: 9000,
      y: 9000,
    });
    expect(app.undo()).toBe(true);
    expect(app.state.doc!.layout.wires).toEqual(stored.layout.wires);
    await app.flush();
    expect(((await storage.load('prj_repair1')) as ProjectDocument).layout.wires).toEqual(
      stored.layout.wires,
    );
  });

  it('a project that needs no repair opens without a notice and without a write', async () => {
    const storage = await ProjectStore.open(new IDBFactory());
    const stored = {
      ...structuredClone(EXAMPLES.find((e) => e.id === 'voltage-divider')!.document),
      projectId: 'prj_repair2',
    } as ProjectDocument;
    await storage.add(stored);
    const app = new AppStore({
      storage,
      prefs: prefs(),
      languages: ['en'],
      newId: () => 'x',
      autosaveDebounceMs: 1,
      repairLayout: (d) => d,
    });
    await app.init();
    await app.openProject('prj_repair2');
    expect(app.state.notice).toBeNull();
    expect(app.undo()).toBe(false);
    await app.flush();
    expect(await storage.load('prj_repair2')).toEqual(stored);
  });
});
