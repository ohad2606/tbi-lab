/**
 * Sprint 20 (s20r4, review B1: a large project froze the tab while its wires were routed). The
 * canonical routing pass and the open-time repair spend at most a fixed WORK budget (lattice
 * cells searched, obstacle elements priced: route.ts SEARCH_BUDGET_CELLS / PRICING_BUDGET_OPS),
 * counted, never timed, so routes stay deterministic and machine-independent. Beyond it, wires
 * keep a simple shape and are reported; the netlist never changes.
 * Measured on the 1-vCPU DEV host (s20r4-large-*.txt): a 2 MB project (3 040 dense wires on 38
 * ESP32 benches) routes in ~2.3 s and repairs in ~1.3 s (was minutes).
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  sameNodeBranches,
  wireCrossings,
  addWire,
  connectivity,
  repairWireRoutesReport,
  routeAutoWiresReport,
  validateProject,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { componentBoxes, repairManual, routeAutomatic, routingLimited } from '../src/ui/routing.js';
import { deriveScene } from '../src/views/scene3d/scene.js';
import { shapeWires } from '../src/views/scene3d/wireShape.js';
import { newDoc } from '../../packages/domain/tests/helpers.js';
import { largeBench } from './support/largeBench.js';
import { randomBench } from './support/routingBench.js';

const nets = (d: ProjectDocument) => JSON.stringify([...connectivity(d).nodeOf].sort());
const routes = (d: ProjectDocument) => JSON.stringify(d.layout.wires.map((w) => w.vertices));

describe('bounded routing of a very large project (s20r4)', () => {
  it('1 280 dense wires: finishes, is deterministic, keeps the netlist, reports the simple shapes', () => {
    const doc = largeBench(80, 16);
    expect(validateProject(doc)).toEqual([]);
    expect(doc.layout.wires.length).toBe(1280);
    const t0 = performance.now();
    const a = routeAutoWiresReport(doc, componentBoxes(doc));
    const ms = performance.now() - t0;
    console.log(`1 280 wires: routed in ${ms.toFixed(0)} ms, ${a.degraded.length} simple shapes`);
    // A regression guard far above the bound (the DEV host is shared and slow), far below minutes.
    expect(ms).toBeLessThan(30_000);
    expect(a.degraded.length).toBeGreaterThan(0);
    const b = routeAutoWiresReport(doc, componentBoxes(doc));
    expect(routes(b.doc)).toBe(routes(a.doc)); // work-counted, not timed: the same every time
    expect(b.degraded).toEqual(a.degraded);
    expect(nets(a.doc)).toBe(nets(doc));
    // The app marks the document's wires drawn with a simple shape (the Circuit view's note).
    const shown = routeAutomatic(doc);
    expect(routingLimited(shown)).toEqual(a.degraded);
    // NOTE 6 (review r3): an edit that does not move a wire (a rename) or an undo makes a new
    // layout object with the same drawing: the note stays.
    const renamed = { ...structuredClone(shown), name: 'Renamed' };
    expect(renamed.layout).not.toBe(shown.layout);
    expect(routingLimited(renamed)).toEqual(a.degraded);
  });

  it('a project small enough for the full router is not marked', () => {
    const doc = largeBench(40, 1);
    const r = routeAutoWiresReport(doc, componentBoxes(doc));
    expect(r.degraded).toEqual([]);
    expect(routingLimited(routeAutomatic(doc))).toEqual([]);
  });

  it('the open-time repair of 1 280 manual wires is bounded too, and keeps the netlist', () => {
    const doc = largeBench(80, 16);
    const manual: ProjectDocument = {
      ...doc,
      layout: {
        ...doc.layout,
        wires: doc.layout.wires.map((w) => {
          const { auto: _auto, ...rest } = w;
          return { ...rest, vertices: [] };
        }),
      },
    };
    const t0 = performance.now();
    const r = repairWireRoutesReport(manual, componentBoxes(manual));
    const ms = performance.now() - t0;
    console.log(`1 280 manual wires: repaired in ${ms.toFixed(0)} ms, ${r.unrepaired.length} left`);
    expect(ms).toBeLessThan(30_000);
    expect(nets(r.doc)).toBe(nets(manual));
    expect(r.unrepaired.length).toBeGreaterThan(0);
  });

  it('B3: adding a far-away wire does not change the routes of the others (40 / 60 wires)', () => {
    // Formerly the reorder rounds depended on the TOTAL number of wires (3 up to 40, 1 up to 60,
    // none above): a wire added anywhere at 40 -> 41 or 60 -> 61 reshuffled every route.
    for (const seed of [1, 3, 5])
      for (const n of [40, 60]) {
        const b = randomBench(n, seed, { dense: true });
        if (b.doc.layout.wires.length !== n) continue;
        const r0 = routeAutomatic(b.doc);
        let d = b.doc;
        const a = addComponent(d, 'component.resistor', { x: 8000, y: 8000 });
        if (!a.ok) throw new Error(a.error);
        d = a.doc;
        const c = addComponent(d, 'component.resistor', { x: 8400, y: 8000 });
        if (!c.ok) throw new Error(c.error);
        d = c.doc;
        const w = addWire(
          d,
          { kind: 'terminal', component: a.id, terminal: 'b' },
          { kind: 'terminal', component: c.id, terminal: 'a' },
          [],
          { waypoints: [] },
        );
        if (!w.ok) throw new Error(w.error);
        const r1 = routeAutomatic(w.doc);
        const of = (doc: ProjectDocument) =>
          JSON.stringify(
            b.doc.layout.wires.map((x) => doc.layout.wires.find((y) => y.id === x.id)!.vertices),
          );
        expect(of(r1), `seed ${seed} n ${n}`).toBe(of(r0));
      }
  });

  it('BLOCKING 2 (review r3): a wire with far coordinates costs no more than a near one in 2D', () => {
    // PSU+ -> R1.a through (X,-20), (X,-100): a few hundred bytes. The segment index and the
    // router's grid and channels must not walk the length (formerly 6 s at X = 2e8; OOM beyond).
    for (const X of [2e8, 2e10, 9e15]) {
      for (const auto of [false, true]) {
        let doc = newDoc();
        const r1 = addComponent(doc, 'component.resistor', { x: 0, y: -100 });
        if (!r1.ok) throw new Error(r1.error);
        doc = r1.doc;
        const w = addWire(
          doc,
          { kind: 'terminal', component: 'PSU1', terminal: 'positive' },
          { kind: 'terminal', component: r1.id, terminal: 'a' },
          [
            { x: X, y: -20 },
            { x: X, y: -100 },
          ],
          auto ? { waypoints: [{ x: X, y: -20 }] } : undefined,
        );
        if (!w.ok) throw new Error(w.error);
        doc = w.doc;
        const t0 = performance.now();
        sameNodeBranches(doc);
        wireCrossings(doc);
        const rep = repairManual(doc);
        const routed = routeAutomatic(rep);
        sameNodeBranches(routed);
        wireCrossings(routed);
        const ms = performance.now() - t0;
        expect(ms, `X ${X} auto ${auto}`).toBeLessThan(5_000);
        expect(nets(routed)).toBe(nets(doc));
      }
    }
  });

  it('MAJOR 3 (review r3): the 3D scene of 640 / 1 280 wires and of a far wire is bounded and says so', () => {
    for (const tiles of [8, 16]) {
      const doc = routeAutomatic(largeBench(80, tiles));
      const t0 = performance.now();
      const s = deriveScene(doc);
      shapeWires(s);
      const ms = performance.now() - t0;
      console.log(`${doc.layout.wires.length} wires: 3D scene and cables in ${ms.toFixed(0)} ms`);
      expect(ms).toBeLessThan(30_000);
      const simple = s.wires.filter((w) => w.simple).map((w) => w.id);
      expect(simple.length).toBeGreaterThan(0);
      for (const id of simple) expect(s.routeLimits).toContain(id);
      expect(JSON.stringify(deriveScene(doc))).toBe(JSON.stringify(s)); // counted: deterministic
    }
    let doc = newDoc();
    const r1 = addComponent(doc, 'component.resistor', { x: 0, y: -100 });
    if (!r1.ok) throw new Error(r1.error);
    doc = r1.doc;
    const w = addWire(
      doc,
      { kind: 'terminal', component: 'PSU1', terminal: 'positive' },
      { kind: 'terminal', component: r1.id, terminal: 'a' },
      [
        { x: 2e10, y: -20 },
        { x: 2e10, y: -100 },
      ],
    );
    if (!w.ok) throw new Error(w.error);
    const t0 = performance.now();
    const s = deriveScene(w.doc);
    shapeWires(s);
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(s.routeLimits).toEqual([w.id]);
    expect(s.wires.find((x) => x.id === w.id)!.simple).toBe(true);
  });
});
