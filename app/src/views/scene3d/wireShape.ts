/**
 * Natural wire shape (Sprint 10 realism pass): hook-up wire is not a CAD pipe. From each wire's
 * route (scene.ts: orthogonal plan runs at a chosen height, vertical risers at the ends) this
 * derives a gentler physical shape:
 * - long runs SAG a little between their supports (up to 2 mm, ~3.5 % of the span), the low point
 *   off-centre by a fixed per-wire amount (asymmetry without randomness);
 * - where a riser turns into a run the wire is BENT, not folded: a bend radius up to 6 mm (a hand-
 *   formed bend), limited by the riser and the run;
 * - a wire leaving a jumper housing runs straight out of it before it bends (strain relief).
 * Deterministic: everything is a function of the route and the wire id (a stable hash), never of
 * time or randomness.
 *
 * Safety: the route's guarantees (no wire through a part it is not connected to, wires that meet
 * at different heights pass a full level apart) must survive. Every draped wire is therefore
 * CHECKED against every other wire and every part's body; if it comes too close it is retried with
 * half the sag, then with the original shape. Presentation only: ends, connectivity and colours
 * are unchanged (tests: app/tests/wire-shape.test.ts).
 */
import * as THREE from 'three';
import { MODEL_HEIGHT, WIRE_RADIUS, type SceneDescription, type Vec3 } from './scene.js';
import { footprintRect, type Rect } from './labels.js';
import { bentPath } from './wires.js';

/** A wire's shape: the control points and the bend radius at each interior point. */
export interface WireShape {
  points: Vec3[];
  radii: number[];
  /** How much of the natural shape was kept: 1 (full), 0.5 (half sag), 0 (the route as is). */
  drape: 0 | 0.5 | 1;
}

const PLAN_BEND = 2.0;
const RISER_BEND = 3.0;
const MAX_RISER_BEND = 6.0;
const MAX_SAG = 2.0;
const SAG_PER_MM = 0.035;
/** Spans shorter than this stay straight (a short jumper is taut). */
const MIN_SAG_SPAN = 14;
/** Straight run out of a jumper housing before the first bend. */
const HOUSING_EXIT = 2.5;
/** Required clearance between the surfaces of two wires, and of a wire over a part (mm). */
const WIRE_GAP = 0.12;
const BODY_GAP = 0.2;

/** A stable 0..1 value from a string (FNV-1a). */
function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 10007) / 10007;
}

const same = (a: Vec3, b: Vec3) =>
  Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const vertical = (a: Vec3, b: Vec3) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;

/** The route's own shape (as drawn before this pass). */
export function plainShape(points: Vec3[]): WireShape {
  const radii: number[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const v = vertical(points[i - 1]!, points[i]!) || vertical(points[i]!, points[i + 1]!);
    radii.push(v ? RISER_BEND : PLAN_BEND);
  }
  return { points, radii, drape: 0 };
}

