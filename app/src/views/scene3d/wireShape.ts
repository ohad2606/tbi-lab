/**
 * Physical wire shape (Sprint 10 realism passes): the ELECTRICAL route and the PHYSICAL cable are
 * different things. The route (scene.ts / route3d.ts: orthogonal plan runs at chosen heights,
 * risers at the ends) says where a wire may go; a real jumper wire never follows it with ruler-
 * straight runs and right-angle elbows. From each route this derives the cable a hand would lay:
 *   route polyline -> cleaned control polygon -> physical curve -> tube (wires.ts).
 * - Cleaned: duplicate points, collinear points and the router's tiny end jogs (a fraction of a
 *   millimetre up to a lead tip) are dropped, so a wire curves into its terminal instead of
 *   stepping into it.
 * - Bends are wide and asymmetric: each corner bends over up to 14 mm of each adjoining run (a run
 *   shared by two corners is shared in proportion; a run that ends at a terminal may be used
 *   almost whole), so a corner reads as a hand-formed curve, never as an elbow. No bend is
 *   tighter than its arms allow; the quadratic blend keeps the tangent continuous.
 * - Gravity: a level span above the bench SAGS (up to 2.5 mm, ~4 % of the span); a sloping span
 *   (a jumper coming down off a header) hangs a little below its chord. A long run resting on the
 *   bench is never ruler-straight: it BOWS slightly sideways (up to 1.6 mm, ~2 % of the run), the
 *   way a wire relaxes when laid down. The low point and the bow's side are fixed per wire (a
 *   stable hash of its id): asymmetry without randomness.
 * - A wire leaving a jumper housing runs straight out of it before it bends (strain relief).
 * - The NECK (owner review, Sprint 10): out of a jumper housing plugged on a header pin the wire
 *   leaves the housing's top face along its axis (where the crimp's insulation wings hold it),
 *   runs 3 mm straight (strain relief), then turns in ONE wide circular bend (6 mm radius where
 *   there is room, else 5 or 4 mm: never below 3x the wire's diameter; the route's own corners
 *   are 2-3 mm), never past straight down (no hook back over the housing), and runs straight on
 *   to where it joins the route in an ordinary soft corner. The route's own steep drop right next
 *   to the housing (which folded the wire back past, and into, the plastic) is replaced; the
 *   neck is checked against every jumper housing and the board's top, and the route's riser is
 *   kept when no such bend fits (jumperNeck).
 * Deterministic: everything is a function of the route and the wire id, never of time, camera or
 * randomness.
 *
 * Safety: the route's guarantees (no wire through a part it is not connected to, wires that cross
 * pass a full level apart) must survive. Every shape is therefore CHECKED against every other wire
 * and every part's body, and stepped down (narrower bends, no bow, half sag) until it passes; the
 * last resort is the route as drawn. Presentation only: ends, connectivity and colours never
 * change (tests: app/tests/wire-shape.test.ts).
 */
import * as THREE from 'three';
import {
  MAX_SAMPLES,
  MODEL_HEIGHT,
  WIRE_RADIUS,
  type SceneDescription,
  type SceneWire,
  type Vec3,
} from './scene.js';
import { footprintRect, type Rect } from './labels.js';
import { bentPath } from './wires.js';
import { ESP32_DEVKITC, ESP32_PCB_TOP, ESP32_PIN_TOP } from './physical.js';

/** A wire's shape: the control points and the bend at each interior point. */
export interface WireShape {
  points: Vec3[];
  /** Symmetric bend radius per interior point (the route as drawn). */
  radii: number[];
  /** A physical cable's bends: arm lengths into and out of each interior point. */
  arms?: [number, number][];
  /** How much of the natural shape was kept: 1 (full), 0.5 (half sag), 0 (the route as is). */
  drape: 0 | 0.5 | 1;
  /** Per end: the bend radius of its neck out of a jumper housing (null: no neck there). */
  necks?: [number | null, number | null];
}

/** Drape work per scene, in samples checked (s20r5; ~1 s on the 1-vCPU DEV host). */
export const DRAPE_WORK_BUDGET = 150_000;

/** One step of physical shaping (stepped down until the shape is clear of everything). */
interface Level {
  /** Bend arm wanted at a plan corner, and where the height profile bends (mm). */
  plan: number;
  ramp: number;
  /** Fraction of the full sideways bow and of the full sag. */
  bow: number;
  sag: number;
  /** Fraction of a jumper's arch out of its housing (0: follow the route down). */
  arch: number;
  /** A hump over another wire or a lead is smoothed (and lifted this much to keep clear, mm). */
  hump: number;
  drape: 0.5 | 1;
}
const LEVELS: readonly Level[] = [
  { plan: 14, ramp: 8, bow: 1, sag: 1, arch: 1, hump: 0.35, drape: 1 },
  { plan: 9, ramp: 6, bow: 0.5, sag: 1, arch: 0.6, hump: 0.7, drape: 1 },
  { plan: 9, ramp: 6, bow: 0.5, sag: 1, arch: 0, hump: 0, drape: 1 },
  { plan: 6, ramp: 5, bow: 0, sag: 0.5, arch: 0, hump: 0, drape: 0.5 },
  { plan: 3.5, ramp: 3.5, bow: 0, sag: 0, arch: 0, hump: 0, drape: 0.5 },
];

