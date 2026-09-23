/**
 * Sprint 4 A10/A11: undo/redo of persistent edits, with monotonic revisions and stable ids;
 * transient runtime input, language and Run/Stop never enter the history.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  moveSelection,
  emptySelection,
  rotateComponents,
  setParam,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { ProjectStore } from '../src/persistence/store.js';
import { SimulationController } from '../src/sim/controller.js';
import { AppStore, type Preferences } from '../src/state/app.js';
import { FakeWorker, settle } from './fakeWorker.js';

const prefs = (): Preferences => {
  const d: Record<string, string> = {};
  return { get: (k) => d[k] ?? null, set: (k, v) => void (d[k] = v) };
};

async function setup() {
  const storage = await ProjectStore.open(new IDBFactory());
  const workers: FakeWorker[] = [];
  const simulation = new SimulationController({
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  const app = new AppStore({
    storage,
    prefs: prefs(),
    languages: ['en'],
    newId: () => 'h1',
    simulation,
    autosaveDebounceMs: 1,
  });
  await app.init();
  await app.newProject('History');
  return { app, storage, workers };
}

const doc = (app: AppStore) => app.state.doc!;
const rev = (app: AppStore) => doc(app).revision.localRevision;
const ids = (d: ProjectDocument) => d.components.map((c) => c.id);
const t = (component: string, terminal: string) => ({
  kind: 'terminal' as const,
  component,
  terminal,
});

describe('undo/redo (A10)', () => {
  it('covers placement, move, rotation, wiring, property, toggle and deletion', async () => {
    const { app } = await setup();
    const snapshots: string[] = [];
    const step = (r: Parameters<AppStore['apply']>[0]) => {
      snapshots.push(JSON.stringify({ ...doc(app), revision: null }));
      expect(app.apply(r)).toBe(true);
    };
    step(addComponent(doc(app), 'component.resistor', { x: 0, y: 0 }));
    step(addComponent(doc(app), 'component.toggle_switch', { x: 200, y: 0 }));
    step(moveSelection(doc(app), { ...emptySelection(), components: ['R1'] }, { x: 40, y: 0 }));
    step(rotateComponents(doc(app), ['R1']));
    step(addWire(doc(app), t('PSU1', 'positive'), t('SW1', 'a')));
    step(setParam(doc(app), 'R1', 'resistance', { value: 470, unit: 'ohm' }));
    step(setParam(doc(app), 'SW1', 'closed', true));
    step(setParam(doc(app), 'PSU1', 'setpointVoltage', { value: 3.3, unit: 'volt' }));
    expect(app.state.history).toEqual({ undo: 8, redo: 0 });
    const final = JSON.stringify({ ...doc(app), revision: null, idCounters: null });
    let last = rev(app);
    for (let k = snapshots.length - 1; k >= 0; k--) {
      expect(app.undo()).toBe(true);
      expect(JSON.stringify({ ...doc(app), revision: null, idCounters: null })).toBe(
        JSON.stringify({ ...JSON.parse(snapshots[k]!), idCounters: null }),
      );
      expect(rev(app)).toBe(last + 1); // every undo is a NEW revision
      last = rev(app);
    }
    expect(app.undo()).toBe(false);
    expect(app.state.history).toEqual({ undo: 0, redo: 8 });
    for (let k = 0; k < 8; k++) {
      expect(app.redo()).toBe(true);
      const expected = k < 7 ? JSON.parse(snapshots[k + 1]!) : JSON.parse(final);
      expect(JSON.stringify({ ...doc(app), revision: null, idCounters: null })).toBe(
        JSON.stringify({ ...expected, revision: null, idCounters: null }),
      );
    }
    expect(doc(app).components.find((c) => c.id === 'SW1')!.params.closed).toBe(true);
    expect(rev(app)).toBe(last + 8);
  });

  it('never reissues an id consumed before an undo; redo restores the same ids', async () => {
    const { app } = await setup();
    app.apply(addComponent(doc(app), 'component.resistor', { x: 0, y: 0 })); // R1
    app.apply(addComponent(doc(app), 'component.resistor', { x: 0, y: 100 })); // R2
    app.undo(); // R2 removed
    app.apply(addComponent(doc(app), 'component.resistor', { x: 0, y: 200 })); // R3, not R2
    expect(ids(doc(app))).toEqual(['PSU1', 'GND1', 'R1', 'R3']);
    expect(app.state.history.redo).toBe(0); // a new edit clears redo
    app.undo();
    app.redo();
    expect(ids(doc(app))).toEqual(['PSU1', 'GND1', 'R1', 'R3']);
  });

  it('every undo/redo result is autosaved through the normal path', async () => {
    const { app, storage } = await setup();
    app.apply(addComponent(doc(app), 'component.resistor', { x: 0, y: 0 }));
    app.undo();
    await app.flush();
    const stored = (await storage.load(doc(app).projectId)) as ProjectDocument;
    expect(ids(stored)).toEqual(['PSU1', 'GND1']);
    expect(stored.revision.localRevision).toBe(rev(app));
  });

  it('history starts empty on reopen (session only)', async () => {
    const { app } = await setup();
    app.apply(addComponent(doc(app), 'component.resistor', { x: 0, y: 0 }));
    await app.flush();
    await app.openProject(doc(app).projectId);
    expect(app.state.history).toEqual({ undo: 0, redo: 0 });
  });
});

describe('history exclusions and running rules (A11)', () => {
  function circuit(app: AppStore) {
    app.apply(addComponent(doc(app), 'component.push_button', { x: 0, y: 0 })); // SW1
    app.apply(addComponent(doc(app), 'component.toggle_switch', { x: 200, y: 0 })); // SW2
    app.apply(addComponent(doc(app), 'component.resistor', { x: 400, y: 0 })); // R1
    for (const [a, b] of [
      [t('PSU1', 'positive'), t('SW1', 'a')],
      [t('SW1', 'b'), t('SW2', 'a')],
      [t('SW2', 'b'), t('R1', 'a')],
      [t('R1', 'b'), t('GND1', 'ref')],
      [t('PSU1', 'negative'), t('GND1', 'ref')],
    ] as const) {
      app.apply(addWire(doc(app), a, b));
    }
    app.apply(setParam(doc(app), 'PSU1', 'outputEnabled', true));
  }

  it('button presses, language and Run/Stop never enter the history or the document', async () => {
    const { app } = await setup();
    circuit(app);
    const history = app.state.history;
    const bytes = JSON.stringify(doc(app));
    app.setLocale('he');
    app.run();
    await settle();
    expect(app.press('SW1', true)).toBe(true);
    await settle();
    expect(app.press('SW1', false)).toBe(true);
    app.stop();
    expect(app.state.history).toEqual(history);
    expect(JSON.stringify(doc(app))).toBe(bytes); // not even the revision moved
  });

  it('a push button cannot be pressed through the store unless it is momentary and running', async () => {
    const { app } = await setup();
    circuit(app);
    expect(app.press('SW1', true)).toBe(false); // not running
    app.run();
    await settle();
    expect(app.press('SW2', true)).toBe(false); // a toggle is not momentary
    expect(app.press('R1', true)).toBe(false);
  });

  it('while running: a live toggle edit is persisted first, then mirrored; undo does the same', async () => {
    const { app, workers } = await setup();
    circuit(app);
    app.run();
    await settle();
    expect(app.apply(setParam(doc(app), 'SW2', 'closed', true))).toBe(true);
    const r1 = rev(app);
    expect(workers[0]!.received.at(-1)).toMatchObject({
      type: 'control',
      component: 'SW2',
      control: { closed: true },
      projectRevision: r1,
    });
    expect(app.undo()).toBe(true); // live: allowed while running
    expect(doc(app).components.find((c) => c.id === 'SW2')!.params.closed).toBe(false);
    expect(workers[0]!.received.at(-1)).toMatchObject({
      type: 'control',
      control: { closed: false },
      projectRevision: r1 + 1,
    });
  });

  it('while running: undoing a structural edit is refused and nothing changes', async () => {
    const { app } = await setup();
    circuit(app);
    app.apply(addComponent(doc(app), 'component.resistor', { x: 600, y: 0 })); // structural
    app.run();
    await settle();
    const before = doc(app);
    expect(app.undo()).toBe(false);
    expect(app.state.notice).toEqual({ key: 'sim.stopToEdit' });
    expect(doc(app)).toBe(before);
    app.stop();
    expect(app.undo()).toBe(true);
  });
});
