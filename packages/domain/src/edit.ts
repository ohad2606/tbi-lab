/**
 * Editing operations over a project document.
 *
 * Every operation is pure: it returns a new document (the input is never mutated) that is
 * structurally valid, with nets re-settled. Operations that cannot be applied return an
 * `EditError` code instead of guessing. Revision metadata is NOT touched here; the
 * persistence layer stamps revisions when a change is written (project.ts `stampRevision`).
 */

import { CATALOG, defaultParams, getTypeDef, onStep } from './catalog.js';
import {
  GRID,
  endPosition,
  locateOnWire,
  nextRotation,
  orthogonalRoute,
  pointOnSegment,
  snap,
  snapPoint,
  wireRoute,
} from './layout.js';
import { isContact, settleContacts } from './contacts.js';
import { nodeKey, nodeNets, settleNets } from './nets.js';
import { starterProgram, starterSourceFor, profileById, utf8Length } from './program.js';
import { allocateId } from './project.js';
import {
  cloneDocument,
  WIRE_COLORS,
  type ComponentTypeId,
  type ParamValue,
  type Point,
  type ProjectDocument,
  type Wire,
  type WireColor,
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
  /** Sprint POT-UNITS: a quantity off its parameter's resolution grid (catalog `step`). */
  | 'off_grid'
  /** Sprint 25: a value outside the part's standard table (catalog `values`). */
  | 'not_standard'
  | 'not_on_wire'
  | 'same_endpoint'
  | 'name_empty'
  | 'no_program'
  | 'source_too_large'
  | 'source_invalid'
  /** Sprint 19B: no programming environment of that id for the board. */
  | 'unknown_profile';

export type EditResult<T = object> =
  ({ ok: true; doc: ProjectDocument } & T) | { ok: false; error: EditError };

export interface Selection {
  components: string[];
  wires: string[];
  junctions: string[];
}

export const emptySelection = (): Selection => ({ components: [], wires: [], junctions: [] });

/**
 * Run a mutation on a clone and settle nets, keeping net ids stable. `placed` names the
 * components the mutation added, moved or rotated: their terminals make and break direct
 * contacts (contacts.ts) before the nets are settled.
 */
function transact(
  doc: ProjectDocument,
  mutate: (draft: ProjectDocument) => EditError | void,
  placed: () => Iterable<string> = () => [],
): EditResult {
  const previous = nodeNets(doc);
  const draft = cloneDocument(doc);
  const error = mutate(draft);
  if (error) return { ok: false, error };
  settleContacts(doc, draft, placed());
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
  const r = transact(
    doc,
    (d) => {
      id = allocateId(d, def.refPrefix);
      d.components.push({ id, type, typeVersion: def.typeVersion, params: defaultParams(def) });
      // A programmable board starts with its environment's starter program (Sprint 7). V1 has at
      // most one program per project (D-S7-1); a second board gets none (it cannot run anyway).
      const program = starterProgram(type);
      if (program && Object.keys(d.programs).length === 0) d.programs[id] = program;
      const p = snapPoint(at);
      d.layout.components[id] = { x: p.x, y: p.y, rotation: 0 };
    },
    () => [id],
  );
  return r.ok ? { ...r, id } : r;
}

/** Move components, junctions and the waypoints of selected wires by a grid-snapped offset. */
export function moveSelection(doc: ProjectDocument, sel: Selection, delta: Point): EditResult {
  const d = snapPoint(delta);
  return transact(
    doc,
    (draft) => {
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
        // An automatic wire's constraints move with it (its route is recomputed from them).
        if (w.auto)
          w.auto.waypoints = w.auto.waypoints.map((v) => ({ x: v.x + d.x, y: v.y + d.y }));
      }
    },
    () => (d.x || d.y ? sel.components : []),
  );
}

