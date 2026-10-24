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
 * Deterministic and grid-aligned. Each hop first tries a fixed, ordered set of short shapes:
 *   0  horizontal-then-vertical L (the previous fixed rule; wins every tie)
 *   1  vertical-then-horizontal L
 *   2+ three-segment channels (V-H-V and H-V-H) whose middle segment runs on a grid line
 *      between the endpoints or up to 8 grid steps outside them
 * and, when none of them is clean, a grid search (any number of bends, around bodies and pin
 * fields; `searchRoute`). Routes are compared lexicographically by:
 *   1. TERMINAL KEEP-OUT: unrelated terminals, board pins and junctions the route enters, i.e.
 *      passes within `TERMINAL_KEEP_OUT` of (Sprint 10 owner blocker). A wire drawn through a pin
 *      reads as connected to it, so this ranks above everything else: a longer route around
 *      the part always beats a short one along a header. Only the hop's own two endpoints are
 *      exempt.
 *   2. PROTECTED REGIONS: length over a display face (Sprint 13 OS-05: an LCD's text, a matrix's
 *      dots; a box the caller marks `display`), plus
 *      HEADER-ROW BAND: length inside the exclusion band of a board header row (its pins and
 *      their stubs, grown by `HEADER_CLEARANCE` on every side; Sprint 10 second owner blocker).
 *      A wire running along or beside a pin row, or along the row's line beyond its last pin,
 *      reads as attached to the row. Only a hop's own pin on that row may cross the band, and
 *      only by its straight, outward exit (perpendicular to the row, away from the board)
 *   3. length running coincident with an existing wire segment   (never look like one wire)
 *   4. length through a component body                            (never cross a symbol)
 *   5. length running along a wire that is attached at the hop's own endpoint: the same terminal,
 *      so the same net, and nothing false is implied. Needed when that wire takes the only free
 *      way out of a pin (along a header the neighbouring pins block both other directions)
 *   6. touches: meeting an existing wire at a point that is not a clean crossing (a T or an end
 *      on the wire reads as a connection)
 *   7. pin-field clearance: unrelated board header pins the route runs right beside (one grid
 *      step away). Not misleading, but a wire hugging a header reads poorly; a wire goes around
 *      a pin field with a visible gap when that costs only bends and length. The pins next to
 *      the hop's own endpoints are exempt (every way out of a header pin passes them)
 *   8. crossings + bends (a clean crossing is allowed and drawn with a bridge; it costs the
 *      same as one extra bend). Sprint 20 (s20r owner report): crossing a wire of the hop's OWN
 *      electrical node costs SAME_CROSS (3) bends: no hop is drawn there (a hop says "not
 *      connected", which would be false), and a plain crossing of one node's wires is ambiguous
 *   8b. TRUNK (s20r): length run along, and points where the route meets or leaves, a wire of the
 *      hop's own node (only when the caller says which node the wire is on, `node`). Wires of one
 *      node may share a run and branch where they part (a T on a wire of the same node reads as
 *      the connection it is), instead of each needing a free side of the terminal and wrapping
 *      round across the others. Ranked after bends: it is free of the "never look like one
 *      wire" rule (criterion 3), which protects DIFFERENT nodes; without a `node` such overlap
 *      stays criterion 3 or 5
 *   9. total length
 *  10. candidate order (the short shapes before the search result)
 *
 * Presentation only. A route has NO electrical meaning: connectivity comes from explicit wire
 * endpoints (terminals, junctions), never from where a route happens to pass, so a new wire can
 * only ever join the net it is explicitly attached to.
 */
import { BOARD_HALF_WIDTH, boardPinPosition, boardTerminalId, getTypeDef } from './catalog.js';

/** Length of the stub drawn for a board pin that cannot be wired (app symbol). */
const BOARD_STUB = 8;
import { ESP32_DEVKITC_WROOM32 } from './boards/esp32DevkitcWroom32.js';
import { isContact } from './contacts.js';
import { wireNodes } from './connectivity.js';
import {
  GRID,
  orthogonalRoute,
  rotatePoint,
  sameNodeCrossings,
  terminalPosition,
  wireCrossings,
  wireRoute,
  type WireCrossing,
} from './layout.js';
import type { Point, ProjectDocument, Wire } from './schema.js';

/** An axis-aligned component body; only its strict interior is an obstacle. */
export interface RouteBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /**
   * Sprint 13 OS-05: a display face (an LCD's text, a matrix's dots), not a body: a wire over it
   * hides what the part shows. Priced with the header bands (criterion 2), ahead of everything
   * but terminal keep-out, so a route around it always wins when one exists.
   */
  display?: boolean;
}

export interface RouteObstacles {
  /** Straight segments of the wires already drawn. */
  segments: readonly (readonly [Point, Point])[];
  /** Component bodies. */
  boxes: readonly RouteBox[];
  /** Terminal and junction positions a route must not pass through. */
  points: readonly Point[];
  /**
   * Drawn terminal LEAD-INS (Sprint 10): the line a symbol draws from its body out to a terminal
   * (a board's pin stub). A wire running along or into one reads as attached to that pin, so a
   * lead is keep-out like its terminal. `[terminal end, body end]`; the lead of a hop's own
   * endpoint terminal is exempt. Optional: none when a symbol's leads lie inside its body box.
   */
  leads?: readonly (readonly [Point, Point])[];
  /**
   * Pin-field positions (a board's header pins, Sprint 10): a route keeps a full grid step of
   * clearance from them where it can (criterion 6). Optional.
   */
  field?: readonly Point[];
  /**
   * Board header rows (Sprint 10): the box of the row's pins and their stubs, and the unit
   * direction pointing out of the board across the row. Criterion 2 keeps routes out of the box
   * grown by `HEADER_CLEARANCE`, except a hop endpoint's straight outward exit. Optional.
   */
  headers?: readonly HeaderRow[];
  /**
   * Sprint 20 (s20r): the electrical node of each wire segment (same order as `segments`), so a
   * hop of a wire on a given node can price crossing its own node's wires (criterion 6b).
   */
  segmentNodes?: readonly (string | null)[];
}

