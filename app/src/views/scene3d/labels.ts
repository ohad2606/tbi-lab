/**
 * Part footprints on the bench (plan rectangles, world mm). Pure: no WebGL (unit-tested). Since the
 * layer model (layers.ts) reference labels are no longer printed on the bench.
 */
import { rotatePoint } from '@tbi-lab/domain';
import { FOOTPRINT, type SceneComponent } from './scene.js';

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** A part's footprint on the bench, world mm. */
export function footprintRect(c: SceneComponent): Rect {
  const [x0, x1, z0, z1] = FOOTPRINT[c.model];
  const r: Rect = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const [x, z] of [
    [x0, z0],
    [x1, z0],
    [x0, z1],
    [x1, z1],
  ] as const) {
    const p = rotatePoint({ x, y: z }, c.rotation);
    r.x0 = Math.min(r.x0, c.x + p.x);
    r.x1 = Math.max(r.x1, c.x + p.x);
    r.z0 = Math.min(r.z0, c.z + p.y);
    r.z1 = Math.max(r.z1, c.z + p.y);
  }
  return r;
}
