/**
 * Keyboard wiring (A11Y-002, TBI-001 slices 1-5): pure logic, no DOM.
 *
 * `candidateTargets` orders the targets a wire can be drawn to from a source pin (pins, and since
 * slice 5 existing junctions and points on other wires); `reduceWireKeyboard`
 * is the small state machine idle -> pins -> wiring(candidate) -> commit/cancel. A commit calls the
 * SAME domain edit as the pointer (`addWire`), so the netlist is identical for both input methods.
 * Presentation (announcements, focus) lives in Canvas and the i18n keys `kbwire.*`.
 */
import {
  CATALOG,
  GRID,
  GROUND_NODE,
  addWire,
  connectivity,
  endPosition,
  locateOnWire,
  nodeKey,
  nodeNets,
  pinKey,
  reconnectWire,
  snap,
  terminalPosition,
  wireGroups,
  wireRoute,
  type EditError,
  type PinRef,
  type Point,
  type ProjectDocument,
  type WireEnd,
} from '@tbi-lab/domain';

/** Why a candidate deserves a warning; presentation localises it. Never hides the candidate. */
export type CandidateHint = 'ground_supply' | 'supply_supply';

/**
 * Where a keyboard wire can end (slice 5 adds the T-connection kinds). Exactly the domain's
 * `WireTarget`: a pin, an existing junction, or a grid point strictly inside another wire's
 * route (`addWire` splits that wire there and creates the junction, as for a pointer click).
 */
export type CandidateTarget =
  | { kind: 'terminal'; component: string; terminal: string }
  | { kind: 'junction'; junction: string }
  | { kind: 'wire'; wire: string; at: Point };

export interface Candidate {
  target: CandidateTarget;
  /** Set when the target is a pin (same object shape as before slice 5). */
  pin?: PinRef;
  /** Canvas position of the target (the split point for a wire). */
  pos: Point;
  /** Distance from the source pin on the canvas, in world units. */
  distance: number;
  hint?: CandidateHint;
}

export interface CandidateOptions {
  /** Cap on the list (default: all). */
  limit?: number;
  /** Pins only, no junction / wire-body targets (re-pick, slice 4, stays pin-only). */
  pinsOnly?: boolean;
}

const samePin = (a: PinRef, b: PinRef) => a.component === b.component && a.terminal === b.terminal;

/** Terminal ids of a component in catalog order. */
export function pinsOf(doc: ProjectDocument, componentId: string): PinRef[] {
  const c = doc.components.find((x) => x.id === componentId);
  if (!c) return [];
  return CATALOG[c.type].terminals.map((t) => ({ component: c.id, terminal: t.id }));
}

export function candidateTargets(
  doc: ProjectDocument,
  from: PinRef,
  opts: CandidateOptions = {},
): Candidate[] {
  const origin = terminalPosition(doc, from.component, from.terminal);
  if (!origin) return [];
  return rankPins(doc, origin, from, opts);
}

const KIND_RANK = { terminal: 0, junction: 1, wire: 2 } as const;
const targetId = (t: CandidateTarget): [string, string] =>
  t.kind === 'terminal'
    ? [t.component, t.terminal]
    : t.kind === 'junction'
      ? [t.junction, '']
      : [t.wire, ''];
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The grid point of `route` nearest to `origin` that lies strictly inside it (never on either
 * end: that is the end's own pin or junction, offered separately). Undefined for a route with no
 * interior grid point or one drawn off the grid (`addWire` snaps the point, so it would miss).
 */
export function interiorPointNear(route: readonly Point[], origin: Point): Point | undefined {
  if (route.length < 2) return undefined;
  const first = route[0]!;
  const last = route[route.length - 1]!;
  const isEnd = (p: Point) =>
    (p.x === first.x && p.y === first.y) || (p.x === last.x && p.y === last.y);
  let best: Point | undefined;
  let bestD = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    const horizontal = a.y === b.y;
    const fixed = horizontal ? a.y : a.x;
    if (snap(fixed) !== fixed) continue;
    const lo = Math.ceil(Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y) / GRID) * GRID;
    const hi = Math.floor(Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y) / GRID) * GRID;
    if (lo > hi) continue;
    const want = clampN(snap(horizontal ? origin.x : origin.y), lo, hi);
    // The nearest grid value, or the next one inwards when that is a route end.
    for (const v of [want, want + GRID, want - GRID]) {
      if (v < lo || v > hi) continue;
      const q = horizontal ? { x: v + 0, y: fixed } : { x: fixed, y: v + 0 };
      if (isEnd(q)) continue;
      const d = Math.hypot(q.x - origin.x, q.y - origin.y);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
      break;
    }
  }
  return best;
}
const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** `from` is the source pin (excluded with everything joined to it); undefined for a junction
 *  source, where only the position orders the pins. */