export interface HeaderRow {
  box: RouteBox;
  outward: Point;
}

/** How far outside its endpoints a channel may run, in grid steps. */
const CHANNEL_REACH = 8;

/**
 * Terminal keep-out radius: a route segment closer than this to an unrelated terminal, board pin
 * or junction ENTERS it. Larger than every marker the canvas draws there (terminal mark r 3.5,
 * junction dot r 4.5, terminal hit area r 9), and half a grid step: on the routing grid a route
 * either runs through a pin's centre line (entered) or a full grid step beside it (clear of its
 * hit area by 11 units).
 */
export const TERMINAL_KEEP_OUT = GRID / 2;

/**
 * Header-row clearance band (Sprint 10): how far beyond a header row's pins and stubs other
 * wires must stay. Two and a half grid steps: the nearest grid line a wire can use beside a row is
 * three steps (60 units) from the pin centres, about 54 units of clear space to a pin marker, so
 * a wire passing a header reads as a separate run, not as part of the row (owner review).
 */
export const HEADER_CLEARANCE = (5 * GRID) / 2;

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

/** Distance from `p` to the segment `s`. */
function distance(p: Point, s: Seg): number {
  const x = Math.max(Math.min(s[0].x, s[1].x), Math.min(p.x, Math.max(s[0].x, s[1].x)));
  const y = Math.max(Math.min(s[0].y, s[1].y), Math.min(p.y, Math.max(s[0].y, s[1].y)));
  return Math.hypot(p.x - x, p.y - y);
}

/** Unrelated terminals, pins and junctions the path enters (not its own endpoints). */
/** Distance between two axis-aligned segments (0 when they meet). */
function segDistance(s: Seg, t: Seg): number {
  const meet =
    Math.max(Math.min(s[0].x, s[1].x), Math.min(t[0].x, t[1].x)) <=
      Math.min(Math.max(s[0].x, s[1].x), Math.max(t[0].x, t[1].x)) &&
    Math.max(Math.min(s[0].y, s[1].y), Math.min(t[0].y, t[1].y)) <=
      Math.min(Math.max(s[0].y, s[1].y), Math.max(t[0].y, t[1].y));
  if (meet) return 0;
  return Math.min(distance(s[0], t), distance(s[1], t), distance(t[0], s), distance(t[1], s));
}

/** Unrelated terminals, pins, junctions and lead-ins the path enters (not its own endpoints'). */
function keepOutHits(segs: readonly Seg[], obs: RouteObstacles, isEnd: (p: Point) => boolean) {
  let n = 0;
  for (const p of obs.points)
    if (!isEnd(p) && segs.some((s) => distance(p, s) < TERMINAL_KEEP_OUT)) n++;
  for (const l of obs.leads ?? [])
    if (!isEnd(l[0]) && segs.some((s) => segDistance(s, l) < TERMINAL_KEEP_OUT)) n++;
  return n;
}

function cost(
  path: Point[],
  obs: RouteObstacles,
  ends: readonly Point[],
  node: string | null = null,
): number[] {
  const segs: Seg[] = [];
  for (let i = 0; i < path.length - 1; i++) segs.push([path[i]!, path[i + 1]!]);
  let overlap = 0;
  let shared = 0;
  let body = 0;
  let touches = 0;
  let crossings = 0;
  let sameCross = 0;
  let trunk = 0;
  const isEnd = (p: Point) => ends.some((e) => eq(e, p));
  // A TRUNK segment (s20r): a segment of a wire of the hop's own node (criterion 8b).
  const isTrunk = (i: number) => node !== null && obs.segmentNodes?.[i] === node;
  for (const s of segs) {
    obs.segments.forEach((t, i) => {
      if (isTrunk(i)) trunk += overlapLength(s, t) / GRID;
      else if (sharesEnd(t, ends)) shared += overlapLength(s, t);
      else overlap += overlapLength(s, t);
      if (crosses(s, t)) {
        if (node !== null && obs.segmentNodes?.[i] === node) sameCross++;
        else crossings++;
      }
    });
    for (const box of obs.boxes) if (!box.display) body += boxLength(s, box);
  }
  const keepOut = keepOutHits(segs, obs, isEnd);
  const hug = hugs(segs, obs, ends);
  const banded = bandLength(segs, obs, ends);
  // Points where the new route meets an existing wire without a clean crossing.
  // (Meeting a trunk segment is where the wire branches off its own node's wire: priced as trunk.)
  obs.segments.forEach((t, i) => {
    for (const q of [t[0], t[1]])
      if (!isEnd(q) && segs.some((s) => onSeg(q, s))) {
        if (isTrunk(i)) trunk++;
        else touches++;
      }
  });
  for (const corner of path.slice(1, -1)) {
    const on = obs.segments.map((t, i) => (onSeg(corner, t) ? i : -1)).filter((i) => i >= 0);
    if (on.length === 0) continue;
    if (on.every(isTrunk)) trunk++;
    else touches++;
  }
  const bends = path.length - 2;
  const length = segs.reduce(
    (n, s) => n + Math.abs(s[1].x - s[0].x) + Math.abs(s[1].y - s[0].y),
    0,
  );
  return [
    keepOut,
    banded,
    overlap,
    body,
    shared,
    touches,
    hug,
    crossings + bends + SAME_CROSS * sameCross,
    trunk,
    length,
  ];
}

