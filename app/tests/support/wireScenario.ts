/**
 * Wire routing integrity: the owner's reported sequence as a reproducible scenario (a PSU, a
 * ground and an SN74LVC1G08 AND gate; gate power and ground wired as the Circuit view draws them;
 * the gate dragged right, left and back), with the geometry measured after every step. Used by
 * the regression test and, unchanged, to record the behaviour of the previous release.
 */
import {
  addComponent,
  addWire,
  autoRouteVertices,
  createProject,
  emptySelection,
  endPosition,
  routeObstacles,
  setParam,
  wireRoute,
  type Point,
  type ProjectDocument,
  type RouteBox,
  type WireTarget,
} from '@tbi-lab/domain';
import * as routing from '../../src/ui/routing.js';

/** The store's canonical routing step (absent in releases before it existed). */
export const normalize: (d: ProjectDocument) => ProjectDocument =
  (routing as { routeAutomatic?: (d: ProjectDocument) => ProjectDocument }).routeAutomatic ??
  ((d) => d);

const T = (component: string, terminal: string): WireTarget => ({
  kind: 'terminal',
  component,
  terminal,
});

/** Draw a wire as the Circuit view does (router corners; clicked points as waypoints). */
export function draw(doc: ProjectDocument, from: WireTarget, to: WireTarget, clicks: Point[] = []) {
  const at = (t: WireTarget) => (t.kind === 'wire' ? t.at : endPosition(doc, t as never)!);
  const a = at(from);
  const b = at(to);
  const obs = routeObstacles(doc, routing.componentBoxes(doc));
  const vertices = autoRouteVertices([a, ...clicks, b], obs);
  const r = (addWire as (...x: unknown[]) => ReturnType<typeof addWire>)(doc, from, to, vertices, {
    waypoints: clicks,
  });
  if (!r.ok) throw new Error(r.error);
  return normalize(r.doc);
}

/** The owner's circuit: PSU1, GND1, the gate U1, with the gate's supply wired. */
export function ownerCircuit(): { doc: ProjectDocument; gate: string } {
  let doc = createProject({ projectId: 'prj_wire', deviceId: 'dev_w', name: 'w', appVersion: '0' });
  const add = (type: Parameters<typeof addComponent>[1], at: Point) => {
    const r = addComponent(doc, type, at);
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
    return r.id;
  };
  const gate = add('logic.gate_and', { x: 160, y: 0 });
  const p = setParam(doc, 'PSU1', 'setpointVoltage', { value: 3, unit: 'volt' });
  if (p.ok) doc = p.doc;
  doc = draw(doc, T('PSU1', 'negative'), T('GND1', 'ref'));
  doc = draw(doc, T('PSU1', 'positive'), T(gate, 'vcc'));
  doc = draw(doc, T(gate, 'gnd'), T('GND1', 'ref'));
  return { doc, gate };
}

/** Drag a selection by `delta` as the Circuit view commits it (store: canonical routing). */
export function drag(doc: ProjectDocument, ids: string[], delta: Point): ProjectDocument {
  const r = routing.moveRouted(doc, { ...emptySelection(), components: ids }, delta);
  if (!r.ok) throw new Error(r.error);
  return normalize(r.doc);
}

type Seg = [Point, Point];
const segs = (r: Point[]): Seg[] => r.slice(1).map((p, i) => [r[i]!, p]);
const horizontal = (s: Seg) => s[0].y === s[1].y;
const between = (v: number, a: number, b: number) => v > Math.min(a, b) && v < Math.max(a, b);
/** A clean crossing (perpendicular, strictly inside both): drawn with a bridge. */
const crosses = (s: Seg, t: Seg) =>
  horizontal(s) !== horizontal(t) &&
  (horizontal(s)
    ? between(t[0].x, s[0].x, s[1].x) && between(s[0].y, t[0].y, t[1].y)
    : between(s[0].x, t[0].x, t[1].x) && between(t[0].y, s[0].y, s[1].y));
/** Length of a segment strictly inside a box grown by `m`. */
function inside(s: Seg, q: RouteBox, m: number): number {
  const [x0, x1, y0, y1] = [q.minX - m, q.maxX + m, q.minY - m, q.maxY + m];
  if (horizontal(s)) {
    if (!(s[0].y > y0 && s[0].y < y1)) return 0;
    return Math.max(
      0,
      Math.min(Math.max(s[0].x, s[1].x), x1) - Math.max(Math.min(s[0].x, s[1].x), x0),
    );
  }
  if (!(s[0].x > x0 && s[0].x < x1)) return 0;
  return Math.max(
    0,
    Math.min(Math.max(s[0].y, s[1].y), y1) - Math.max(Math.min(s[0].y, s[1].y), y0),
  );
}

export interface Geometry {
  routes: Record<string, Point[]>;
  bends: number;
  length: number;
  /** Clean crossings between different wires (each drawn with a bridge). */
  bridges: number;
  /** Route length inside a component body (strict interior; none is acceptable). */
  bodyLength: number;
  /** Route length within half a grid step of a body, outside it, away from the wire's ends. */
  nearBodyLength: number;
}

export function measure(doc: ProjectDocument): Geometry {
  const routes: Record<string, Point[]> = {};
  for (const w of doc.layout.wires) routes[w.id] = wireRoute(doc, w) ?? [];
  const all = Object.entries(routes);
  let bridges = 0;
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++)
      for (const s of segs(all[i]![1]))
        for (const t of segs(all[j]![1])) if (crosses(s, t)) bridges++;
  const boxes = routing.componentBoxes(doc).filter((b) => !b.display);
  let bodyLength = 0;
  let nearBodyLength = 0;
  for (const [, r] of all) {
    const ends = [r[0]!, r[r.length - 1]!];
    for (const s of segs(r)) {
      // Exempt the stretch within one grid step of the wire's own ends (it leaves its terminal).
      const nearEnd = ends.some(
        (e) =>
          Math.max(Math.abs(s[0].x - e.x), Math.abs(s[0].y - e.y)) <= 20 &&
          Math.max(Math.abs(s[1].x - e.x), Math.abs(s[1].y - e.y)) <= 20,
      );
      for (const q of boxes) {
        bodyLength += inside(s, q, 0);
        if (!nearEnd) nearBodyLength += inside(s, q, 10) - inside(s, q, 0);
      }
    }
  }
  return {
    routes,
    bends: all.reduce((n, [, r]) => n + Math.max(0, r.length - 2), 0),
    length: all.reduce(
      (n, [, r]) =>
        n + segs(r).reduce((m, s) => m + Math.abs(s[1].x - s[0].x) + Math.abs(s[1].y - s[0].y), 0),
      0,
    ),
    bridges,
    bodyLength,
    nearBodyLength,
  };
}
