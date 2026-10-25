/**
 * Sprint 21 (s21r, task 4): the routing work budgets (s20r4 search / pricing, s20r5 3D scene,
 * s20r6 overlays and cables) only ever change GEOMETRY. A document routed or repaired with its
 * work limited has exactly the netlist of the same document routed or repaired without a limit:
 * the same connections, nets, wire ends, junctions and simulation snapshot, and the netlist
 * written independently (union-find over the wire ends, no nets.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  createSnapshot,
  repairWireRoutesReport,
  routeAutoWiresReport,
  topologyKey,
  type ProjectDocument,
  type WireEnd,
} from '@tbi-lab/domain';
import { componentBoxes } from '../src/ui/routing.js';
import { deriveScene } from '../src/views/scene3d/scene.js';
import { randomBench } from './support/routingBench.js';

const key = (e: WireEnd) =>
  e.kind === 'terminal' ? `${e.component}:${e.terminal}` : `junction:${e.junction}`;
/** Union-find over the wire ends: the terminal groups (independent of nets.ts). */
function independent(d: ProjectDocument): string {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    if (!parent.has(k)) parent.set(k, k);
    const p = parent.get(k)!;
    return p === k ? k : find(p);
  };
  for (const w of d.layout.wires) {
    const a = find(key(w.from));
    const b = find(key(w.to));
    if (a !== b) parent.set(a, b);
  }
  const groups = new Map<string, string[]>();
  for (const k of parent.keys())
    if (!k.startsWith('junction:')) groups.set(find(k), [...(groups.get(find(k)) ?? []), k]);
  return JSON.stringify(
    [...groups.values()]
      .filter((g) => g.length > 1)
      .map((g) => g.sort())
      .sort(),
  );
}
const electrical = (d: ProjectDocument) =>
  JSON.stringify({
    snapshot: createSnapshot(d).snapshotId,
    topology: topologyKey(d),
    nets: d.nets,
    connections: d.connections,
    ends: d.layout.wires.map((w) => [w.id, w.from, w.to]),
    junctions: d.layout.junctions,
  });
const routes = (d: ProjectDocument) => JSON.stringify(d.layout.wires.map((w) => w.vertices));
const UNLIMITED = { cells: 1e12, ops: 1e15 };

describe('work budgets never change the netlist (s21r)', () => {
  it('canonical routing: limited == unlimited netlist, geometry differs', () => {
    for (const [n, seed] of [
      [40, 1],
      [60, 2],
    ] as const) {
      const doc = randomBench(n, seed, { dense: true, board: true }).doc;
      const boxes = componentBoxes(doc);
      const free = routeAutoWiresReport(doc, boxes, undefined, UNLIMITED);
      expect(free.degraded).toEqual([]);
      for (const limits of [{ cells: 0 }, { ops: 20_000 }, { cells: 2_000, ops: 400_000 }]) {
        const lim = routeAutoWiresReport(doc, boxes, undefined, limits);
        expect(lim.degraded.length, `${n} ${JSON.stringify(limits)}`).toBeGreaterThan(0);
        expect(routes(lim.doc)).not.toBe(routes(free.doc)); // the limit did change geometry
        expect(electrical(lim.doc)).toBe(electrical(free.doc));
        expect(electrical(lim.doc)).toBe(electrical(doc));
        expect(independent(lim.doc)).toBe(independent(free.doc));
        expect(independent(lim.doc)).toBe(independent(doc));
      }
    }
  });

  it('open-time repair of manual wires: limited == unlimited netlist', () => {
    const doc = randomBench(40, 3, { dense: true, board: true }).doc;
    // Every wire manual with a stale route across the bench (through pins and bodies).
    const manual: ProjectDocument = {
      ...doc,
      layout: {
        ...doc.layout,
        wires: doc.layout.wires.map(({ auto: _a, ...w }, i) => ({
          ...w,
          vertices: [
            { x: -400 + 20 * (i % 30), y: -300 },
            { x: -400 + 20 * (i % 30), y: 300 },
          ],
        })),
      },
    };
    const boxes = componentBoxes(manual);
    const free = repairWireRoutesReport(manual, boxes, UNLIMITED);
    expect(free.unrepaired).toEqual([]);
    const lim = repairWireRoutesReport(manual, boxes, { ops: 50_000 });
    expect(lim.unrepaired.length).toBeGreaterThan(0);
    expect(routes(lim.doc)).not.toBe(routes(free.doc));
    expect(electrical(lim.doc)).toBe(electrical(free.doc));
    expect(electrical(lim.doc)).toBe(electrical(manual));
    expect(independent(lim.doc)).toBe(independent(manual));
  });

  it('3D: a scene of a budget-limited document ends every cable on its own terminals', () => {
    const doc = randomBench(40, 1, { dense: true, board: true }).doc;
    const lim = routeAutoWiresReport(doc, componentBoxes(doc), undefined, { cells: 0 }).doc;
    const s = deriveScene(lim);
    const at = new Map<string, { x: number; y: number; z: number }>(
      s.components.flatMap((c) => c.terminals.map((t) => [`${c.id}:${t.id}`, t] as const)),
    );
    for (const w of lim.layout.wires) {
      const cable = s.wires.find((x) => x.id === w.id);
      if (!cable) continue; // a contact: no cable
      for (const [e, p] of [
        [w.from, cable.points[0]!],
        [w.to, cable.points[cable.points.length - 1]!],
      ] as const) {
        if (e.kind !== 'terminal') continue;
        const t = at.get(key(e))!;
        expect(Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z), `${w.id} ${key(e)}`).toBeLessThan(1e-6);
      }
    }
  });
});
