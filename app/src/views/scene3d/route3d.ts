/**
 * 3D wire heights (Sprint 10, owner review of the PIR alarm and relay examples): how a hook-up
 * wire rises and falls along its plan path. A person wiring a bench keeps a jumper low and only
 * lifts it where something is in the way, so instead of one height for the whole wire (the old
 * router: the highest obstacle anywhere lifted the whole wire, and its ends became tall vertical
 * risers) each wire gets a HEIGHT PROFILE along its plan path:
 *
 * - it lies just above the bench (FLOOR) by default: a short local connection stays low;
 * - where it must clear something it rises to that thing's clearance height only over that
 *   stretch, with gradual ramps (SLOPE) before and after, so tall obstacles give a smooth arch,
 *   not a fence;
 * - it leaves and reaches its ends from their own height: a jumper housing's top (after a short
 *   straight exit upward), a pin under a module (after the exit lane), a lead end on the bench;
 * - against other wires it passes UNDER where the other is high enough, otherwise it hops OVER
 *   the other locally (a full wire diameter plus a gap), never by lifting the whole wire.
 *
 * Preference order (owner review): 1. valid connectivity; 2. no physical collision, checked
 * against the parts' real volumes (a final true-distance check on the low route before any rise:
 * clearLow); 3. the shortest physically plausible path; 4. the lowest reasonable height; 5. the
 * fewest bends; 6. the least deviation from the 2D route. A conservative clearance never comes
 * before the check that it is actually needed.
 *
 * Obstacles: other parts' bodies (and the wire's own end parts except where it leaves them), every
 * terminal, header pin and junction it passes near (spots), and the wires routed before it
 * (document order). Deterministic: a function of the plan paths, the obstacles and the order.
 * Pure: no WebGL (tests: app/tests/route3d.test.ts).
 */
import type { Point } from '@tbi-lab/domain';
import { WIRE } from './physical.js';
import type { Vec3 } from './scene.js';

/** A wire's resting height above the bench (its centre: a radius plus a little). */
export const FLOOR = WIRE.radiusMm + 0.25;
/** Steepest ramp (rise per mm of run): about 35 degrees. */
export const SLOPE = 0.7;
/** Valleys narrower than this between two raised stretches are spanned (mm). */
const BRIDGE = 12;
/** Height-profile grid step (mm). */
const GRID = 0.25;
/** Steepest ramp ever (beyond it the end rises straight). */
const MAX_SLOPE = 6;
/** Wire surfaces passing over/under each other stay this far apart (mm). */
const WIRE_GAP = 0.3;
/** Over a part's body or a terminal: this much above its top, wire surface to top (mm). */
const BODY_GAP = 0.5;
/** Height of a wire's centre over the top of a body or terminal it passes (a gap at its surface). */
export const CLEARANCE = WIRE.radiusMm + BODY_GAP;
/** Plan distance within which a wire passes over a terminal or pin. */
const NEAR = WIRE.radiusMm + 0.6;
/** How far a wire may run inside its own end part's footprint as it leaves it (mm). */
const OWN_EXIT = 3;
/** Default corner radii: in plan, and where the height profile bends. */
export const PLAN_BEND = 4;
export const RAMP_BEND = 5;

export interface Obstacle {
  part: string;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Underside: a raised body (a module on its pin header) may be passed under. */
  bottom: number;
  top: number;
}

export interface Spot {
  x: number;
  z: number;
  h: number;
}

export interface WireRouteInput {
  id: string;
  node: string | null;
  /** Plan path of the profiled part (x, y = scene z), axis-aligned runs. */
  plan: Point[];
  /** Fixed 3D points before plan[0] (the last at plan[0], at the start height), and after. */
  head: Vec3[];
  tail: Vec3[];
  /** Height at plan[0] and at the last plan point. */
  startY: number;
  endY: number;
  /** The parts the wire ends on (their bodies are exempt where the wire leaves them). */
  parts: [string | null, string | null];
  /** Obstacle ids of the wire's own end fittings (a jumper housing it is plugged into). */
  housings?: [string | null, string | null];
  /** Plan points of its own ends (spots there are its own terminals). */
  ownEnds: Point[];
  /** Corner radius at plan vertices (index into `plan`), when not the default. */
  radii?: Map<number, number>;
}