/** An existing wire segment that ends at one of the hop's endpoints (a wire on the same terminal). */
const sharesEnd = (t: Seg, ends: readonly Point[]) => ends.some((e) => eq(t[0], e) || eq(t[1], e));

/**
 * A route is clean when it enters no terminal, runs along no other wire, through no body, and
 * touches no wire.
 */
const clean = (k: readonly number[]) =>
  k[0] === 0 && k[1] === 0 && k[2] === 0 && k[3] === 0 && k[4] === 0 && k[5] === 0 && k[6] === 0;

/** Whether pin-field point p is one grid step beside a segment (clear of it, but hugging it). */
const beside = (p: Point, s: Seg) => {
  const d = distance(p, s);
  return d >= TERMINAL_KEEP_OUT && d <= GRID;
};
/** Pin-field points hugged by the path (criterion 6), the endpoints' neighbours exempt. */
function hugs(segs: readonly Seg[], obs: RouteObstacles, ends: readonly Point[]): number {
  let n = 0;
  for (const p of obs.field ?? []) {
    if (ends.some((e) => Math.hypot(p.x - e.x, p.y - e.y) <= GRID)) continue;
    if (segs.some((s) => beside(p, s))) n++;
  }
  return n;
}

/** A header row's exclusion band: its pin field grown by `HEADER_CLEARANCE`. */
const band = (h: HeaderRow): RouteBox => ({
  minX: h.box.minX - HEADER_CLEARANCE,
  minY: h.box.minY - HEADER_CLEARANCE,
  maxX: h.box.maxX + HEADER_CLEARANCE,
  maxY: h.box.maxY + HEADER_CLEARANCE,
});
const inBox = (p: Point, q: RouteBox) =>
  p.x >= q.minX && p.x <= q.maxX && p.y >= q.minY && p.y <= q.maxY;
/** Length of an axis-aligned segment inside a box (its interior, or along its inside). */
function lengthInside(s: Seg, q: RouteBox): number {
  const x0 = Math.max(Math.min(s[0].x, s[1].x), q.minX);
  const x1 = Math.min(Math.max(s[0].x, s[1].x), q.maxX);
  const y0 = Math.max(Math.min(s[0].y, s[1].y), q.minY);
  const y1 = Math.min(Math.max(s[0].y, s[1].y), q.maxY);
  if (x0 > x1 || y0 > y1) return 0;
  const inner = (v: number, lo: number, hi: number) => v > lo && v < hi;
  if (horizontal(s)) return inner(s[0].y, q.minY, q.maxY) ? x1 - x0 : 0;
  if (vertical(s)) return inner(s[0].x, q.minX, q.maxX) ? y1 - y0 : 0;
  return 0;
}
/**
 * Whether segment s is a hop endpoint's straight outward exit across header row h: it starts (or
 * ends) at an endpoint inside the row's band and runs along the row's outward direction, away
 * from the board.
 */
function outwardExit(s: Seg, h: HeaderRow, ends: readonly Point[]): boolean {
  const q = band(h);
  for (const [from, to] of [
    [s[0], s[1]],
    [s[1], s[0]],
  ] as const) {
    if (!ends.some((e) => eq(e, from)) || !inBox(from, q)) continue;
    const dx = Math.sign(to.x - from.x);
    const dy = Math.sign(to.y - from.y);
    if (dx === Math.sign(h.outward.x) && dy === Math.sign(h.outward.y)) return true;
  }
  return false;
}
/**
 * The search's per-step form of `outwardExit`: a grid step lying on an endpoint's outward exit
 * line inside the band (on the endpoint's row, on its outward side). A whole straight exit is
 * made of such steps; pricing only the step that touches the endpoint as exempt would make the
 * search prefer the shortest band crossing instead of the straight exit.
 */
function onExitLine(s: Seg, h: HeaderRow, ends: readonly Point[]): boolean {
  const q = band(h);
  return ends.some((e) => {
    if (!inBox(e, q)) return false;
    return s.every((p) =>
      h.outward.y === 0
        ? p.y === e.y && Math.sign(p.x - e.x) !== -Math.sign(h.outward.x)
        : p.x === e.x && Math.sign(p.y - e.y) !== -Math.sign(h.outward.y),
    );
  });
}

/**
 * Criterion 2: route length inside header-row bands (outward exits of its own pins exempt) and
 * over display faces.
 */
function bandLength(segs: readonly Seg[], obs: RouteObstacles, ends: readonly Point[]): number {
  let n = 0;
  for (const q of obs.boxes) if (q.display) for (const s of segs) n += lengthInside(s, q);
  for (const h of obs.headers ?? []) {
    const q = band(h);
    for (const s of segs) if (!outwardExit(s, h, ends)) n += lengthInside(s, q);
  }
  return n;
}

/** Weights that make the search's additive cost follow the lexicographic order above. */
const W_KEEP = 1e15;
const W_BAND = 1e14; // per grid step inside a header-row band
const W_OVERLAP = 1e13; // per grid step
const W_BODY = 1e11; // per grid step
const W_SHARED = 1e9; // per grid step
const W_TOUCH = 1e7;

/** A crossing of a wire of the hop's own node costs this many bends (criterion 8, s20r). */
const SAME_CROSS = 3;
const W_SAME = SAME_CROSS * 1e3; // SAME_CROSS bends (W_BEND)
const W_TRUNK = 0.5; // per grid step along, or a branch off, a wire of the own node (8b)
const W_HUG = 1e5; // per grid step beside a pin-field point
const W_BEND = 1e3; // a bend or a clean crossing; a grid step of length costs 1
/**
 * Search area: a margin around the endpoints and the bodies it reaches, widened (doubling) while
 * the best route still enters a keep-out or a header band, up to `SEARCH_MARGIN_MAX`; and its largest size.
 */
