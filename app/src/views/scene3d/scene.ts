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
  GROUND_NODE,
  connectivity,
  nodeKey,
  rotatePoint,
  terminalPosition,
  wireGroups,
  wireRoute,
  type ComponentTypeId,
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

export interface SceneDescription {
  components: SceneComponent[];
  wires: SceneWire[];
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

const WIRE_HEIGHTS = [0.7, 1.0, 1.3];
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
  doc.layout.wires.forEach((w, i) => {
    const route = wireRoute(doc, w);
    if (!route || route.length < 2) return;
    const node = groupNode.get(nodeKey(w.from)) ?? null;
    // Lifted above the plane; neighbouring wires at different heights, so wires that cross
    // in the drawing (unconnected) pass over one another instead of touching.
    const h = WIRE_HEIGHTS[i % WIRE_HEIGHTS.length]!;
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

  return { components, wires, ...extent(components, wires) };
}

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
