/**
 * 3D scene description (Sprint 9, D-S9-3; physical scale since Sprint 10): a pure, deterministic
 * function of the project document. No WebGL here: the renderer turns this description into
 * meshes, and unit tests check it directly.
 *
 * Mapping (the 2D circuit layout is the single source of placement; nothing is placed twice):
 * - plan position: X = layout x, Z = layout y, in millimetres (physical.ts: one 2D grid step =
 *   3.175 mm); the layout's clockwise rotation becomes a rotation about the vertical axis;
 * - size, height and shape come from each part's PHYSICAL metadata (physical.ts), never from its
 *   2D symbol size; every part stands on the bench plane (Y = 0);
 * - each terminal has an ATTACH POINT on the physical part (a lead end, a header pin's jumper
 *   housing, a binding post) where its wires meet it. For leaded parts it is the 2D terminal
 *   position; for the ESP32 it is the real header pin (on the 2D pin column, at the real 2.54 mm
 *   pitch along the header), and the wire's 3D end follows it;
 * - wires follow their 2D routes, coloured by ELECTRICAL NODE (ground black, a supply rail red,
 *   other nodes from a fixed palette), at heights chosen so that no wire touches anything it is
 *   not connected to (wireHeights).
 *
 * Visual detail derived from design values (resistor colour bands, LED colour and package, switch
 * position) is presentation only; nothing here ever feeds the simulation.
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
  type Rotation,
  type WireEnd,
} from '@tbi-lab/domain';
import {
  DIODE_DO35,
  ESP32_ATTACH_HEIGHT,
  ESP32_DEVKITC,
  ESP32_PIN_TOP,
  GROUND_POST,
  LEAD_ATTACH_HEIGHT,
  LED_PACKAGES,
  MM_PER_LAYOUT_UNIT,
  PSU,
  RESISTOR,
  TACTILE,
  TOGGLE,
  WIRE,
} from './physical.js';
import { ledLook } from '../ledLooks.js';

/** Scene units (millimetres) per 2D layout unit (physical.ts). */
export const SCALE = MM_PER_LAYOUT_UNIT;

export type ModelKey =
  | 'board.esp32_devkitc'
  | 'resistor.axial'
  | 'led.radial'
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
  'component.led': 'led.radial',
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
  /** Attach point: where this terminal's wires meet the physical part (scene space, mm). */
  x: number;
  y: number;
  z: number;
  /** Node it belongs to, or null when unwired. */
  node: string | null;
  /**
   * Set when another part's terminal sits on this one WITHOUT a connection: the model stops its
   * lead short of the terminal, so touching leads never read as joined.
   */
  open?: true;
}

export type LedPackage = keyof typeof LED_PACKAGES;

export interface SceneComponent {
  id: string;
  type: ComponentTypeId;
  model: ModelKey;
  /** Plan position of the component origin (mm). */
  x: number;
  z: number;
  /** Rotation about the vertical axis, radians (layout clockwise = negative about +Y). */
  rotationY: number;
  /** Layout rotation in degrees, for models that care about their local axes. */
  rotation: Rotation;
  terminals: SceneTerminal[];
  /** Presentation details derived from design values. */
  visual: {
    /** Resistor colour code (digit/multiplier/tolerance colour names), or null if the value has no exact 4- or 5-band code. */
    bands?: string[] | null;
    /** LED: emission colour, package and lens finish, from its model card's datasheet. */
    led?: { color: string; package: LedPackage; clear: boolean };
    /** Toggle switch position (the persisted parameter). */
    closed?: boolean;
    /** Bench supply: its design setpoints, shown on its displays. */
    psu?: { volts: number; amps: number };
    /** ESP32: the header pins that carry a wire (they get a jumper housing). */
    wiredPins?: string[];
  };
}