const PLAN_BEND = 2.0;
const RISER_BEND = 3.0;
const MAX_SAG = 2.5;
const SAG_PER_MM = 0.04;
/** A sloping span hangs this much below its chord, at most (mm), and per mm of span. */
const MAX_HANG = 2.0;
const HANG_PER_MM = 0.03;
/** A run resting on the bench bows sideways this much at most (mm), and per mm of run. */
const MAX_BOW = 1.6;
const BOW_PER_MM = 0.02;
/** Runs shorter than this stay straight in plan. */
const MIN_BOW_RUN = 20;
/** Interior points this close to an end are the router's end jogs (mm). */
const END_JOG = 1.2;
/** Steepest climb of a wire resting over something it crosses (mm per mm). */
const MAX_CLIMB = 0.4;
/** A bend's arms differ by at most this ratio (a very lopsided quadratic would kink). */
const ARM_RATIO = 4;
/** Spans shorter than this stay straight (a short jumper is taut). */
const MIN_SAG_SPAN = 14;
/** Straight run out of a jumper housing before the first bend. */
const HOUSING_EXIT = 2.5;
/** The neck out of a jumper housing: straight strain relief, then the first bend's radius (mm). */
export const NECK_STRAIGHT = 3.0;
export const NECK_RADIUS = 6.0;
/** Bend radii tried, widest first; the smallest is still 3x the wire's diameter (mm). */
export const NECK_RADII = [NECK_RADIUS, 5, 4] as const;
/** The neck's arc turns at most this far (down: hanging beside the housing, never hooking back). */
const NECK_MAX_TURN = Math.PI;
/** The corner where the neck joins the route turns at most this far. */
const NECK_MAX_JOIN = (100 / 180) * Math.PI;
/** Clearance of the neck's surface from a housing or the board top (mm). */
const NECK_GAP = 0.25;

/** A box a wire's neck must clear (plan rectangle and heights, mm). */
export interface NeckBox {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y0: number;
  y1: number;
}
/** What a jumper wire's neck must clear: every jumper housing, and each board's top. */
export interface NeckContext {
  housings: NeckBox[];
  boards: NeckBox[];
}

/** Distance from a point to a box (0 inside). */
export function boxDistance(p: Vec3, b: NeckBox): number {
  const dx = Math.max(b.x0 - p.x, 0, p.x - b.x1);
  const dy = Math.max(b.y0 - p.y, 0, p.y - b.y1);
  const dz = Math.max(b.z0 - p.z, 0, p.z - b.z1);
  return Math.hypot(dx, dy, dz);
}

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
export function plainShape(points: Vec3[], given?: number[]): WireShape {
  if (given && given.length === points.length - 2) return { points, radii: [...given], drape: 0 };
  const radii: number[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const v = vertical(points[i - 1]!, points[i]!) || vertical(points[i]!, points[i + 1]!);
    radii.push(v ? RISER_BEND : PLAN_BEND);
  }
  return { points, radii, drape: 0 };
}

