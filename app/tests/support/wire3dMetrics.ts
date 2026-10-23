/**
 * Sprint 20 (s20r): geometric measurements of the 3D wires AS DRAWN (the physical cable shapes
 * the renderer builds, wireShape.ts `shapeWires`), and of their routes (the scene's control
 * polylines). Used by the invariant tests and by the evidence scripts.
 *
 * Terms:
 *  - wire-wire gap: the shortest distance between the AXES of two wires' sampled curves, ignoring
 *    the stretch within `SHARED_END` of an end the two share (wires on one terminal meet there by
 *    design). Two tubes of radius r interpenetrate when the axis gap is < 2r.
 *  - plan crossing: two wires' plan projections (x, z) cross; its vertical separation is the
 *    height difference of the two axes there (a visible crossing needs > 2r: one passes over).
 *  - loop: a wire whose plan projection crosses itself (a closed loop drawn in the air or on the
 *    bench); hairpin: the plan direction turns back by more than 150 degrees within 6 mm.
 */
import * as THREE from 'three';
import type { ProjectDocument } from '@tbi-lab/domain';
import type { Obstacle } from '../../src/views/scene3d/route3d.js';
import { footprintRect } from '../../src/views/scene3d/labels.js';
import {
  MODEL_HEIGHT,
  sceneObstacles,
  WIRE_RADIUS,
  type SceneDescription,
  type Vec3,
} from '../../src/views/scene3d/scene.js';
import { sampleShape, shapeWires } from '../../src/views/scene3d/wireShape.js';
import { samples as polySamples } from './scene3dChecks.js';

/** Around an end two wires share, they meet by design (mm). */
export const SHARED_END = 4;
const r = WIRE_RADIUS;

export interface PairReport {
  a: string;
  b: string;
  sameNode: boolean;
  /** Smallest axis-to-axis distance away from shared ends (mm). */
  gap: number;
  at: Vec3;
}
export interface CrossingReport {
  a: string;
  b: string;
  sameNode: boolean;
  /** Vertical axis separation at the crossing (mm). */
  dy: number;
  at: { x: number; z: number };
}
export interface Metrics3d {
  wires: number;
  /** Different-node pairs whose tubes interpenetrate (gap < 2r) / touch (gap < 2r + 0.05). */
  foreignPenetrations: PairReport[];
  /** Same-node pairs whose tubes interpenetrate away from any shared end (visual tangle). */
  ownPenetrations: PairReport[];
  /** Smallest different-node gap in the scene. */
  minForeignGap: number;
  crossings: CrossingReport[];
  /** Crossings whose vertical separation is below 2r (drawn through each other). */
  flatCrossings: CrossingReport[];
  loops: string[];
  hairpins: string[];
  /** Wire samples inside a part's routing volume (not its own end part). */
  bodyHits: string[];
  /** Ends not at their terminal's attach point. */
  badEnds: string[];
  /**
   * Wires that climb over the body of a part they END on, away from that end (a wire reaching a
   * pin by going up and over its own module from the far side: an arch, a loop near the terminal).
   */
  overOwnBody: string[];
  /** Sum of plan corners (> 20 degrees) of the routes. */
  planBends: number;
  length: number;
}

type P = { x: number; y: number; z: number };
const dist = (p: P, q: P) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

/** The drawn curve of every wire (renderer shapes), sampled every ~0.6 mm. */
export function drawnSamples(scene: SceneDescription): Map<string, P[]> {
  const shapes = shapeWires(scene);
  return new Map(
    scene.wires.map((w) => [w.id, sampleShape(shapes.get(w.id)!).map((v) => ({ ...v }))]),
  );
}
/** The route polylines (control points) sampled every 0.5 mm. */
export function routeSamples(scene: SceneDescription): Map<string, P[]> {
  return new Map(scene.wires.map((w) => [w.id, polySamples(w, 0.5)]));
}

function segPlanIntersect(a: P, b: P, c: P, d: P): { t: number; u: number } | null {
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const sx = d.x - c.x;
  const sz = d.z - c.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / den;
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / den;
  if (t < 0 || t >= 1 || u < 0 || u >= 1) return null;
  return { t, u };
}

