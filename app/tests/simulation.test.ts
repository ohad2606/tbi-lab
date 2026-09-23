import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  createProject,
  emptySelection,
  moveSelection,
  setParam,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { ProjectStore } from '../src/persistence/store.js';
import { SimulationController } from '../src/sim/controller.js';
import { AppStore, type Preferences } from '../src/state/app.js';
import { FakeWorker, settle, type FakeOptions } from './fakeWorker.js';

function ledCircuit(enabled = true): ProjectDocument {
  let doc = createProject({ projectId: 'prj_sim', deviceId: 'd', name: 'Sim', appVersion: '0' });
  const step = <T extends { ok: boolean }>(r: T) => {
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r as Extract<T, { ok: true }> & { doc: ProjectDocument };
  };
  doc = step(addComponent(doc, 'component.resistor', { x: 0, y: 0 })).doc;
  doc = step(addComponent(doc, 'component.led', { x: 200, y: 0 })).doc;
  const t = (component: string, terminal: string) => ({
    kind: 'terminal' as const,
    component,
    terminal,
  });
  doc = step(addWire(doc, t('PSU1', 'positive'), t('R1', 'a'))).doc;
  doc = step(addWire(doc, t('R1', 'b'), t('D1', 'anode'))).doc;
  doc = step(addWire(doc, t('D1', 'cathode'), t('GND1', 'ref'))).doc;
  doc = step(addWire(doc, t('PSU1', 'negative'), t('GND1', 'ref'))).doc;
  doc = step(setParam(doc, 'R1', 'resistance', { value: 220, unit: 'ohm' })).doc;
  return step(setParam(doc, 'PSU1', 'outputEnabled', enabled)).doc;
}

function controller(opts: FakeOptions = {}) {
  const workers: FakeWorker[] = [];
  const c = new SimulationController({
    createWorker: () => {
      const w = new FakeWorker(opts);
      workers.push(w);
      return w;
    },
    timeoutMs: 50,
  });
  return { c, workers };
}

describe('SimulationController', () => {
  it('Run: stopped -> starting -> running with a real engine outcome and timings', async () => {
    const { c, workers } = controller();
    const seen: string[] = [];
    c.subscribe(() => seen.push(c.state.status));
    await c.run(ledCircuit());
    await settle();
    expect(seen).toEqual(['starting', 'running']);
    const s = c.state;
    if (s.status !== 'running' || !s.outcome.ok) throw new Error('not running');
    expect(s.outcome.components.D1!.current).toBeGreaterThan(0.01);
    expect(s.timings.workerStartMs).not.toBeNull();
    expect(workers[0]!.received[0]!.type).toBe('load');
  });

  it('an engine refusal is a failed run, not a running one', async () => {
    const { c } = controller();
    await c.run(
      createProject({ projectId: 'prj_empty', deviceId: 'd', name: 'E', appVersion: '0' }),
    );
    await settle();
    expect(c.state).toEqual({
      status: 'failed',
      failure: { kind: 'engine', error: { code: 'empty_circuit' } },
    });
    expect(c.active).toBe(false);
  });

  it('Stop clears runtime state; a late outcome is ignored', async () => {
    const { c } = controller();
    const run = c.run(ledCircuit());
    c.stop();
    await run;
    await settle();
    expect(c.state).toEqual({ status: 'stopped' });
  });

  it('a live control re-solves the loaded snapshot and reports the applied revision', async () => {
    const { c, workers } = controller();
    await c.run(ledCircuit());
    await settle();
    expect(c.control('PSU1', { outputEnabled: false }, 42)).toBe(true);
    await settle();
    const s = c.state;
    if (s.status !== 'running' || !s.outcome.ok) throw new Error('not running');
    expect(s.outcome.components.PSU1!.mode).toBe('off');
    expect(s.outcome.appliedRevision).toBe(42);
    expect(s.solves).toBe(2);
    expect(workers[0]!.received.map((m) => m.type)).toEqual(['load', 'control']);
  });

  it('a worker crash fails safely and the next Run starts a fresh worker', async () => {
    const { c, workers } = controller({ behaviour: 'crash' });
    await c.run(ledCircuit());
    await settle();
    expect(c.state).toMatchObject({
      status: 'failed',
      failure: { kind: 'worker', code: 'worker_crashed' },
    });
    expect(workers[0]!.terminated).toBe(true);
    await c.run(ledCircuit());
    await settle();
    expect(workers).toHaveLength(2);
  });

  it('a worker that never answers times out', async () => {
    const { c, workers } = controller({ behaviour: 'hang' });
    await c.run(ledCircuit());
    await new Promise((r) => setTimeout(r, 120));
    expect(c.state).toMatchObject({
      status: 'failed',
      failure: { kind: 'worker', code: 'timeout' },
    });
    expect(workers[0]!.terminated).toBe(true);
  });
});

