/**
 * 3D scene description (Sprint 9, D-S9-3): a pure, deterministic function of the project
 * document. No WebGL here: the renderer turns this description into meshes, and unit tests
 * check it directly.
 *
 * Mapping (the 2D circuit layout is the single source of placement; nothing is placed twice):
 * - plan position: X = layout x, Z = layout y (both × SCALE); the layout's clockwise rotation
 *   becomes a rotation about the vertical axis;
 * - elevation is derived: the base plane at Y = 0, every part standing on it (its model knows
 *   its own height), wires lifted slightly above the plane so they read clearly;
 * - wires follow their 2D routes, coloured by ELECTRICAL NODE (ground black, a supply rail red,
 *   other nodes from a fixed palette), so the 3D view shows connectivity, not just geometry.
 *
 * Visual detail derived from design values (resistor colour bands, LED colour, switch position)
 * is presentation only; nothing here ever feeds the simulation.
 */

import {
  CATALOG,
  ESP32_DEVKITC_WROOM32,
  GROUND_NODE,
  boardPinPosition,
  connectivity,
  contacts,
  nodeKey,
  rotatePoint,
  terminalPosition,
  touchingUnconnected,
  wireGroups,
  wireRoute,
  type ComponentTypeId,
  type Point,
  type ProjectDocument,
  type Quantity,
} from '@tbi-lab/domain';

/** Scene units per schematic unit (a 20-unit grid step is 2 scene units). */
export const SCALE = 0.1;

export type ModelKey =
  | 'board.esp32_devkitc'
  | 'resistor.axial'
  | 'led.5mm'
  | 'diode.axial'
  | 'switch.tactile'
  | 'switch.toggle'
  | 'ground.post'
  | 'instrument.psu'
  | 'generic';

/** Which model draws each component type. A type without an entry gets the generic box. */
export const MODEL_FOR: Partial<Record<ComponentTypeId, ModelKey>> = {
  'board.esp32_devkitc_wroom32': 'board.esp32_devkitc',
  'component.resistor': 'resistor.axial',
  'component.led': 'led.5mm',
  'component.diode': 'diode.axial',
  'component.push_button': 'switch.tactile',
  'component.toggle_switch': 'switch.toggle',
  'component.ground': 'ground.post',
  'instrument.lab_psu': 'instrument.psu',
};

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SceneTerminal {
  id: string;
  /** Plan position of the terminal (where its lead or wire attaches). */
  x: number;
  z: number;
  /** Node it belongs to, or null when unwired. */
  node: string | null;
  /**
   * Set when another part's terminal sits on this one WITHOUT a connection: the model stops its
   * lead short of the terminal, so touching leads never read as joined.
   */
  open?: true;
}

export interface SceneComponent {
  id: string;
  type: ComponentTypeId;
  model: ModelKey;
  /** Plan position of the component origin. */
  x: number;
  z: number;
  /** Rotation about the vertical axis, radians (layout clockwise = negative about +Y). */
  rotationY: number;
  /** Layout rotation in degrees, for models that care about their local axes. */
  rotation: 0 | 90 | 180 | 270;
  terminals: SceneTerminal[];
  /** Presentation details derived from design values. */
  visual: {
    /** Resistor colour code (digit/multiplier/tolerance colour names), or null if the value has no exact 4- or 5-band code. */
    bands?: string[] | null;
    /** LED lens colour (CSS colour). */
    ledColor?: string;
    /** Toggle switch position (the persisted parameter). */
    closed?: boolean;
  };
}

export interface SceneWire {
  id: string;
  node: string | null;
  color: string;
  /** Polyline in scene space, from the first end to the second. */
  points: Vec3[];
}

/**
 * A point where terminals meet. `contact`: a direct terminal-to-terminal connection in the
 * project (drawn as a solder joint). `open`: terminals that touch but are NOT connected (drawn
 * as a gap with a not-connected mark).
 */
export interface SceneJoint {
  kind: 'contact' | 'open';
  x: number;
  z: number;
  /** Terminal height there (the highest of the parts that meet). */
  y: number;
  /** Pin keys `component:terminal` that meet here. */
  terminals: string[];
  /** The node of a contact; null for an open joint. */
  node: string | null;
}

export interface SceneDescription {
  components: SceneComponent[];
  wires: SceneWire[];
  joints: SceneJoint[];
  /** Base plane rectangle (plan). */
  base: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Bounding box of the content, for fitting the camera. */
  bounds: { min: Vec3; max: Vec3 };
}

