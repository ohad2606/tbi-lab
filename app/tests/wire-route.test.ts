/**
 * Wire auto-routing through the real app store (Product Alpha maintenance): the route a new
 * wire gets is ordinary stored geometry, so undo/redo and autosave/reload keep it exactly.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  autoRouteVertices,
  emptySelection,
  routeObstacles,
  terminalPosition,
  wireRoute,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { ProjectStore } from '../src/persistence/store.js';
import { AppStore, type Preferences } from '../src/state/app.js';

const prefs = (): Preferences => {
  const data: Record<string, string> = {};
  return { get: (k) => data[k] ?? null, set: (k, v) => void (data[k] = v) };
};

async function setup() {
  let n = 0;
  const storage = await ProjectStore.open(new IDBFactory());
  const app = new AppStore({
    storage,
    prefs: prefs(),
    languages: ['en-US'],
    newId: () => `id${++n}`,
    autosaveDebounceMs: 1,
  });
  await app.init();
  await app.newProject('Loop');
  return { app, storage };
}

/** PSU+ -> LED -> R on one row, then the auto-routed return R.b -> PSU-. */
function drawLoop(app: AppStore): string {
  const doc = () => app.state.doc!;
  const led = addComponent(doc(), 'component.led', { x: 0, y: -20 });
  if (!led.ok) throw new Error('led');
  app.apply(led);
  const r = addComponent(doc(), 'component.resistor', { x: 120, y: -20 });
  if (!r.ok) throw new Error('r');
  app.apply(r);
  app.apply(
    addWire(
      doc(),
      { kind: 'terminal', component: 'PSU1', terminal: 'positive' },
      { kind: 'terminal', component: led.id, terminal: 'anode' },
    ),
    emptySelection(),
  );
  app.apply(
    addWire(
      doc(),
      { kind: 'terminal', component: led.id, terminal: 'cathode' },
      { kind: 'terminal', component: r.id, terminal: 'a' },
    ),
    emptySelection(),
  );
  const from = terminalPosition(doc(), r.id, 'b')!;
  const to = terminalPosition(doc(), 'PSU1', 'negative')!;
  // Bodies are irrelevant to this route's choice; wire segments alone steer it here.
  const w = addWire(
    doc(),
    { kind: 'terminal', component: r.id, terminal: 'b' },
    { kind: 'terminal', component: 'PSU1', terminal: 'negative' },
    autoRouteVertices([from, to], routeObstacles(doc(), [])),
  );
  if (!w.ok) throw new Error('wire');
  app.apply(w, emptySelection());
  return w.id;
}

const routeOf = (doc: ProjectDocument, id: string) =>
  wireRoute(
    doc,
    doc.layout.wires.find((w) => w.id === id)!,
  );

describe('auto-routed wire geometry in the app', () => {
  it('9. undo and redo restore exactly the chosen route', async () => {
    const { app } = await setup();
    const id = drawLoop(app);
    const chosen = routeOf(app.state.doc!, id);
    expect(chosen).toEqual([
      { x: 160, y: -20 },
      { x: 160, y: 20 },
      { x: -80, y: 20 },
    ]);
    expect(app.undo()).toBe(true);
    expect(app.state.doc!.layout.wires.some((w) => w.id === id)).toBe(false);
    expect(app.redo()).toBe(true);
    expect(routeOf(app.state.doc!, id)).toEqual(chosen);
  });

  it('8. autosave and reload keep the route (no re-routing on load)', async () => {
    const { app, storage } = await setup();
    const id = drawLoop(app);
    const chosen = routeOf(app.state.doc!, id);
    await app.flush();
    const stored = (await storage.load(app.state.doc!.projectId)) as ProjectDocument;
    expect(routeOf(stored, id)).toEqual(chosen);
  });
});