export interface SceneWire {
  id: string;
  node: string | null;
  color: string;
  /** Polyline in scene space (mm), from the first end's attach point to the second's. */
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
  /** Height of the joint (the highest attach point that meets there). */
  y: number;
  /** Pin keys `component:terminal` that meet here. */
  terminals: string[];
  /** The node of a contact; null for an open joint. */
  node: string | null;
  /**
   * Attach points of the joined terminals that are NOT at (x, y, z) (a lead touching a header pin
   * whose physical pin lies a step away): the renderer bridges them with a short solder link.
   */
  links?: Vec3[];
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

/** Tallest point of each model (mm), for bounds, labels and wires passing over it. */
export const MODEL_HEIGHT: Record<ModelKey, number> = {
  'board.esp32_devkitc': ESP32_ATTACH_HEIGHT,
  'resistor.axial': RESISTOR.standoffMm + RESISTOR.bodyDiameterMm,
  'led.radial': LED_PACKAGES.t1_34.standoffMm + LED_PACKAGES.t1_34.heightMm,
  'diode.axial': DIODE_DO35.standoffMm + DIODE_DO35.bodyDiameterMm,
  'switch.tactile': TACTILE.standoffMm + TACTILE.bodyHeightMm + TACTILE.actuatorHeightMm,
  'switch.toggle':
    TOGGLE.standoffMm + TOGGLE.bodyHeightMm + TOGGLE.bushingHeightMm + TOGGLE.leverLengthMm * 0.9,
  'ground.post': GROUND_POST.plateThicknessMm + GROUND_POST.postHeightMm,
  'instrument.psu': PSU.bodyHeightMm,
  generic: 3,
};

/**
 * Plan footprint of each model at rotation 0, local mm (minX, maxX, minZ, maxZ): where the part
 * occupies the bench. Wires that cross another part's footprint pass over it.
 */
export const FOOTPRINT: Record<ModelKey, readonly [number, number, number, number]> = {
  'board.esp32_devkitc': [
    -ESP32_DEVKITC.pcbWidthMm / 2,
    ESP32_DEVKITC.pcbWidthMm / 2,
    ESP32_DEVKITC.pcbCentreZMm - ESP32_DEVKITC.pcbLengthMm / 2 - ESP32_DEVKITC.moduleOverhangMm,
    ESP32_DEVKITC.pcbCentreZMm + ESP32_DEVKITC.pcbLengthMm / 2 + 1.0,
  ],
  'resistor.axial': [-6.7, 6.7, -RESISTOR.bodyDiameterMm / 2, RESISTOR.bodyDiameterMm / 2],
  'led.radial': [
    -6.7,
    6.7,
    -LED_PACKAGES.t1_34.flangeDiameterMm / 2,
    LED_PACKAGES.t1_34.flangeDiameterMm / 2,
  ],
  'diode.axial': [-6.7, 6.7, -DIODE_DO35.bodyDiameterMm / 2, DIODE_DO35.bodyDiameterMm / 2],
  'switch.tactile': [-6.7, 6.7, -TACTILE.bodyMm / 2, TACTILE.bodyMm / 2],
  'switch.toggle': [-6.7, 6.7, -TOGGLE.bodyZMm / 2, TOGGLE.bodyZMm / 2],
  'ground.post': [
    -GROUND_POST.plateMm / 2,
    GROUND_POST.plateMm / 2,
    -3.175 - 0.8,
    -3.175 + GROUND_POST.postOffsetZMm + GROUND_POST.plateMm / 2,
  ],
  'instrument.psu': [
    PSU.frontXMm - PSU.bodyXMm,
    PSU.frontXMm + PSU.postLengthMm,
    -PSU.bodyZMm / 2,
    PSU.bodyZMm / 2,
  ],
  generic: [-6.35, 6.35, -1.5, 1.5],
};

/** Radius of a wire tube (the renderer draws wires at this radius). */
export const WIRE_RADIUS = WIRE.radiusMm;

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

/** Along an ESP32 header, the real pin centre (2.54 mm pitch, centred on the board origin). */
export const realPinZ = (position: number) =>
  (position - (ESP32_DEVKITC.headerPins + 1) / 2) * ESP32_DEVKITC.pinPitchMm;

/**
 * Attach point of a terminal in the part's local frame (rotation 0), mm. `wired`: whether a wire
 * ends on it (an ESP32 pin then carries a jumper housing, and its wires meet the housing's top).
 */
function localAttach(
  type: ComponentTypeId,
  model: ModelKey,
  terminal: string,
  wired: boolean,
): Vec3 {
  const def = CATALOG[type].terminals.find((t) => t.id === terminal)!;
  const x = def.offset.x * SCALE;
  const z = def.offset.y * SCALE;
  switch (model) {
    case 'board.esp32_devkitc': {
      // The real header pin: its row is the 2D pin column (25.4 mm apart at this scale); along
      // the header it is at the real 2.54 mm pitch, centred like the 2D pins.
      const pin = ESP32_DEVKITC_WROOM32.pins.find(
        (p) =>
          `gpio${p.gpio}` === terminal ||
          (terminal === 'gnd' && p.role === 'ground' && p.header === 'J3' && p.position === 1),
      )!;
      return { x, y: wired ? ESP32_ATTACH_HEIGHT : ESP32_PIN_TOP, z: realPinZ(pin.position) };
    }
    case 'instrument.psu':
      return { x, y: PSU.attachHeightMm, z };
    case 'ground.post':
      return { x, y: GROUND_POST.attachHeightMm, z };
    default:
      return { x, y: LEAD_ATTACH_HEIGHT, z };
  }
}

function place(c: { x: number; z: number; rotation: Rotation }, p: Vec3): Vec3 {
  const r = rotatePoint({ x: p.x, y: p.z }, c.rotation);
  return { x: c.x + r.x, y: p.y, z: c.z + r.y };
}

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