/** Height (Y) at which a part's terminals take wires. */
export const TERMINAL_HEIGHT: Record<ModelKey, number> = {
  'board.esp32_devkitc': 1.1,
  'resistor.axial': 0.25,
  'led.5mm': 0.25,
  'diode.axial': 0.25,
  'switch.tactile': 0.25,
  'switch.toggle': 0.25,
  'ground.post': 1.0,
  'instrument.psu': 1.6,
  generic: 0.25,
};

/** Model heights, for bounds and labels (the renderer's models stay within them). */
export const MODEL_HEIGHT: Record<ModelKey, number> = {
  'board.esp32_devkitc': 1.6,
  'resistor.axial': 1.3,
  'led.5mm': 4.1,
  'diode.axial': 1.2,
  'switch.tactile': 1.7,
  'switch.toggle': 2.6,
  'ground.post': 1.3,
  'instrument.psu': 4.2,
  generic: 1.5,
};

/**
 * Wire levels above the plane. One level step (0.45) is well over a wire's diameter (0.28), so
 * wires at different levels visibly pass over one another.
 */
const WIRE_HEIGHTS = [0.7, 1.15, 1.6];
/** Radius of a wire tube (the renderer draws wires at this radius). */
export const WIRE_RADIUS = 0.14;
const GROUND_COLOR = '#202326';
const SUPPLY_COLOR = '#d32f2f';
/** Signal wire colours, in the order nodes are first met (no red or black: those mean ±). */
const SIGNAL_COLORS = ['#ef7d17', '#1e88e5', '#43a047', '#8e24aa', '#f9a825', '#00897b', '#6d4c41'];

const COLOR_CODE = [
  'black',
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'violet',
  'grey',
  'white',
];
const MULTIPLIER: Record<number, string> = {
  [-2]: 'silver',
  [-1]: 'gold',
  0: 'black',
  1: 'brown',
  2: 'red',
  3: 'orange',
  4: 'yellow',
  5: 'green',
  6: 'blue',
  7: 'violet',
  8: 'grey',
  9: 'white',
};

/**
 * The resistor colour code for an exact resistance: 4 bands (2 digits, multiplier, gold 5 %) if
 * two significant digits express it exactly, else 5 bands (3 digits, multiplier, brown 1 %), else
 * null — no band is ever invented for a value the code cannot express.
 */
export function resistorBands(ohms: number): string[] | null {
  if (!(ohms > 0) || !Number.isFinite(ohms)) return null;
  for (const digits of [2, 3]) {
    for (let m = -2; m <= 9; m++) {
      const sig = ohms / 10 ** m;
      const rounded = Math.round(sig);
      if (rounded < 10 ** (digits - 1) || rounded >= 10 ** digits) continue;
      if (Math.abs(sig - rounded) > 1e-9 * Math.max(1, sig)) continue;
      const ds = String(rounded)
        .split('')
        .map((d) => COLOR_CODE[Number(d)]!);
      return [...ds, MULTIPLIER[m]!, digits === 2 ? 'gold' : 'brown'];
    }
  }
  return null;
}

/** Lens colour of each curated LED model (its datasheet colour). */
const LED_COLORS: Record<string, string> = { 'model.led.vishay_tlhr5400': '#e53935' };