/** The route's control polygon, cleaned: no duplicates, no collinear points, no end jogs. */
function clean(points: Vec3[], ends: readonly [string, string]): Vec3[] {
  // The ends are exact: a point (nearly) on top of an end goes, never the end itself.
  const n = points.length;
  let pts = points.filter(
    (p, i) =>
      i === 0 || i === n - 1 || (dist(p, points[i - 1]!) > 0.05 && dist(p, points[n - 1]!) > 0.05),
  );
  // The router's tiny steps up to a lead tip or post (not a jumper's straight exit): of the
  // points within a jog's reach of an end only the outermost stays (it keeps the route's height
  // where the jog ends), so the wire drops to its terminal in one short step.
  const jog = (k: 0 | 1) => {
    if (ends[k] === 'jumper') return;
    const e = k === 0 ? pts[0]! : pts[pts.length - 1]!;
    const inner = (p: Vec3) => dist(p, e) < END_JOG;
    const idx = pts.map((_, i) => i).filter((i) => i > 0 && i < pts.length - 1);
    const near = idx.filter((i) => inner(pts[i]!));
    if (near.length < 2) return;
    // Keep the one farthest along the route from the end.
    const keep = k === 0 ? Math.max(...near) : Math.min(...near);
    const drop = new Set(near.filter((i) => i !== keep));
    pts = pts.filter((_, i) => !drop.has(i));
  };
  jog(0);
  jog(1);
  // Collinear points (a straight run split by the router) carry no bend.
  const out: Vec3[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1]!;
    const p = pts[i]!;
    const b = pts[i + 1]!;
    const u = new THREE.Vector3(p.x - a.x, p.y - a.y, p.z - a.z).normalize();
    const v = new THREE.Vector3(b.x - p.x, b.y - p.y, b.z - p.z).normalize();
    if (u.dot(v) < 0.9995) out.push(p);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/**
 * The interior control points of a cable resting on a straight stretch's height profile `chain`
 * (its first and last points are the stretch's ends, kept by the caller): the profile sampled
 * every 0.4 mm, dilated by 2.5 mm and lifted by `lift` near what it rests on (both fading to
 * nothing at the ends), simplified (Ramer-Douglas-Peucker, 0.15 mm), each kept point a soft
 * bend of up to 3 mm.
 */
function restOn(chain: Vec3[], lift: number): (Vec3 & { soft: true; want: number })[] {
  const a = chain[0]!;
  const b = chain[chain.length - 1]!;
  const L = Math.hypot(b.x - a.x, b.z - a.z);
  const s = chain.map((p) => Math.hypot(p.x - a.x, p.z - a.z));
  const yAt = (t: number) => {
    let k = 1;
    while (k < s.length - 1 && s[k]! < t) k++;
    const u = (t - s[k - 1]!) / Math.max(1e-9, s[k]! - s[k - 1]!);
    return chain[k - 1]!.y + (chain[k]!.y - chain[k - 1]!.y) * Math.min(1, Math.max(0, u));
  };
  const n = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(L / 0.4)));
  const ts = Array.from({ length: n + 1 }, (_, i) => (L * i) / n);
  const raw = ts.map(yAt);
  // A stiff wire bridges a gap narrower than about 5 mm between two supports instead of dipping
  // into it: the dilation reaches 2.5 mm either side (the route's own corner heights count too:
  // a peak between two samples). The lift applies only near what the wire rests on (a point of
  // the route above the stretch's ends), never along a level run.
  const W = 2.5;
  const base = Math.max(a.y, b.y) + 0.1;
  const raised = s.filter((_, k) => chain[k]!.y > base);
  const up = ts.map((t, i) => {
    let m = raw[i]!;
    for (let k = 0; k < s.length; k++) if (Math.abs(s[k]! - t) <= W) m = Math.max(m, chain[k]!.y);
    for (let k = 0; k <= n; k++) if (Math.abs(ts[k]! - t) <= W) m = Math.max(m, raw[k]!);
    const near = raised.length ? Math.min(...raised.map((r) => Math.abs(r - t))) : Infinity;
    const lw = Math.min(1, Math.max(0, 1 - (near - W) / 1.5));
    return m + lift * lw;
  });
  // A jumper wire is too stiff to climb steeply: it rises over what it crosses at most MAX_CLIMB
  // mm per mm (a cone under every raised point), so a hump has long gentle sides, not a step.
  const cone = ts.map((t) => Math.max(...up.map((y, k) => y - MAX_CLIMB * Math.abs(t - ts[k]!))));
  const dil = ts.map((t, i) => {
    const w = Math.min(1, Math.min(t, L - t) / 1.0);
    return raw[i]! + Math.max(0, cone[i]! - raw[i]!) * w;
  });
  // Simplify, keeping the ends.
  const keep = new Set<number>([0, n]);
  const rdp = (i0: number, i1: number) => {
    let worst = -1;
    let dmax = 0.15;
    for (let k = i0 + 1; k < i1; k++) {
      const u = (ts[k]! - ts[i0]!) / Math.max(1e-9, ts[i1]! - ts[i0]!);
      const d = Math.abs(dil[k]! - (dil[i0]! + (dil[i1]! - dil[i0]!) * u));
      if (d > dmax) {
        dmax = d;
        worst = k;
      }
    }
    if (worst < 0) return;
    keep.add(worst);
    rdp(i0, worst);
    rdp(worst, i1);
  };
  rdp(0, n);
  const ux = L > 0 ? (b.x - a.x) / L : 0;
  const uz = L > 0 ? (b.z - a.z) / L : 0;
  return [...keep]
    .sort((x, y) => x - y)
    .filter((k) => k !== 0 && k !== n)
    .map((k) => ({
      x: a.x + ux * ts[k]!,
      y: dil[k]!,
      z: a.z + uz * ts[k]!,
      soft: true as const,
      want: 3,
    }));
}

type V3 = THREE.Vector3;
const v3 = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);