/** Measure a scene's wires. `which`: the drawn cables (default) or the routes. */
export function measure3d(
  doc: ProjectDocument,
  scene: SceneDescription,
  which: 'drawn' | 'route' = 'drawn',
): Metrics3d {
  const S = which === 'drawn' ? drawnSamples(scene) : routeSamples(scene);
  const ws = scene.wires;
  const ends = (id: string) => {
    const s = S.get(id)!;
    return [s[0]!, s[s.length - 1]!];
  };
  const out: Metrics3d = {
    wires: ws.length,
    foreignPenetrations: [],
    ownPenetrations: [],
    minForeignGap: Infinity,
    crossings: [],
    flatCrossings: [],
    loops: [],
    hairpins: [],
    bodyHits: [],
    badEnds: [],
    overOwnBody: [],
    planBends: 0,
    length: 0,
  };
  // Pairs.
  for (let i = 0; i < ws.length; i++)
    for (let j = i + 1; j < ws.length; j++) {
      const A = ws[i]!;
      const B = ws[j]!;
      const sa = S.get(A.id)!;
      const sb = S.get(B.id)!;
      const sameNode = A.node !== null && A.node === B.node;
      const shared = ends(A.id).filter((e) => ends(B.id).some((f) => dist(e, f) < 1e-3));
      const free = (p: P) => !shared.some((e) => dist(e, p) < SHARED_END);
      let gap = Infinity;
      let at: P = sa[0]!;
      for (const p of sa) {
        if (!free(p)) continue;
        for (const q of sb) {
          if (!free(q)) continue;
          if (Math.abs(p.x - q.x) > gap || Math.abs(p.z - q.z) > gap) continue;
          const d = dist(p, q);
          if (d < gap) {
            gap = d;
            at = p;
          }
        }
      }
      const rep: PairReport = { a: A.id, b: B.id, sameNode, gap, at: { ...at } };
      if (!sameNode) out.minForeignGap = Math.min(out.minForeignGap, gap);
      if (gap < 2 * r) (sameNode ? out.ownPenetrations : out.foreignPenetrations).push(rep);
      // Plan crossings (away from shared ends).
      for (let m = 1; m < sa.length; m++)
        for (let n = 1; n < sb.length; n++) {
          const x = segPlanIntersect(sa[m - 1]!, sa[m]!, sb[n - 1]!, sb[n]!);
          if (!x) continue;
          const pa = sa[m - 1]!;
          const p = {
            x: pa.x + (sa[m]!.x - pa.x) * x.t,
            y: pa.y + (sa[m]!.y - pa.y) * x.t,
            z: pa.z + (sa[m]!.z - pa.z) * x.t,
          };
          if (!free(p)) continue;
          const qb = sb[n - 1]!;
          const qy = qb.y + (sb[n]!.y - qb.y) * x.u;
          const c: CrossingReport = {
            a: A.id,
            b: B.id,
            sameNode,
            dy: Math.abs(p.y - qy),
            at: { x: p.x, z: p.z },
          };
          // One crossing per place (samples are dense).
          if (
            out.crossings.some(
              (k) => k.a === c.a && k.b === c.b && Math.hypot(k.at.x - c.at.x, k.at.z - c.at.z) < 3,
            )
          )
            continue;
          out.crossings.push(c);
          if (c.dy < 2 * r) out.flatCrossings.push(c);
        }
    }
  // Per wire: loops, hairpins, bends, length, ends.
  for (const w of ws) {
    const s = S.get(w.id)!;
    for (let i = 1; i < s.length; i++) out.length += dist(s[i - 1]!, s[i]!);
    let loop = false;
    for (let m = 1; m < s.length && !loop; m++)
      for (let n = m + 2; n < s.length && !loop; n++) {
        const x = segPlanIntersect(s[m - 1]!, s[m]!, s[n - 1]!, s[n]!);
        // A vertical riser projects to a point: ignore crossings between near-coincident samples.
        if (x && dist(s[m]!, s[n]!) > 1.5) loop = true;
      }
    if (loop) out.loops.push(w.id);
    // Plan heading along the curve (samples whose plan step is long enough to define one).
    const heads: { a: number; s: number }[] = [];
    let acc = 0;
    for (let i = 1; i < s.length; i++) {
      const dx = s[i]!.x - s[i - 1]!.x;
      const dz = s[i]!.z - s[i - 1]!.z;
      const l = Math.hypot(dx, dz);
      acc += l;
      if (l > 0.05) heads.push({ a: Math.atan2(dz, dx), s: acc });
    }
    let hair = false;
    for (let i = 0; i < heads.length && !hair; i++)
      for (let k = i + 1; k < heads.length && heads[k]!.s - heads[i]!.s < 6; k++) {
        let d = Math.abs(heads[k]!.a - heads[i]!.a);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (d > (150 * Math.PI) / 180) {
          hair = true;
          break;
        }
      }
    if (hair) out.hairpins.push(w.id);
    // Route corners in plan.
    const pts = w.points.filter(
      (p, i) => i === 0 || Math.hypot(p.x - w.points[i - 1]!.x, p.z - w.points[i - 1]!.z) > 1e-6,
    );
    for (let i = 1; i < pts.length - 1; i++) {
      const u = { x: pts[i]!.x - pts[i - 1]!.x, z: pts[i]!.z - pts[i - 1]!.z };
      const v = { x: pts[i + 1]!.x - pts[i]!.x, z: pts[i + 1]!.z - pts[i]!.z };
      const c = (u.x * v.x + u.z * v.z) / (Math.hypot(u.x, u.z) * Math.hypot(v.x, v.z));
      if (c < Math.cos((20 * Math.PI) / 180)) out.planBends++;
    }
    // Ends at their terminals' attach points.
    const src = doc.layout.wires.find((x) => x.id === w.id)!;
    ([src.from, src.to] as const).forEach((e, k) => {
      if (e.kind !== 'terminal') return;
      const t = scene.components
        .find((c) => c.id === e.component)
        ?.terminals.find((q) => q.id === e.terminal);
      const p = k === 0 ? s[0]! : s[s.length - 1]!;
      if (!t || dist(t, p) > 1e-6) out.badEnds.push(`${w.id}:${k}`);
      // Over its own part's body, more than 3 mm (plan) from where it is fastened.
      const c = scene.components.find((x) => x.id === e.component);
      if (!c || out.overOwnBody.includes(`${w.id}>${c.id}`)) return;
      const f = footprintRect(c);
      const top = MODEL_HEIGHT[c.model];
      const over = s.some(
        (q) =>
          q.x > f.x0 + 0.5 &&
          q.x < f.x1 - 0.5 &&
          q.z > f.z0 + 0.5 &&
          q.z < f.z1 - 0.5 &&
          q.y > top * 0.5 &&
          q.y > 2 &&
          Math.hypot(q.x - p.x, q.z - p.z) > 3,
      );
      if (over) out.overOwnBody.push(`${w.id}>${c.id}`);
    });
  }
  out.bodyHits = bodyHits(doc, scene, S);
  return out;
}