export function deriveScene(doc: ProjectDocument): SceneDescription {
  const g = connectivity(doc);
  const nodeColor = new Map<string, string>();
  let signal = 0;
  for (const n of g.nodes)
    nodeColor.set(
      n.id,
      n.id === GROUND_NODE
        ? GROUND_COLOR
        : n.kind === 'supply'
          ? SUPPLY_COLOR
          : SIGNAL_COLORS[signal++ % SIGNAL_COLORS.length]!,
    );

  const components: SceneComponent[] = [];
  for (const c of doc.components) {
    const placement = doc.layout.components[c.id];
    if (!placement) continue;
    const model = MODEL_FOR[c.type] ?? 'generic';
    const terminals = CATALOG[c.type].terminals.map((t) => {
      const p = terminalPosition(doc, c.id, t.id)!;
      return {
        id: t.id,
        x: p.x * SCALE,
        z: p.y * SCALE,
        node: g.nodeOf.get(`${c.id}:${t.id}`) ?? null,
      };
    });
    const visual: SceneComponent['visual'] = {};
    if (c.type === 'component.resistor') {
      const r = c.params.resistance as Quantity | undefined;
      visual.bands = r ? resistorBands(r.value) : null;
    }
    if (c.type === 'component.led')
      visual.ledColor = LED_COLORS[String(c.params.model)] ?? '#e53935';
    if (c.type === 'component.toggle_switch') visual.closed = c.params.closed === true;
    components.push({
      id: c.id,
      type: c.type,
      model,
      x: placement.x * SCALE,
      z: placement.y * SCALE,
      rotationY: (-placement.rotation * Math.PI) / 180,
      rotation: placement.rotation,
      terminals,
      visual,
    });
  }

  // Each wire belongs to the electrical node of the wire-graph group it is part of.
  const groupNode = new Map<string, string | null>();
  for (const group of wireGroups(doc)) {
    const terminal = group.find((k) => k.startsWith('t:'));
    const [, comp, term] = terminal ? terminal.split(':') : [];
    const node = terminal ? (g.nodeOf.get(`${comp}:${term}`) ?? null) : null;
    for (const k of group) groupNode.set(k, node);
  }
  const heightAt = (end: { kind: string; component?: string }) => {
    if (end.kind !== 'terminal') return WIRE_HEIGHTS[0]!;
    const c = components.find((x) => x.id === end.component);
    return c ? TERMINAL_HEIGHT[c.model] : WIRE_HEIGHTS[0]!;
  };
  const wires: SceneWire[] = [];
  const heights = wireHeights(doc);
  doc.layout.wires.forEach((w) => {
    const route = wireRoute(doc, w);
    if (!route || route.length < 2) return;
    const node = groupNode.get(nodeKey(w.from)) ?? null;
    const h = heights.get(w.id)!;
    const flat = route.map((p) => ({ x: p.x * SCALE, z: p.y * SCALE }));
    const first = flat[0]!;
    const last = flat[flat.length - 1]!;
    const points: Vec3[] = [
      { x: first.x, y: heightAt(w.from), z: first.z },
      ...flat.map((p) => ({ x: p.x, y: h, z: p.z })),
      { x: last.x, y: heightAt(w.to), z: last.z },
    ];
    wires.push({
      id: w.id,
      node,
      color: node ? (nodeColor.get(node) ?? SIGNAL_COLORS[0]!) : '#9aa3ad',
      points: dedupe(points),
    });
  });

  // Where terminals meet: the project's direct contacts, and touching terminals it does NOT
  // connect.
  const height = (id: string) => {
    const c = components.find((x) => x.id === id);
    return c ? TERMINAL_HEIGHT[c.model] : WIRE_HEIGHTS[0]!;
  };
  const joints: SceneJoint[] = [];
  const contactAt = new Map<string, SceneJoint>();
  for (const w of contacts(doc)) {
    if (w.from.kind !== 'terminal' || w.to.kind !== 'terminal') continue;
    const p = terminalPosition(doc, w.from.component, w.from.terminal)!;
    const k = `${p.x},${p.y}`;
    let j = contactAt.get(k);
    if (!j) {
      j = {
        kind: 'contact',
        x: p.x * SCALE,
        z: p.y * SCALE,
        y: 0,
        terminals: [],
        node: g.nodeOf.get(`${w.from.component}:${w.from.terminal}`) ?? null,
      };
      contactAt.set(k, j);
      joints.push(j);
    }
    for (const e of [w.from, w.to]) {
      const key = `${e.component}:${e.terminal}`;
      if (!j.terminals.includes(key)) j.terminals.push(key);
      j.y = Math.max(j.y, height(e.component));
    }
  }
  for (const t of touchingUnconnected(doc)) {
    const keys = t.terminals.map((e) => `${e.component}:${e.terminal}`);
    joints.push({
      kind: 'open',
      x: t.x * SCALE,
      z: t.y * SCALE,
      y: Math.max(...t.terminals.map((e) => height(e.component))),
      terminals: keys,
      node: null,
    });
    for (const e of t.terminals) {
      const term = components
        .find((c) => c.id === e.component)
        ?.terminals.find((x) => x.id === e.terminal);
      if (term) term.open = true;
    }
  }
  for (const j of joints) j.terminals.sort();

  return { components, wires, joints, ...extent(components, wires) };
}

/** Height of a wire that has to pass over terminals, header pins, junctions or a part. */
export const OVER_HEIGHT = 2.2;
const LEVEL_STEP = 0.45;

