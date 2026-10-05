/**
 * Automatic routing of a NEW wire (Product Alpha maintenance).
 *
 * A stored wire is drawn as `orthogonalRoute([from, ...vertices, to])`: every hop horizontal
 * first, then vertical. Left alone, that fixed rule can lay a new wire directly on top of an
 * existing one (for example a return wire that leaves a terminal on the same row as the circuit
 * it returns past), so two distinct conductors read as one. This router chooses, for each hop
 * of a wire being drawn, a Manhattan shape that stays visually independent. The chosen corners
 * become the wire's ordinary stored vertices; the schema and every existing wire are unchanged.
 *
 * Deterministic and grid-aligned. Each hop picks the lowest-cost candidate from a fixed,
 * ordered set:
 *   0  horizontal-then-vertical L (the previous fixed rule; wins every tie)
 *   1  vertical-then-horizontal L
 *   2+ three-segment channels (V-H-V and H-V-H) whose middle segment runs on a grid line
 *      between the endpoints or up to 8 grid steps outside them
 * compared lexicographically by:
 *   1. length running coincident with an existing wire segment   (never look like one wire)
 *   2. length through a component body                            (never cross a symbol)
 *   3. touches: passing through another terminal/junction, or meeting an existing wire at a
 *      point that is not a clean crossing (a T or an end on the wire reads as a connection)
 *   4. crossings + bends (a clean crossing is allowed and drawn with a bridge; it costs the
 *      same as one extra bend)
 *   5. total length
 *   6. candidate order
 *
 * Presentation only. A route has NO electrical meaning: connectivity comes from explicit wire
 * endpoints (terminals, junctions), never from where a route happens to pass, so a new wire can
 * only ever join the net it is explicitly attached to.
 */
import { boardPinPosition, getTypeDef } from './catalog.js';
import { ESP32_DEVKITC_WROOM32 } from './boards/esp32DevkitcWroom32.js';
import { isContact } from './contacts.js';
import { GRID, orthogonalRoute, rotatePoint, terminalPosition, wireRoute } from './layout.js';
import type { Point, ProjectDocument, Wire } from './schema.js';

/** An axis-aligned component body; only its strict interior is an obstacle. */
export interface RouteBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RouteObstacles {
  /** Straight segments of the wires already drawn. */
  segments: readonly (readonly [Point, Point])[];
  /** Component bodies. */
  boxes: readonly RouteBox[];
  /** Terminal and junction positions a route must not pass through. */
  points: readonly Point[];
}

/** How far outside its endpoints a channel may run, in grid steps. */
const CHANNEL_REACH = 8;

type Seg = readonly [Point, Point];
const eq = (p: Point, q: Point) => p.x === q.x && p.y === q.y;
const horizontal = (s: Seg) => s[0].y === s[1].y && s[0].x !== s[1].x;
const vertical = (s: Seg) => s[0].x === s[1].x && s[0].y !== s[1].y;

/** Consecutive duplicates removed; null if the path doubles back on itself. */
function normalize(pts: Point[]): Point[] | null {
  const out: Point[] = [];
  for (const p of pts) if (!out.length || !eq(out[out.length - 1]!, p)) out.push(p);
  const minimal: Point[] = [];
  for (const p of out) {
    const a = minimal[minimal.length - 2];
    const b = minimal[minimal.length - 1];
    if (a && b && ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y))) {
      // Collinear: allowed only when it keeps going the same way.
      const forward =
        a.x === b.x
          ? Math.sign(b.y - a.y) === Math.sign(p.y - b.y)
          : Math.sign(b.x - a.x) === Math.sign(p.x - b.x);
      if (!forward) return null;
      minimal[minimal.length - 1] = p;
    } else minimal.push(p);
  }
  return minimal;
}

function channels(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(lo / GRID) * GRID; v <= hi; v += GRID) if (v > lo && v < hi) out.push(v);
  for (let k = 1; k <= CHANNEL_REACH; k++) out.push(hi + k * GRID, lo - k * GRID);
  return out;
}

