/**
 * Sprint 22 (s22r): two exit lanes of DIFFERENT nodes no longer touch at pin level. Lanes run
 * at pin height under and out of a module, where no cable can hop over another; two parts' facing
 * pins in the narrow gap between their boards sent both lanes into that gap (randomBench(40,
 * 2011, dense, board): U4.gnd and U6.vcc, 3.8 mm apart) and the 3D scene fell back to a scene
 * whose cables towered 45 mm high. Now the later wire's lane takes its next side
 * (scene.ts assignLanes / laneContacts). Different-node contacts on the routes of these benches,
 * before -> after: 2001 4 -> 0, 2002 5 -> 1, 2011 4 -> 1 (s22r sweeps).
 */
import { describe, expect, it } from 'vitest';
import { routeConflictsReport } from '@tbi-lab/domain';
import { componentBoxes, routeAutomatic } from '../src/ui/routing.js';
import { deriveScene } from '../src/views/scene3d/scene.js';
import { measure3d } from './support/wire3dMetrics.js';
import { randomBench } from './support/routingBench.js';

describe('exit lanes of different nodes do not touch (s22r)', () => {
  it('dense board benches: fewer contacts, every one flagged, no tower', () => {
    const want: Record<number, number> = { 2001: 0, 2002: 1, 2011: 1 };
    for (const [seed, max] of Object.entries(want)) {
      const d = routeAutomatic(randomBench(40, Number(seed), { dense: true, board: true }).doc);
      const s = deriveScene(d);
      const m = measure3d(d, s, 'route');
      expect(m.foreignPenetrations.length, seed).toBeLessThanOrEqual(max);
      for (const p of m.foreignPenetrations) expect(s.routeLimits, seed).toContain(p.a);
      for (const w of s.wires)
        expect(Math.max(...w.points.map((p) => p.y)), `${seed} ${w.id}`).toBeLessThan(30);
    }
  });

  // 2D (route.ts): automatic wires left reading as connected to another node get first pick in
  // one more pass, kept when fewer such wires remain. randomBench(40, 7103, dense, board): W35 and
  // W36 ran along another node's wire through a gate; randomBench(40, 2005, ...) W8 / W24 met
  // another node's wire.
  it('2D: a wire drawn along another node is routed first and clears it', () => {
    for (const seed of [7103]) {
      const doc = randomBench(40, seed, { dense: true, board: true }).doc;
      const d = routeAutomatic(doc);
      const r = routeConflictsReport(d, componentBoxes(d));
      expect(r.kinds.wire, `${seed}`).toEqual([]);
      expect(r.kinds.body, `${seed}`).toEqual([]);
      expect(JSON.stringify(routeAutomatic(doc).layout)).toBe(JSON.stringify(d.layout));
      // Endpoints (and so the netlist) untouched.
      expect(d.layout.wires.map((w) => [w.id, w.from, w.to])).toEqual(
        doc.layout.wires.map((w) => [w.id, w.from, w.to]),
      );
    }
  });
});