describe('AppStore with a running simulation', () => {
  const prefs = (): Preferences => {
    const d: Record<string, string> = {};
    return { get: (k) => d[k] ?? null, set: (k, v) => void (d[k] = v) };
  };
  async function setup(opts: FakeOptions = {}) {
    const storage = await ProjectStore.open(new IDBFactory());
    const { c, workers } = controller(opts);
    const app = new AppStore({
      storage,
      prefs: prefs(),
      languages: ['en'],
      newId: () => 'x1',
      simulation: c,
      autosaveDebounceMs: 1,
    });
    await app.init();
    await app.newProject('Sim');
    // Load the LED circuit as the open project (as if the user had drawn it).
    const drawn = ledCircuit();
    app.apply({ ok: true, doc: { ...drawn, projectId: app.state.doc!.projectId } });
    await app.flush();
    return { app, storage, c, workers };
  }

  it('A11: a structural edit is refused while running and nothing changes', async () => {
    const { app } = await setup();
    app.run();
    await settle();
    expect(app.state.sim.status).toBe('running');
    const before = app.state.doc;
    expect(app.apply(addComponent(before!, 'component.resistor', { x: 400, y: 0 }))).toBe(false);
    expect(app.state.doc).toBe(before);
    expect(app.state.notice).toEqual({ key: 'sim.stopToEdit' });
    expect(app.apply(setParam(before!, 'R1', 'resistance', { value: 330, unit: 'ohm' }))).toBe(
      false,
    );
    // Layout-only edits are allowed and do not touch the running session.
    expect(
      app.apply(
        moveSelection(before!, { ...emptySelection(), components: ['R1'] }, { x: 20, y: 0 }),
      ),
    ).toBe(true);
    app.stop();
    expect(app.apply(addComponent(app.state.doc!, 'component.resistor', { x: 400, y: 0 }))).toBe(
      true,
    );
  });

  it('A10: a live PSU edit is persisted first, then mirrored with that revision, then re-solved', async () => {
    const { app, storage, workers } = await setup();
    app.run();
    await settle();
    const before = app.state.doc!;
    expect(
      app.apply(setParam(before, 'PSU1', 'setpointVoltage', { value: 3.3, unit: 'volt' })),
    ).toBe(true);
    const rev = app.state.doc!.revision.localRevision;
    expect(rev).toBe(before.revision.localRevision + 1);
    const control = workers[0]!.received.find((m) => m.type === 'control');
    expect(control).toMatchObject({
      component: 'PSU1',
      control: { setpointVoltage: 3.3 },
      projectRevision: rev,
    });
    await settle();
    await app.flush();
    const stored = (await storage.load(before.projectId)) as ProjectDocument;
    expect(stored.components[0]!.params.setpointVoltage).toEqual({ value: 3.3, unit: 'volt' });
    expect(stored.revision.localRevision).toBe(rev);
    const s = app.state.sim;
    if (s.status !== 'running' || !s.outcome.ok) throw new Error('not running');
    expect(s.outcome.appliedRevision).toBe(rev);
    expect(s.outcome.components.PSU1!.voltage).toBeCloseTo(3.3, 12);
  });

  it('runtime results never enter the stored project', async () => {
    const { app, storage } = await setup();
    await app.flush();
    const bytes = JSON.stringify(await storage.load(app.state.doc!.projectId));
    app.run();
    await settle();
    await app.flush();
    expect(JSON.stringify(await storage.load(app.state.doc!.projectId))).toBe(bytes);
    app.stop();
    await app.flush();
    expect(JSON.stringify(await storage.load(app.state.doc!.projectId))).toBe(bytes);
  });

  it('A14: a worker failure leaves the project intact and editable', async () => {
    const { app, storage } = await setup({ behaviour: 'crash' });
    const bytes = JSON.stringify(await storage.load(app.state.doc!.projectId));
    app.run();
    await settle();
    expect(app.state.sim).toMatchObject({ status: 'failed', failure: { code: 'worker_crashed' } });
    expect(JSON.stringify(await storage.load(app.state.doc!.projectId))).toBe(bytes);
    expect(app.apply(addComponent(app.state.doc!, 'component.resistor', { x: 400, y: 0 }))).toBe(
      true,
    );
    app.stop();
    expect(app.state.sim.status).toBe('stopped');
  });

  it('leaving the project stops the simulation', async () => {
    const { app } = await setup();
    app.run();
    await settle();
    await app.goHome();
    expect(app.state.sim.status).toBe('stopped');
  });
});