export interface WireRoute {
  points: Vec3[];
  radii: number[];
}

interface Req {
  s0: number;
  s1: number;
  h: number;
}

/** A routed wire's segments, for the wires after it. */
interface Seg3 {
  a: Vec3;
  b: Vec3;
  node: string | null;
  wire: string;
}

const len = (p: Point, q: Point) => Math.hypot(q.x - p.x, q.y - p.y);

/** Cumulative arc length at each plan vertex. */
function stations(plan: Point[]): number[] {
  const s = [0];
  for (let i = 1; i < plan.length; i++) s.push(s[i - 1]! + len(plan[i - 1]!, plan[i]!));
  return s;
}

/** Where a plan path runs within `pad` of a rectangle: arc-length intervals. */
function rectIntervals(plan: Point[], st: number[], o: Obstacle, pad: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < plan.length; i++) {
    const a = plan[i - 1]!;
    const b = plan[i]!;
    const l = st[i]! - st[i - 1]!;
    // Clip the segment against the padded rectangle (Liang-Barsky).
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dz = b.y - a.y;
    const clip = (p: number, q: number) => {
      if (Math.abs(p) < 1e-12) return q >= 0;
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      return t0 <= t1;
    };
    if (
      clip(-dx, a.x - (o.x0 - pad)) &&
      clip(dx, o.x1 + pad - a.x) &&
      clip(-dz, a.y - (o.z0 - pad)) &&
      clip(dz, o.z1 + pad - a.y)
    ) {
      const s0 = st[i - 1]! + t0 * l;
      const s1 = st[i - 1]! + t1 * l;
      const last = out[out.length - 1];
      if (last && s0 <= last[1] + 1e-6) last[1] = Math.max(last[1], s1);
      else out.push([s0, s1]);
    }
  }
  return out;
}

/** Closest arc length on a plan path to a point, and the plan distance. */
function closest(plan: Point[], st: number[], p: Point): { s: number; d: number } {
  let best = { s: 0, d: Infinity };
  for (let i = 1; i < plan.length; i++) {
    const a = plan[i - 1]!;
    const b = plan[i]!;
    const l = st[i]! - st[i - 1]!;
    const t =
      l < 1e-9
        ? 0
        : Math.min(
            1,
            Math.max(0, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (l * l)),
          );
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const d = len(p, q);
    if (d < best.d) best = { s: st[i - 1]! + t * l, d };
  }
  return best;
}

/**
 * Whether a wire following the low profile `h` over [s0, s1] stays a wire radius plus WIRE_GAP
 * clear of an obstacle's box (true 3D point-to-box distance of the tube's axis).
 */
function clearLow(
  plan: Point[],
  st: number[],
  s0: number,
  s1: number,
  o: Obstacle,
  h: (s: number) => number,
): boolean {
  const need = WIRE.radiusMm + WIRE_GAP;
  for (let s = Math.max(0, s0); s <= s1 + 1e-9; s += 0.25) {
    const q = pointAt(plan, st, Math.min(s, s1));
    const y = h(Math.min(s, s1));
    const dx = Math.max(o.x0 - q.x, 0, q.x - o.x1);
    const dz = Math.max(o.z0 - q.y, 0, q.y - o.z1);
    const dy = Math.max(o.bottom - y, 0, y - o.top);
    if (Math.hypot(dx, dy, dz) < need) return false;
  }
  return true;
}

