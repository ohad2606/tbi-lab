/**
 * Schematic geometry: grid, rotation, terminal positions and wire routes.
 *
 * All persisted coordinates are integer schematic units. The canvas is a technical, LTR
 * coordinate space; nothing here depends on locale or text direction.
 */

import { getTypeDef } from './catalog.js';
import { wireNodes } from './connectivity.js';
import type { Point, ProjectDocument, Rotation, Wire, WireEnd } from './schema.js';

/** Editor grid pitch in schematic units. Placements and wire points snap to it. */
export const GRID = 20;

export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

export function snap(value: number): number {
  // `+ 0` normalises -0, which would otherwise survive into the persisted document.
  return Math.round(value / GRID) * GRID + 0;
}

export function snapPoint(p: Point): Point {
  return { x: snap(p.x), y: snap(p.y) };
}

/** Rotate a point clockwise (screen coordinates, y down) about the origin. */
export function rotatePoint(p: Point, rotation: Rotation): Point {
  switch (rotation) {
    case 0:
      return { x: p.x, y: p.y };
    case 90:
      return { x: -p.y + 0, y: p.x + 0 };
    case 180:
      return { x: -p.x + 0, y: -p.y + 0 };
    case 270:
      return { x: p.y + 0, y: -p.x + 0 };
  }
}

export function nextRotation(rotation: Rotation): Rotation {
  return ROTATIONS[(ROTATIONS.indexOf(rotation) + 1) % ROTATIONS.length]!;
}

/**
 * Components by id, per components array (s20r4, review B1: a linear search per terminal made
 * routing a large project quadratic). Documents are immutable: an array is never changed in
 * place, so the map of an array stays valid.
 */
const byIdCache = new WeakMap<
  readonly ProjectDocument['components'][number][],
  Map<string, ProjectDocument['components'][number]>
>();
function componentById(list: readonly ProjectDocument['components'][number][]) {
  let m = byIdCache.get(list);
  if (!m) {
    m = new Map(list.map((c) => [c.id, c]));
    byIdCache.set(list, m);
  }
  return m;
}

/** Absolute position of a component terminal, or undefined if it does not exist. */
export function terminalPosition(
  doc: ProjectDocument,
  componentId: string,
  terminalId: string,
): Point | undefined {
  const component = componentById(doc.components).get(componentId);
  const placement = doc.layout.components[componentId];
  if (!component || !placement) return undefined;
  const terminal = getTypeDef(component.type)?.terminals.find((t) => t.id === terminalId);
  if (!terminal) return undefined;
  const r = rotatePoint(terminal.offset, placement.rotation);
  return { x: placement.x + r.x, y: placement.y + r.y };
}

export function endPosition(doc: ProjectDocument, end: WireEnd): Point | undefined {
  if (end.kind === 'terminal') return terminalPosition(doc, end.component, end.terminal);
  const j = doc.layout.junctions.find((jn) => jn.id === end.junction);
  return j ? { x: j.x, y: j.y } : undefined;
}

/**
 * Orthogonal route through the given points: each hop is drawn horizontal leg first, then
 * vertical. Consecutive duplicate points are removed. Splitting a wire at any point on this
 * route and routing both halves the same way reproduces the identical path.
 */
export function orthogonalRoute(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  const push = (p: Point) => {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push({ x: p.x, y: p.y });
  };
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (i > 0) {
      const prev = points[i - 1]!;
      push({ x: p.x, y: prev.y });
    }
    push(p);
  }
  // Drop collinear middle points so the route is a minimal polyline.
  const minimal: Point[] = [];
  for (const p of out) {
    const a = minimal[minimal.length - 2];
    const b = minimal[minimal.length - 1];
    if (a && b && ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y))) {
      minimal[minimal.length - 1] = p;
    } else {
      minimal.push(p);
    }
  }
  return minimal;
}

/** The drawn polyline of a wire, or undefined if an endpoint no longer resolves. */
export function wireRoute(doc: ProjectDocument, wire: Wire): Point[] | undefined {
  const a = endPosition(doc, wire.from);
  const b = endPosition(doc, wire.to);
  if (!a || !b) return undefined;
  return orthogonalRoute([a, ...wire.vertices, b]);
}