  const wiredEnds = new Set(
    doc.layout.wires.flatMap((w) =>
      [w.from, w.to].flatMap((e) =>
        e.kind === 'terminal' ? [`${e.component}:${e.terminal}`] : [],
      ),
    ),
  );
  const components: SceneComponent[] = [];
  for (const c of doc.components) {
    const placement = doc.layout.components[c.id];
    if (!placement) continue;
    const model = MODEL_FOR[c.type] ?? 'generic';
    const origin = { x: placement.x * SCALE, z: placement.y * SCALE, rotation: placement.rotation };
    const terminals = CATALOG[c.type].terminals.map((t) => ({
      id: t.id,
      ...place(origin, localAttach(c.type, model, t.id, wiredEnds.has(`${c.id}:${t.id}`))),
      node: g.nodeOf.get(`${c.id}:${t.id}`) ?? null,
    }));
    const visual: SceneComponent['visual'] = {};
    if (c.type === 'component.resistor') {
      const r = c.params.resistance as Quantity | undefined;
      visual.bands = r ? resistorBands(r.value) : null;
    }
    if (c.type === 'component.led') visual.led = ledLook(c.params.model);
    if (c.type === 'component.toggle_switch') visual.closed = c.params.closed === true;
    if (c.type === 'instrument.lab_psu') {
      const v = c.params.setpointVoltage as Quantity | undefined;
      const i = c.params.currentLimit as Quantity | undefined;
      visual.psu = { volts: v?.value ?? 0, amps: i?.value ?? 0 };
    }
    if (model === 'board.esp32_devkitc')
      visual.wiredPins = CATALOG[c.type].terminals
        .map((t) => t.id)
        .filter((t) => wiredEnds.has(`${c.id}:${t}`));
    components.push({
      id: c.id,
      type: c.type,
      model,
      x: origin.x,
      z: origin.z,
      rotationY: (-placement.rotation * Math.PI) / 180,
      rotation: placement.rotation,
      terminals,
      visual,
    });
  }
  const attachOf = (component: string, terminal: string) =>
    components.find((c) => c.id === component)?.terminals.find((t) => t.id === terminal);

  // Each wire belongs to the electrical node of the wire-graph group it is part of.
  const groupNode = new Map<string, string | null>();
  for (const group of wireGroups(doc)) {
    const terminal = group.find((k) => k.startsWith('t:'));
    const [, comp, term] = terminal ? terminal.split(':') : [];
    const node = terminal ? (g.nodeOf.get(`${comp}:${term}`) ?? null) : null;
    for (const k of group) groupNode.set(k, node);
  }