/** Plan point at arc length s. */
function pointAt(plan: Point[], st: number[], s: number): Point {
  let i = 1;
  while (i < plan.length - 1 && st[i]! < s) i++;
  const a = plan[i - 1]!;
  const b = plan[i]!;
  const l = st[i]! - st[i - 1]!;
  const t = l < 1e-9 ? 0 : Math.min(1, Math.max(0, (s - st[i - 1]!) / l));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** The height profile: rests on the floor, ramps to every requirement and to the end heights. */
function profile(
  L: number,
  hs: number,
  he: number,
  reqs: Req[],
  bridge?: { s0: number; s1: number; c: number }[],
) {
  // Steeper than SLOPE only when the wire must climb more than SLOPE allows over its length (a
  // short wire up to a jumper housing): then evenly, instead of a vertical riser at one end.
  // Likewise to clear something close to an end (a box right beside the lead it starts from).
  let k = Math.max(SLOPE, Math.abs(hs - he) / Math.max(1, L * 0.85));
  for (const r of reqs) {
    if (r.s0 > 0) k = Math.max(k, (r.h - hs) / Math.max(1, r.s0 * 0.85));
    if (r.s1 < L) k = Math.max(k, (r.h - he) / Math.max(1, (L - r.s1) * 0.85));
  }
  k = Math.min(k, MAX_SLOPE);
  // On a grid: every requirement raises the cells it covers (widened by a cell, so that values
  // between cells never fall below the true profile), then a forward and a backward pass let
  // each height fall off at the slope: exactly the cones, in linear time.
  const n = Math.max(1, Math.ceil(L / GRID));
  const ds = L / n;
  const g = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const s = i * ds;
    g[i] = Math.min(FLOOR, hs + k * s, he + k * (L - s));
  }
  g[0] = Math.max(g[0]!, hs);
  g[n] = Math.max(g[n]!, he);
  for (const r of reqs) {
    const i0 = Math.max(0, Math.floor(r.s0 / ds) - 1);
    const i1 = Math.min(n, Math.ceil(r.s1 / ds) + 1);
    for (let i = i0; i <= i1; i++) g[i] = Math.max(g[i]!, r.h);
  }
  for (let i = 1; i <= n; i++) g[i] = Math.max(g[i]!, g[i - 1]! - k * ds);
  for (let i = n - 1; i >= 0; i--) g[i] = Math.max(g[i]!, g[i + 1]! - k * ds);
  // Fewer, longer curves: a valley narrower than BRIDGE between two raised stretches is spanned
  // (a wire laid over two things a little apart does not dip to the bench between them), never
  // above a ceiling (where the wire was found to pass under something).
  if (bridge) {
    const w = Math.max(1, Math.round(BRIDGE / 2 / ds));
    const left = new Float64Array(n + 1);
    const right = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
      let m = -Infinity;
      for (let j = Math.max(0, i - w); j <= i; j++) m = Math.max(m, g[j]!);
      left[i] = m;
    }
    for (let i = n; i >= 0; i--) {
      let m = -Infinity;
      for (let j = i; j <= Math.min(n, i + w); j++) m = Math.max(m, g[j]!);
      right[i] = m;
    }
    const filled = Float64Array.from(g);
    for (let i = 1; i < n; i++) {
      const fill = Math.min(left[i]!, right[i]!);
      if (fill <= g[i]! + 0.5 || fill < FLOOR + 1) continue;
      const s = i * ds;
      const cap = Math.min(
        fill,
        ...bridge.filter((c) => s >= c.s0 - ds && s <= c.s1 + ds).map((c) => c.c),
      );
      filled[i] = Math.max(g[i]!, cap);
    }
    g.set(filled);
  }
  const h = (s: number) => {
    const x = Math.min(n, Math.max(0, s / ds));
    const i = Math.min(n - 1, Math.floor(x));
    const t = x - i;
    return g[i]! * (1 - t) + g[i + 1]! * t;
  };
  /** Highest point over [s0, s1]. */
  const top = (s0: number, s1: number) => {
    let m = -Infinity;
    const i0 = Math.max(0, Math.floor(Math.max(0, s0) / ds));
    const i1 = Math.min(n, Math.ceil(Math.min(L, s1) / ds));
    for (let i = i0; i <= i1; i++) m = Math.max(m, g[i]!);
    return m;
  };
  return Object.assign(h, { top });
}

/**
 * Where (arc-length interval on my path) another wire's 3D segment comes within `reach` in plan,
 * and how high that segment is there (min and max).
 */