function rankPins(
  doc: ProjectDocument,
  origin: Point,
  from: PinRef | undefined,
  opts: CandidateOptions,
): Candidate[] {
  const g = connectivity(doc);
  const fromNode = from ? g.nodeOf.get(pinKey(from.component, from.terminal)) : undefined;
  const kindOf = new Map(g.nodes.map((n) => [n.id, n.kind]));
  const hintFor = (node: string | undefined): CandidateHint | undefined => {
    const a = fromNode ? kindOf.get(fromNode) : undefined;
    const b = node ? kindOf.get(node) : undefined;
    if (!a || !b) return undefined;
    if ((a === 'ground' && b === 'supply') || (a === 'supply' && b === 'ground'))
      return 'ground_supply';
    if (a === 'supply' && b === 'supply') return 'supply_supply';
    return undefined;
  };

  // Pins already joined to the source: directly by a wire, or on its electrical node.
  const joined = new Set<string>();
  for (const w of doc.layout.wires) {
    if (w.from.kind !== 'terminal' || w.to.kind !== 'terminal') continue;
    const a = { component: w.from.component, terminal: w.from.terminal };
    const b = { component: w.to.component, terminal: w.to.terminal };
    if (!from) break;
    if (samePin(a, from)) joined.add(pinKey(b.component, b.terminal));
    if (samePin(b, from)) joined.add(pinKey(a.component, a.terminal));
  }

  const out: Candidate[] = [];
  const dist = (p: Point) => Math.hypot(p.x - origin.x, p.y - origin.y);
  for (const c of doc.components) {
    for (const t of CATALOG[c.type].terminals) {
      const pin = { component: c.id, terminal: t.id };
      if (from && samePin(pin, from)) continue;
      const key = pinKey(c.id, t.id);
      if (joined.has(key)) continue;
      const node = g.nodeOf.get(key);
      if (fromNode && node === fromNode) continue;
      const p = terminalPosition(doc, c.id, t.id);
      if (!p) continue;
      const cand: Candidate = {
        target: { kind: 'terminal', ...pin },
        pin,
        pos: p,
        distance: dist(p),
      };
      const hint = hintFor(node);
      if (hint) cand.hint = hint;
      out.push(cand);
    }
  }

  if (from && !opts.pinsOnly) {
    // Slice 5: T-connections. Wire-graph group (same wires) and electrical node of every end;
    // a junction or wire on the source's group or node is already joined to it.
    const groupOf = new Map<string, number>();
    wireGroups(doc).forEach((grp, i) => grp.forEach((k) => groupOf.set(k, i)));
    const netOf = nodeNets(doc);
    const groundNets = new Set(doc.nets.filter((n) => n.role === 'ground').map((n) => n.id));
    const nodeOfEnd = (end: WireEnd) => {
      const net = netOf.get(nodeKey(end));
      return net === undefined ? undefined : groundNets.has(net) ? GROUND_NODE : net;
    };
    const fromEnd: WireEnd = { kind: 'terminal', ...from };
    const fromGroup = groupOf.get(nodeKey(fromEnd));
    const onSource = (end: WireEnd) => {
      const grp = groupOf.get(nodeKey(end));
      if (fromGroup !== undefined && grp === fromGroup) return true;
      const node = nodeOfEnd(end);
      return fromNode !== undefined && node === fromNode;
    };
    for (const j of doc.layout.junctions) {
      const end: WireEnd = { kind: 'junction', junction: j.id };
      if (onSource(end)) continue;
      const pos = { x: j.x, y: j.y };
      const cand: Candidate = {
        target: { kind: 'junction', junction: j.id },
        pos,
        distance: dist(pos),
      };
      const hint = hintFor(nodeOfEnd(end));
      if (hint) cand.hint = hint;
      out.push(cand);
    }
    for (const w of doc.layout.wires) {
      if (onSource(w.from)) continue;
      const route = wireRoute(doc, w);
      const at = route && interiorPointNear(route, origin);
      if (!at || !locateOnWire(doc, w, at)) continue;
      const d = dist(at);
      if (d === 0) continue;
      const cand: Candidate = { target: { kind: 'wire', wire: w.id, at }, pos: at, distance: d };
      const hint = hintFor(nodeOfEnd(w.from));
      if (hint) cand.hint = hint;
      out.push(cand);
    }
  }

  out.sort((x, y) => {
    const [xa, xb] = targetId(x.target);
    const [ya, yb] = targetId(y.target);
    return (
      x.distance - y.distance ||
      KIND_RANK[x.target.kind] - KIND_RANK[y.target.kind] ||
      cmp(xa, ya) ||
      cmp(xb, yb)
    );
  });
  return opts.limit === undefined ? out : out.slice(0, opts.limit);
}

