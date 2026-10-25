/**
 * Sprint 21 (s21r, review r5 finding 6): the 3D scene as the view shows it, with its routing
 * limitations checked on the cables AS DRAWN (wireShape.ts), not only on their routes.
 *
 * `routeLimits` (scene.ts) checks every route; the drawn cable (sag, bows, bends) was assumed
 * never to come closer to anything than its route. The review found it can: a cable 1.28 mm
 * (axis) from a cable of another node (less than its diameter) and cables through part volumes,
 * with routeLimits empty. Here every drawn cable is sampled and checked the same way as the
 * routes: a cable of another node closer than a cable diameter (away from an end the two share),
 * or a sample inside a part's volume (scene.ts `bodyHit`, same exemptions). Each such wire is
 * added to `routeLimits`, so the 3D view's note names it. Bounded (DRAWN_CHECK_WORK): a wire the
 * check could not reach is listed too (a contact not checked is never claimed absent).
 *
 * The shapes are computed once per scene (`sceneShapes`, keyed by its wire list) and reused by the
 * renderer. Presentation only.
 */
import type { ProjectDocument } from '@tbi-lab/domain';
import {
  bodyHit,
  byWireId,
  deriveScene,
  sceneObstacles,
  WIRE_RADIUS,
  type SceneDescription,
  type SceneWire,
  type Vec3,
} from './scene.js';
import { sampleShape, shapeWires, type WireShape } from './wireShape.js';

/** Sample comparisons and body tests the drawn-cable check may spend (counted, never timed). */
export const DRAWN_CHECK_WORK = 4_000_000;
/** Around an end two cables share, they meet by design (plan distance, mm; as the metrics). */
const SHARED_END = 5;
/** Sample spacing along a drawn cable (mm). */
const STEP = 0.3;

const shapesOf = new WeakMap<readonly SceneWire[], Map<string, WireShape>>();
/** The drawn shapes of a scene's wires (wireShape.ts `shapeWires`), computed once per scene. */
export function sceneShapes(desc: SceneDescription): Map<string, WireShape> {
  let s = shapesOf.get(desc.wires);
  if (!s) {
    s = shapeWires(desc);
    shapesOf.set(desc.wires, s);
  }
  return s;
}

/**
 * The wires whose DRAWN cable touches a cable of another node or passes through a part's
 * volume, plus the wires the bounded check did not reach.
 */
export function drawnLimits(
  doc: ProjectDocument,
  desc: SceneDescription,
  shapes: Map<string, WireShape> = sceneShapes(desc),
  workCap = DRAWN_CHECK_WORK,
): string[] {
  const out = new Set<string>();
  const wires = desc.wires.filter((w) => !w.simple && shapes.has(w.id));
  let work = 0;
  const samples = new Map<string, Vec3[]>();
  let reached = wires.length;
  for (let i = 0; i < wires.length; i++) {
    const w = wires[i]!;
    const s = sampleShape(shapes.get(w.id)!, STEP).map((v) => ({ x: v.x, y: v.y, z: v.z }));
    work += s.length;
    if (work > workCap) {
      reached = i;
      break;
    }
    samples.set(w.id, s);
  }
  for (const w of wires.slice(reached)) out.add(w.id);
  const checked = wires.slice(0, reached);
  // Cables of different nodes: a grid of cells one cable diameter wide.
  const d2 = 2 * WIRE_RADIUS;
  const cell = (p: Vec3) =>
    `${Math.floor(p.x / d2)},${Math.floor(p.y / d2)},${Math.floor(p.z / d2)}`;
  const grid = new Map<string, { w: number; p: Vec3 }[]>();
  checked.forEach((w, k) => {
    for (const p of samples.get(w.id)!) {
      const c = cell(p);
      const list = grid.get(c);
      if (list) list.push({ w: k, p });
      else grid.set(c, [{ w: k, p }]);
    }
  });
  const endsOf = (k: number) => {
    const s = samples.get(checked[k]!.id)!;
    return [s[0]!, s[s.length - 1]!];
  };
  const near = (a: Vec3, b: Vec3, r: number) =>
    Math.hypot(a.x - b.x, a.z - b.z) < r && Math.abs(a.y - b.y) < r + 1;
  let limited = -1;
  for (let k = 0; k < checked.length && limited < 0; k++) {
    const A = checked[k]!;
    const ea = endsOf(k);
    for (const p of samples.get(A.id)!) {
      const gx = Math.floor(p.x / d2);
      const gy = Math.floor(p.y / d2);
      const gz = Math.floor(p.z / d2);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++)
            for (const q of grid.get(`${gx + dx},${gy + dy},${gz + dz}`) ?? []) {
              if (q.w <= k) continue;
              work++;
              const B = checked[q.w]!;
              if (A.node !== null && A.node === B.node) continue;
              const dist = Math.hypot(p.x - q.p.x, p.y - q.p.y, p.z - q.p.z);
              if (dist >= d2) continue;
              // Ends the two share (a junction both meet): they converge there by design.
              const eb = endsOf(q.w);
              const shared = ea.filter((e) => eb.some((f) => near(e, f, 1e-3)));
              if (shared.some((e) => Math.hypot(e.x - p.x, e.z - p.z) < SHARED_END)) continue;
              out.add(A.id);
              out.add(B.id);
            }
      if (work > workCap) {
        limited = k;
        break;
      }
    }
  }
  if (limited >= 0) for (const w of checked.slice(limited)) out.add(w.id);
  // Part volumes (the same test as routeLimits on the routes).
  const obstacles = sceneObstacles(doc, desc);
  const sources = new Map([...doc.layout.wires].reverse().map((x) => [x.id, x]));
  for (const w of limited >= 0 ? checked.slice(0, limited) : checked) {
    if (out.has(w.id)) continue;
    const src = sources.get(w.id);
    if (!src) continue;
    const own = [src.from, src.to].flatMap((e) =>
      e.kind === 'terminal' ? [e.component, `${e.component}:${e.terminal}`] : [],
    );
    const isOwn = (part: string) => own.includes(part) || own.some((x) => part.startsWith(`${x}:`));
    const s = samples.get(w.id)!;
    const ends = [s[0]!, s[s.length - 1]!];
    const xs = s.map((p) => p.x);
    const zs = s.map((p) => p.z);
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    const nearBodies = obstacles.filter(
      (o) => o.x1 + 1 > x0 && o.x0 - 1 < x1 && o.z1 + 1 > z0 && o.z0 - 1 < z1,
    );
    work += s.length * nearBodies.length;
    if (work > workCap) {
      out.add(w.id);
      continue;
    }
    if (s.some((p) => nearBodies.some((o) => bodyHit(o, p, isOwn(o.part), ends)))) out.add(w.id);
  }
  return [...out].sort(byWireId);
}

/**
 * The scene the 3D view shows (s21r): `deriveScene`, with every wire whose drawn cable touches
 * another node or passes through a part added to `routeLimits`.
 */
export function deriveCheckedScene(doc: ProjectDocument): SceneDescription {
  const s = deriveScene(doc);
  const extra = drawnLimits(doc, s).filter((id) => !(s.routeLimits ?? []).includes(id));
  if (!extra.length) return s;
  return { ...s, routeLimits: [...(s.routeLimits ?? []), ...extra].sort(byWireId) };
}