const SEARCH_MARGIN = 4 * GRID;
const SEARCH_MARGIN_MAX = 32 * GRID;
const SEARCH_MAX_NODES = 60_000;
/** Cell key stride (rt2): cx * CELL_KEY + cy is unique for |cy| < 2^19 lattice steps. */
const CELL_KEY = 1 << 20;
const DIRS: readonly Point[] = [
  { x: GRID, y: 0 },
  { x: 0, y: GRID },
  { x: -GRID, y: 0 },
  { x: 0, y: -GRID },
];

/**
 * Grid search for a hop none of the short shapes routes cleanly (Sprint 10): a least-cost path on
 * the routing grid through `a`, with any number of bends, priced by the same order as `cost`
 * (keep-out, then wire overlap, body, touches, bends and crossings, length). It finds the way
 * around a board's pin field or a dense group of parts. Null when the endpoints are not on one
 * grid lattice or the area is too large; the caller keeps the best short shape then.
 * The result is compared with the short shapes by `cost`, so it is used only when it is better.
 */
function searchRoute(
  a: Point,
  b: Point,
  obs: RouteObstacles,
  margin: number,
  wireNode: string | null = null,
): Point[] | null {
  if ((b.x - a.x) % GRID !== 0 || (b.y - a.y) % GRID !== 0) return null;
  // Area: the endpoints, grown by every body it reaches, plus a margin to go around them.
  let minX = Math.min(a.x, b.x) - margin;
  let maxX = Math.max(a.x, b.x) + margin;
  let minY = Math.min(a.y, b.y) - margin;
  let maxY = Math.max(a.y, b.y) + margin;
  for (let grown = true; grown;) {
    grown = false;
    for (const q of obs.boxes) {
      if (q.maxX < minX || q.minX > maxX || q.maxY < minY || q.minY > maxY) continue;
      const nx0 = Math.min(minX, q.minX - margin);
      const nx1 = Math.max(maxX, q.maxX + margin);
      const ny0 = Math.min(minY, q.minY - margin);
      const ny1 = Math.max(maxY, q.maxY + margin);
      if (nx0 < minX || nx1 > maxX || ny0 < minY || ny1 > maxY) grown = true;
      [minX, maxX, minY, maxY] = [nx0, nx1, ny0, ny1];
    }
  }
  // Lattice through `a`.
  const x0 = a.x - Math.ceil((a.x - minX) / GRID) * GRID;
  const y0 = a.y - Math.ceil((a.y - minY) / GRID) * GRID;
  const nx = Math.floor((maxX - x0) / GRID) + 1;
  const ny = Math.floor((maxY - y0) / GRID) + 1;
  if (nx * ny > SEARCH_MAX_NODES) return null;
  const node = (p: Point) => ((p.y - y0) / GRID) * nx + (p.x - x0) / GRID;
  const at = (n: number): Point => ({ x: x0 + (n % nx) * GRID, y: y0 + Math.floor(n / nx) * GRID });
  const isEnd = (p: Point) => eq(p, a) || eq(p, b);
  const ends = [a, b];
  // Spatial buckets (by nearest lattice node) of keep-out points and wire segments.
  // (Rt2: numeric cell keys and in-place appends; the same buckets in the same order as the
  // former string keys, so every lookup returns the same lists.)
  const key = (cx: number, cy: number) => cx * CELL_KEY + cy;
  const cell = (x: number, y: number) =>
    key(Math.round((x - x0) / GRID), Math.round((y - y0) / GRID));
  const append = <T>(map: Map<number, T[]>, k: number, v: T) => {
    const list = map.get(k);
    if (list) list.push(v);
    else map.set(k, [v]);
  };
  const pointsAt = new Map<number, Point[]>();
  for (const p of obs.points) {
    if (isEnd(p)) continue;
    append(pointsAt, cell(p.x, p.y), p);
  }
  const fieldAt = new Map<number, Point[]>();
  for (const p of obs.field ?? []) {
    if (Math.hypot(p.x - a.x, p.y - a.y) <= GRID || Math.hypot(p.x - b.x, p.y - b.y) <= GRID)
      continue;
    append(fieldAt, cell(p.x, p.y), p);
  }
  const leadsAt = new Map<number, Seg[]>();
  for (const l of obs.leads ?? []) {
    if (isEnd(l[0])) continue;
    for (const q of [l[0], l[1]]) append(leadsAt, cell(q.x, q.y), l);
  }
  const segsAt = new Map<number, Seg[]>();
  // Segments of the hop's own node (s20r): crossing one costs W_SAME; running along or
  // branching off one costs W_TRUNK (criteria 8 and 8b).
  const own = new Set<Seg>();
  if (wireNode !== null)
    obs.segments.forEach((t, i) => obs.segmentNodes?.[i] === wireNode && own.add(t));
  const trunks = own;
  for (const t of obs.segments) {
    const len = Math.abs(t[1].x - t[0].x) + Math.abs(t[1].y - t[0].y);
    const n = Math.max(1, Math.ceil(len / GRID));
    for (let i = 0; i <= n; i++) {
      const k = cell(t[0].x + ((t[1].x - t[0].x) * i) / n, t[0].y + ((t[1].y - t[0].y) * i) / n);
      const list = segsAt.get(k) ?? [];
      if (!list.includes(t)) list.push(t);
      segsAt.set(k, list);
    }
  }
  const near = <T>(map: Map<number, T[]>, p: Point): T[] => {
    const out = new Set<T>();
    const cx = Math.round((p.x - x0) / GRID);
    const cy = Math.round((p.y - y0) / GRID);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const list = map.get(key(cx + i, cy + j));
        if (list) for (const v of list) out.add(v);
      }
    return [...out];
  };
  /** What lies near each lattice node (points, leads, wire segments); memoized. */
  const around: ({ p: Point[]; l: Seg[]; t: Seg[]; f: Point[] } | undefined)[] = [];
  const nearNode = (n: number) =>
    (around[n] ??= {
      p: near(pointsAt, at(n)),
      l: near(leadsAt, at(n)),
      t: near(segsAt, at(n)),
      f: near(fieldAt, at(n)),
    });
  const union = <T>(x: T[], y: T[]): T[] => (y.length ? [...new Set([...x, ...y])] : x);
  // Rt2: only the bodies and header bands that reach the lattice can price a step on it; every
  // other one adds an exact 0 (no closed overlap with any step), so dropping them, in order,
  // changes no sum.
  const lattice: RouteBox = {
    minX: x0,
    minY: y0,
    maxX: x0 + (nx - 1) * GRID,
    maxY: y0 + (ny - 1) * GRID,
  };
  const touches = (q: RouteBox) =>
    q.maxX >= lattice.minX &&
    q.minX <= lattice.maxX &&
    q.maxY >= lattice.minY &&
    q.minY <= lattice.maxY;
  // Per lattice node, the bodies and header bands that can touch a step leaving it (closed
  // overlap with the step's segment, which lies within one grid step of the node), in their
  // original order: the same nonzero terms in the same order as iterating all of them.
  const boxesAt = new Map<number, RouteBox[]>();
  const headersAt = new Map<number, HeaderRow[]>();
  const spread = <T>(map: Map<number, T[]>, q: RouteBox, v: T) => {
    if (!touches(q)) return;
    const i0 = Math.max(0, Math.floor((q.minX - x0) / GRID) - 1);
    const i1 = Math.min(nx - 1, Math.ceil((q.maxX - x0) / GRID) + 1);
    const j0 = Math.max(0, Math.floor((q.minY - y0) / GRID) - 1);
    const j1 = Math.min(ny - 1, Math.ceil((q.maxY - y0) / GRID) + 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) append(map, j * nx + i, v);
  };
  for (const q of obs.boxes) spread(boxesAt, q, q);
  for (const h of obs.headers ?? []) spread(headersAt, band(h), h);
  const NONE: never[] = [];
  const total = nx * ny * 4;
  /** Price of one grid step from lattice node n in direction d (without bends); memoized. */
  const steps = new Float64Array(total).fill(-1);
  const stepCost = (n: number, d: number): number => {
    const memo = steps[n * 4 + d]!;
    if (memo >= 0) return memo;
    const u = at(n);
    const v = { x: u.x + DIRS[d]!.x, y: u.y + DIRS[d]!.y };
    const s: Seg = [u, v];
    let c = 1;
    const nu = nearNode(n);
    const nv = nearNode(node(v));
    for (const p of union(nu.p, nv.p)) if (distance(p, s) < TERMINAL_KEEP_OUT) c += W_KEEP;
    for (const l of union(nu.l, nv.l)) if (segDistance(s, l) < TERMINAL_KEEP_OUT) c += W_KEEP;
    for (const p of union(nu.f, nv.f)) if (beside(p, s)) c += W_HUG;
    for (const h of headersAt.get(n) ?? NONE)
      if (!onExitLine(s, h, ends)) c += (lengthInside(s, band(h)) / GRID) * W_BAND;
    for (const t of union(nu.t, nv.t)) {
      const o = overlapLength(s, t) / GRID;
      c += o * (trunks.has(t) ? W_TRUNK : sharesEnd(t, [a, b]) ? W_SHARED : W_OVERLAP);
      if (crosses(s, t)) c += own.has(t) ? W_SAME : W_BEND;
    }
    for (const q of boxesAt.get(n) ?? NONE)
      c += q.display ? (lengthInside(s, q) / GRID) * W_BAND : (boxLength(s, q) / GRID) * W_BODY;
    steps[n * 4 + d] = c;
    return c;
  };
  /** Wire segments through each lattice node (for crossings and touches); memoized. */
  const through = new Map<number, Seg[]>();
  const segsThrough = (n: number): Seg[] => {
    let list = through.get(n);
    if (!list) {
      const v = at(n);
      list = nearNode(n).t.filter((t) => onSeg(v, t));
      through.set(n, list);
    }
    return list;
  };
  /** Price of passing through lattice node n from direction `din` to `dout`. */
  const turnCost = (n: number, din: number, dout: number): number => {
    let c = din >= 0 && din !== dout ? W_BEND : 0;
    const v = at(n);
    if (isEnd(v)) return c;
    for (const t of segsThrough(n)) {
      const atEnd = eq(v, t[0]) || eq(v, t[1]);
      const perpendicular = vertical(t) ? DIRS[dout]!.y === 0 : DIRS[dout]!.x === 0;
      // Straight through a wire's interior is a clean crossing; anything else meets it (a T).
      if (atEnd || !perpendicular || din !== dout) c += trunks.has(t) ? W_TRUNK : W_TOUCH;
      else c += own.has(t) ? W_SAME : W_BEND;
    }
    return c;
  };
  const dist = new Float64Array(total).fill(Infinity);
  const prev = new Int32Array(total).fill(-1);
  // Binary heap of [cost, state].
  const heap: [number, number][] = [];
  const push = (e: [number, number]) => {
    heap.push(e);
    for (let i = heap.length - 1; i > 0;) {
      const j = (i - 1) >> 1;
      if (heap[j]![0] < e[0] || (heap[j]![0] === e[0] && heap[j]![1] <= e[1])) break;
      heap[i] = heap[j]!;
      heap[j] = e;
      i = j;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        const less = (x: number, y: number) =>
          heap[x]![0] < heap[y]![0] || (heap[x]![0] === heap[y]![0] && heap[x]![1] < heap[y]![1]);
        if (l < heap.length && less(l, m)) m = l;
        if (r < heap.length && less(r, m)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m]!, heap[i]!];
        i = m;
      }
    }
    return top;
  };
  const inArea = (p: Point) =>
    p.x >= x0 && p.y >= y0 && p.x < x0 + nx * GRID && p.y < y0 + ny * GRID;
  // A*: every grid step costs at least 1, so the remaining Manhattan steps never overestimate.
  const h = (n: number) => (Math.abs(at(n).x - b.x) + Math.abs(at(n).y - b.y)) / GRID;
  const goal = node(b);
  const relax = (from: number, n: number, din: number) => {
    const u = at(n);
    for (let d = 0; d < 4; d++) {
      if (din >= 0 && (d + 2) % 4 === din) continue; // no U-turn in place
      const v = { x: u.x + DIRS[d]!.x, y: u.y + DIRS[d]!.y };
      if (!inArea(v)) continue;
      const base = from < 0 ? 0 : dist[from]! + turnCost(n, din, d);
      const c = base + stepCost(n, d);
      const m = node(v);
      const s = m * 4 + d;
      if (c < dist[s]!) {
        dist[s] = c;
        prev[s] = from;
        push([c + h(m), s]);
      }
    }
  };
  relax(-1, node(a), -1);
  let found = -1;
  while (heap.length) {
    const [f, s] = pop();
    const n = s >> 2;
    if (f > dist[s]! + h(n)) continue;
    if (n === goal) {
      found = s;
      break;
    }
    relax(s, n, s & 3);
  }
  if (found < 0) return null;
  const pts: Point[] = [];
  for (let s = found; s >= 0; s = prev[s]!) pts.push(at(s >> 2));
  pts.push(a);
  return orthogonalRoute(pts.reverse());
}

