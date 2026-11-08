/**
 * Wire routing integrity through the real store (AppStore with the app's `routeLayout`): every
 * layout edit leaves the automatic wires canonical; undo restores the exact earlier drawing.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  emptySelection,
  projectHash,
  setParam,
  wireRoute,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { ProjectStore } from '../src/persistence/store.js';
import { AppStore, type Preferences } from '../src/state/app.js';
import { moveRouted, routeAutomatic } from '../src/ui/routing.js';
import { draw } from './support/wireScenario.js';

const prefs = (): Preferences => {
  const d: Record<string, string> = {};
  return { get: (k) => d[k] ?? null, set: (k, v) => void (d[k] = v) };
};
const T = (component: string, terminal: string) => ({
  kind: 'terminal' as const,
  component,
  terminal,
});
const drawn = (d: ProjectDocument) =>
  JSON.stringify(d.layout.wires.map((w) => [w.id, wireRoute(d, w)]));

describe('wire routing integrity in the store', () => {
  it('drags through the store stay canonical; moving back and undo both restore the drawing', async () => {
    const storage = await ProjectStore.open(new IDBFactory());
    const app = new AppStore({
      storage,
      prefs: prefs(),
      languages: ['en'],
      newId: () => 'r1',
      autosaveDebounceMs: 1,
      routeLayout: routeAutomatic,
    });
    await app.init();
    await app.newProject('Routing');
    const doc = () => app.state.doc!;
    expect(app.apply(addComponent(doc(), 'logic.gate_and', { x: 160, y: 0 }))).toBe(true);
    const p = setParam(doc(), 'PSU1', 'setpointVoltage', { value: 3, unit: 'volt' });
    if (p.ok) app.apply(p);
    // Wires as the Circuit view adds them (automatic, waypoints = clicks); the store routes.
    for (const [a, b] of [
      [T('PSU1', 'negative'), T('GND1', 'ref')],
      [T('PSU1', 'positive'), T('U1', 'vcc')],
      [T('U1', 'gnd'), T('GND1', 'ref')],
    ] as const) {
      const before = doc();
      const next = draw(before, a, b);
      app.apply({ ok: true, doc: next });
    }
    expect(doc().layout.wires.every((w) => w.auto)).toBe(true);
    const start = drawn(doc());
    const sel = { ...emptySelection(), components: ['U1'] };
    for (const dx of [200, -320]) {
      expect(app.apply(moveRouted(doc(), sel, { x: dx, y: 0 }))).toBe(true);
      expect(drawn(routeAutomatic(doc()))).toBe(drawn(doc())); // committed = canonical
    }
    const mid = drawn(doc());
    expect(app.apply(moveRouted(doc(), sel, { x: 120, y: 0 }))).toBe(true);
    expect(drawn(doc())).toBe(start);
    app.undo();
    expect(drawn(doc())).toBe(mid); // undo restores the exact earlier drawing
    app.redo();
    expect(drawn(doc())).toBe(start);

    // Review 1: a stale automatic route stored by another build is routed on open (one undoable
    // "routes adjusted" edit), never shown as it was stored.
    const id = doc().projectId;
    await new Promise((r) => setTimeout(r, 100)); // pending autosaves land first
    const stale = JSON.parse(JSON.stringify(doc())) as ProjectDocument;
    stale.layout.wires.find((w) => w.id === 'W2')!.vertices = [
      { x: -80, y: -200 },
      { x: 360, y: -200 },
    ];
    await storage.save(stale);
    await app.openProject(id);
    expect(drawn(doc())).toBe(start);
    expect(app.state.notice?.key).toBe('open.routesAdjusted');

    // Sprint 21 (s21r): the same stale project IMPORTED from a file: the import's confirmation
    // no longer replaces the "routes adjusted" notice (Sprint 20 UX defect); both are shown.
    const file = (await app.exportProject(id))!;
    const pkg = JSON.parse(file.text) as {
      project: ProjectDocument;
      integrity: { project: string };
    };
    pkg.project.layout.wires.find((w) => w.id === 'W2')!.vertices = [
      { x: -80, y: -200 },
      { x: 360, y: -200 },
    ];
    pkg.integrity.project = projectHash(pkg.project);
    await app.deleteProject(id);
    expect(await app.importPackage(JSON.stringify(pkg))).toBe(true);
    expect(drawn(doc())).toBe(start);
    expect(app.state.notice).toMatchObject({
      key: 'import.done',
      tone: 'info',
      also: ['open.routesAdjusted'],
    });
    // A package that needs no adjustment says only "Imported".
    const clean = (await app.exportProject(doc().projectId))!;
    await app.deleteProject(doc().projectId);
    expect(await app.importPackage(clean.text)).toBe(true);
    expect(app.state.notice?.also).toBeUndefined();
  });
});