  // Plan routes in mm, each end moved onto its terminal's physical attach point.
  const routes = new Map<string, { flat: Point[]; ends: [Vec3, Vec3] }>();
  for (const w of doc.layout.wires) {
    const route = wireRoute(doc, w);
    if (!route || route.length < 2) continue;
    let flat: Point[] = route.map((p) => ({ x: p.x * SCALE, y: p.y * SCALE }));
    const endAt = (e: WireEnd, p: Point): Vec3 => {
      const a = e.kind === 'terminal' ? attachOf(e.component, e.terminal) : undefined;
      return a ? { x: a.x, y: a.y, z: a.z } : { x: p.x, y: WIRE.baseHeightMm, z: p.y };
    };
    const a = endAt(w.from, flat[0]!);
    const b = endAt(w.to, flat[flat.length - 1]!);
    flat = moveEnd(moveEnd(flat, { x: a.x, y: a.z }, 'start'), { x: b.x, y: b.z }, 'end');
    routes.set(w.id, { flat, ends: [a, b] });
  }

  const wires: SceneWire[] = [];
  const heights = wireHeights(doc, components, routes);
  for (const w of doc.layout.wires) {
    const r = routes.get(w.id);
    if (!r) continue;
    const node = groupNode.get(nodeKey(w.from)) ?? null;
    const h = heights.get(w.id)!;
    const [a, b] = r.ends;
    const points: Vec3[] = [a, ...r.flat.map((p) => ({ x: p.x, y: h, z: p.y })), b];
    wires.push({
      id: w.id,
      node,
      color: node ? (nodeColor.get(node) ?? SIGNAL_COLORS[0]!) : '#9aa3ad',
      points: dedupe(points),
    });
  }

  // Where terminals meet: the project's direct contacts, and touching terminals it does NOT
  // connect.
  const joints: SceneJoint[] = [];
  const contactAt = new Map<string, SceneJoint>();
  for (const w of contacts(doc)) {
    if (w.from.kind !== 'terminal' || w.to.kind !== 'terminal') continue;
    const p = terminalPosition(doc, w.from.component, w.from.terminal)!;
    const k = `${p.x},${p.y}`;
    let j = contactAt.get(k);
    if (!j) {
      const a = attachOf(w.from.component, w.from.terminal)!;
      j = {
        kind: 'contact',
        x: a.x,
        z: a.z,
        y: a.y,
        terminals: [],
        node: g.nodeOf.get(`${w.from.component}:${w.from.terminal}`) ?? null,
      };
      contactAt.set(k, j);
      joints.push(j);
    }
    for (const e of [w.from, w.to]) {
      const key = `${e.component}:${e.terminal}`;
      if (j.terminals.includes(key)) continue;
      j.terminals.push(key);
      const at = attachOf(e.component, e.terminal)!;
      if (at.x !== j.x || at.z !== j.z || at.y !== j.y)
        (j.links ??= []).push({ x: at.x, y: at.y, z: at.z });
    }
  }
  for (const t of touchingUnconnected(doc)) {
    const keys = t.terminals.map((e) => `${e.component}:${e.terminal}`);
    const at = attachOf(t.terminals[0]!.component, t.terminals[0]!.terminal)!;
    joints.push({
      kind: 'open',
      x: at.x,
      z: at.z,
      y: Math.max(...t.terminals.map((e) => attachOf(e.component, e.terminal)!.y)),
      terminals: keys,
      node: null,
    });
    for (const e of t.terminals) {
      const term = attachOf(e.component, e.terminal);
      if (term) term.open = true;
    }
  }
  for (const j of joints) j.terminals.sort();

  return { components, wires, joints, ...extent(components, wires) };
}

/**
 * Move one end of an orthogonal plan route onto `to`, keeping it orthogonal: the final straight
 * run is extended or shortened when it already lines up, otherwise a short jog is added.
 */
function moveEnd(flat: Point[], to: Point, which: 'start' | 'end'): Point[] {
  const pts = which === 'start' ? [...flat].reverse() : [...flat];
  const last = pts[pts.length - 1]!;
  if (last.x === to.x && last.y === to.y) return flat;
  const prev = pts[pts.length - 2];
  if (prev && prev.y === last.y && to.y === last.y) pts[pts.length - 1] = { ...to };
  else if (prev && prev.x === last.x && to.x === last.x) pts[pts.length - 1] = { ...to };
  else if (last.y === to.y || last.x === to.x) pts.push({ ...to });
  else pts.push({ x: to.x, y: last.y }, { ...to });
  return which === 'start' ? pts.reverse() : pts;
}

