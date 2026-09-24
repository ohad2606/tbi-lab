/**
 * Editing operations over a project document.
 *
 * Every operation is pure: it returns a new document (the input is never mutated) that is
 * structurally valid, with nets re-settled. Operations that cannot be applied return an
 * `EditError` code instead of guessing. Revision metadata is NOT touched here; the
 * persistence layer stamps revisions when a change is written (project.ts `stampRevision`).
 */

import { CATALOG, defaultParams, getTypeDef } from './catalog.js';
import {
  GRID,
  endPosition,
  locateOnWire,
  nextRotation,
  orthogonalRoute,
  snap,
  snapPoint,
  wireRoute,
} from './layout.js';
import { nodeKey, nodeNets, settleNets } from './nets.js';
import { allocateId } from './project.js';
import {
  cloneDocument,
  type ComponentTypeId,
  type ParamValue,
  type Point,
  type ProjectDocument,
  type Wire,
  type WireEnd,
} from './schema.js';

export type EditError =
  | 'unknown_component'
  | 'unknown_type'
  | 'unknown_terminal'
  | 'unknown_wire'
  | 'unknown_junction'
  | 'unknown_net'
  | 'unknown_param'
  | 'param_type'
  | 'out_of_range'
  | 'not_on_wire'
  | 'same_endpoint'
  | 'name_empty';

export type EditResult<T = object> =
  ({ ok: true; doc: ProjectDocument } & T) | { ok: false; error: EditError };

export interface Selection {
  components: string[];
  wires: string[];
  junctions: string[];
}

export const emptySelection = (): Selection => ({ components: [], wires: [], junctions: [] });

/** Run a mutation on a clone and settle nets, keeping net ids stable. */
function transact(
  doc: ProjectDocument,
  mutate: (draft: ProjectDocument) => EditError | void,
): EditResult {
  const previous = nodeNets(doc);
  const draft = cloneDocument(doc);
  const error = mutate(draft);
  if (error) return { ok: false, error };
  cleanupJunctions(draft);
  settleNets(draft, previous);
  return { ok: true, doc: draft };
}

// ---------------------------------------------------------------------------------------------
// Components

export function addComponent(
  doc: ProjectDocument,
  type: ComponentTypeId,
  at: Point,
): EditResult<{ id: string }> {
  const def = getTypeDef(type);
  if (!def) return { ok: false, error: 'unknown_type' };
  let id = '';
  const r = transact(doc, (d) => {
    id = allocateId(d, def.refPrefix);
    d.components.push({ id, type, typeVersion: def.typeVersion, params: defaultParams(def) });
    const p = snapPoint(at);
    d.layout.components[id] = { x: p.x, y: p.y, rotation: 0 };
  });
  return r.ok ? { ...r, id } : r;
}

/** Move components, junctions and the waypoints of selected wires by a grid-snapped offset. */
export function moveSelection(doc: ProjectDocument, sel: Selection, delta: Point): EditResult {
  const d = snapPoint(delta);
  return transact(doc, (draft) => {
    for (const id of sel.components) {
      const p = draft.layout.components[id];
      if (!p) return 'unknown_component';
      p.x += d.x;
      p.y += d.y;
    }
    for (const id of sel.junctions) {
      const j = draft.layout.junctions.find((x) => x.id === id);
      if (!j) return 'unknown_junction';
      j.x += d.x;
      j.y += d.y;
    }
    for (const id of sel.wires) {
      const w = draft.layout.wires.find((x) => x.id === id);
      if (!w) return 'unknown_wire';
      w.vertices = w.vertices.map((v) => ({ x: v.x + d.x, y: v.y + d.y }));
    }
  });
}

/** Rotate each component 90° clockwise about its own origin; attached wires follow. */
export function rotateComponents(doc: ProjectDocument, ids: string[]): EditResult {
  return transact(doc, (draft) => {
    for (const id of ids) {
      const p = draft.layout.components[id];
      if (!p) return 'unknown_component';
      p.rotation = nextRotation(p.rotation);
    }
  });
}

export function setParam(
  doc: ProjectDocument,
  componentId: string,
  key: string,
  value: ParamValue,
): EditResult {
  return transact(doc, (draft) => {
    const c = draft.components.find((x) => x.id === componentId);
    if (!c) return 'unknown_component';
    const def = CATALOG[c.type].params.find((p) => p.key === key);
    if (!def) return 'unknown_param';
    if (def.kind === 'boolean') {
      if (typeof value !== 'boolean') return 'param_type';
    } else if (def.kind === 'enum') {
      if (typeof value !== 'string') return 'param_type';
      if (!def.options.some((o) => o.value === value)) return 'out_of_range';
    } else {
      if (typeof value !== 'object' || value.unit !== def.unit) return 'param_type';
      if (!Number.isFinite(value.value) || value.value < def.min || value.value > def.max) {
        return 'out_of_range';
      }
    }
    c.params[key] = typeof value === 'object' ? { value: value.value, unit: value.unit } : value;
  });
}