function nearSegment(
  plan: Point[],
  st: number[],
  g: Seg3,
  reach: number,
  box: { x0: number; x1: number; z0: number; z1: number },
): { s0: number; s1: number; lo: number; hi: number } | null {
  const a = { x: g.a.x, y: g.a.z };
  const b = { x: g.b.x, y: g.b.z };
  const gl = len(a, b);
  let s0 = Infinity;
  let s1 = -Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  // Sample the other segment (plan) every half reach; each sample near my path marks an interval.
  const n = Math.max(1, Math.ceil(gl / (reach / 2)));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    if (p.x < box.x0 || p.x > box.x1 || p.y < box.z0 || p.y > box.z1) continue;
    const y = g.a.y + (g.b.y - g.a.y) * t;
    const c = closest(plan, st, p);
    if (c.d >= reach) continue;
    const half = Math.sqrt(reach * reach - c.d * c.d);
    s0 = Math.min(s0, c.s - half);
    s1 = Math.max(s1, c.s + half);
    // A vertical riser spans its whole height at one plan point.
    lo = Math.min(lo, y, gl < 1e-9 ? Math.min(g.a.y, g.b.y) : y);
    hi = Math.max(hi, y, gl < 1e-9 ? Math.max(g.a.y, g.b.y) : y);
  }
  return s0 === Infinity ? null : { s0, s1, lo, hi };
}

/**
 * Route the wires' heights, in order. Returns each wire's 3D control points and the corner
 * radius at each interior point.
 */