type Seg = [Point, Point];
const segsOf = (r: Point[]): Seg[] => r.slice(1).map((b, i) => [r[i]!, b]);
const onSeg = (p: Point, [a, b]: Seg) =>
  p.x >= Math.min(a.x, b.x) &&
  p.x <= Math.max(a.x, b.x) &&
  p.y >= Math.min(a.y, b.y) &&
  p.y <= Math.max(a.y, b.y) &&
  (a.x === b.x ? p.x === a.x : p.y === a.y);
/** Points two axis-aligned segments share (the ends of a collinear overlap, or one point). */
function shared(s: Seg, t: Seg): Point[] {
  const out: Point[] = [];
  for (const p of [...s, ...t]) if (onSeg(p, s) && onSeg(p, t)) out.push(p);
  const sv = s[0].x === s[1].x;
  const tv = t[0].x === t[1].x;
  if (sv !== tv) {
    const p = sv ? { x: s[0].x, y: t[0].y } : { x: t[0].x, y: s[0].y };
    if (onSeg(p, s) && onSeg(p, t)) out.push(p);
  }
  return out;
}

/**
 * Wire heights (Sprint 9: no 3D geometry may suggest a connection the project does not have).
 * - A wire whose route passes over a terminal, a drawn header pin or a junction that is not one
 *   of its own ends, or across another part's body, runs at OVER_HEIGHT and above: higher than
 *   every terminal, lead and wire end, so it visibly passes over them.
 * - Wires whose routes meet anywhere other than an end they share (a crossing, a corner on a
 *   segment, an overlap) never get the same height, so they pass over one another.
 * Deterministic: wires in document order, each at the lowest free level (starting at a level
 * that varies with its index, so neighbouring wires read apart).
 */
function wireHeights(doc: ProjectDocument): Map<string, number> {
  const routes = new Map<string, Point[]>();
  for (const w of doc.layout.wires) {
    const r = wireRoute(doc, w);
    if (r && r.length >= 2) routes.set(w.id, r);
  }
  const spots: Point[] = doc.layout.junctions.map((j) => ({ x: j.x, y: j.y }));
  const bodies: { id: string; minX: number; maxX: number; minY: number; maxY: number }[] = [];
  for (const c of doc.components) {
    const placement = doc.layout.components[c.id];
    if (!placement) continue;
    for (const t of CATALOG[c.type].terminals) spots.push(terminalPosition(doc, c.id, t.id)!);
    if (c.type === 'board.esp32_devkitc_wroom32')
      for (const pin of ESP32_DEVKITC_WROOM32.pins) {
        const q = rotatePoint(boardPinPosition(pin), placement.rotation);
        spots.push({ x: placement.x + q.x, y: placement.y + q.y });
      }
    const [hx, hz] = FOOTPRINT[MODEL_FOR[c.type] ?? 'generic'];
    const corner = rotatePoint({ x: hx / SCALE, y: hz / SCALE }, placement.rotation);
    const ex = Math.abs(corner.x);
    const ey = Math.abs(corner.y);
    bodies.push({
      id: c.id,
      minX: placement.x - ex,
      maxX: placement.x + ex,
      minY: placement.y - ey,
      maxY: placement.y + ey,
    });
  }
  const crossesBody = (r: Point[], b: (typeof bodies)[0]) =>
    segsOf(r).some(([a, c]) =>
      a.y === c.y
        ? a.y > b.minY && a.y < b.maxY && Math.max(a.x, c.x) > b.minX && Math.min(a.x, c.x) < b.maxX
        : a.x > b.minX &&
          a.x < b.maxX &&
          Math.max(a.y, c.y) > b.minY &&
          Math.min(a.y, c.y) < b.maxY,
    );
  const eq = (p: Point, q: Point) => p.x === q.x && p.y === q.y;
  const key = (p: Point) => `${p.x},${p.y}`;
  // Spots each wire passes over (not its own ends), and the wires that END at each spot (their
  // vertical riser stands there, up to their own height).
  const passes = new Map<string, Set<string>>();
  const endsAt = new Map<string, string[]>();
  const over = new Map<string, boolean>();
  for (const w of doc.layout.wires) {
    const r = routes.get(w.id);
    if (!r) continue;
    const ends = [r[0]!, r[r.length - 1]!];
    for (const e of ends) endsAt.set(key(e), [...(endsAt.get(key(e)) ?? []), w.id]);
    const own = new Set(
      [w.from, w.to].flatMap((e) => (e.kind === 'terminal' ? [e.component] : [])),
    );
    const passed = spots.filter(
      (p) => !ends.some((e) => eq(e, p)) && segsOf(r).some((s) => onSeg(p, s)),
    );
    passes.set(w.id, new Set(passed.map(key)));
    over.set(w.id, passed.length > 0 || bodies.some((b) => !own.has(b.id) && crossesBody(r, b)));
  }
  // Wires whose routes meet other than at an end both share.
  const ids = [...routes.keys()];
  const meets = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = routes.get(ids[i]!)!;
      const b = routes.get(ids[j]!)!;
      const endOfBoth = (p: Point) =>
        (eq(p, a[0]!) || eq(p, a[a.length - 1]!)) && (eq(p, b[0]!) || eq(p, b[b.length - 1]!));
      const hit = segsOf(a).some((s) =>
        segsOf(b).some((t) => shared(s, t).some((p) => !endOfBoth(p))),
      );
      if (hit) {
        meets.get(ids[i]!)!.add(ids[j]!);
        meets.get(ids[j]!)!.add(ids[i]!);
      }
    }
  // Wires at plane level first, then the lifted ones: each lifted wire also runs above every
  // wire whose end (riser) stands on a spot it passes over. Repeated until stable (a lifted wire
  // may pass over the end of another lifted wire).
  const height = new Map<string, number>();
  const assign = (w: { id: string }, i: number) => {
    const risers = [...passes.get(w.id)!].flatMap((k) =>
      (endsAt.get(k) ?? []).filter((o) => o !== w.id).map((o) => height.get(o) ?? 0),
    );
    const base = over.get(w.id)
      ? Math.max(OVER_HEIGHT, ...risers.map((h) => round(h + LEVEL_STEP)))
      : WIRE_HEIGHTS[0]!;
    const taken = new Set(
      [...meets.get(w.id)!].map((o) => height.get(o)).filter((h) => h !== undefined),
    );
    const levels = [i % WIRE_HEIGHTS.length, ...Array.from({ length: 64 }, (_, k) => k)];
    const level = levels.find((k) => !taken.has(round(base + k * LEVEL_STEP)))!;
    height.set(w.id, round(base + level * LEVEL_STEP));
  };
  const placed = doc.layout.wires.map((w, i) => ({ w, i })).filter(({ w }) => routes.has(w.id));
  for (const { w, i } of placed) if (!over.get(w.id)) assign(w, i);
  for (let round_ = 0; round_ < 4; round_++) {
    const before = JSON.stringify([...height]);
    for (const { w, i } of placed) if (over.get(w.id)) assign(w, i);
    if (JSON.stringify([...height]) === before) break;
  }
  return height;
}
const round = (v: number) => Math.round(v * 100) / 100;

