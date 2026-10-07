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
 * and the nearest hit wins (with `withActuators`, during a simulation, a physical control's
 * actuator region first: `actuators`). The bench, the backdrop, labels and shadows are not in the set, so
 * they can never select anything. Pure and deterministic; run only on a click (no per-frame
 * raycasting).
 */
import type * as THREE from 'three';
import type { Obstacle } from './route3d.js';
import type { ModelKey, SceneDescription } from './scene.js';
import { WIRE_RADIUS } from './scene.js';
import { worldBoxes, type Box } from './separation.js';
import { TACTILE, TOGGLE } from './physical.js';
import { TOGGLE_TILT } from './assets/benchParts.js';
import { sampleShape, type WireShape } from './wireShape.js';

export type Pick =
  | { kind: 'component'; id: string }
  | { kind: 'wire'; id: string }
  /** A physical control's actuator (the toggle's lever, the button's cap) of a part. */
  | { kind: 'actuator'; id: string; control: 'toggle' | 'momentary' }
  | null;

/** An interactive region of a part: where its actuator is (world box), and what it does. */
export interface Actuator {
  id: string;
  control: 'toggle' | 'momentary';
  box: Obstacle;
}

/**
 * The interactive regions of a scene's physical controls (Sprint 10, operation during Run), from
 * the parts' real dimensions: the toggle switch's lever (its whole swing above the nut, both
 * positions) and the push button's actuator cap. Interaction descriptors, by model: a future
 * control (a knob, a multi-position switch) adds its region here.
 */
export function actuators(scene: SceneDescription): Actuator[] {
  const out: Actuator[] = [];
  for (const c of scene.components) {
    const local = ACTUATOR_REGIONS[c.model];
    if (!local) continue;
    const [box] = worldBoxes({
      id: c.id,
      model: c.model,
      x: c.x,
      z: c.z,
      rotation: c.rotation,
      boxes: [local.box],
      nodes: [],
    });
    out.push({
      id: c.id,
      control: local.control,
      box: {
        part: c.id,
        x0: box!.x0,
        x1: box!.x1,
        z0: box!.z0,
        z1: box!.z1,
        bottom: box!.y0,
        top: box!.y1,
      },
    });
  }
  return out;
}

const toggleTop = TOGGLE.standoffMm + TOGGLE.bodyHeightMm;
const togglePivot = toggleTop + TOGGLE.bushingHeightMm - 0.6;
const swing = Math.sin(Math.abs(TOGGLE_TILT.open)) * TOGGLE.leverLengthMm + 1;
const tactCover = TACTILE.standoffMm + TACTILE.bodyHeightMm - 0.35 + 0.12;
const ACTUATOR_REGIONS: Partial<Record<ModelKey, { control: 'toggle' | 'momentary'; box: Box }>> = {
  'switch.toggle': {
    control: 'toggle',
    box: {
      x0: -swing,
      x1: swing,
      z0: -1.3,
      z1: 1.3,
      y0: togglePivot - 0.3,
      y1: togglePivot + TOGGLE.leverLengthMm + 0.5,
    },
  },
  'switch.tactile': {
    control: 'momentary',
    box: {
      x0: -TACTILE.actuatorDiameterMm / 2 - 0.5,
      x1: TACTILE.actuatorDiameterMm / 2 + 0.5,
      z0: -TACTILE.actuatorDiameterMm / 2 - 0.5,
      z1: TACTILE.actuatorDiameterMm / 2 + 0.5,
      y0: tactCover,
      y1: tactCover + 0.12 + TACTILE.actuatorHeightMm + 0.4,
    },
  },
};

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
  withActuators = false,
): Pick {
  const n = Math.hypot(...ray.dir);
  const r: Ray = { origin: ray.origin, dir: ray.dir.map((v) => v / n) as Ray['dir'] };
  let best: { t: number; hit: Pick } | null = null;
  const consider = (t: number, hit: Pick) => {
    if (!best || t < best.t - 1e-9) best = { t, hit };
  };
  const parts = new Set(scene.components.map((c) => c.id));
  // An actuator hit beats its own part's body (whose box encloses the lever), not what is in
  // front of it.
  const acted = new Set<string>();
  for (const a of withActuators ? actuators(scene) : []) {
    const t = hitBox(r, a.box);
    if (t !== null) {
      consider(t - 0.25, { kind: 'actuator', id: a.id, control: a.control });
      acted.add(a.id);
    }
  }
  for (const o of obstacles) {
    const id = parts.has(o.part) ? o.part : o.part.split(':')[0]!;
    if (!parts.has(id) || acted.has(id)) continue;
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