/** The natural shape at a given sag factor (0..1). */
export function drapedShape(
  id: string,
  points: Vec3[],
  ends: readonly [string, string],
  sag: number,
): WireShape {
  let pts = points.map((p) => ({ ...p }));
  // Out of a jumper housing: a straight exit before the bend (the riser keeps its top).
  const exit = (k: 0 | 1) => {
    if (ends[k] !== 'jumper' || pts.length < 3) return;
    const [e, top] = k === 0 ? [pts[0]!, pts[1]!] : [pts[pts.length - 1]!, pts[pts.length - 2]!];
    if (!vertical(e, top) || top.y - e.y < HOUSING_EXIT * 2) return;
    const p = { ...e, y: e.y + HOUSING_EXIT };
    if (k === 0) pts.splice(1, 0, p);
    else pts.splice(pts.length - 1, 0, p);
  };
  exit(0);
  exit(1);
  // Sag along long level runs (both ends at the same height, not vertical).
  if (sag > 0) {
    const out: Vec3[] = [pts[0]!];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const span = Math.hypot(b.x - a.x, b.z - a.z);
      if (!vertical(a, b) && Math.abs(a.y - b.y) < 1e-6 && span >= MIN_SAG_SPAN) {
        // Never lower than a wire's thickness plus a little over the bench.
        const depth = Math.max(
          0,
          Math.min(sag * Math.min(MAX_SAG, SAG_PER_MM * span), a.y - (WIRE_RADIUS + 0.5)),
        );
        // The low point off-centre by up to +-15 % of the span (per wire and run, stable).
        const peak = 0.5 + 0.3 * (hash01(`${id}:${i}`) - 0.5);
        for (const t of [peak * 0.5, peak, peak + (1 - peak) * 0.5]) {
          // A smooth catenary-like profile through the low point.
          const u = t <= peak ? t / peak : (1 - t) / (1 - peak);
          const dy = depth * Math.sin((Math.PI / 2) * u);
          out.push({ x: a.x + (b.x - a.x) * t, y: a.y - dy, z: a.z + (b.z - a.z) * t });
        }
      }
      out.push(b);
    }
    pts = out;
  }
  // Bend radii: a riser turning into a run bends wide; plan turns stay tight; the sag's own
  // control points take the widest radius the neighbouring runs allow (a smooth curve).
  const radii: number[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const p = pts[i]!;
    const b = pts[i + 1]!;
    const riser = vertical(a, p) || vertical(p, b);
    const turn = new THREE.Vector3(p.x - a.x, p.y - a.y, p.z - a.z)
      .normalize()
      .dot(new THREE.Vector3(b.x - p.x, b.y - p.y, b.z - p.z).normalize());
    if (turn > 0.95)
      radii.push(50); // a sag point: as smooth as the runs allow
    else if (riser) {
      const rise = vertical(a, p) ? Math.abs(p.y - a.y) : Math.abs(b.y - p.y);
      const run = vertical(a, p) ? dist(p, b) : dist(a, p);
      radii.push(
        sag > 0
          ? Math.max(RISER_BEND, Math.min(MAX_RISER_BEND, rise * 0.45, run * 0.4))
          : RISER_BEND,
      );
    } else radii.push(PLAN_BEND);
  }
  return { points: pts, radii, drape: sag >= 1 ? 1 : sag > 0 ? 0.5 : 0 };
}

/** Points along a shape, every `step` mm. */
export function sampleShape(s: WireShape, step = 0.6): THREE.Vector3[] {
  const path = bentPath(s.points, s.radii);
  const n = Math.max(2, Math.ceil(path.getLength() / step));
  return Array.from({ length: n + 1 }, (_, i) => path.getPointAt(i / n));
}