type Seg = [Point, Point];
const segsOf = (r: Point[]): Seg[] => r.slice(1).map((b, i) => [r[i]!, b]);
const EPS = 1e-6;
const onSeg = (p: Point, [a, b]: Seg) =>
  p.x >= Math.min(a.x, b.x) - EPS &&
  p.x <= Math.max(a.x, b.x) + EPS &&
  p.y >= Math.min(a.y, b.y) - EPS &&
  p.y <= Math.max(a.y, b.y) + EPS &&
  (Math.abs(a.x - b.x) < EPS ? Math.abs(p.x - a.x) < EPS : Math.abs(p.y - a.y) < EPS);
/** Points two axis-aligned segments share (the ends of a collinear overlap, or one point). */
function shared(s: Seg, t: Seg): Point[] {
  const out: Point[] = [];
  for (const p of [...s, ...t]) if (onSeg(p, s) && onSeg(p, t)) out.push(p);
  const sv = Math.abs(s[0].x - s[1].x) < EPS;
  const tv = Math.abs(t[0].x - t[1].x) < EPS;
  if (sv !== tv) {
    const p = sv ? { x: s[0].x, y: t[0].y } : { x: t[0].x, y: s[0].y };
    if (onSeg(p, s) && onSeg(p, t)) out.push(p);
  }
  return out;
}
const eq = (p: Point, q: Point) => Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS;
/** Within this plan distance a wire is taken to pass over a pin or terminal. */
const NEAR_MM = WIRE.radiusMm + 0.6;
const nearSeg = (p: Point, [a, b]: Seg) => {
  const cx = Math.min(Math.max(p.x, Math.min(a.x, b.x)), Math.max(a.x, b.x));
  const cy = Math.min(Math.max(p.y, Math.min(a.y, b.y)), Math.max(a.y, b.y));
  return Math.hypot(p.x - cx, p.y - cy) < NEAR_MM;
};
const round = (v: number) => Math.round(v * 100) / 100;

/**
 * Wire heights (no 3D geometry may suggest a connection the project does not have), in mm:
 * - a wire never runs below the attach points of its own ends (it would pass through the part it
 *   ends on, e.g. under an ESP32's PCB);
 * - a wire passing over a terminal, a header pin or a junction that is not one of its own ends,
 *   or across another part's body, runs a clearance above the tallest of them, and above every
 *   other wire's riser that stands there;
 * - wires whose routes meet anywhere other than an end they share (a crossing, a corner on a
 *   segment, an overlap) never get the same height, so they pass over one another.
 * Deterministic: wires in document order, each at the lowest free level (starting at a level
 * that varies with its index, so neighbouring wires read apart).
 */