/** Candidate shapes for one hop, in preference order (see the module comment). */
function candidates(a: Point, b: Point): Point[][] {
  const raw: Point[][] = [
    [a, { x: b.x, y: a.y }, b],
    [a, { x: a.x, y: b.y }, b],
  ];
  for (const y of channels(Math.min(a.y, b.y), Math.max(a.y, b.y)))
    raw.push([a, { x: a.x, y }, { x: b.x, y }, b]);
  for (const x of channels(Math.min(a.x, b.x), Math.max(a.x, b.x)))
    raw.push([a, { x, y: a.y }, { x, y: b.y }, b]);
  const seen = new Set<string>();
  const out: Point[][] = [];
  for (const r of raw) {
    const n = normalize(r);
    if (!n) continue;
    const key = n.map((p) => `${p.x},${p.y}`).join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function overlapLength(s: Seg, t: Seg): number {
  if (horizontal(s) && horizontal(t) && s[0].y === t[0].y) {
    const lo = Math.max(Math.min(s[0].x, s[1].x), Math.min(t[0].x, t[1].x));
    const hi = Math.min(Math.max(s[0].x, s[1].x), Math.max(t[0].x, t[1].x));
    return Math.max(0, hi - lo);
  }
  if (vertical(s) && vertical(t) && s[0].x === t[0].x) {
    const lo = Math.max(Math.min(s[0].y, s[1].y), Math.min(t[0].y, t[1].y));
    const hi = Math.min(Math.max(s[0].y, s[1].y), Math.max(t[0].y, t[1].y));
    return Math.max(0, hi - lo);
  }
  return 0;
}

function boxLength(s: Seg, box: RouteBox): number {
  if (horizontal(s)) {
    if (!(s[0].y > box.minY && s[0].y < box.maxY)) return 0;
    const lo = Math.max(Math.min(s[0].x, s[1].x), box.minX);
    const hi = Math.min(Math.max(s[0].x, s[1].x), box.maxX);
    return Math.max(0, hi - lo);
  }
  if (vertical(s)) {
    if (!(s[0].x > box.minX && s[0].x < box.maxX)) return 0;
    const lo = Math.max(Math.min(s[0].y, s[1].y), box.minY);
    const hi = Math.min(Math.max(s[0].y, s[1].y), box.maxY);
    return Math.max(0, hi - lo);
  }
  return 0;
}

const inside = (v: number, p: number, q: number) => v > Math.min(p, q) && v < Math.max(p, q);
const onSeg = (p: Point, s: Seg) =>
  (vertical(s) &&
    p.x === s[0].x &&
    p.y >= Math.min(s[0].y, s[1].y) &&
    p.y <= Math.max(s[0].y, s[1].y)) ||
  (horizontal(s) &&
    p.y === s[0].y &&
    p.x >= Math.min(s[0].x, s[1].x) &&
    p.x <= Math.max(s[0].x, s[1].x));

/** Clean crossing: perpendicular, meeting strictly inside both. */
function crosses(s: Seg, t: Seg): boolean {
  const [v, h] =
    vertical(s) && horizontal(t) ? [s, t] : vertical(t) && horizontal(s) ? [t, s] : [null, null];
  if (!v || !h) return false;
  return inside(v[0].x, h[0].x, h[1].x) && inside(h[0].y, v[0].y, v[1].y);
}

function cost(path: Point[], obs: RouteObstacles, ends: readonly Point[]): number[] {
  const segs: Seg[] = [];
  for (let i = 0; i < path.length - 1; i++) segs.push([path[i]!, path[i + 1]!]);
  let overlap = 0;
  let body = 0;
  let touches = 0;
  let crossings = 0;
  const isEnd = (p: Point) => ends.some((e) => eq(e, p));
  for (const s of segs) {
    for (const t of obs.segments) {
      overlap += overlapLength(s, t);
      if (crosses(s, t)) crossings++;
    }
    for (const box of obs.boxes) body += boxLength(s, box);
  }
  // Points where the new route meets something without a clean crossing.
  for (const p of obs.points) if (!isEnd(p) && segs.some((s) => onSeg(p, s))) touches++;
  for (const t of obs.segments) {
    for (const q of [t[0], t[1]]) if (!isEnd(q) && segs.some((s) => onSeg(q, s))) touches++;
  }
  for (const corner of path.slice(1, -1)) if (obs.segments.some((t) => onSeg(corner, t))) touches++;
  const bends = path.length - 2;
  const length = segs.reduce(
    (n, s) => n + Math.abs(s[1].x - s[0].x) + Math.abs(s[1].y - s[0].y),
    0,
  );
  return [overlap, body, touches, crossings + bends, length];
}

function better(p: number[], q: number[]): boolean {
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i]! < q[i]!;
  return false;
}

/**
 * The route of a new wire through `waypoints` (its start, the points the user clicked, its end).
 * Returns the full polyline; its interior points are the vertices to store. Hops are routed in
 * order, and each routed hop becomes an obstacle for the following ones.
 */
export function autoRoute(waypoints: readonly Point[], obstacles: RouteObstacles): Point[] {
  if (waypoints.length < 2) return waypoints.map((p) => ({ ...p }));
  const segments = [...obstacles.segments];
  const path: Point[] = [waypoints[0]!];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i]!;
    const b = waypoints[i + 1]!;
    const obs = { ...obstacles, segments };
    let best: Point[] | null = null;
    let bestCost: number[] = [];
    for (const c of candidates(a, b)) {
      const k = cost(c, obs, [a, b]);
      if (!best || better(k, bestCost)) {
        best = c;
        bestCost = k;
      }
    }
    for (let j = 0; j < best!.length - 1; j++) segments.push([best![j]!, best![j + 1]!]);
    path.push(...best!.slice(1));
  }
  // Minimal polyline (merges collinear corners where two hops meet).
  return orthogonalRoute(path);
}

