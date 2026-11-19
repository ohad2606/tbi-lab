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
  pinKey,
  terminalPosition,
  type EditError,
  type PinRef,
  type Point,
  type ProjectDocument,
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
  const g = connectivity(doc);
  const fromNode = g.nodeOf.get(pinKey(from.component, from.terminal));
  const kindOf = new Map(g.nodes.map((n) => [n.id, n.kind]));

  // Pins already joined to the source: directly by a wire, or on its electrical node.
  const joined = new Set<string>();
  for (const w of doc.layout.wires) {
    if (w.from.kind !== 'terminal' || w.to.kind !== 'terminal') continue;
    const a = { component: w.from.component, terminal: w.from.terminal };
    const b = { component: w.to.component, terminal: w.to.terminal };
    if (samePin(a, from)) joined.add(pinKey(b.component, b.terminal));
    if (samePin(b, from)) joined.add(pinKey(a.component, a.terminal));
  }

  const out: Candidate[] = [];
  for (const c of doc.components) {
    for (const t of CATALOG[c.type].terminals) {
      const pin = { component: c.id, terminal: t.id };
      if (samePin(pin, from)) continue;
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
// State machine

export type WireKbState =
  | { mode: 'idle' }
  | { mode: 'pins'; component: string; index: number }
  | { mode: 'wiring'; from: PinRef; candidates: Candidate[]; index: number };

export type WireKbAction =
  | { type: 'enterPins'; component: string }
  | { type: 'movePin'; delta: number }
  | { type: 'start' }
  | { type: 'cycle'; delta: number }
  | { type: 'commit' }
  | { type: 'cancel' };

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
  | { kind: 'noTargets'; pin: PinRef };

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
      if (state.mode !== 'wiring') return { state };
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
      return { state: { mode: 'idle' }, event: { kind: 'cancel' } };
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