function wireHeights(
  doc: ProjectDocument,
  components: SceneComponent[],
  routes: Map<string, { flat: Point[]; ends: [Vec3, Vec3] }>,
): Map<string, number> {
  // Spots a wire may pass over: every attach point, every physical header pin, every junction.
  const spots: { p: Point; h: number }[] = doc.layout.junctions.map((j) => ({
    p: { x: j.x * SCALE, y: j.y * SCALE },
    h: WIRE.baseHeightMm,
  }));
  const bodies: {
    id: string;
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    h: number;
  }[] = [];
  for (const c of components) {
    for (const t of c.terminals) spots.push({ p: { x: t.x, y: t.z }, h: t.y });
    if (c.model === 'board.esp32_devkitc')
      for (const pin of ESP32_DEVKITC_WROOM32.pins) {
        const local = boardPinPosition(pin);
        const at = place(c, {
          x: Math.sign(local.x) * (ESP32_DEVKITC.headerRowSpacingMm / 2),
          y: 0,
          z: realPinZ(pin.position),
        });
        spots.push({ p: { x: at.x, y: at.z }, h: ESP32_ATTACH_HEIGHT });
      }
    const [x0, x1, z0, z1] = FOOTPRINT[c.model];
    const corners = [
      [x0, z0],
      [x1, z0],
      [x0, z1],
      [x1, z1],
    ].map(([x, z]) => place(c, { x: x!, y: 0, z: z! }));
    bodies.push({
      id: c.id,
      minX: Math.min(...corners.map((q) => q.x)),
      maxX: Math.max(...corners.map((q) => q.x)),
      minZ: Math.min(...corners.map((q) => q.z)),
      maxZ: Math.max(...corners.map((q) => q.z)),
      h: MODEL_HEIGHT[c.model],
    });
  }
  const crossesBody = (r: Point[], b: (typeof bodies)[0]) =>
    segsOf(r).some(([a, c]) =>
      Math.abs(a.y - c.y) < EPS
        ? a.y > b.minZ && a.y < b.maxZ && Math.max(a.x, c.x) > b.minX && Math.min(a.x, c.x) < b.maxX
        : a.x > b.minX &&
          a.x < b.maxX &&
          Math.max(a.y, c.y) > b.minZ &&
          Math.min(a.y, c.y) < b.maxZ,
    );
  const key = (p: Point) => `${round(p.x)},${round(p.y)}`;

  const floor = new Map<string, number>();
  const passes = new Map<string, Set<string>>();
  const endsAt = new Map<string, string[]>();
  for (const w of doc.layout.wires) {
    const r = routes.get(w.id);
    if (!r) continue;
    const ends = [r.flat[0]!, r.flat[r.flat.length - 1]!];
    for (const e of ends) endsAt.set(key(e), [...(endsAt.get(key(e)) ?? []), w.id]);
    const own = new Set(
      [w.from, w.to].flatMap((e) => (e.kind === 'terminal' ? [e.component] : [])),
    );
    const segs = segsOf(r.flat);
    const passed = spots.filter(
      (s) =>
        !ends.some((e) => Math.hypot(e.x - s.p.x, e.y - s.p.y) < NEAR_MM) &&
        segs.some((g) => nearSeg(s.p, g)),
    );
    passes.set(w.id, new Set(passed.map((s) => key(s.p))));
    const over = Math.max(
      ...passed.map((s) => s.h + WIRE.clearanceMm),
      ...bodies
        .filter((b) => !own.has(b.id) && crossesBody(r.flat, b))
        .map((b) => b.h + WIRE.clearanceMm),
      0,
    );
    floor.set(w.id, Math.max(WIRE.baseHeightMm, r.ends[0].y, r.ends[1].y, over));
  }
  // Wires whose routes meet other than at an end both share.
  const ids = [...routes.keys()];
  const meets = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = routes.get(ids[i]!)!.flat;
      const b = routes.get(ids[j]!)!.flat;
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
  // Each wire also runs above every wire whose end (riser) stands on a spot it passes over.
  // Repeated until stable (a lifted wire may pass over the end of another lifted wire).
  const height = new Map<string, number>();
  const assign = (id: string, i: number) => {
    const risers = [...passes.get(id)!].flatMap((k) =>
      (endsAt.get(k) ?? []).filter((o) => o !== id).map((o) => height.get(o) ?? 0),
    );
    const base = Math.max(floor.get(id)!, ...risers.map((h) => round(h + WIRE.levelStepMm)));
    const taken = new Set(
      [...meets.get(id)!].map((o) => height.get(o)).filter((h) => h !== undefined),
    );
    const levels = [i % 3, ...Array.from({ length: 64 }, (_, k) => k)];
    const level = levels.find((k) => !taken.has(round(base + k * WIRE.levelStepMm)))!;
    height.set(id, round(base + level * WIRE.levelStepMm));
  };
  const order = doc.layout.wires
    .map((w, i) => ({ id: w.id, i }))
    .filter(({ id }) => routes.has(id));
  for (let pass = 0; pass < 5; pass++) {
    const before = JSON.stringify([...height]);
    for (const { id, i } of order) assign(id, i);
    if (JSON.stringify([...height]) === before) break;
  }
  return height;
}

function dedupe(points: Vec3[]): Vec3[] {
  return points.filter(
    (p, i) =>
      i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y || p.z !== points[i - 1]!.z,
  );
}

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
    const [x0, x1, z0, z1] = FOOTPRINT[c.model];
    for (const [x, z] of [
      [x0, z0],
      [x1, z0],
      [x0, z1],
      [x1, z1],
    ] as const) {
      const p = place(c, { x, y: 0, z });
      add(p.x, MODEL_HEIGHT[c.model], p.z);
    }
  }
  for (const w of wires) for (const p of w.points) add(p.x, p.y, p.z);
  if (min.x === Infinity) {
    min.x = -25;
    min.z = -25;
    max.x = 25;
    max.z = 25;
  }
  const margin = 10;
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