/**
 * How far from a hop's short shapes an obstacle can still price one of them: the widest cost
 * term is the header band (`HEADER_CLEARANCE` beyond the row's box); the pin-field hug reaches one
 * grid step, the keep-out half a step; wire overlap, touches, crossings and bodies need contact.
 */
const SHAPE_REACH = HEADER_CLEARANCE + GRID;

/** The obstacles that can price a short shape of hop a-b (`candidates`), in their order. */
function nearShapes(obs: RouteObstacles, a: Point, b: Point): RouteObstacles {
  const r = CHANNEL_REACH * GRID + SHAPE_REACH;
  const minX = Math.min(a.x, b.x) - r;
  const maxX = Math.max(a.x, b.x) + r;
  const minY = Math.min(a.y, b.y) - r;
  const maxY = Math.max(a.y, b.y) + r;
  const hit = (x0: number, y0: number, x1: number, y1: number) =>
    Math.max(x0, x1) >= minX &&
    Math.min(x0, x1) <= maxX &&
    Math.max(y0, y1) >= minY &&
    Math.min(y0, y1) <= maxY;
  const seg = (t: readonly [Point, Point]) => hit(t[0].x, t[0].y, t[1].x, t[1].y);
  const pt = (p: Point) => hit(p.x, p.y, p.x, p.y);
  const box = (q: RouteBox) => hit(q.minX, q.minY, q.maxX, q.maxY);
  const kept = obs.segments.map(seg);
  return {
    segments: obs.segments.filter((_, i) => kept[i]),
    segmentNodes: obs.segmentNodes?.filter((_, i) => kept[i]),
    boxes: obs.boxes.filter(box),
    points: obs.points.filter(pt),
    leads: (obs.leads ?? []).filter(seg),
    field: (obs.field ?? []).filter(pt),
    headers: (obs.headers ?? []).filter((h) => box(h.box)),
  };
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
export function autoRoute(
  waypoints: readonly Point[],
  obstacles: RouteObstacles,
  options: { search?: boolean; node?: string | null } = {},
): Point[] {
  const search = options.search ?? true;
  const node = options.node ?? null;
  if (waypoints.length < 2) return waypoints.map((p) => ({ ...p }));
  const segments = [...obstacles.segments];
  // Node of each segment (s20r).
  const segmentNodes: (string | null)[] = obstacles.segments.map(
    (_, i) => obstacles.segmentNodes?.[i] ?? null,
  );
  const path: Point[] = [waypoints[0]!];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i]!;
    const b = waypoints[i + 1]!;
    const obs = { ...obstacles, segments, segmentNodes };
    let best: Point[] | null = null;
    let bestCost: number[] = [];
    // Rt2: the short shapes lie within the endpoints' box grown by the channel reach; an obstacle
    // farther than SHAPE_REACH from it adds an exact 0 to every cost term of every shape, so the
    // shapes are priced against the nearer ones only (in their order: the same sums).
    const shapeObs = nearShapes(obs, a, b);
    for (const c of candidates(a, b)) {
      const k = cost(c, shapeObs, [a, b], node);
      if (!best || better(k, bestCost)) {
        best = c;
        bestCost = k;
      }
    }
    // None of the short shapes is clean: search, widening the area while a keep-out remains.
    // Widening stops once keep-out and band are solved, or when a wider area no longer reduces
    // them (a pin boxed in by its neighbours cannot do better however far the search reaches).
    let previous: number[] | null = null;
    for (let m = SEARCH_MARGIN; search && !clean(bestCost) && m <= SEARCH_MARGIN_MAX; m *= 2) {
      const found = searchRoute(a, b, obs, m, node);
      if (!found) break;
      const k = cost(found, obs, [a, b], node);
      if (better(k, bestCost)) {
        best = found;
        bestCost = k;
      }
      if (bestCost[0] === 0 && bestCost[1] === 0) break;
      // (Keep-out is always pursued to the largest area; only a band remainder may stop early.)
      if (previous && k[0] === 0 && !better(k.slice(0, 2), previous.slice(0, 2))) break;
      previous = k;
    }
    for (let j = 0; j < best!.length - 1; j++) {
      segments.push([best![j]!, best![j + 1]!]);
      // The wire's own earlier hops are never a trunk for it (it would double back along itself).
      segmentNodes.push(null);
    }
    path.push(...best!.slice(1));
  }
  // Minimal polyline (merges collinear corners where two hops meet).
  return orthogonalRoute(path);
}