/**
 * The neck of a jumper end (`pts[0]` the housing's top, `pts[1]` straight above it): the points
 * that replace the route up to where the neck merges into it (a hard point on the route), or null
 * when no wide bend fits (the route stays as it is). `limit`: how far along the route the merge
 * may be (mm).
 *
 * In the vertical plane through the housing's axis and the merge point J: straight up
 * NECK_STRAIGHT to S, a circular arc of radius R (the widest of NECK_RADII that fits) turning
 * toward J, then the arc's tangent straight to J; J itself is an ordinary soft corner of the
 * cable onto the route. The merge is the nearest point of the route for which the arc and the
 * tangent clear every jumper housing (its own included) and the board's top, the arc turns at
 * most NECK_MAX_TURN and the corner at J at most NECK_MAX_JOIN.
 */
export function jumperNeck(
  pts: (Vec3 & { soft?: boolean })[],
  ctx: NeckContext,
  limit: number,
  radii: readonly number[] = NECK_RADII,
): { neck: (Vec3 & { soft?: boolean; want?: number })[]; rest: number; radius: number } | null {
  if (pts.length < 3 || !vertical(pts[0]!, pts[1]!) || pts[1]!.y <= pts[0]!.y) return null;
  const E = v3(pts[0]!);
  const S = E.clone().setY(E.y + NECK_STRAIGHT);
  const segs: { a: V3; b: V3; s0: number; len: number; i: number }[] = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = v3(pts[i - 1]!);
    const b = v3(pts[i]!);
    const len = a.distanceTo(b);
    if (len > 1e-6) segs.push({ a, b, s0: acc, len, i });
    acc += len;
  }
  const clearR = WIRE_RADIUS + NECK_GAP;
  const fits = (p: V3) =>
    ctx.housings.every((h) => boxDistance(p, h) >= clearR) &&
    ctx.boards.every((b) => boxDistance(p, b) >= clearR);
  for (const R of radii)
    for (let L = NECK_STRAIGHT + 2; L <= Math.min(limit, acc - 1); L += 0.5) {
      const seg = segs.find((g) => L >= g.s0 && L <= g.s0 + g.len - 0.1);
      if (!seg) continue;
      const J = seg.a.clone().addScaledVector(seg.b.clone().sub(seg.a).normalize(), L - seg.s0);
      // The plane: h along the plan direction to J, v up; S at (0, 0), the arc's centre (R, 0).
      const hj = Math.hypot(J.x - S.x, J.z - S.z);
      if (hj < 1) continue;
      const d = new THREE.Vector3((J.x - S.x) / hj, 0, (J.z - S.z) / hj);
      const vj = J.y - S.y;
      if (Math.hypot(hj - R, vj) <= R + 0.5) continue;
      // The tangent point: the arc turned by phi (direction (sin, cos)) heads straight at J.
      const cross = (a: number) =>
        Math.sin(a) * (vj - R * Math.sin(a)) - Math.cos(a) * (hj - R + R * Math.cos(a));
      const ahead = (a: number) =>
        Math.sin(a) * (hj - R + R * Math.cos(a)) + Math.cos(a) * (vj - R * Math.sin(a)) > 0;
      let phi = -1;
      const step = Math.PI / 360;
      for (let a = 0; a + step <= NECK_MAX_TURN && phi < 0; a += step) {
        if (cross(a) * cross(a + step) > 0) continue;
        let lo = a;
        let hi = a + step;
        for (let k = 0; k < 30; k++) {
          const mid = (lo + hi) / 2;
          if (cross(lo) * cross(mid) <= 0) hi = mid;
          else lo = mid;
        }
        if (ahead(lo)) phi = lo;
      }
      if (phi < 0) continue;
      const at = (h: number, v: number) =>
        S.clone()
          .addScaledVector(d, h)
          .setY(S.y + v);
      const T = at(R - R * Math.cos(phi), R * Math.sin(phi));
      const lineDir = J.clone().sub(T).normalize();
      const out = seg.b.clone().sub(seg.a).normalize();
      if (lineDir.angleTo(out) > NECK_MAX_JOIN) continue;
      // Arc points about 1 mm apart; all of it, and the straight on to J, clear.
      const n = Math.max(2, Math.ceil((R * phi) / 1.0));
      const arc = Array.from({ length: n }, (_, k) => {
        const a = (phi * (k + 1)) / n;
        return at(R - R * Math.cos(a), R * Math.sin(a));
      });
      const line = Math.ceil(T.distanceTo(J) / 0.5);
      const probe = [
        ...Array.from({ length: 4 * n }, (_, k) => {
          const a = (phi * (k + 1)) / (4 * n);
          return at(R - R * Math.cos(a), R * Math.sin(a));
        }),
        ...Array.from({ length: line }, (_, k) => T.clone().lerp(J, (k + 1) / line)),
      ];
      if (!probe.every(fits)) continue;
      const f = (p: V3) => ({ x: p.x, y: p.y, z: p.z });
      return {
        // S: the end of the straight (its blend into the arc reaches back at most 0.5 mm).
        neck: [pts[0]!, { ...f(S), want: 0.5 }, ...arc.map((p) => ({ ...f(p), soft: true })), f(J)],
        rest: seg.i,
        radius: R,
      };
    }
  return null;
}

