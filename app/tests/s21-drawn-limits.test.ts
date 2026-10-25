/**
 * Sprint 21 (s21r, review r5 finding 6): the 3D view's routeLimits cover the cables AS DRAWN.
 * The drawn cable (sag, bows) could come closer to a cable of another node, or into a part's
 * volume, than its route (randomBench(40, 2007, dense, board): W3 and W12 of different nodes at
 * a 1.28 mm axis gap with routeLimits empty; seeds 2004 / 2010: drawn body hits unlisted).
 * `deriveCheckedScene` (what the view shows) lists every such wire; the check is bounded and
 * lists what it could not reach.
 */
import { describe, expect, it } from 'vitest';
import { routeAutomatic } from '../src/ui/routing.js';
import { deriveScene } from '../src/views/scene3d/scene.js';
import { deriveCheckedScene, drawnLimits, sceneShapes } from '../src/views/scene3d/checked.js';
import { measure3d } from './support/wire3dMetrics.js';
import { randomBench } from './support/routingBench.js';

describe('3D routeLimits cover the drawn cables (s21r review r5)', () => {
  it('every drawn contact of two nodes and every drawn body pass is listed', () => {
    for (const seed of [2004, 2007, 2010]) {
      const d = routeAutomatic(randomBench(40, seed, { dense: true, board: true }).doc);
      const s = deriveCheckedScene(d);
      const m = measure3d(d, s, 'drawn');
      const need = new Set([
        ...m.foreignPenetrations.flatMap((p) => [p.a, p.b]),
        ...m.bodyHits.map((b) => b.split('>')[0]!),
      ]);
      expect(need.size, `${seed}`).toBeGreaterThan(0);
      for (const id of need) expect(s.routeLimits, `${seed} ${id}`).toContain(id);
      // The route-level list alone missed some (the case the review found).
      if (seed === 2007) expect(deriveScene(d).routeLimits).toEqual([]);
    }
  });

  it('the shapes are computed once per scene; the check is bounded and lists what it skipped', () => {
    const d = routeAutomatic(randomBench(20, 1, { dense: true }).doc);
    const s = deriveScene(d);
    expect(sceneShapes(s)).toBe(sceneShapes({ ...s, routeLimits: ['x'] }));
    const all = s.wires.filter((w) => !w.simple).map((w) => w.id);
    expect(drawnLimits(d, s, sceneShapes(s), 0).sort()).toEqual([...all].sort());
  });
});