/** Distance in grid cells, rounded, for announcements. */
export const distanceCells = (distance: number) => Math.max(1, Math.round(distance / GRID));

// ---------------------------------------------------------------------------------------------
// Re-pick an endpoint (TBI-001 slice 4)

export type WireSide = 'from' | 'to';

/**
 * Candidate pins for the moving `side` of a wire: the same ordering and hints as creation
 * (`candidateTargets`), computed as if the wire were not there (so pins that are on the fixed
 * end's net only THROUGH this wire stay offered). The pin the side already has is not offered.
 * Undefined when the wire does not exist.
 */
export function reconnectCandidates(
  doc: ProjectDocument,
  wireId: string,
  side: WireSide,
): Candidate[] | undefined {
  const wire = doc.layout.wires.find((w) => w.id === wireId);
  if (!wire) return undefined;
  const fixed = side === 'from' ? wire.to : wire.from;
  const moving = side === 'from' ? wire.from : wire.to;
  const without: ProjectDocument = {
    ...doc,
    layout: { ...doc.layout, wires: doc.layout.wires.filter((w) => w.id !== wireId) },
  };
  let list: Candidate[];
  if (fixed.kind === 'terminal') {
    list = candidateTargets(
      without,
      { component: fixed.component, terminal: fixed.terminal },
      { pinsOnly: true },
    );
  } else {
    const origin = endPosition(without, fixed);
    list = origin ? rankPins(without, origin, undefined, {}) : [];
  }
  // Another wire already joining the fixed end and a pin would be a refused duplicate.
  const twins = new Set(
    without.layout.wires.flatMap((w) =>
      nodeKey(w.from) === nodeKey(fixed) && w.to.kind === 'terminal'
        ? [nodeKey(w.to)]
        : nodeKey(w.to) === nodeKey(fixed) && w.from.kind === 'terminal'
          ? [nodeKey(w.from)]
          : [],
    ),
  );
  return list.filter((c) => {
    if (c.target.kind !== 'terminal') return false;
    const k = nodeKey(c.target);
    return !twins.has(k) && !(moving.kind === 'terminal' && nodeKey(moving) === k);
  });
}

// ---------------------------------------------------------------------------------------------
// State machine

export type WireKbState =
  | { mode: 'idle' }
  | { mode: 'pins'; component: string; index: number }
  | { mode: 'wiring'; from: PinRef; candidates: Candidate[]; index: number }
  // Re-pick (slice 4): choosing which end of the selected wire to move, then its new target.
  | { mode: 'ends'; wire: string; side: WireSide }
  | { mode: 'repick'; wire: string; side: WireSide; candidates: Candidate[]; index: number };

export type WireKbAction =
  | { type: 'enterPins'; component: string }
  | { type: 'movePin'; delta: number }
  | { type: 'start' }
  | { type: 'cycle'; delta: number }
  | { type: 'commit' }
  | { type: 'cancel' }
  | { type: 'repickStart'; wire: string }
  /** Move the end highlight to the other end (Tab). */
  | { type: 'repickToggle' }
  /** Choose an end: `side` (keys 1/2), or the highlighted one when omitted (Enter). */
  | { type: 'repickChoose'; side?: WireSide };

