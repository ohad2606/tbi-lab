/**
 * Geometric checks of a derived 3D scene (shared by the 3D routing tests and the wire routing
 * integrity suite): wire samples tested against the parts' real routing volumes.
 */
import { expect } from 'vitest';
import type { ProjectDocument } from '@tbi-lab/domain';
import type { Obstacle } from '../../src/views/scene3d/route3d.js';
import {
  sceneObstacles,
  WIRE_RADIUS,
  type SceneDescription,
  type SceneWire,
  type Vec3,
} from '../../src/views/scene3d/scene.js';

/** Points along a wire's control polyline, every `step` mm. */
export function samples(w: SceneWire, step = 0.25): Vec3[] {
  const out: Vec3[] = [w.points[0]!];
  for (let i = 1; i < w.points.length; i++) {
    const a = w.points[i - 1]!;
    const b = w.points[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}
/**
 * No wire passes through a part's body: every point of a wire is outside every routing volume of
 * the parts it does not end on (by more than most of a wire radius), and outside the raised
 * bodies (a module board, its dome) of the parts it does end on.
 */
export function expectNoWireThroughBodies(
  doc: ProjectDocument,
  s: SceneDescription,
  label: string,
  only: (o: Obstacle) => boolean = () => true,
) {
  const obstacles = sceneObstacles(doc, s).filter(only);
  const m = WIRE_RADIUS * 0.8;
  for (const w of s.wires) {
    const src = doc.layout.wires.find((x) => x.id === w.id)!;
    const own = [src.from, src.to].flatMap((e) =>
      e.kind === 'terminal' ? [e.component, `${e.component}:${e.terminal}`] : [],
    );
    const ends = [w.points[0]!, w.points.at(-1)!];
    for (const p of samples(w, 0.5))
      for (const o of obstacles) {
        const isOwn = own.includes(o.part) || own.some((x) => o.part.startsWith(`${x}:`));
        if (isOwn && o.bottom < 2) continue;
        // Its own terminal fitting (a supply's binding post) where it is fastened.
        if (isOwn && ends.some((e) => Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z) < 3)) continue;
        const inside =
          p.x > o.x0 - m &&
          p.x < o.x1 + m &&
          p.z > o.z0 - m &&
          p.z < o.z1 + m &&
          p.y > o.bottom - m &&
          p.y < o.top + m;
        expect(inside, `${label}: ${w.id} through ${o.part} at ${JSON.stringify(p)}`).toBe(false);
      }
  }
}