/**
 * Samples inside a part's routing volume (scene3dChecks criterion, applied to any samples):
 * outside every volume of the parts it does not end on by most of a wire radius, and outside
 * the raised volumes of its own parts except where it is fastened.
 */
export function bodyHits(
  doc: ProjectDocument,
  scene: SceneDescription,
  S: Map<string, P[]>,
  only: (o: Obstacle) => boolean = () => true,
): string[] {
  const obstacles = sceneObstacles(doc, scene).filter(only);
  const m = r * 0.8;
  const out: string[] = [];
  for (const w of scene.wires) {
    const src = doc.layout.wires.find((x) => x.id === w.id)!;
    const own = [src.from, src.to].flatMap((e) =>
      e.kind === 'terminal' ? [e.component, `${e.component}:${e.terminal}`] : [],
    );
    const s = S.get(w.id)!;
    const ends = [s[0]!, s[s.length - 1]!];
    const hit = new Set<string>();
    for (const p of s)
      for (const o of obstacles) {
        const isOwn = own.includes(o.part) || own.some((x) => o.part.startsWith(`${x}:`));
        if (isOwn && o.bottom < 2) continue;
        if (isOwn && ends.some((e) => dist(e, p) < 3)) continue;
        if (
          p.x > o.x0 - m &&
          p.x < o.x1 + m &&
          p.z > o.z0 - m &&
          p.z < o.z1 + m &&
          p.y > o.bottom - m &&
          p.y < o.top + m
        )
          hit.add(o.part);
      }
    for (const h of hit) out.push(`${w.id}>${h}`);
  }
  return out;
}

/** A compact one-line summary (evidence logs). */
export function summary(m: Metrics3d): string {
  return [
    `wires ${m.wires}`,
    `foreign-pen ${m.foreignPenetrations.length}`,
    `own-pen ${m.ownPenetrations.length}`,
    `minForeignGap ${m.minForeignGap === Infinity ? '-' : m.minForeignGap.toFixed(2)}`,
    `crossings ${m.crossings.length}`,
    `flat ${m.flatCrossings.length}`,
    `loops ${m.loops.length}`,
    `hairpins ${m.hairpins.length}`,
    `body ${m.bodyHits.length}`,
    `badEnds ${m.badEnds.length}`,
    `overOwn ${m.overOwnBody.length}`,
    `bends ${m.planBends}`,
    `len ${m.length.toFixed(0)}`,
  ].join(' | ');
}

export { THREE };