export interface WireKbContext {
  doc: ProjectDocument;
  /** True while the simulation runs: wiring is refused, as for the pointer. */
  running: boolean;
  /** Router for the new wire's stored vertices (default: none). */
  route?: (from: Point, to: Point) => { vertices: Point[] };
}

/** What happened, for the announcer. `pin` is the pin the event is about. */
export type WireKbEvent =
  | { kind: 'pins'; pin: PinRef; count: number }
  | { kind: 'pin'; pin: PinRef }
  | { kind: 'start'; pin: PinRef }
  | { kind: 'candidate'; candidate: Candidate; n: number; total: number }
  | { kind: 'done'; from: PinRef; to: CandidateTarget }
  | { kind: 'cancel' }
  | { kind: 'refused'; reason: EditError }
  | { kind: 'running' }
  | { kind: 'noTargets'; pin: PinRef }
  | { kind: 'repickEnds'; wire: string; from: WireEnd; to: WireEnd }
  | { kind: 'repickSide'; side: WireSide; end: WireEnd }
  | { kind: 'repickStart'; wire: string; side: WireSide; end: WireEnd }
  | { kind: 'repickNoTargets'; wire: string; side: WireSide }
  | { kind: 'repickDone'; wire: string; from: WireEnd; to: WireEnd }
  | { kind: 'repickCancel'; wire: string };

export interface WireKbResult {
  state: WireKbState;
  /** The edited document, only on a successful commit. */
  doc?: ProjectDocument;
  event?: WireKbEvent;
}

const wrap = (i: number, n: number) => ((i % n) + n) % n;