export function renameProject(doc: ProjectDocument, name: string): EditResult {
  const trimmed = name.trim();
  if (trimmed === '') return { ok: false, error: 'name_empty' };
  // User-authored text is stored exactly as entered (apart from surrounding whitespace).
  return { ok: true, doc: { ...cloneDocument(doc), name: trimmed } };
}

/** Set or clear a net's user-authored name, stored verbatim and never translated. */
export function renameNet(
  doc: ProjectDocument,
  netId: string,
  userName: string | null,
): EditResult {
  if (!doc.nets.some((n) => n.id === netId)) return { ok: false, error: 'unknown_net' };
  const draft = cloneDocument(doc);
  const name = userName === null || userName.trim() === '' ? null : userName;
  draft.nets = draft.nets.map((n) => (n.id === netId ? { ...n, userName: name } : n));
  return { ok: true, doc: draft };
}

// ---------------------------------------------------------------------------------------------
// Deletion

/**
 * Delete components, wires and junctions. A component takes the wires that terminate on it
 * with it; a junction takes its wires. Junctions left with fewer than three wires are then
 * dissolved, and nets are re-settled: no dangling reference can remain.
 */
export function deleteSelection(doc: ProjectDocument, sel: Selection): EditResult {
  return transact(doc, (draft) => {
    const comps = new Set(sel.components);
    const juncs = new Set(sel.junctions);
    const wires = new Set(sel.wires);
    const touches = (e: WireEnd) =>
      (e.kind === 'terminal' && comps.has(e.component)) ||
      (e.kind === 'junction' && juncs.has(e.junction));
    draft.layout.wires = draft.layout.wires.filter(
      (w) => !wires.has(w.id) && !touches(w.from) && !touches(w.to),
    );
    draft.layout.junctions = draft.layout.junctions.filter((j) => !juncs.has(j.id));
    draft.components = draft.components.filter((c) => !comps.has(c.id));
    for (const id of comps) delete draft.layout.components[id];
  });
}

// ---------------------------------------------------------------------------------------------
// Wiring

/** Where a new wire starts or ends: an existing endpoint, or a point on an existing wire. */
export type WireTarget = WireEnd | { kind: 'wire'; wire: string; at: Point };

/**
 * Draw a wire between two targets through optional waypoints. Ending on an existing wire
 * splits it and creates a junction there; wires that merely cross are never connected.
 */
export function addWire(
  doc: ProjectDocument,
  from: WireTarget,
  to: WireTarget,
  vertices: Point[] = [],
): EditResult<{ id: string }> {
  let id = '';
  const r = transact(doc, (draft) => {
    const a = resolveTarget(draft, from);
    if (typeof a === 'string') return a;
    const b = resolveTarget(draft, to);
    if (typeof b === 'string') return b;
    if (nodeKey(a) === nodeKey(b)) return 'same_endpoint';
    id = allocateId(draft, 'W');
    draft.layout.wires.push({ id, from: a, to: b, vertices: vertices.map(snapPoint) });
  });
  return r.ok ? { ...r, id } : r;
}

/**
 * Drag one straight segment of a wire's drawn route perpendicular to itself (Sprint 5).
 *
 * `segment` indexes the wire's minimal orthogonal route (`wireRoute`). A horizontal segment
 * moves by `delta.y`, a vertical one by `delta.x` (snapped to the grid); the other component of
 * `delta` is ignored. The wire's ENDPOINTS never move: dragging a segment that touches a
 * terminal or junction inserts a short jog so the end stays exactly where it was. The resulting
 * bends become the wire's stored vertices. Connectivity and nets are unchanged, so this is a
 * layout edit (allowed while running, undoable like any move).
 */
export function moveWireSegment(
  doc: ProjectDocument,
  wireId: string,
  segment: number,
  delta: Point,
): EditResult {
  return transact(doc, (draft) => {
    const wire = draft.layout.wires.find((w) => w.id === wireId);
    if (!wire) return 'unknown_wire';
    const route = wireRoute(draft, wire);
    if (!route || !Number.isInteger(segment) || segment < 0 || segment >= route.length - 1) {
      return 'not_on_wire';
    }
    const a = route[segment]!;
    const b = route[segment + 1]!;
    const horizontal = a.y === b.y;
    const d = snap(horizontal ? delta.y : delta.x);
    if (d === 0) return;
    const shift = (p: Point): Point =>
      horizontal ? { x: p.x, y: p.y + d } : { x: p.x + d, y: p.y };
    const last = route.length - 1;
    const pts: Point[] = [route[0]!];
    if (segment === 0) pts.push(shift(route[0]!)); // jog out of the fixed start
    for (let i = 1; i < last; i++) {
      pts.push(i === segment || i === segment + 1 ? shift(route[i]!) : route[i]!);
    }
    if (segment === last - 1) pts.push(shift(route[last]!)); // jog into the fixed end
    pts.push(route[last]!);
    // Consecutive points are axis-aligned, so the orthogonal route through them is exactly
    // this polyline; the minimal form drops points made redundant by the move.
    wire.vertices = orthogonalRoute(pts).slice(1, -1);
  });
}