export function routeWires(
  inputs: readonly WireRouteInput[],
  obstacles: readonly Obstacle[],
  spots: readonly Spot[],
): Map<string, WireRoute> {
  const r = WIRE.radiusMm;
  const out = new Map<string, WireRoute>();
  // Every wire's fixed lead-in and lead-out (exit lanes, jumper exits) is known up front: wires
  // routed earlier must clear the fixed parts of later ones too.
  const segsOf = (pts: Vec3[], w: WireRouteInput): Seg3[] =>
    pts.slice(1).map((b, i) => ({ a: pts[i]!, b, node: w.node, wire: w.id }));
  const fixed: Seg3[] = inputs.flatMap((w) => [...segsOf(w.head, w), ...segsOf(w.tail, w)]);
  const routed: Seg3[] = [];

  for (const w of inputs) {
    const plan = w.plan;
    const st = stations(plan);
    const L = st[st.length - 1]!;
    const reqs: Req[] = [];
    // Part bodies: over them, except the own end part where the wire leaves it. A raised body
    // is decided like a wire (below): under it when there is room, else over.
    const raised: { s0: number; s1: number; lo: number; hi: number }[] = [];
    const low = profile(L, w.startY, w.endY, []);
    for (const o of obstacles) {
      // Its own end parts: only where it really runs over them (it meets them at their edge).
      const own = o.part === w.parts[0] || o.part === w.parts[1];
      for (let [s0, s1] of rectIntervals(plan, st, o, own ? 0 : r + 0.3)) {
        // Its own end part: only where it leaves it (the first few mm); a run back along or
        // across its own part clears it like any other.
        // Its own fitting (the housing it is plugged into) entirely; a part of its own no taller
        // than the end itself (a supply's post strip, a ground plate) where it leaves it.
        if (w.housings?.includes(o.part)) continue;
        if (s0 < 1e-6 && o.part === w.parts[0])
          s0 = o.top <= w.startY + 2 * r ? s1 : Math.max(s0, OWN_EXIT);
        if (s1 > L - 1e-6 && o.part === w.parts[1])
          s1 = o.top <= w.endY + 2 * r ? s0 : Math.min(s1, L - OWN_EXIT);
        if (s1 <= s0) continue;
        // Final actual-clearance check: the low route (resting on the bench, rising only to its
        // ends) is tested against the body's real volume by true 3D distance (corners included);
        // where it is already clear by a wire radius plus the gap, no rise is made.
        // Only for a body standing on the bench (rt2, PSU-post collision): a RAISED body (a
        // binding post, a module on its header) that the low route clears by passing under it is
        // decided over/under against the FINAL profile below, because a later requirement (a
        // terminal passed near) can lift the wire into it; deciding it on the low route alone
        // left a supply wire running through the other binding post.
        const isRaised = o.bottom > 2 * r + BODY_GAP + FLOOR;
        if (!own && !isRaised && clearLow(plan, st, s0, s1, o, low)) continue;
        if (isRaised)
          raised.push({
            s0,
            s1,
            lo: o.bottom + r - BODY_GAP + WIRE_GAP,
            hi: o.top - r + BODY_GAP - WIRE_GAP,
          });
        else reqs.push({ s0, s1, h: o.top + CLEARANCE });
      }
    }
    // Terminals, pins, junctions passed near (not its own ends).
    const sx0 = Math.min(...plan.map((q) => q.x)) - NEAR;
    const sx1 = Math.max(...plan.map((q) => q.x)) + NEAR;
    const sz0 = Math.min(...plan.map((q) => q.y)) - NEAR;
    const sz1 = Math.max(...plan.map((q) => q.y)) + NEAR;
    for (const sp of spots) {
      if (sp.x < sx0 || sp.x > sx1 || sp.z < sz0 || sp.z > sz1) continue;
      const p = { x: sp.x, y: sp.z };
      if (w.ownEnds.some((e) => len(e, p) < NEAR)) continue;
      const c = closest(plan, st, p);
      if (c.d >= NEAR) continue;
      const half = Math.sqrt(NEAR * NEAR - c.d * c.d);
      reqs.push({ s0: c.s - half, s1: c.s + half, h: sp.h + CLEARANCE });
    }
    // Other wires: under where they are high enough, else over, locally. Repeated until stable
    // (hopping over one may bring the wire up against another).
    const reach = 2 * r + WIRE_GAP;
    // Only segments whose plan extent comes near this path's (a cheap bounding-box test first).
    const bx0 = Math.min(...plan.map((p) => p.x)) - reach;
    const bx1 = Math.max(...plan.map((p) => p.x)) + reach;
    const bz0 = Math.min(...plan.map((p) => p.y)) - reach;
    const bz1 = Math.max(...plan.map((p) => p.y)) + reach;
    const others = [...fixed.filter((g) => g.wire !== w.id), ...routed].filter(
      (g) =>
        Math.max(g.a.x, g.b.x) >= bx0 &&
        Math.min(g.a.x, g.b.x) <= bx1 &&
        Math.max(g.a.z, g.b.z) >= bz0 &&
        Math.min(g.a.z, g.b.z) <= bz1,
    );
    const near = others
      .map((g) => ({
        g,
        n: nearSegment(plan, st, g, reach, { x0: bx0, x1: bx1, z0: bz0, z1: bz1 }),
      }))
      .filter((x): x is { g: Seg3; n: NonNullable<typeof x.n> } => !!x.n)
      // Wires meeting at a shared end (a junction, a shared terminal) touch there by design.
      .filter(
        ({ g }) =>
          !(
            g.node === w.node &&
            w.node !== null &&
            w.ownEnds.some(
              (e) => len(e, { x: g.a.x, y: g.a.z }) < 3 || len(e, { x: g.b.x, y: g.b.z }) < 3,
            )
          ),
      );
    near.push(...raised.map((n) => ({ g: null as unknown as Seg3, n })));
    const over = new Set<number>();
    const ceilings: { s0: number; s1: number; c: number }[] = [];
    let h = profile(L, w.startY, w.endY, reqs);
    for (let round = 0; round < 8; round++) {
      let added = false;
      near.forEach(({ n }, k) => {
        if (over.has(k)) return;
        const s0 = Math.max(0, n.s0);
        const s1 = Math.min(L, n.s1);
        const top = h.top(s0, s1);
        if (top + reach <= n.lo + 1e-6) {
          ceilings.push({ s0: n.s0, s1: n.s1, c: n.lo - reach }); // passes under
          return;
        }
        over.add(k);
        reqs.push({ s0: n.s0, s1: n.s1, h: n.hi + reach });
        added = true;
      });
      if (!added) break;
      h = profile(L, w.startY, w.endY, reqs);
    }
    // Decisions made (over / under); the final shape spans narrow valleys.
    h = profile(L, w.startY, w.endY, reqs, ceilings);

    // Sample the profile, keep the points where the path bends (plan vertices) or the slope
    // changes.
    const samples: { s: number; p: Vec3; vertex: number }[] = [];
    const step = 0.5;
    // Every requirement's edges are sampled exactly (a plateau's corners are never cut).
    const edges = reqs
      .flatMap((q) => [q.s0, q.s1])
      .filter((x) => x > 0 && x < L)
      .sort((x, y) => x - y);
    let e = 0;
    for (let i = 0; i < plan.length; i++) {
      samples.push({ s: st[i]!, p: { x: plan[i]!.x, y: h(st[i]!), z: plan[i]!.y }, vertex: i });
      if (i === plan.length - 1) break;
      const a = plan[i]!;
      const b = plan[i + 1]!;
      const s0 = st[i]!;
      const s1 = st[i + 1]!;
      const inside: number[] = [];
      for (let s = s0 + step; s < s1 - 1e-6; s += step) inside.push(s);
      while (e < edges.length && edges[e]! <= s0 + 1e-6) e++;
      for (let k = e; k < edges.length && edges[k]! < s1 - 1e-6; k++) inside.push(edges[k]!);
      inside.sort((x, y) => x - y);
      for (const s of inside) {
        const t = (s - s0) / Math.max(1e-9, s1 - s0);
        samples.push({
          s,
          p: { x: a.x + (b.x - a.x) * t, y: h(s), z: a.y + (b.y - a.y) * t },
          vertex: -1,
        });
      }
    }
    // The ends exactly at their own heights (the grid is exact only to rounding there).
    const s0p = samples[0]!.p;
    const sLp = samples[samples.length - 1]!.p;
    if (Math.abs(s0p.y - w.startY) < 1e-6) s0p.y = w.startY;
    if (Math.abs(sLp.y - w.endY) < 1e-6) sLp.y = w.endY;
    // Per plan run, the profile simplified (Ramer-Douglas-Peucker in arc length x height): ramps
    // become single straight runs whose knees the bends round off.
    const rdp = (pts: typeof samples, tol: number): typeof samples => {
      if (pts.length < 3) return pts;
      const a = pts[0]!;
      const b = pts[pts.length - 1]!;
      let worst = -1;
      let dmax = tol;
      for (let i = 1; i < pts.length - 1; i++) {
        const c = pts[i]!;
        const t = (c.s - a.s) / Math.max(1e-9, b.s - a.s);
        // One-sided: the simplified line may pass a little above the profile, never below it.
        const below = c.p.y - (a.p.y + (b.p.y - a.p.y) * t);
        const d = below > 1e-4 ? tol + below : -below;
        if (d > dmax) {
          dmax = d;
          worst = i;
        }
      }
      if (worst < 0) return [a, b];
      return [...rdp(pts.slice(0, worst + 1), tol).slice(0, -1), ...rdp(pts.slice(worst), tol)];
    };
    const kept: typeof samples = [];
    let from = 0;
    for (let i = 1; i < samples.length; i++)
      if (samples[i]!.vertex >= 0) {
        const run = rdp(samples.slice(from, i + 1), 0.08);
        kept.push(...(kept.length ? run.slice(1) : run));
        from = i;
      }
    // Assemble: head (ends at plan[0], start height), the profile, tail.
    const pts: Vec3[] = [...w.head];
    const radii: number[] = w.head.slice(1).map(() => RAMP_BEND);
    const push = (p: Vec3, radius: number) => {
      const last = pts[pts.length - 1];
      if (last && Math.hypot(last.x - p.x, last.y - p.y, last.z - p.z) < 1e-6) return;
      if (pts.length) radii.push(radius);
      pts.push(p);
    };
    // A forced riser at an end (something to clear right there): straight up, then on.
    if (!w.head.length || Math.abs(kept[0]!.p.y - w.startY) > 1e-6)
      push({ x: plan[0]!.x, y: w.startY, z: plan[0]!.y }, RAMP_BEND);
    for (const k of kept)
      push(k.p, k.vertex >= 0 ? (w.radii?.get(k.vertex) ?? PLAN_BEND) : RAMP_BEND);
    const last = plan[plan.length - 1]!;
    push({ x: last.x, y: w.endY, z: last.y }, RAMP_BEND);
    for (const p of w.tail) push(p, RAMP_BEND);
    // `radii` has one entry per point after the first; the corner radius belongs to interior
    // points: drop the first point's entry and the last's.
    const interior = radii.slice(0, Math.max(0, pts.length - 2));
    out.set(w.id, { points: pts, radii: interior });
    routed.push(...segsOf(pts, w));
  }
  return out;
}