/** The vertices to store for `autoRoute(waypoints, obstacles)`. */
export function autoRouteVertices(waypoints: readonly Point[], obstacles: RouteObstacles): Point[] {
  return autoRoute(waypoints, obstacles).slice(1, -1);
}

/**
 * Obstacles of a document for routing a new wire: every existing wire segment (except the
 * `except` wires), every terminal and junction position and every pin a board draws (its
 * unconnectable header pins included: a wire running along a header would read as connected to
 * each pin it passes), plus the component bodies the caller supplies (symbol geometry is
 * presentation, owned by the app).
 */
export function routeObstacles(
  doc: ProjectDocument,
  boxes: readonly RouteBox[],
  except: ReadonlySet<string> = new Set(),
): RouteObstacles {
  const segments: [Point, Point][] = [];
  for (const w of doc.layout.wires) {
    if (except.has(w.id)) continue;
    const r = wireRoute(doc, w);
    if (!r) continue;
    for (let i = 0; i < r.length - 1; i++) segments.push([r[i]!, r[i + 1]!]);
  }
  const points: Point[] = doc.layout.junctions.map((j) => ({ x: j.x, y: j.y }));
  const seen = new Set<string>();
  const add = (p: Point) => {
    const k = `${p.x},${p.y}`;
    if (seen.has(k)) return;
    seen.add(k);
    points.push(p);
  };
  for (const c of doc.components) {
    for (const t of getTypeDef(c.type)?.terminals ?? []) {
      const p = terminalPosition(doc, c.id, t.id);
      if (p) add(p);
    }
    const placement = doc.layout.components[c.id];
    if (c.type === 'board.esp32_devkitc_wroom32' && placement)
      for (const pin of ESP32_DEVKITC_WROOM32.pins) {
        const q = rotatePoint(boardPinPosition(pin), placement.rotation);
        add({ x: placement.x + q.x, y: placement.y + q.y });
      }
  }
  return { segments, boxes, points };
}

/**
 * Re-route existing wires after a placement edit (Sprint 9). A stored wire keeps its vertices
 * when a part it is attached to moves, so its fixed horizontal-first route can end up running
 * along a header, through a body or over unrelated terminals. Each of the given wires whose
 * route now does so is replaced by the best of:
 *   - the router's shapes through its own vertices (the user's waypoints are kept), and
 *   - the router's shapes straight between its ends,
 * when that is strictly better by the router's cost (module comment). A wire whose route is
 * clean is never touched, and a direct contact (contacts.ts) has no route to improve.
 *
 * Presentation only: endpoints never change, so connectivity and nets cannot change. Returns
 * a new document (the input is not mutated), or the same document if nothing changed.
 */
export function rerouteWires(
  doc: ProjectDocument,
  wireIds: Iterable<string>,
  boxes: readonly RouteBox[],
): ProjectDocument {
  let out = doc;
  for (const id of new Set(wireIds)) {
    const wire = out.layout.wires.find((w) => w.id === id);
    if (!wire || isContact(out, wire)) continue;
    const route = wireRoute(out, wire);
    if (!route || route.length < 2) continue;
    const obs = routeObstacles(out, boxes, new Set([id]));
    const ends = [route[0]!, route[route.length - 1]!];
    const now = cost(route, obs, ends);
    if (now[0] === 0 && now[1] === 0 && now[2] === 0) continue;
    let best: Point[] | null = null;
    let bestCost = now;
    for (const waypoints of [[ends[0]!, ...wire.vertices, ends[1]!], ends]) {
      const candidate = autoRoute(waypoints, obs);
      const k = cost(candidate, obs, ends);
      if (better(k, bestCost)) {
        best = candidate;
        bestCost = k;
      }
    }
    if (!best) continue;
    const vertices = best.slice(1, -1);
    out = {
      ...out,
      layout: {
        ...out.layout,
        wires: out.layout.wires.map((w): Wire => (w.id === id ? { ...w, vertices } : w)),
      },
    };
  }
  return out;
}

/**
 * The wires a placement edit of `components` drags along: every wire with a terminal end on one
 * of them, except the wires that were selected and moved rigidly with them.
 */
export function attachedWires(
  doc: ProjectDocument,
  components: Iterable<string>,
  movedWires: Iterable<string> = [],
): string[] {
  const parts = new Set(components);
  const rigid = new Set(movedWires);
  const on = (e: Wire['from']) => e.kind === 'terminal' && parts.has(e.component);
  return doc.layout.wires
    .filter((w) => !rigid.has(w.id) && (on(w.from) || on(w.to)))
    .map((w) => w.id);
}