function dedupe(points: Vec3[]): Vec3[] {
  return points.filter(
    (p, i) =>
      i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y || p.z !== points[i - 1]!.z,
  );
}

/** Plan footprint half-extents of a model at rotation 0 (local x, z), for bounds. */
const FOOTPRINT: Record<ModelKey, [number, number]> = {
  'board.esp32_devkitc': [8.5, 19.8],
  'resistor.axial': [4, 0.6],
  'led.5mm': [4, 1.2],
  'diode.axial': [4, 0.5],
  'switch.tactile': [4, 1.7],
  'switch.toggle': [4, 1.2],
  'ground.post': [0.8, 2.2],
  'instrument.psu': [4.2, 4.2],
  generic: [4, 1],
};

function extent(components: SceneComponent[], wires: SceneWire[]) {
  const min = { x: Infinity, y: 0, z: Infinity };
  const max = { x: -Infinity, y: 0.5, z: -Infinity };
  const add = (x: number, y: number, z: number) => {
    min.x = Math.min(min.x, x);
    min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x);
    max.y = Math.max(max.y, y);
    max.z = Math.max(max.z, z);
  };
  for (const c of components) {
    const [hx, hz] = FOOTPRINT[c.model];
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const r = rotatePoint({ x: sx * hx, y: sz * hz }, c.rotation);
      add(c.x + r.x, MODEL_HEIGHT[c.model], c.z + r.y);
    }
  }
  for (const w of wires) for (const p of w.points) add(p.x, p.y, p.z);
  if (min.x === Infinity) {
    min.x = -10;
    min.z = -10;
    max.x = 10;
    max.z = 10;
  }
  const margin = 4;
  return {
    base: {
      minX: min.x - margin,
      maxX: max.x + margin,
      minZ: min.z - margin,
      maxZ: max.z + margin,
    },
    bounds: { min: { ...min }, max: { ...max } },
  };
}