export function reduceWireKeyboard(
  state: WireKbState,
  action: WireKbAction,
  ctx: WireKbContext,
): WireKbResult {
  switch (action.type) {
    case 'enterPins': {
      const pins = pinsOf(ctx.doc, action.component);
      if (!pins.length) return { state };
      return {
        state: { mode: 'pins', component: action.component, index: 0 },
        event: { kind: 'pins', pin: pins[0]!, count: pins.length },
      };
    }
    case 'movePin': {
      if (state.mode !== 'pins') return { state };
      const pins = pinsOf(ctx.doc, state.component);
      if (!pins.length) return { state: { mode: 'idle' } };
      const index = wrap(state.index + action.delta, pins.length);
      return { state: { ...state, index }, event: { kind: 'pin', pin: pins[index]! } };
    }
    case 'start': {
      if (state.mode !== 'pins') return { state };
      if (ctx.running) return { state, event: { kind: 'running' } };
      const from = pinsOf(ctx.doc, state.component)[state.index];
      if (!from) return { state: { mode: 'idle' } };
      const candidates = candidateTargets(ctx.doc, from);
      if (!candidates.length) return { state, event: { kind: 'noTargets', pin: from } };
      return {
        state: { mode: 'wiring', from, candidates, index: 0 },
        event: { kind: 'start', pin: from },
      };
    }
    case 'cycle': {
      if (state.mode !== 'wiring' && state.mode !== 'repick') return { state };
      const index = wrap(state.index + action.delta, state.candidates.length);
      return {
        state: { ...state, index },
        event: {
          kind: 'candidate',
          candidate: state.candidates[index]!,
          n: index + 1,
          total: state.candidates.length,
        },
      };
    }
    case 'commit': {
      if (state.mode === 'repick') {
        if (ctx.running) return { state, event: { kind: 'running' } };
        const w = ctx.doc.layout.wires.find((x) => x.id === state.wire);
        if (!w) return { state: { mode: 'idle' } };
        const cand = state.candidates[state.index]!;
        const fixed = state.side === 'from' ? w.to : w.from;
        const a = endPosition(ctx.doc, fixed);
        const b = cand.pos;
        const vertices = a && b && ctx.route ? ctx.route(a, b).vertices : [];
        const r = reconnectWire(
          ctx.doc,
          w.id,
          state.side,
          cand.target,
          // The router's route runs from the fixed end to the new one; stored order is from->to.
          state.side === 'from' ? [...vertices].reverse() : vertices,
        );
        if (!r.ok) return { state, event: { kind: 'refused', reason: r.error } };
        const nw = r.doc.layout.wires.find((x) => x.id === w.id) ?? w;
        return {
          state: { mode: 'idle' },
          doc: r.doc,
          event: { kind: 'repickDone', wire: w.id, from: nw.from, to: nw.to },
        };
      }
      if (state.mode !== 'wiring') return { state };
      if (ctx.running) return { state, event: { kind: 'running' } };
      // Slice 5: `to` may be a junction or a point on a wire; `addWire` is the pointer's call.
      const to = state.candidates[state.index]!.target;
      const a = terminalPosition(ctx.doc, state.from.component, state.from.terminal);
      const b = state.candidates[state.index]!.pos;
      const vertices = a && ctx.route ? ctx.route(a, b).vertices : [];
      const r = addWire(
        ctx.doc,
        { kind: 'terminal', ...state.from },
        to,
        vertices,
        ctx.route ? { waypoints: [] } : undefined,
      );
      if (!r.ok) return { state, event: { kind: 'refused', reason: r.error } };
      return {
        state: {
          mode: 'pins',
          component: state.from.component,
          index: pinsOf(ctx.doc, state.from.component).findIndex(
            (p) => p.terminal === state.from.terminal,
          ),
        },
        doc: r.doc,
        event: { kind: 'done', from: state.from, to },
      };
    }
    case 'cancel':
      if (state.mode === 'idle') return { state };
      if (state.mode === 'ends' || state.mode === 'repick')
        return { state: { mode: 'idle' }, event: { kind: 'repickCancel', wire: state.wire } };
      return { state: { mode: 'idle' }, event: { kind: 'cancel' } };
    case 'repickStart': {
      if (state.mode !== 'idle') return { state };
      if (ctx.running) return { state, event: { kind: 'running' } };
      const w = ctx.doc.layout.wires.find((x) => x.id === action.wire);
      if (!w) return { state };
      return {
        state: { mode: 'ends', wire: w.id, side: 'from' },
        event: { kind: 'repickEnds', wire: w.id, from: w.from, to: w.to },
      };
    }
    case 'repickToggle': {
      if (state.mode !== 'ends') return { state };
      const w = ctx.doc.layout.wires.find((x) => x.id === state.wire);
      if (!w) return { state: { mode: 'idle' } };
      const side: WireSide = state.side === 'from' ? 'to' : 'from';
      return { state: { ...state, side }, event: { kind: 'repickSide', side, end: w[side] } };
    }
    case 'repickChoose': {
      if (state.mode !== 'ends') return { state };
      if (ctx.running) return { state, event: { kind: 'running' } };
      const side = action.side ?? state.side;
      const w = ctx.doc.layout.wires.find((x) => x.id === state.wire);
      if (!w) return { state: { mode: 'idle' } };
      const candidates = reconnectCandidates(ctx.doc, w.id, side) ?? [];
      if (!candidates.length)
        return { state: { ...state, side }, event: { kind: 'repickNoTargets', wire: w.id, side } };
      return {
        state: { mode: 'repick', wire: w.id, side, candidates, index: 0 },
        event: { kind: 'repickStart', wire: w.id, side, end: w[side] },
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Wire selection by keyboard (TBI-001 slice 2). Pure: order is document order (a new wire is
// appended, so existing positions never shift when wires are added).

export interface WireStep {
  /** Wire id now selected. */
  id: string;
  /** 1-based position and total, for "Wire n of total". */
  n: number;
  total: number;
}

/** Next (delta 1) / previous (delta -1) wire, wrapping. With no (or a stale) current wire, next
 *  starts at the first and previous at the last. Undefined when the document has no wires. */
export function stepWireSelection(
  doc: ProjectDocument,
  current: string | undefined,
  delta: 1 | -1,
): WireStep | undefined {
  const wires = doc.layout.wires;
  if (!wires.length) return undefined;
  const at = current === undefined ? -1 : wires.findIndex((w) => w.id === current);
  const index = at < 0 ? (delta > 0 ? 0 : wires.length - 1) : wrap(at + delta, wires.length);
  return { id: wires[index]!.id, n: index + 1, total: wires.length };
}

/** 1-based position of a wire in the stable order (0 when absent). */
export const wirePosition = (doc: ProjectDocument, id: string) =>
  doc.layout.wires.findIndex((w) => w.id === id) + 1;

/** The subset of KeyboardEvent the wire-selection key match needs (pure, testable). */
export interface BracketKeyEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  getModifierState?: (k: string) => boolean;
}

/**
 * Maps a key event to a wire-selection step: ']' -> +1 (next), '[' -> -1 (previous), else null.
 * Semantics follow the TYPED character (`key`), so AltGr layouts (German: AltGr+8 types '[') work
 * and on a layout where the physical BracketLeft key types ']' (Hebrew) that key selects "next".
 * `code` is only a fallback when `key` is not a single printable character (e.g. 'Dead',
 * 'Unidentified'); a printable key such as 'ü' on the physical bracket key is rejected.
 * Ctrl/Meta/Alt and Shift are rejected, except the Ctrl+Alt pair the OS reports for AltGr.
 */
export function wireBracketStep(e: BracketKeyEvent): 1 | -1 | null {
  if (e.metaKey || e.shiftKey) return null;
  const altGr = e.ctrlKey && e.altKey && e.getModifierState?.('AltGraph') === true;
  if ((e.ctrlKey || e.altKey) && !altGr) return null;
  if (e.key === '[') return -1;
  if (e.key === ']') return 1;
  if ([...e.key].length === 1) return null;
  if (e.code === 'BracketLeft') return -1;
  if (e.code === 'BracketRight') return 1;
  return null;
}

/**
 * While choosing the end / the new target (slice 4) these keys must not fall through to the
 * wire-selection, wiring-start, re-pick-start or delete handlers (they would leave stale kb state).
 * Ctrl/Meta/Alt combinations (undo, redo) are not swallowed; the mode resets when the document changes.
 */
export function repickSwallowsKey(e: BracketKeyEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return (
    wireBracketStep(e) !== null ||
    e.key === 'Delete' ||
    e.key === 'Backspace' ||
    e.code === 'KeyW' ||
    e.code === 'KeyE'
  );
}

/**
 * True when a re-pick in progress no longer applies: the simulation runs, the wire is gone, the
 * document changed since the mode started (edit, undo, redo) or the selection is no longer exactly
 * that wire.
 */
export function repickIsStale(
  wire: string,
  doc: ProjectDocument,
  startDoc: ProjectDocument,
  running: boolean,
  selection: {
    wires: readonly string[];
    components: readonly string[];
    junctions: readonly string[];
  },
): boolean {
  return (
    running ||
    doc !== startDoc ||
    !doc.layout.wires.some((w) => w.id === wire) ||
    selection.wires.length !== 1 ||
    selection.wires[0] !== wire ||
    selection.components.length > 0 ||
    selection.junctions.length > 0
  );
}

// Wires list (TBI-001 slice 3): the same stable document order as `stepWireSelection`.
export interface WireListEntry {
  id: string;
  /** 1-based position, shown as "W{n}". */
  n: number;
  from: string;
  to: string;
}

/** One entry per wire in document order; `endName` renders an endpoint (pin or junction). */
export function wireListEntries(
  doc: ProjectDocument,
  endName: (end: ProjectDocument['layout']['wires'][number]['from']) => string,
): WireListEntry[] {
  return doc.layout.wires.map((w, i) => ({
    id: w.id,
    n: i + 1,
    from: endName(w.from),
    to: endName(w.to),
  }));
}

/**
 * How far to move the camera (world units) so that `pos` lies at least `margin` inside the visible
 * area (`viewW` x `viewH` world units, top-left at `camera`). Zero on an axis that is already
 * inside. When the view is smaller than twice the margin the point is centred on that axis.
 */
export function panIntoView(
  camera: { x: number; y: number },
  view: { w: number; h: number },
  pos: { x: number; y: number },
  margin: number,
): { dx: number; dy: number } {
  const axis = (p: number, c: number, len: number): number => {
    if (len <= 2 * margin) return p - (c + len / 2);
    if (p < c + margin) return p - c - margin;
    if (p > c + len - margin) return p - c - len + margin;
    return 0;
  };
  return { dx: axis(pos.x, camera.x, view.w), dy: axis(pos.y, camera.y, view.h) };
}