/**
 * The physical cable at one level of shaping: the cleaned control polygon, with a sag or hang
 * point on each long span (or a sideways bow on a long run resting on the bench), and each
 * corner's bend arms.
 */
export function cableShape(
  id: string,
  points: Vec3[],
  ends: readonly [string, string],
  level: Level = LEVELS[0]!,
  ctx?: NeckContext,
): WireShape {
  type P = Vec3 & { soft?: boolean; want?: number };
  let pts: P[] = clean(points, ends);
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
  // A jumper wire is stiff enough to arch: up out of its housing, over, and down onto the bench,
  // landing along the way it then runs (instead of the route's straight drop).
  const arch = (forward: P[]): P[] => {
    if (level.arch <= 0 || forward.length < 4) return forward;
    const E = forward[1]!;
    if (!vertical(forward[0]!, E)) return forward;
    const low = Math.min(...forward.slice(2).map((p) => p.y));
    const j = forward.findIndex((p, i) => i >= 2 && p.y <= low + 0.3);
    if (j < 2 || j >= forward.length - 1) return forward;
    const L = forward[j]!;
    const m = forward.findIndex((p, i) => i > j && Math.hypot(p.x - L.x, p.z - L.z) > 0.5);
    if (m < 0) return forward;
    const D = Math.hypot(L.x - E.x, L.z - E.z);
    if (D < 3) return forward;
    const run = Math.hypot(forward[m]!.x - L.x, forward[m]!.z - L.z);
    const ux = (forward[m]!.x - L.x) / run;
    const uz = (forward[m]!.z - L.z) / run;
    // Landing away from the housing only (a route that doubles back keeps its own shape).
    if (ux * (L.x - E.x) + uz * (L.z - E.z) < 0) return forward;
    const rise = level.arch * Math.min(8, Math.max(2, 0.25 * D));
    const back = Math.min(0.5 * D, Math.max(3, 0.4 * D), 14);
    const A: P = { x: E.x, y: E.y + rise, z: E.z, soft: true };
    const B: P = { x: L.x - ux * back, y: L.y, z: L.z - uz * back, soft: true };
    return [forward[0]!, E, A, B, ...forward.slice(j)];
  };
  if (ends[0] === 'jumper') pts = arch(pts);
  if (ends[1] === 'jumper') pts = arch([...pts].reverse()).reverse();
  // Out of a jumper housing: the neck (strain relief, one wide bend, merging into the route).
  const necks: [number | null, number | null] = [null, null];
  if (ctx) {
    const both = ends[0] === 'jumper' && ends[1] === 'jumper';
    const total = pts.reduce((m, p, i) => (i ? m + dist(pts[i - 1]!, p) : 0), 0);
    const limit = both ? total / 2 - 1 : total - 1;
    const withNeck = (forward: P[], k: 0 | 1): P[] => {
      const r = jumperNeck(forward, ctx, Math.min(40, limit));
      necks[k] = r ? r.radius : null;
      return r ? [...r.neck, ...forward.slice(r.rest)] : forward;
    };
    if (ends[0] === 'jumper') pts = withNeck(pts, 0);
    if (ends[1] === 'jumper') pts = withNeck([...pts].reverse(), 1).reverse();
  }
  // The height profile along each straight stretch of the plan (the route rising over a wire or
  // lead it crosses and settling back, following a row of leads): a cable does not trace every
  // step, it RESTS on what it passes over. The profile is dilated (each point raised to the
  // highest route height within 1 mm either side, plus a small lift, so the curve, which runs
  // inside its control points, still clears all of it), simplified, and drawn through soft
  // points; level runs stay level, the stretch's ends stay exact.
  if (level.hump > 0) {
    const inLine = (a: Vec3, p: Vec3, b: Vec3) => {
      const u = new THREE.Vector2(p.x - a.x, p.z - a.z);
      const v = new THREE.Vector2(b.x - p.x, b.z - p.z);
      return u.length() > 1e-6 && v.length() > 1e-6 && u.normalize().dot(v.normalize()) > 0.9995;
    };
    const out: P[] = [pts[0]!];
    let i = 1;
    while (i < pts.length - 1) {
      const a = out[out.length - 1]!;
      // A curve already drawn (a jumper's neck or arch) is kept as it is.
      if (pts[i]!.soft) {
        out.push(pts[i]!);
        i++;
        continue;
      }
      let j = i;
      while (j < pts.length - 1 && inLine(j === i ? a : pts[j - 1]!, pts[j]!, pts[j + 1]!)) j++;
      const chain = [a, ...pts.slice(i, j + 1)];
      const ys = chain.map((p) => p.y);
      const range = Math.max(...ys) - Math.min(...ys);
      const up = ys.every((y, k) => k === 0 || y >= ys[k - 1]! - 0.02);
      const down = ys.every((y, k) => k === 0 || y <= ys[k - 1]! + 0.02);
      if (j > i && !a.soft && range > 0.05) {
        // Up and back down (a hump, a row of leads): rest on it. One way only: a ramp keeps the
        // route's points, except a step too small to see, which becomes one gentle slope.
        if (!up && !down) out.push(...restOn(chain, level.hump));
        else if (range >= 0.3) out.push(...pts.slice(i, j));
        i = j;
      } else {
        out.push(pts[i]!);
        i++;
      }
    }
    out.push(pts[pts.length - 1]!);
    pts = out;
  }
  // Gravity and relaxation: one soft point per long span.
  const out: P[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const h = hash01(`${id}:${i}`);
    // The low point (or the bow's apex) off-centre by up to +-15 % of the span.
    const t = 0.5 + 0.3 * (h - 0.5);
    const mid = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    const floor = WIRE_RADIUS + 0.5;
    const level_ = Math.abs(a.y - b.y) < 1e-6;
    const span3 = Math.hypot(span, b.y - a.y);
    if (a.soft || b.soft) {
      // Already part of a curve (a jumper's arch).
    } else if (!vertical(a, b) && span3 >= MIN_SAG_SPAN && Math.min(a.y, b.y) > floor + 0.2) {
      // A span in the air: it sags (level) or hangs below its chord (sloping).
      const want = level_
        ? Math.min(MAX_SAG, SAG_PER_MM * span)
        : Math.min(MAX_HANG, HANG_PER_MM * span3);
      const depth = Math.max(0, Math.min(level.sag * want, mid.y - floor));
      if (depth > 0.05) out.push({ ...mid, y: mid.y - depth, soft: true });
    } else if (level_ && span >= MIN_BOW_RUN && level.bow > 0) {
      // A run resting on the bench: a slight sideways bow, to a side fixed per wire.
      const off = level.bow * Math.min(MAX_BOW, BOW_PER_MM * span) * (h < 0.5 ? -1 : 1);
      const nx = -(b.z - a.z) / span;
      const nz = (b.x - a.x) / span;
      out.push({ x: mid.x + nx * off, y: mid.y, z: mid.z + nz * off, soft: true });
    }
    out.push(b);
  }
  pts = out;
  // Each corner's wanted arm: wide in plan, a little less where the height profile bends; a soft
  // point takes all its spans allow (a smooth curve through it).
  const n = pts.length;
  const want = (i: number) => {
    const a = pts[i - 1]!;
    const p = pts[i]!;
    const b = pts[i + 1]!;
    if (p.want !== undefined) return p.want;
    if (p.soft) return Infinity;
    const flat = Math.abs(a.y - p.y) < 0.3 && Math.abs(b.y - p.y) < 0.3;
    return flat ? level.plan : level.ramp;
  };
  const wants = pts.map((_, i) => (i > 0 && i < n - 1 ? want(i) : 0));
  const arms: [number, number][] = pts.slice(1, -1).map(() => [0, 0]);
  for (let k = 0; k < n - 1; k++) {
    const L = dist(pts[k]!, pts[k + 1]!);
    const left = k > 0 ? wants[k]! : 0; // the corner at the run's start (its out-arm)
    const right = k + 1 < n - 1 ? wants[k + 1]! : 0; // at its end (its in-arm)
    let aL = 0;
    let aR = 0;
    if (left && right) {
      const wl = Math.min(left, L);
      const wr = Math.min(right, L);
      const share = wl + wr > L ? L / (wl + wr) : 1;
      aL = wl * share;
      aR = wr * share;
    } else if (left || right) {
      // A run that ends at a terminal: the corner may bend over most of it; out of a jumper
      // housing the wire leaves straight for a while first.
      const terminal = left ? ends[1] : ends[0];
      const keep = terminal === 'jumper' ? 0.45 * L : Math.max(0.25, Math.min(1, 0.3 * L));
      const a = Math.min(left || right, Math.max(0, L - keep));
      if (left) aL = a;
      else aR = a;
    }
    if (k > 0) arms[k - 1]![1] = aL;
    if (k + 1 < n - 1) arms[k]![0] = aR;
  }
  // No bend lopsided enough to kink.
  for (const arm of arms) {
    const lo = Math.min(arm[0], arm[1]);
    if (arm[0] > lo * ARM_RATIO) arm[0] = lo * ARM_RATIO;
    if (arm[1] > lo * ARM_RATIO) arm[1] = lo * ARM_RATIO;
  }
  return {
    points: pts.map(({ x, y, z }) => ({ x, y, z })),
    radii: arms.map(([a, b]) => Math.min(a, b)),
    arms,
    drape: level.drape,
    ...(ctx ? { necks } : {}),
  };
}