/** Axis-aligned segment containment (inclusive of both ends). */
export function pointOnSegment(p: Point, a: Point, b: Point): boolean {
  if (a.x === b.x) {
    return p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
  }
  if (a.y === b.y) {
    return p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
  }
  return false;
}

/**
 * Where `p` lies on a wire's route: the index of the waypoint hop it belongs to (0 = between
 * `from` and the first vertex). Returns undefined if `p` is not on the route.
 */
export function locateOnWire(
  doc: ProjectDocument,
  wire: Wire,
  p: Point,
): { hop: number } | undefined {
  const a = endPosition(doc, wire.from);
  const b = endPosition(doc, wire.to);
  if (!a || !b) return undefined;
  const waypoints = [a, ...wire.vertices, b];
  for (let hop = 0; hop < waypoints.length - 1; hop++) {
    const seg = orthogonalRoute([waypoints[hop]!, waypoints[hop + 1]!]);
    for (let i = 0; i < seg.length - 1; i++) {
      if (pointOnSegment(p, seg[i]!, seg[i + 1]!)) return { hop };
    }
    if (seg.length === 1 && seg[0]!.x === p.x && seg[0]!.y === p.y) return { hop };
  }
  return undefined;
}

/**
 * A place where two wires are drawn across each other WITHOUT being connected (Sprint 5).
 *
 * Presentation only: crossings are derived from the drawing and never stored, and they have no
 * electrical meaning. Connectivity comes from explicit wire endpoints (terminals, junctions)
 * alone; a crossing is by definition not a connection, and the canvas draws a bridge (line hop)
 * there so the drawing says so too.
 */
export interface WireCrossing {
  x: number;
  y: number;
  /** The wire whose VERTICAL segment carries the bridge (it hops over the other). */
  over: string;
  /** The wire whose horizontal segment passes straight underneath. */
  under: string;
}

/**
 * Sprint 20 (s20r): where two wires of the SAME electrical node are drawn across each other.
 * Not drawn with a hop (a hop says "not connected", which would be false); the router avoids
 * these (route.ts, criterion 6b). Presentation only.
 */
export function sameNodeCrossings(doc: ProjectDocument): WireCrossing[] {
  return allCrossings(doc, true).crossings;
}

/**
 * Every unconnected orthogonal crossing in the drawing, in a deterministic order: between wires
 * of DIFFERENT electrical nodes only (Sprint 20: a hop between two wires of one node would say
 * "not connected", which is false; those are `sameNodeCrossings`).
 *
 * A vertical segment of one wire and a horizontal segment of another (or of the same wire,
 * non-adjacent) cross when the point lies STRICTLY inside both segments. Not a crossing:
 * a point where either segment ends (a shared endpoint, a corner, a T), a junction position or a
 * terminal position (where a connection is or could be explicit), and collinear overlaps (no
 * single crossing point).
 */
export function wireCrossings(doc: ProjectDocument): WireCrossing[] {
  return allCrossings(doc, false).crossings;
}
/** `wireCrossings` with whether its work cap (OVERLAY_WORK) cut it short (s20r6). */
export function wireCrossingsReport(doc: ProjectDocument): {
  crossings: WireCrossing[];
  limited: boolean;
} {
  return allCrossings(doc, false);
}

/**
 * Sprint 20 (s20r round 3, owner directive "Electrical junctions must be explicit"): the points
 * where wires of ONE node branch off a run they share (the router lets them share runs: route.ts
 * criterion 8b), drawn with a dot like a junction. PRESENTATION ONLY: never stored, never a
 * junction object, no effect on connectivity (the wires' endpoints alone decide that).
 *
 * A point is a branch when it is not a terminal or a junction (those are marked already), a wire
 * of the node bends or ends there, and the wires of that node leave it in at least three of the
 * four directions. Two wires merely crossing (both straight through) are not a branch, and wires
 * of different nodes never count together.
 */
export function sameNodeBranches(doc: ProjectDocument): Point[] {
  return sameNodeBranchesReport(doc).points;
}

/**
 * The 2D overlays' work cap (s20r6, review r4 MAJOR 1: crossings and branch dots are computed on
 * every Canvas render, and their work can grow with the square of the wires, by output alone):
 * at most this many candidate tests per overlay; past it the overlay is cut short (`limited`) and
 * the Circuit view says so. Counted, never timed: the same drawing every time.
 */