/** Rotate each component 90° clockwise about its own origin; attached wires follow. */
export function rotateComponents(doc: ProjectDocument, ids: string[]): EditResult {
  return transact(
    doc,
    (draft) => {
      for (const id of ids) {
        const p = draft.layout.components[id];
        if (!p) return 'unknown_component';
        p.rotation = nextRotation(p.rotation);
      }
    },
    () => ids,
  );
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
      if (!onStep(def, value.value)) return 'off_grid';
      if (def.values && !def.values.includes(value.value)) return 'not_standard';
    }
    // An optional parameter set back to its default is removed (stored only when it differs).
    if (def.kind === 'enum' && def.optional && value === def.default) delete c.params[key];
    else
      c.params[key] = typeof value === 'object' ? { value: value.value, unit: value.unit } : value;
  });
}

/**
 * Set a wire's colour, or clear it (`null`: automatic, from its net). Presentation only: the
 * wire's ends, route and the nets are unchanged.
 */
export function setWireColor(
  doc: ProjectDocument,
  wireId: string,
  color: WireColor | null,
): EditResult {
  if (color !== null && !(WIRE_COLORS as readonly string[]).includes(color))
    return { ok: false, error: 'out_of_range' };
  const draft = cloneDocument(doc);
  const w = draft.layout.wires.find((x) => x.id === wireId);
  if (!w) return { ok: false, error: 'unknown_wire' };
  if (color === null) delete w.color;
  else w.color = color;
  return { ok: true, doc: draft };
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
    for (const id of comps) {
      delete draft.layout.components[id];
      delete draft.programs[id]; // a board's program goes with the board
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Programs (Sprint 7)

/**
 * Make a board run its own program (instead of a reference image), creating the environment's
 * starter program if it has none. V1 keeps one program per project.
 */
export function useBoardProgram(doc: ProjectDocument, boardId: string): EditResult {
  const board = doc.components.find((c) => c.id === boardId);
  if (!board) return { ok: false, error: 'unknown_component' };
  const program = doc.programs[boardId] ?? starterProgram(board.type);
  if (!program) return { ok: false, error: 'no_program' };
  if (!doc.programs[boardId] && Object.keys(doc.programs).length > 0)
    return { ok: false, error: 'no_program' };
  return transact(doc, (d) => {
    d.components.find((c) => c.id === boardId)!.params.firmware = 'program';
    d.programs[boardId] = program;
  });
}

/**
 * Sprint 19B: switch a board's program to another programming environment of its board (Arduino
 * C++ or MicroPython). The program becomes that environment's starter: source in one language is
 * never translated into another. The caller confirms with the user before discarding edited code;
 * the edit is undoable like any other.
 */
export function setProgramProfile(
  doc: ProjectDocument,
  boardId: string,
  profileId: string,
): EditResult {
  const program = doc.programs[boardId];
  const board = doc.components.find((c) => c.id === boardId);
  if (!program || !board) return { ok: false, error: 'no_program' };
  const profile = profileById(profileId);
  if (!profile || profile.board !== board.type) return { ok: false, error: 'unknown_profile' };
  if (program.profile === profileId) return { ok: true, doc };
  return transact(doc, (d) => {
    d.programs[boardId] = {
      language: profile.language,
      profile: profile.id,
      fileName: profile.fileName,
      text: starterSourceFor(profile.language),
    };
  });
}

/**
 * Replace a board's program source text exactly (no normalisation of any kind). A program edit
 * never changes the loaded circuit: it is allowed while a session runs and never reaches it.
 */
export function setProgramText(doc: ProjectDocument, boardId: string, text: string): EditResult {
  const program = doc.programs[boardId];
  if (!program) return { ok: false, error: 'no_program' };
  if (text.includes('\u0000')) return { ok: false, error: 'source_invalid' };
  const profile = profileById(program.profile);
  if (profile && utf8Length(text) > profile.maxSourceBytes)
    return { ok: false, error: 'source_too_large' };
  if (program.text === text) return { ok: true, doc };
  const draft = cloneDocument(doc);
  draft.programs[boardId] = { ...program, text };
  return { ok: true, doc: draft };
}

// ---------------------------------------------------------------------------------------------
// Wiring

/** Where a new wire starts or ends: an existing endpoint, or a point on an existing wire. */
export type WireTarget = WireEnd | { kind: 'wire'; wire: string; at: Point };

/**
 * Draw a wire between two targets through optional waypoints. Ending on an existing wire
 * splits it and creates a junction there; wires that merely cross are never connected.
 *
 * With `auto` the wire is AUTOMATIC (schema `Wire.auto`): `auto.waypoints` are the points the user
 * placed while drawing it, and `vertices` the router's current route through them.
 */
export function addWire(
  doc: ProjectDocument,
  from: WireTarget,
  to: WireTarget,
  vertices: Point[] = [],
  auto?: { waypoints: Point[] },
): EditResult<{ id: string }> {
  let id = '';
  const r = transact(doc, (draft) => {
    const a = resolveTarget(draft, from);
    if (typeof a === 'string') return a;
    const b = resolveTarget(draft, to);
    if (typeof b === 'string') return b;
    if (nodeKey(a) === nodeKey(b)) return 'same_endpoint';
    id = allocateId(draft, 'W');
    draft.layout.wires.push({
      id,
      from: a,
      to: b,
      vertices: vertices.map(snapPoint),
      ...(auto ? { auto: { waypoints: auto.waypoints.map(snapPoint) } } : {}),
    });
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
    // The user shaped this wire by hand: from now on it is MANUAL (its geometry is kept as drawn).
    delete wire.auto;
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
  // An automatic wire stays automatic on both sides; each side keeps the user's waypoints on its
  // own part of the route (in order along it).
  const route = wireRoute(doc, wire) ?? [];
  const along = (p: Point) => routeDistance(route, p);
  const cut = along(at);
  const tail: Wire = {
    id: allocateId(doc, 'W'),
    from: jEnd,
    to: wire.to,
    vertices: wire.vertices.slice(loc.hop),
    // A wire the user coloured stays that colour on both sides of the new junction.
    ...(wire.color ? { color: wire.color } : {}),
    ...(wire.auto
      ? { auto: { waypoints: wire.auto.waypoints.filter((p) => along(p) > cut) } }
      : {}),
  };
  if (wire.auto) wire.auto = { waypoints: wire.auto.waypoints.filter((p) => along(p) < cut) };
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
        if (joined) {
          if (!joined.auto) delete wires[0]!.auto;
          Object.assign(wires[0]!, joined);
        } else doc.layout.wires = doc.layout.wires.filter((w) => w !== wires[0]);
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
  // A join with an automatic side stays automatic (review 3: never freeze router output as user
  // geometry): an automatic side contributes its waypoints, a manual side its corners (the user's
  // own geometry, kept as constraints). Two manual sides give a manual wire, unchanged.
  if (a.auto || b.auto) {
    const corners = (w: Wire, path: Point[]) => (w.auto ? null : path.slice(1, -1));
    const wa = a.auto
      ? isJ(a.to)
        ? a.auto.waypoints
        : [...a.auto.waypoints].reverse()
      : corners(a, pa)!;
    const wb = b.auto
      ? isJ(b.from)
        ? b.auto.waypoints
        : [...b.auto.waypoints].reverse()
      : corners(b, pb)!;
    return { id: a.id, from: aFar, to: bFar, vertices, auto: { waypoints: [...wa, ...wb] } };
  }
  const joined: Wire = { id: a.id, from: aFar, to: bFar, vertices };
  return joined;
}

/** Distance along a route (polyline) to point p on it; Infinity when p is not on it. */
function routeDistance(route: readonly Point[], p: Point): number {
  let d = 0;
  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    if (pointOnSegment(p, a, b)) return d + Math.abs(p.x - a.x) + Math.abs(p.y - a.y);
    d += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
  }
  return Infinity;
}

/**
 * Wire routing integrity: make the given wires AUTOMATIC (an explicit user action, "Route
 * automatically"): their bends are dropped and from now on the router draws them, recomputed after
 * every layout change. Connectivity is unchanged. Contacts (no route) are skipped.
 */
export function makeWiresAutomatic(doc: ProjectDocument, wireIds: readonly string[]): EditResult {
  return transact(doc, (draft) => {
    for (const id of wireIds) {
      const w = draft.layout.wires.find((x) => x.id === id);
      if (!w) return 'unknown_wire';
      // A contact has no route; an automatic wire keeps its waypoints (review minor).
      if (w.auto || isContact(draft, w)) continue;
      w.auto = { waypoints: [] };
      w.vertices = [];
    }
  });
}

export { GRID };
