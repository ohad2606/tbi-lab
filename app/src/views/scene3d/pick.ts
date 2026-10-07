/**
 * 3D picking (Sprint 10, owner-approved limited interaction): what a click in the 3D view hits,
 * as a LOGICAL project entity (a component id or a wire id), never a mesh. The 3D view stays a
 * derived view: picking only selects; it never edits topology or placement.
 *
 * Picking works on the scene description, not on the rendered meshes (static meshes are merged
 * across parts for speed, so a mesh no longer knows its part): the click ray is intersected with
 * - every part's routing volumes (the boxes wires clear: its body, leads, posts, jumper
 *   housings; scene.ts sceneObstacles), which resolve to the part;
 * - every wire's shaped tube (the same shape the renderer draws, wireShape.ts), with a slightly
 *   generous radius so a thin wire is easy to hit;
 * and the nearest hit wins. The bench, the backdrop, labels and shadows are not in the set, so
 * they can never select anything. Pure and deterministic; run only on a click (no per-frame
 * raycasting).
 */
import type * as THREE from 'three';
import type { Obstacle } from './route3d.js';
import type { SceneDescription } from './scene.js';
import { WIRE_RADIUS } from './scene.js';
import { sampleShape, type WireShape } from './wireShape.js';

export type Pick = { kind: 'component'; id: string } | { kind: 'wire'; id: string } | null;

export interface Ray {
  origin: [number, number, number];
  dir: [number, number, number];
}

/** Each drawn shape sampled once (a scene's shapes live until the scene changes). */
const sampled = new WeakMap<WireShape, THREE.Vector3[]>();

/** Hit radius of a wire for picking: a little more than the tube (mm). */
const WIRE_PICK = WIRE_RADIUS * 1.8;

/** Ray parameter where it enters a box, or null when it misses (slab test). */
function hitBox(r: Ray, o: Obstacle): number | null {
  let t0 = 0;
  let t1 = Infinity;
  const lo = [o.x0, o.bottom, o.z0];
  const hi = [o.x1, o.top, o.z1];
  for (let k = 0; k < 3; k++) {
    const d = r.dir[k]!;
    const p = r.origin[k]!;
    if (Math.abs(d) < 1e-12) {
      if (p < lo[k]! || p > hi[k]!) return null;
      continue;
    }
    let a = (lo[k]! - p) / d;
    let b = (hi[k]! - p) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0;
}

/** Closest approach of a ray to a segment: [ray parameter, distance]. */
function nearSegment(r: Ray, a: THREE.Vector3, b: THREE.Vector3): [number, number] {
  const o = r.origin;
  const d = r.dir;
  const u = [b.x - a.x, b.y - a.y, b.z - a.z];
  const w = [o[0] - a.x, o[1] - a.y, o[2] - a.z];
  const dot = (p: number[], q: number[]) => p[0]! * q[0]! + p[1]! * q[1]! + p[2]! * q[2]!;
  const A = dot(d, d);
  const B = dot(d, u);
  const C = dot(u, u);
  const D = dot(d, w);
  const E = dot(u, w);
  const den = A * C - B * B;
  let t = den > 1e-12 ? (A * E - B * D) / den : C > 1e-12 ? E / C : 0;
  t = Math.min(1, Math.max(0, t));
  const s = Math.max(0, (t * B - D) / A);
  const p = [o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s];
  const q = [a.x + u[0]! * t, a.y + u[1]! * t, a.z + u[2]! * t];
  return [s, Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!)];
}

/**
 * The entity a ray hits first. `obstacles`: the scene's part volumes (part id, or
 * `part:terminal` for a jumper housing); `shapes`: the wires' drawn shapes.
 */
export function pick(
  ray: Ray,
  scene: SceneDescription,
  obstacles: readonly Obstacle[],
  shapes: ReadonlyMap<string, WireShape>,
): Pick {
  const n = Math.hypot(...ray.dir);
  const r: Ray = { origin: ray.origin, dir: ray.dir.map((v) => v / n) as Ray['dir'] };
  let best: { t: number; hit: Pick } | null = null;
  const consider = (t: number, hit: Pick) => {
    if (!best || t < best.t - 1e-9) best = { t, hit };
  };
  const parts = new Set(scene.components.map((c) => c.id));
  for (const o of obstacles) {
    const id = parts.has(o.part) ? o.part : o.part.split(':')[0]!;
    if (!parts.has(id)) continue;
    const t = hitBox(r, o);
    if (t !== null) consider(t, { kind: 'component', id });
  }
  for (const w of scene.wires) {
    const shape = shapes.get(w.id);
    if (!shape) continue;
    let pts = sampled.get(shape);
    if (!pts) sampled.set(shape, (pts = sampleShape(shape, 1)));
    for (let i = 1; i < pts.length; i++) {
      const [t, d] = nearSegment(r, pts[i - 1]!, pts[i]!);
      // A wire is in front of whatever it lies on: prefer it on a near-tie with a body.
      if (d < WIRE_PICK) consider(t - 0.5, { kind: 'wire', id: w.id });
    }
  }
  return best ? (best as { t: number; hit: Pick }).hit : null;
}
