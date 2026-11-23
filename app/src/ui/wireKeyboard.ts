/**
 * Keyboard wiring (A11Y-002, TBI-001 slice 1): pure logic, no DOM.
 *
 * `candidateTargets` orders the pins a wire can be drawn to from a source pin; `reduceWireKeyboard`
 * is the small state machine idle -> pins -> wiring(candidate) -> commit/cancel. A commit calls the
 * SAME domain edit as the pointer (`addWire`), so the netlist is identical for both input methods.
 * Presentation (announcements, focus) lives in Canvas and the i18n keys `kbwire.*`.
 */
import {
  CATALOG,
  GRID,
  addWire,
  connectivity,
  endPosition,
  nodeKey,
  pinKey,
  reconnectWire,
  terminalPosition,
  type EditError,
  type PinRef,
  type Point,
  type ProjectDocument,
  type WireEnd,
} from '@tbi-lab/domain';

/** Why a candidate deserves a warning; presentation localises it. Never hides the candidate. */
export type CandidateHint = 'ground_supply' | 'supply_supply';

export interface Candidate {
  pin: PinRef;
  /** Distance from the source pin on the canvas, in world units. */
  distance: number;
  hint?: CandidateHint;
}

export interface CandidateOptions {
  /** Cap on the list (default: all). */
  limit?: number;
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
      const cand: Candidate = { pin, distance: Math.hypot(p.x - origin.x, p.y - origin.y) };
      const a = fromNode ? kindOf.get(fromNode) : undefined;
      const b = node ? kindOf.get(node) : undefined;
      if (a && b) {
        if ((a === 'ground' && b === 'supply') || (a === 'supply' && b === 'ground'))
          cand.hint = 'ground_supply';
        else if (a === 'supply' && b === 'supply') cand.hint = 'supply_supply';
      }
      out.push(cand);
    }
  }
  out.sort(
    (x, y) =>
      x.distance - y.distance ||
      (x.pin.component < y.pin.component ? -1 : x.pin.component > y.pin.component ? 1 : 0) ||
      (x.pin.terminal < y.pin.terminal ? -1 : x.pin.terminal > y.pin.terminal ? 1 : 0),
  );
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
    list = candidateTargets(without, { component: fixed.component, terminal: fixed.terminal });
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
    const k = nodeKey({ kind: 'terminal', ...c.pin });
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
  | { kind: 'done'; from: PinRef; to: PinRef }
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
        const to = state.candidates[state.index]!.pin;
        const fixed = state.side === 'from' ? w.to : w.from;
        const a = endPosition(ctx.doc, fixed);
        const b = terminalPosition(ctx.doc, to.component, to.terminal);
        const vertices = a && b && ctx.route ? ctx.route(a, b).vertices : [];
        const r = reconnectWire(
          ctx.doc,
          w.id,
          state.side,
          { kind: 'terminal', ...to },
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
      const to = state.candidates[state.index]!.pin;
      const a = terminalPosition(ctx.doc, state.from.component, state.from.terminal);
      const b = terminalPosition(ctx.doc, to.component, to.terminal);
      const vertices = a && b && ctx.route ? ctx.route(a, b).vertices : [];
      const r = addWire(
        ctx.doc,
        { kind: 'terminal', ...state.from },
        { kind: 'terminal', ...to },
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