/** A grid of sample points for neighbour queries (cell = 2 mm). */
class Grid {
  private readonly cells = new Map<string, { p: THREE.Vector3; wire: number }[]>();
  private static key(x: number, y: number, z: number) {
    return `${Math.floor(x / 2)},${Math.floor(y / 2)},${Math.floor(z / 2)}`;
  }
  add(p: THREE.Vector3, wire: number) {
    const k = Grid.key(p.x, p.y, p.z);
    (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push({ p, wire });
  }
  remove(wire: number) {
    for (const [k, list] of this.cells) {
      const kept = list.filter((e) => e.wire !== wire);
      if (kept.length) this.cells.set(k, kept);
      else this.cells.delete(k);
    }
  }
  near(p: THREE.Vector3, r: number, visit: (q: THREE.Vector3, wire: number) => boolean): boolean {
    const c = Math.ceil(r / 2);
    const x0 = Math.floor(p.x / 2);
    const y0 = Math.floor(p.y / 2);
    const z0 = Math.floor(p.z / 2);
    for (let dx = -c; dx <= c; dx++)
      for (let dy = -c; dy <= c; dy++)
        for (let dz = -c; dz <= c; dz++)
          for (const e of this.cells.get(`${x0 + dx},${y0 + dy},${z0 + dz}`) ?? [])
            if (e.p.distanceTo(p) < r && !visit(e.p, e.wire)) return false;
    return true;
  }
}

/**
 * The shapes of all wires of a scene: each as natural as it can be without coming closer than the
 * route allows to another wire or to a part's body. Deterministic (scene order).
 */
export function shapeWires(desc: SceneDescription): Map<string, WireShape> {
  const wires = desc.wires;
  const shapes = wires.map((w) => plainShape(w.points));
  const samples = shapes.map((s) => sampleShape(s));
  const grid = new Grid();
  samples.forEach((ss, i) => ss.forEach((p) => grid.add(p, i)));
  // Part bodies (plan footprint up to the model's height); a wire's own end parts are exempt.
  const bodies: { id: string; r: Rect; h: number }[] = desc.components.map((c) => ({
    id: c.id,
    r: footprintRect(c),
    h: MODEL_HEIGHT[c.model],
  }));
  const owners = new Map<string, Set<string>>();
  for (const w of wires) {
    const ids = new Set<string>();
    for (const end of [w.points[0]!, w.points[w.points.length - 1]!])
      for (const c of desc.components)
        if (c.terminals.some((t) => Math.abs(t.x - end.x) < 1e-6 && Math.abs(t.z - end.z) < 1e-6))
          ids.add(c.id);
    owners.set(w.id, ids);
  }
  const endsOf = (i: number) => [
    wires[i]!.points[0]!,
    wires[i]!.points[wires[i]!.points.length - 1]!,
  ];
  const minGap = 2 * WIRE_RADIUS + WIRE_GAP;
  const ok = (i: number, ss: THREE.Vector3[], original: THREE.Vector3[]) => {
    const w = wires[i]!;
    const mine = endsOf(i);
    // Never lower than the original route over the bench near anything it had to clear: a draped
    // point may only be lower than the route where no part body is under it.
    for (const p of ss) {
      if (p.y < WIRE_RADIUS + 0.2) {
        // At the very ends the wire meets its terminal near the bench: allowed there only.
        if (!mine.some((e) => Math.hypot(e.x - p.x, e.z - p.z) < 4)) return false;
      }
      for (const b of bodies) {
        if (owners.get(w.id)!.has(b.id)) continue;
        const inPlan =
          p.x > b.r.x0 - WIRE_RADIUS &&
          p.x < b.r.x1 + WIRE_RADIUS &&
          p.z > b.r.z0 - WIRE_RADIUS &&
          p.z < b.r.z1 + WIRE_RADIUS;
        if (inPlan && p.y < b.h + WIRE_RADIUS + BODY_GAP) {
          // Was the route itself this low here? Then the shape changed nothing that matters.
          const before = original.reduce(
            (m, q) => (Math.hypot(q.x - p.x, q.z - p.z) < 1 ? Math.min(m, q.y) : m),
            Infinity,
          );
          if (p.y < before - 1e-6) return false;
        }
      }
      // Other wires: keep the route's separation, except near an end both wires share.
      const clear = grid.near(p, minGap, (q, j) => {
        if (j === i) return true;
        const shared = endsOf(j).some((e) => mine.some((m) => same(m, e)) && dist(e, p) < 4);
        return shared;
      });
      if (!clear) return false;
    }
    return true;
  };
  wires.forEach((w, i) => {
    const original = samples[i]!;
    grid.remove(i);
    for (const sag of [1, 0.5]) {
      const s = drapedShape(w.id, w.points, w.ends, sag);
      const ss = sampleShape(s);
      if (ok(i, ss, original)) {
        shapes[i] = s;
        samples[i] = ss;
        break;
      }
    }
    samples[i]!.forEach((p) => grid.add(p, i));
  });
  return new Map(wires.map((w, i) => [w.id, shapes[i]!]));
}