export const OVERLAY_WORK = 2_000_000;

/** `sameNodeBranches` with whether its work cap cut it short (s20r6). */
export function sameNodeBranchesReport(doc: ProjectDocument): {
  points: Point[];
  limited: boolean;
} {
  const node = wireNodes(doc);
  const marked = new Set<string>();
  for (const j of doc.layout.junctions) marked.add(`${j.x},${j.y}`);
  for (const c of doc.components)
    for (const t of getTypeDef(c.type)?.terminals ?? []) {
      const p = terminalPosition(doc, c.id, t.id);
      if (p) marked.add(`${p.x},${p.y}`);
    }
  // Every segment, bucketed by the grid cells it covers (s20r4, review B7: each point was
  // tested against every segment of its node).
  type Seg = { a: Point; b: Point; n: string };
  const index = new SegmentIndex<Seg>();
  const vertices: { p: Point; n: string }[] = [];
  for (const w of doc.layout.wires) {
    const r = wireRoute(doc, w);
    const n = node.get(w.id);
    if (!r || !n) continue;
    for (let i = 1; i < r.length; i++) index.add(r[i - 1]!, r[i]!, { a: r[i - 1]!, b: r[i]!, n });
    for (const p of r) vertices.push({ p, n });
  }
  const out = new Map<string, Point>();
  const refused = new Set<string>();
  let work = 0;
  let limited = false;
  for (const { p, n } of vertices) {
    const k = `${p.x},${p.y}`;
    if (marked.has(k) || out.has(k) || refused.has(k)) continue;
    const dirs = new Set<string>();
    let foreign = false;
    const [here, long] = index.atParts(p);
    work += here.length + long.length;
    if (work > OVERLAY_WORK) {
      limited = true;
      break;
    }
    for (const { a, b, n: m } of [here, long].flat()) {
      if (!onSegment(p, a, b)) continue;
      // s20r4 (review B2): a wire of ANOTHER node through or onto the point. A dot there would
      // sit on a different-node crossing or T (where a hop or nothing is drawn): no dot.
      if (m !== n) {
        foreign = true;
        break;
      }
      for (const q of [a, b])
        if (q.x !== p.x || q.y !== p.y) dirs.add(`${Math.sign(q.x - p.x)},${Math.sign(q.y - p.y)}`);
    }
    if (foreign) refused.add(k);
    else if (dirs.size >= 3) out.set(k, { x: p.x, y: p.y });
  }
  return { points: [...out.values()].sort((p, q) => p.x - q.x || p.y - q.y), limited };
}

const onSegment = (p: Point, a: Point, b: Point) =>
  (a.x === b.x && p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)) ||
  (a.y === b.y && p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x));

/**
 * Axis-aligned segments bucketed by coarse cells (layout units), for point and run queries.
 * s20r5 (review r3, BLOCKING 2): the work must not grow with coordinate size. A segment is put in
 * at most MAX_CELLS cells; a longer one goes to a `long` list that every query scans instead (the
 * pre-index behaviour, O(segments), for those only). Queries are capped the same way: a run
 * covering more than MAX_CELLS cells scans every segment. So building costs at most
 * O(segments x MAX_CELLS) and a query O(MAX_CELLS x bucket + long), whatever the coordinates.
 */