function resolveTarget(doc: ProjectDocument, t: WireTarget): WireEnd | EditError {
  if (t.kind === 'terminal') {
    const c = doc.components.find((x) => x.id === t.component);
    if (!c) return 'unknown_component';
    if (!CATALOG[c.type].terminals.some((x) => x.id === t.terminal)) return 'unknown_terminal';
    return { kind: 'terminal', component: t.component, terminal: t.terminal };
  }
  if (t.kind === 'junction') {
    return doc.layout.junctions.some((j) => j.id === t.junction)
      ? { kind: 'junction', junction: t.junction }
      : 'unknown_junction';
  }
  return splitWire(doc, t.wire, snapPoint(t.at));
}

/** Split a wire at a point on its route, returning the endpoint that now sits there. */
function splitWire(doc: ProjectDocument, wireId: string, at: Point): WireEnd | EditError {
  const wire = doc.layout.wires.find((w) => w.id === wireId);
  if (!wire) return 'unknown_wire';
  for (const end of [wire.from, wire.to]) {
    const p = endPosition(doc, end);
    if (p && p.x === at.x && p.y === at.y) return end;
  }
  const loc = locateOnWire(doc, wire, at);
  if (!loc) return 'not_on_wire';
  const junction = { id: allocateId(doc, 'J'), x: at.x, y: at.y };
  doc.layout.junctions.push(junction);
  const jEnd: WireEnd = { kind: 'junction', junction: junction.id };
  const tail: Wire = {
    id: allocateId(doc, 'W'),
    from: jEnd,
    to: wire.to,
    vertices: wire.vertices.slice(loc.hop),
  };
  wire.to = jEnd;
  wire.vertices = wire.vertices.slice(0, loc.hop);
  doc.layout.wires.push(tail);
  return jEnd;
}

// ---------------------------------------------------------------------------------------------
// Junction maintenance

function attached(doc: ProjectDocument, junctionId: string): Wire[] {
  return doc.layout.wires.filter(
    (w) =>
      (w.from.kind === 'junction' && w.from.junction === junctionId) ||
      (w.to.kind === 'junction' && w.to.junction === junctionId),
  );
}

/**
 * A junction exists only where three or more wires meet. With two it is dissolved and its
 * wires joined into one (same drawn path); with one, the dead-end stub goes with it; with
 * none, it is removed. Repeats until stable, since each step can change a neighbour.
 */
export function cleanupJunctions(doc: ProjectDocument): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const j of [...doc.layout.junctions]) {
      const wires = attached(doc, j.id);
      const isJ = (e: WireEnd) => e.kind === 'junction' && e.junction === j.id;
      const degree = wires.reduce((n, w) => n + (isJ(w.from) ? 1 : 0) + (isJ(w.to) ? 1 : 0), 0);
      if (degree >= 3) continue;
      changed = true;
      // Join before removing the junction: the joined path is computed through its position.
      const joined = wires.length === 2 ? joinAt(doc, wires[0]!, wires[1]!, j.id) : undefined;
      doc.layout.junctions = doc.layout.junctions.filter((x) => x.id !== j.id);
      const ids = new Set(wires.map((w) => w.id));
      if (wires.length === 2) {
        doc.layout.wires = doc.layout.wires.filter((w) => !ids.has(w.id) || w === wires[0]);
        if (joined) Object.assign(wires[0]!, joined);
        else doc.layout.wires = doc.layout.wires.filter((w) => w !== wires[0]);
      } else {
        doc.layout.wires = doc.layout.wires.filter((w) => !ids.has(w.id));
      }
      break;
    }
  }
}

/** The drawn path of `w` oriented so it ends at junction `jId`. */
function pathEndingAt(doc: ProjectDocument, w: Wire, jId: string): Point[] | undefined {
  const route = wireRoute(doc, w);
  if (!route) return undefined;
  return w.to.kind === 'junction' && w.to.junction === jId ? route : route.reverse();
}

function joinAt(doc: ProjectDocument, a: Wire, b: Wire, jId: string): Wire | undefined {
  const isJ = (e: WireEnd) => e.kind === 'junction' && e.junction === jId;
  const aFar = isJ(a.to) ? a.from : a.to;
  const bFar = isJ(b.to) ? b.from : b.to;
  if (nodeKey(aFar) === nodeKey(bFar)) return undefined; // the join would be a closed loop
  const pa = pathEndingAt(doc, a, jId);
  const pb = pathEndingAt(doc, b, jId)?.reverse();
  if (!pa || !pb) return undefined;
  // Every corner of the original paths becomes a waypoint, so the drawing is unchanged.
  const vertices = [...pa.slice(1), ...pb.slice(1, -1)];
  return { id: a.id, from: aFar, to: bFar, vertices };
}

export { GRID };