/** Points along a shape, every `step` mm. */
export function sampleShape(s: WireShape, step = 0.6): THREE.Vector3[] {
  const path = bentPath(s.points, s.radii, s.arms);
  // At most MAX_SAMPLES per wire (s20r5: sampling must not grow without bound with length).
  const n = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(path.getLength() / step)));
  return Array.from({ length: n + 1 }, (_, i) => path.getPointAt(i / n));
}

/** A grid of sample points for neighbour queries (cell = 2 mm). */
class Grid {
  private readonly cells = new Map<string, { p: THREE.Vector3; wire: number }[]>();
  /** The cells each wire has samples in (s20r5: removal visited every cell of the scene). */
  private readonly keysOf = new Map<number, Set<string>>();
  private static key(x: number, y: number, z: number) {
    return `${Math.floor(x / 2)},${Math.floor(y / 2)},${Math.floor(z / 2)}`;
  }
  add(p: THREE.Vector3, wire: number) {
    const k = Grid.key(p.x, p.y, p.z);
    (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push({ p, wire });
    (this.keysOf.get(wire) ?? this.keysOf.set(wire, new Set()).get(wire)!).add(k);
  }
  remove(wire: number) {
    for (const k of this.keysOf.get(wire) ?? []) {
      const list = this.cells.get(k);
      if (!list) continue;
      const kept = list.filter((e) => e.wire !== wire);
      if (kept.length) this.cells.set(k, kept);
      else this.cells.delete(k);
    }
    this.keysOf.delete(wire);
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
export function shapeWires(
  desc: SceneDescription,
  /** Diagnostics: per wire, the level kept and why the wider ones were refused. */
  report?: Map<string, string>,
): Map<string, WireShape> {
  const wires = desc.wires;
  const shapes = wires.map((w) => plainShape(w.points, w.radii));
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
  // What the necks out of jumper housings must clear: every housing, and each board's top (its
  // module, up to which the router keeps wires off the board, and the bare pin stubs).
  const half = ESP32_DEVKITC.dupontSizeMm / 2;
  const neckCtx: NeckContext = {
    housings: wires.flatMap((w) =>
      ([0, 1] as const)
        .filter((k) => w.ends[k] === 'jumper')
        .map((k) => {
          const e = k === 0 ? w.points[0]! : w.points[w.points.length - 1]!;
          return { x0: e.x - half, x1: e.x + half, z0: e.z - half, z1: e.z + half, y0: 0, y1: e.y };
        }),
    ),
    boards: desc.components
      .filter((c) => c.model === 'board.esp32_devkitc')
      .map((c) => {
        const r = footprintRect(c);
        return { ...r, y0: 0, y1: Math.max(ESP32_PCB_TOP + 3.3, ESP32_PIN_TOP) };
      }),
  };
  const endsOf = (i: number) => [
    wires[i]!.points[0]!,
    wires[i]!.points[wires[i]!.points.length - 1]!,
  ];
  const minGap = 2 * WIRE_RADIUS + WIRE_GAP;
  // Two wires that already ran closer than that (they leave a shared terminal side by side)
  // may stay as close as their routes were: never closer.
  const plain = samples.map((ss) => ss);
  const pairs = new Map<string, number>();
  const sharedEnds = (i: number, j: number) =>
    endsOf(i).filter((e) => endsOf(j).some((f) => same(e, f)));
  const routeGap = (i: number, j: number) => {
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    let g = pairs.get(key);
    if (g === undefined) {
      const sh = sharedEnds(i, j);
      const one = (a: number, b: number) => {
        let m = Infinity;
        for (const p of plain[a]!) {
          if (sh.some((e) => dist(e, p) < 4)) continue;
          for (const q of plain[b]!) m = Math.min(m, p.distanceTo(q));
        }
        return m;
      };
      g = Math.max(one(i, j), one(j, i));
      pairs.set(key, g);
    }
    return g;
  };
  const enteredMemo = new Map<THREE.Vector3[], Set<string>>();
  /** Whether the route's samples come over a body's footprint anywhere (memoized per route). */
  const entered = (original: THREE.Vector3[], b: (typeof bodies)[number]) => {
    let set = enteredMemo.get(original);
    if (!set) {
      set = new Set(
        bodies
          .filter((q) =>
            original.some(
              (p) =>
                p.x > q.r.x0 - WIRE_RADIUS &&
                p.x < q.r.x1 + WIRE_RADIUS &&
                p.z > q.r.z0 - WIRE_RADIUS &&
                p.z < q.r.z1 + WIRE_RADIUS &&
                p.y < q.h + WIRE_RADIUS + BODY_GAP,
            ),
          )
          .map((q) => q.id),
      );
      enteredMemo.set(original, set);
    }
    return set.has(b.id);
  };
  const ok = (i: number, ss: THREE.Vector3[], original: THREE.Vector3[]): string | null => {
    const w = wires[i]!;
    const mine = endsOf(i);
    // Never lower than the original route over the bench near anything it had to clear: a draped
    // point may only be lower than the route where no part body is under it.
    const routeY = (p: THREE.Vector3) =>
      original.reduce(
        (m, q) => (Math.hypot(q.x - p.x, q.z - p.z) < 1.5 ? Math.min(m, q.y) : m),
        Infinity,
      );
    for (const p of ss) {
      if (p.y < WIRE_RADIUS + 0.2) {
        // Resting on the bench, never into it; lower than that only where the route itself is
        // (a lead tip just above the bench), or at the very ends.
        const near = mine.some((e) => Math.hypot(e.x - p.x, e.z - p.z) < 4);
        if (!near && p.y < Math.min(WIRE_RADIUS, routeY(p)) - 1e-6) return 'bench';
      }
      for (const b of bodies) {
        // A part the wire ends on: exempt near that end or at pin level under it (s20r4, review
        // B6: the drape cut a corner through its own supply's case, far from the post).
        if (
          owners.get(w.id)!.has(b.id) &&
          (mine.some((e) => Math.hypot(e.x - p.x, e.z - p.z) < 4) ||
            mine.some((e) => p.y <= e.y + 2 * WIRE_RADIUS))
        )
          continue;
        const inPlan =
          p.x > b.r.x0 - WIRE_RADIUS &&
          p.x < b.r.x1 + WIRE_RADIUS &&
          p.z > b.r.z0 - WIRE_RADIUS &&
          p.z < b.r.z1 + WIRE_RADIUS;
        if (inPlan && p.y < b.h + WIRE_RADIUS + BODY_GAP) {
          // Was the route itself this low here? Then the shape changed nothing that matters.
          // (s20r: a body the route never came over at all is never entered: a bench-level
          // route running just beside a ground plate was let bow sideways onto it.)
          if (!entered(original, b)) return `body ${b.id}`;
          const before = original.reduce(
            (m, q) => (Math.hypot(q.x - p.x, q.z - p.z) < 1 ? Math.min(m, q.y) : m),
            Infinity,
          );
          if (p.y < before - 1e-6) return `body ${b.id}`;
        }
      }
      // Other wires: keep the route's separation, except near an end both wires share.
      const clear = grid.near(p, minGap, (q, j) => {
        if (j === i) return true;
        const shared = endsOf(j).some((e) => mine.some((m) => same(m, e)) && dist(e, p) < 4);
        return shared || q.distanceTo(p) >= Math.min(minGap, routeGap(i, j)) - 1e-6;
      });
      if (!clear) return 'wire';
    }
    return null;
  };
  const plainSamples = [...samples];
  let work = 0;
  const shaped = new Set<number>();
  const shapeOne = (w: SceneWire, i: number) => {
    // A simple cable (s20r5) keeps its plain shape: no drape is tried.
    if (w.simple) {
      report?.set(w.id, 'simple');
      return;
    }
    const original = plainSamples[i]!;
    grid.remove(i);
    const refused: string[] = [];
    for (const [k, level] of LEVELS.entries()) {
      // s20r5 (review r3, MAJOR 3): a counted budget of drape samples checked per scene; past
      // it a wire keeps its plain shape (the route as drawn: every guarantee of the route holds).
      if (work > DRAPE_WORK_BUDGET) {
        refused.push('budget');
        break;
      }
      const s = cableShape(w.id, w.points, w.ends, level, neckCtx);
      const ss = sampleShape(s);
      work += ss.length * (1 + bodies.length / 50);
      const why = ok(i, ss, original);
      if (!why) {
        shapes[i] = s;
        samples[i] = ss;
        shaped.add(i);
        refused.push(`level ${k}`);
        break;
      }
      refused.push(why);
    }
    report?.set(w.id, refused.join(', '));
    samples[i]!.forEach((p) => grid.add(p, i));
  };
  wires.forEach(shapeOne);
  // A wire refused at every level only because of a wire shaped after it (whose route, not its
  // final shape, was in the way: a jumper's route hopping over a neighbour's housing that its
  // own neck then leaves) gets a second try against the final shapes, in scene order.
  wires.forEach((w, i) => {
    if (!shaped.has(i) && w.ends.includes('jumper')) shapeOne(w, i);
  });
  return new Map(wires.map((w, i) => [w.id, shapes[i]!]));
}