class SegmentIndex<T> {
  static readonly CELL = 200;
  static readonly MAX_CELLS = 64;
  private readonly cells = new Map<string, T[]>();
  readonly long: T[] = [];
  private static span(a: Point, b: Point) {
    const c = SegmentIndex.CELL;
    const x0 = Math.floor(Math.min(a.x, b.x) / c);
    const x1 = Math.floor(Math.max(a.x, b.x) / c);
    const y0 = Math.floor(Math.min(a.y, b.y) / c);
    const y1 = Math.floor(Math.max(a.y, b.y) / c);
    return { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
  }
  add(a: Point, b: Point, v: T): void {
    const sp = SegmentIndex.span(a, b);
    if (!(sp.count <= SegmentIndex.MAX_CELLS)) {
      this.long.push(v);
      return;
    }
    for (let x = sp.x0; x <= sp.x1; x++)
      for (let y = sp.y0; y <= sp.y1; y++) {
        const k = `${x},${y}`;
        const list = this.cells.get(k);
        if (list) list.push(v);
        else this.cells.set(k, [v]);
      }
  }
  /** Every segment that may contain p, as two lists (a superset; callers test exactly). */
  atParts(p: Point): [readonly T[], readonly T[]] {
    const c = SegmentIndex.CELL;
    return [this.cells.get(`${Math.floor(p.x / c)},${Math.floor(p.y / c)}`) ?? [], this.long];
  }
  /** Every segment that may meet the run a-b (a superset, possibly with repeats). */
  along(a: Point, b: Point): readonly T[] | 'all' {
    const sp = SegmentIndex.span(a, b);
    if (!(sp.count <= SegmentIndex.MAX_CELLS)) return 'all';
    const out: T[] = [...this.long];
    for (let x = sp.x0; x <= sp.x1; x++)
      for (let y = sp.y0; y <= sp.y1; y++) out.push(...(this.cells.get(`${x},${y}`) ?? []));
    return out;
  }
}

/** Crossings between wires of one node (`same`), or of different nodes (s20r). */
function allCrossings(
  doc: ProjectDocument,
  same: boolean,
): { crossings: WireCrossing[]; limited: boolean } {
  const node = wireNodes(doc);
  type Seg = { wire: string; a: Point; b: Point };
  const vertical: Seg[] = [];
  const horizontal: Seg[] = [];
  for (const w of doc.layout.wires) {
    const r = wireRoute(doc, w);
    if (!r) continue;
    for (let i = 0; i < r.length - 1; i++) {
      const a = r[i]!;
      const b = r[i + 1]!;
      if (a.x === b.x && a.y !== b.y) vertical.push({ wire: w.id, a, b });
      else if (a.y === b.y && a.x !== b.x) horizontal.push({ wire: w.id, a, b });
    }
  }
  const blocked = new Set<string>();
  for (const j of doc.layout.junctions) blocked.add(`${j.x},${j.y}`);
  for (const c of doc.components) {
    for (const t of getTypeDef(c.type)?.terminals ?? []) {
      const p = terminalPosition(doc, c.id, t.id);
      if (p) blocked.add(`${p.x},${p.y}`);
    }
  }
  const inside = (v: number, p: number, q: number) => v > Math.min(p, q) && v < Math.max(p, q);
  const out: WireCrossing[] = [];
  // Horizontal segments bucketed by cell (s20r4, review B7: every vertical was tested against
  // every horizontal on every frame); per vertical, the buckets along it, each segment once, in
  // document order as before.
  const index = new SegmentIndex<Seg & { k: number }>();
  horizontal.forEach((h, k) => index.add(h.a, h.b, { ...h, k }));
  const all = horizontal.map((h, k) => ({ ...h, k }));
  let work = 0;
  let limited = false;
  for (const v of vertical) {
    const found = index.along(v.a, v.b);
    let near: readonly (Seg & { k: number })[];
    if (found === 'all')
      near = all; // in order, each once: no copy, no sort
    else {
      const seen = new Set<number>();
      const list: (Seg & { k: number })[] = [];
      for (const h of found)
        if (!seen.has(h.k)) {
          seen.add(h.k);
          list.push(h);
        }
      list.sort((p, q) => p.k - q.k);
      near = list;
    }
    work += near.length + 1;
    if (work > OVERLAY_WORK) {
      limited = true;
      break;
    }
    for (const h of near) {
      const x = v.a.x;
      const y = h.a.y;
      if (!inside(x, h.a.x, h.b.x) || !inside(y, v.a.y, v.b.y)) continue;
      if (blocked.has(`${x},${y}`)) continue;
      // A hop marks wires that are NOT connected: only between different nodes (s20r).
      if ((node.get(v.wire) === node.get(h.wire)) !== same) continue;
      out.push({ x, y, over: v.wire, under: h.wire });
    }
  }
  return {
    crossings: out.sort(
      (p, q) => p.x - q.x || p.y - q.y || (p.over < q.over ? -1 : p.over > q.over ? 1 : 0),
    ),
    limited,
  };
}