/** The vertices to store for `autoRoute(waypoints, obstacles)`. */
export function autoRouteVertices(
  waypoints: readonly Point[],
  obstacles: RouteObstacles,
  options: { search?: boolean; node?: string | null } = {},
): Point[] {
  return autoRoute(waypoints, obstacles, options).slice(1, -1);
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
  const segmentNodes: string[] = [];
  const nodes = wireNodes(doc);
  for (const w of doc.layout.wires) {
    if (except.has(w.id)) continue;
    const r = wireRoute(doc, w);
    if (!r) continue;
    for (let i = 0; i < r.length - 1; i++) {
      segments.push([r[i]!, r[i + 1]!]);
      segmentNodes.push(nodes.get(w.id)!);
    }
  }
  const points: Point[] = doc.layout.junctions.map((j) => ({ x: j.x, y: j.y }));
  const seen = new Set<string>();
  const add = (p: Point) => {
    const k = `${p.x},${p.y}`;
    if (seen.has(k)) return;
    seen.add(k);
    points.push(p);
  };
  const leads: [Point, Point][] = [];
  const field: Point[] = [];
  const headers: HeaderRow[] = [];
  for (const c of doc.components) {
    for (const t of getTypeDef(c.type)?.terminals ?? []) {
      const p = terminalPosition(doc, c.id, t.id);
      if (p) add(p);
    }
    const placement = doc.layout.components[c.id];
    if (c.type === 'board.esp32_devkitc_wroom32' && placement) {
      const at = (q: Point): Point => {
        const r = rotatePoint(q, placement.rotation);
        return { x: placement.x + r.x, y: placement.y + r.y };
      };
      for (const pin of ESP32_DEVKITC_WROOM32.pins) {
        const pos = boardPinPosition(pin);
        add(at(pos));
        field.push(at(pos));
        // The stub the board draws for the pin (app symbol): from the board edge out to the
        // terminal, or a short stub at the edge for a pin that cannot be wired.
        const edge = pos.x < 0 ? -BOARD_HALF_WIDTH : BOARD_HALF_WIDTH;
        const outer =
          boardTerminalId(pin) !== undefined ? pos.x : edge + Math.sign(pos.x) * BOARD_STUB;
        leads.push([at({ x: outer, y: pos.y }), at({ x: edge, y: pos.y })]);
      }
      // Each header row: its pins and their stubs, from the board edge out to the pin points.
      for (const header of new Set(ESP32_DEVKITC_WROOM32.pins.map((p) => p.header))) {
        const pos = ESP32_DEVKITC_WROOM32.pins
          .filter((p) => p.header === header)
          .map((p) => boardPinPosition(p));
        const side = Math.sign(pos[0]!.x);
        const corners = [
          at({ x: side * BOARD_HALF_WIDTH, y: Math.min(...pos.map((p) => p.y)) }),
          at({ x: pos[0]!.x, y: Math.max(...pos.map((p) => p.y)) }),
        ];
        const out = rotatePoint({ x: side, y: 0 }, placement.rotation);
        headers.push({
          box: {
            minX: Math.min(corners[0]!.x, corners[1]!.x),
            minY: Math.min(corners[0]!.y, corners[1]!.y),
            maxX: Math.max(corners[0]!.x, corners[1]!.x),
            maxY: Math.max(corners[0]!.y, corners[1]!.y),
          },
          outward: { x: Math.round(out.x), y: Math.round(out.y) },
        });
      }
    }
  }
  return { segments, boxes, points, leads, field, headers, segmentNodes };
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
    // Automatic wires are routed canonically (`routeAutoWires`), never patched from their old route.
    if (!wire || wire.auto || isContact(out, wire)) continue;
    const route = wireRoute(out, wire);
    if (!route || route.length < 2) continue;
    const obs = routeObstacles(out, boxes, new Set([id]));
    const ends = [route[0]!, route[route.length - 1]!];
    const node = wireNodes(out).get(id) ?? null;
    const now = cost(route, obs, ends, node);
    if (clean(now)) continue;
    let best: Point[] | null = null;
    let bestCost = now;
    for (const waypoints of [[ends[0]!, ...wire.vertices, ends[1]!], ends]) {
      const candidate = autoRoute(waypoints, obs, { node });
      const k = cost(candidate, obs, ends, node);
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

/** Wire ids in creation order (W1, W2, ..., W10): numeric, then textual. */
const byCreation = (a: Wire, b: Wire) => {
  // A total order (review minor): `W<n>` by n, any other id after them, then by id text.
  const n = (w: Wire) => Number(/^W(\d+)$/.exec(w.id)?.[1] ?? Infinity);
  const na = n(a);
  const nb = n(b);
  if (na !== nb) return na < nb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Wire routing integrity (2026-10-22): the CANONICAL route of every automatic wire (schema
 * `Wire.auto`), recomputed from scratch from the current layout, never from its previous route.
 *
 * Root cause this replaces: a wire's route was chosen once, when it was drawn, and stored as
 * ordinary vertices; a later move kept them (and `rerouteWires` reused them as if the user had
 * placed them), so detours accumulated across drags and moving a part back did not restore the
 * drawing. Now an automatic wire's drawing is a pure function of:
 *   - the component bodies and terminals (the caller's `boxes`, the document's positions),
 *   - every MANUAL wire (fixed geometry, an obstacle for all automatic wires),
 *   - the automatic wires created BEFORE it (creation order, `W1` < `W2` < ...): each is routed
 *     against the ones before it exactly as when it was drawn,
 *   - its own ends and the user's waypoints (in order).
 * So identical geometry and constraints give identical routes, and moving a part back restores
 * the drawing it had there. Endpoints never change: connectivity and nets cannot either.
 * Direct contacts (no route) are skipped. Returns the same document when nothing changes.
 */
export function routeAutoWires(
  doc: ProjectDocument,
  boxes: readonly RouteBox[],
  preview?: { only: ReadonlySet<string> },
): ProjectDocument {
  // PREVIEW (a drag in progress, bounded for interactivity): only the given wires, by the short
  // shapes alone (no grid search). Never committed: the drop routes canonically.
  const autos = doc.layout.wires
    .filter((w) => w.auto && !isContact(doc, w) && (!preview || preview.only.has(w.id)))
    .sort(byCreation);
  if (autos.length === 0) return doc;
  // Electrical nodes never change while routing (routes are geometry only).
  const nodes = wireNodes(doc);
  let best = routeInOrder(doc, autos, boxes, nodes, !preview);
  if (preview) return best;
  // Sprint 20 (s20r, owner report): wires of ONE node that still cross each other. Each is
  // routed against the wires before it, so an earlier wire can wall in a later one's pin (two
  // pins side by side on one node: the first wire goes round the second pin). The order is then
  // changed deterministically, as a function of the document only (never of history): the later
  // wire of each such pair is routed just before the earlier one; the result is kept when it has
  // fewer same-node crossings, then fewer crossings, then fewer bends. A few rounds at most.
  const ids = new Set(autos.map((w) => w.id));
  let order = autos;
  let score = orderScore(best, ids);
  for (let round = 0; round < 3 && score[0]! > 0; round++) {
    const next = [...order];
    for (const c of sameNodeCrossings(best)) {
      if (!ids.has(c.over) || !ids.has(c.under) || c.over === c.under) continue;
      const i = next.findIndex((w) => w.id === c.over);
      const j = next.findIndex((w) => w.id === c.under);
      const [early, late] = i < j ? [i, j] : [j, i];
      const [w] = next.splice(late, 1);
      next.splice(early, 0, w!);
    }
    if (next.every((w, k) => w === order[k])) break;
    const routed = routeInOrder(doc, next, boxes, nodes, true);
    const k = orderScore(routed, ids);
    if (!better(k, score)) break;
    best = routed;
    score = k;
    order = next;
  }
  return best;
}

/** Same-node crossings, crossings (hops) and bends of the automatic wires `ids` (s20r). */
function orderScore(doc: ProjectDocument, ids: ReadonlySet<string>): number[] {
  const involves = (c: WireCrossing) => ids.has(c.over) || ids.has(c.under);
  let bends = 0;
  for (const w of doc.layout.wires) if (ids.has(w.id)) bends += w.vertices.length;
  return [
    sameNodeCrossings(doc).filter(involves).length,
    wireCrossings(doc).filter(involves).length,
    bends,
  ];
}

/** Route the automatic wires `autos` in this order, each against the ones before it. */
function routeInOrder(
  doc: ProjectDocument,
  autos: readonly Wire[],
  boxes: readonly RouteBox[],
  nodes: ReadonlyMap<string, string>,
  search: boolean,
): ProjectDocument {
  const pending = new Set(autos.map((w) => w.id));
  let out = doc;
  for (const wire of autos) {
    const ends = wireRoute(out, { ...wire, vertices: [] });
    if (!ends || ends.length < 1) {
      pending.delete(wire.id);
      continue;
    }
    const a = ends[0]!;
    const b = ends[ends.length - 1]!;
    // Obstacles: everything but this wire and the automatic wires after it.
    const obs = routeObstacles(out, boxes, pending);
    const vertices = autoRouteVertices([a, ...wire.auto!.waypoints, b], obs, {
      search,
      node: nodes.get(wire.id) ?? null,
    });
    pending.delete(wire.id);
    const current = out.layout.wires.find((w) => w.id === wire.id)!;
    if (JSON.stringify(current.vertices) === JSON.stringify(vertices)) continue;
    out = {
      ...out,
      layout: {
        ...out.layout,
        wires: out.layout.wires.map((w): Wire => (w.id === wire.id ? { ...w, vertices } : w)),
      },
    };
  }
  return out;
}

/**
 * Repair stored wires that break the visual invariant (Sprint 10): a wire whose stored route
 * enters an unrelated terminal's keep-out or a header-row band (criteria 1 and 2) reads as
 * attached to something it is not connected to. Such a wire, typically drawn before these rules
 * existed, is re-routed (`rerouteWires`). Every other wire keeps its stored route exactly, so
 * drawings are not churned by softer preferences.
 *
 * Presentation only: endpoints never change, so connectivity and nets cannot change. Returns
 * the same document when nothing needs repair.
 */
export function repairWireRoutes(
  doc: ProjectDocument,
  boxes: readonly RouteBox[],
): ProjectDocument {
  const broken = doc.layout.wires.filter((w) => {
    if (w.auto || isContact(doc, w)) return false;
    const route = wireRoute(doc, w);
    if (!route || route.length < 2) return false;
    const k = cost(route, routeObstacles(doc, boxes, new Set([w.id])), [
      route[0]!,
      route[route.length - 1]!,
    ]);
    return k[0]! > 0 || k[1]! > 0;
  });
  return broken.length
    ? rerouteWires(
        doc,
        broken.map((w) => w.id),
        boxes,
      )
    : doc;
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
