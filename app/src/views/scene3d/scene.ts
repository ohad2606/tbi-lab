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
  MATRIX_1088AS_PINS,
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
  BUZZER_CEM1205,
  DIODE_DO35,
  LDR_GL5528,
  RELAY_SRD,
  RGB_LED_5MM,
  TO92,
  PIR_HC_SR501,
  HC_SR04_MODULE,
  DHT22_CASE,
  LCD1602_MODULE,
  capacitorPackage,
  LED_MATRIX_1088AS,
  matrixPinXZ,
  ESP32_ATTACH_HEIGHT,
  ESP32_DEVKITC,
  ESP32_PCB_TOP,
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
import { NEUTRAL_HEX, resolveWireColors } from '../wireColors.js';
import { separateBodies, worldBoxes, type Body, type Box } from './separation.js';
import {
  FLOOR,
  routeWires,
  type Obstacle,
  type Spot,
  type WireRoute,
  type WireRouteInput,
} from './route3d.js';

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
  | 'led.rgb'
  | 'ldr.disc'
  | 'buzzer.can'
  | 'relay.cube'
  | 'transistor.to92'
  | 'sensor.pir'
  | 'display.matrix'
  | 'capacitor.radial'
  | 'sensor.ultrasonic'
  | 'sensor.dht22'
  | 'display.lcd1602'
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
  'component.rgb_led': 'led.rgb',
  'component.photoresistor': 'ldr.disc',
  'component.buzzer': 'buzzer.can',
  'component.relay': 'relay.cube',
  'component.bjt_npn': 'transistor.to92',
  'sensor.pir_hc_sr501': 'sensor.pir',
  'display.led_matrix_8x8': 'display.matrix',
  'component.capacitor': 'capacitor.radial',
  'sensor.hc_sr04': 'sensor.ultrasonic',
  'sensor.dht22': 'sensor.dht22',
  'display.lcd1602_i2c': 'display.lcd1602',
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
    /** Capacitor: its value, which picks the package (physical.ts capacitorPackage). */
    farads?: number;
  };
}

/**
 * What a wire end meets, for its presentation (the renderer draws the end to suit; it never
 * changes the route): a header pin's jumper housing (`jumper`), a binding post (`post`), a part's
 * lead or pin tip (`lead`), or another wire at a junction (`junction`).
 */
export type WireEndKind = 'jumper' | 'post' | 'lead' | 'junction';

export interface SceneWire {
  id: string;
  node: string | null;
  color: string;
  /** Polyline in scene space (mm), from the first end's attach point to the second's. */
  points: Vec3[];
  /** What each end meets (presentation). */
  ends: [WireEndKind, WireEndKind];
  /** Corner radius at each interior point (route3d.ts), when the router chose it. */
  radii?: number[];
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
  /**
   * The visual-only separation applied to physical bodies (separation.ts): each part moved from
   * its 2D-derived position (plan offset, mm), and pairs still overlapping after the capped
   * resolution. The project's own coordinates are never changed.
   */
  separation: {
    moved: { id: string; dx: number; dz: number }[];
    unresolved: [string, string][];
  };
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
  'led.rgb': RGB_LED_5MM.standoffMm + RGB_LED_5MM.heightMm,
  'ldr.disc': LDR_GL5528.standoffMm + LDR_GL5528.thicknessMm,
  'buzzer.can': BUZZER_CEM1205.standoffMm + BUZZER_CEM1205.heightMm,
  'relay.cube': RELAY_SRD.standoffMm + RELAY_SRD.heightMm,
  'transistor.to92': TO92.standoffMm + TO92.heightMm,
  'sensor.pir': PIR_HC_SR501.standoffMm + PIR_HC_SR501.boardThicknessMm + PIR_HC_SR501.domeHeightMm,
  'display.matrix': LED_MATRIX_1088AS.standoffMm + LED_MATRIX_1088AS.heightMm,
  // The largest can (the body of a given value is in its visual).
  'capacitor.radial': 21,
  'sensor.ultrasonic': HC_SR04_MODULE.standoffMm + HC_SR04_MODULE.boardYMm,
  'sensor.dht22': DHT22_CASE.standoffMm + DHT22_CASE.heightMm,
  'display.lcd1602':
    LCD1602_MODULE.standoffMm + LCD1602_MODULE.pcbThicknessMm + LCD1602_MODULE.bezelHeightMm,
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
  // The flange: the legs stand under it (high-fidelity model, Sprint 10).
  'led.radial': [
    -LED_PACKAGES.t1_34.flangeDiameterMm / 2,
    LED_PACKAGES.t1_34.flangeDiameterMm / 2,
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
  'led.rgb': [-6.7, 6.7, -3.6, 3.6],
  'ldr.disc': [-6.7, 6.7, -LDR_GL5528.diameterMm / 2, LDR_GL5528.diameterMm / 2],
  'buzzer.can': [
    -BUZZER_CEM1205.diameterMm / 2,
    BUZZER_CEM1205.diameterMm / 2,
    -BUZZER_CEM1205.diameterMm / 2,
    BUZZER_CEM1205.diameterMm / 2,
  ],
  'relay.cube': [
    -RELAY_SRD.lengthMm / 2,
    RELAY_SRD.lengthMm / 2,
    -RELAY_SRD.widthMm / 2,
    RELAY_SRD.widthMm / 2,
  ],
  'transistor.to92': [-6.7, 3.6, -6.7, 6.7],
  'capacitor.radial': [-6.7, 6.7, -6.25, 6.25],
  'display.matrix': [
    -LED_MATRIX_1088AS.sizeMm / 2,
    LED_MATRIX_1088AS.sizeMm / 2,
    -LED_MATRIX_1088AS.sizeMm / 2,
    LED_MATRIX_1088AS.sizeMm / 2,
  ],
  'sensor.pir': [
    -PIR_HC_SR501.boardXMm / 2,
    PIR_HC_SR501.boardXMm / 2,
    -PIR_HC_SR501.boardZMm / 2,
    PIR_HC_SR501.boardZMm / 2,
  ],
  // Sprint 12: the upright ultrasonic board with its transducers (+x) and crystal (-x).
  'sensor.ultrasonic': [
    HC_SR04_MODULE.boardXMm - HC_SR04_MODULE.boardThicknessMm / 2 - HC_SR04_MODULE.backMm,
    HC_SR04_MODULE.boardXMm + HC_SR04_MODULE.boardThicknessMm / 2 + HC_SR04_MODULE.frontMm,
    -HC_SR04_MODULE.boardZMm / 2,
    HC_SR04_MODULE.boardZMm / 2,
  ],
  'sensor.dht22': [
    -DHT22_CASE.depthXMm / 2,
    DHT22_CASE.depthXMm / 2,
    -DHT22_CASE.widthZMm / 2,
    DHT22_CASE.widthZMm / 2,
  ],
  'display.lcd1602': [
    LCD1602_MODULE.pcbLeftXMm,
    LCD1602_MODULE.pcbLeftXMm + LCD1602_MODULE.pcbXMm,
    LCD1602_MODULE.pcbCentreZMm - LCD1602_MODULE.pcbZMm / 2,
    LCD1602_MODULE.pcbCentreZMm + LCD1602_MODULE.pcbZMm / 2,
  ],
  generic: [-6.35, 6.35, -1.5, 1.5],
};

/** Radius of a wire tube (the renderer draws wires at this radius). */
export const WIRE_RADIUS = WIRE.radiusMm;

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
    case 'display.matrix': {
      // The real pin under the block (rows and columns by the 1088AS pin map).
      const n = MATRIX_1088AS_PINS.indexOf(terminal) + 1;
      const [px, pz] = matrixPinXZ(n);
      return { x: px, y: LED_MATRIX_1088AS.attachHeightMm, z: pz };
    }
    case 'sensor.pir': {
      const [px, pz] = PIR_HC_SR501.pins[terminal]!;
      return { x: px, y: PIR_HC_SR501.attachHeightMm, z: pz };
    }
    // Sprint 12: the real header pins (tips under the upright modules; the LCD backpack's pins
    // pointing out of its left edge, their tips on the 2D terminal column).
    case 'sensor.ultrasonic': {
      const [px, pz] = HC_SR04_MODULE.pins[terminal]!;
      return { x: px, y: HC_SR04_MODULE.attachHeightMm, z: pz };
    }
    case 'sensor.dht22': {
      const [px, pz] = DHT22_CASE.pins[terminal]!;
      return { x: px, y: DHT22_CASE.attachHeightMm, z: pz };
    }
    case 'display.lcd1602': {
      const [px, pz] = LCD1602_MODULE.pins[terminal]!;
      return { x: px, y: LCD1602_MODULE.pinHeightMm, z: pz };
    }
    case 'led.radial': {
      // The real leg tips (2.54 mm pitch under the body), not the 2D terminal spacing: the wire's
      // end follows the leg, as for the relay's and the ESP32's real pins (assets/led5mm.ts).
      return {
        x: Math.sign(x) * (LED_PACKAGES.t1_34.leadPitchMm / 2),
        y: LEAD_ATTACH_HEIGHT,
        z: 0,
      };
    }
    case 'relay.cube': {
      // The real pin (bottom face), as the ESP32's header pins: the wire's end follows it.
      const [px, pz] = RELAY_SRD.pins[terminal]!;
      return { x: px, y: RELAY_SRD.attachHeightMm, z: pz };
    }
    default:
      return { x, y: LEAD_ATTACH_HEIGHT, z };
  }
}

function place(c: { x: number; z: number; rotation: Rotation }, p: Vec3): Vec3 {
  const r = rotatePoint({ x: p.x, y: p.z }, c.rotation);
  return { x: c.x + r.x, y: p.y, z: c.z + r.y };
}

export function deriveScene(doc: ProjectDocument): SceneDescription {
  // The scene as intended: bodies separated, wires freshly routed from the final terminals. The
  // 3D view must never suggest a connection the project does not have: if wires or terminals of
  // different nodes touch, the safer alternatives are tried in order (the previous router,
  // then the 2D-derived placement) and the one with the fewest such contacts is kept (the
  // earlier on a tie). Normally the first one is clean and nothing else is built.
  const first = buildScene(doc, true, 'fresh');
  let bad = touchingNodes(first).length;
  if (!bad) return first;
  let best = first;
  const moved = first.separation.moved.length > 0;
  const options: [boolean, 'fresh' | 'legacy'][] = [
    [true, 'legacy'],
    ...(moved
      ? ([
          [false, 'fresh'],
          [false, 'legacy'],
        ] as [boolean, 'fresh' | 'legacy'][])
      : []),
  ];
  for (const [separate, router] of options) {
    const s = buildScene(doc, separate, router);
    const n = touchingNodes(s).length;
    if (n < bad) {
      best = s;
      bad = n;
      if (!n) break;
    }
  }
  return best;
}

/**
 * Pairs of electrically different things that touch in a scene's geometry: two wires of
 * different nodes closer than their diameters, or a wire passing a terminal of another node (not
 * one of its ends) within a wire radius plus a lead's half-thickness. Plan bounding boxes first.
 */
export function touchingNodes(s: SceneDescription): string[] {
  const out: string[] = [];
  const r = WIRE_RADIUS;
  const boxOf = (pts: Vec3[], pad: number) => ({
    x0: Math.min(...pts.map((p) => p.x)) - pad,
    x1: Math.max(...pts.map((p) => p.x)) + pad,
    z0: Math.min(...pts.map((p) => p.z)) - pad,
    z1: Math.max(...pts.map((p) => p.z)) + pad,
  });
  const meet = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) =>
    a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1;
  const boxes = s.wires.map((w) => boxOf(w.points, r + 0.5));
  const segs = s.wires.map((w) => w.points.slice(1).map((b, i) => [w.points[i]!, b] as const));
  for (let i = 0; i < s.wires.length; i++)
    for (let j = i + 1; j < s.wires.length; j++) {
      const a = s.wires[i]!;
      const b = s.wires[j]!;
      if ((a.node && a.node === b.node) || !meet(boxes[i]!, boxes[j]!)) continue;
      if (
        segs[i]!.some(([p, q]) =>
          segs[j]!.some(
            ([u, v]) => segBoxesMeet(p, q, u, v, 1.4) && segDistance(p, q, u, v) < 2 * r + 0.05,
          ),
        )
      )
        out.push(`w:${a.id}|${b.id}`);
    }
  for (const c of s.components)
    for (const t of c.terminals) {
      if (t.open) continue;
      s.wires.forEach((w, i) => {
        if (t.node && w.node === t.node) return;
        const ends = [w.points[0]!, w.points.at(-1)!];
        if (ends.some((e) => e.x === t.x && e.y === t.y && e.z === t.z)) return;
        const bx = boxes[i]!;
        if (t.x < bx.x0 || t.x > bx.x1 || t.z < bx.z0 || t.z > bx.z1) return;
        if (segs[i]!.some(([p, q]) => segDistance(p, q, t, t) < r + 0.4))
          out.push(`t:${w.id}|${c.id}:${t.id}`);
      });
    }
  return out;
}

/** Whether the bounding boxes of segments ab and cd, padded, overlap (a cheap first test). */
function segBoxesMeet(a: Vec3, b: Vec3, c: Vec3, d: Vec3, pad: number): boolean {
  return (
    Math.max(a.x, b.x) + pad >= Math.min(c.x, d.x) &&
    Math.max(c.x, d.x) + pad >= Math.min(a.x, b.x) &&
    Math.max(a.y, b.y) + pad >= Math.min(c.y, d.y) &&
    Math.max(c.y, d.y) + pad >= Math.min(a.y, b.y) &&
    Math.max(a.z, b.z) + pad >= Math.min(c.z, d.z) &&
    Math.max(c.z, d.z) + pad >= Math.min(a.z, b.z)
  );
}

/** Shortest distance between segments ab and cd. */
function segDistance(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const sub = (p: Vec3, q: Vec3) => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z });
  const dot = (p: Vec3, q: Vec3) => p.x * q.x + p.y * q.y + p.z * q.z;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const u = sub(b, a);
  const v = sub(d, c);
  const w = sub(a, c);
  const A = dot(u, u);
  const B = dot(u, v);
  const C = dot(v, v);
  const D = dot(u, w);
  const E = dot(v, w);
  const den = A * C - B * B;
  let sc = A < 1e-12 || den < 1e-12 ? 0 : clamp01((B * E - C * D) / den);
  let tc = C < 1e-12 ? 0 : clamp01((A < 1e-12 ? E : B * sc + E) / C);
  if (A >= 1e-12) sc = clamp01((tc * B - D) / A);
  if (C >= 1e-12) tc = clamp01((sc * B + E) / C);
  const p = { x: a.x + u.x * sc, y: a.y + u.y * sc, z: a.z + u.z * sc };
  const q = { x: c.x + v.x * tc, y: c.y + v.y * tc, z: c.z + v.z * tc };
  return Math.sqrt(dot(sub(p, q), sub(p, q)));
}

/**
 * A part's collision volumes (separation.ts), local frame: its physical footprint from the bench
 * to its top; the PIR module as its board at its real height over its pin header; and for each
 * wired pin under a body, the strip its wire leaves by at pin level, tagged with `wired(pin)`.
 */
export function collisionBoxes(
  type: ComponentTypeId,
  model: ModelKey,
  farads: number | undefined,
  wired: (terminal: string) => string | null,
): Box[] {
  const [x0, x1, z0, z1] = FOOTPRINT[model];
  const top = MODEL_HEIGHT[model];
  const boxes: Box[] = [];
  if (model === 'capacitor.radial') {
    // The leads reach the 2D terminals along x; the body is the disc's thickness or the can.
    const p = capacitorPackage(farads ?? 100e-6);
    const half = p.kind === 'disc' ? p.thicknessMm / 2 : p.diameterMm / 2;
    const height = p.standoffMm + (p.kind === 'disc' ? p.diameterMm : p.heightMm);
    boxes.push({ x0: -6.7, x1: 6.7, z0: -half, z1: half, y0: 0, y1: height });
  } else if (model === 'sensor.pir') {
    // The board (with the trim pots under it), the dome on it, the pin header below.
    const P = PIR_HC_SR501;
    const pins = Object.values(P.pins);
    const board = P.standoffMm + P.boardThicknessMm;
    const R = P.domeDiameterMm / 2;
    boxes.push({ x0, x1, z0, z1, y0: P.standoffMm - 2.5, y1: board });
    boxes.push({ x0: -R, x1: R, z0: -R, z1: R, y0: board, y1: top });
    boxes.push({
      x0: Math.min(...pins.map((q) => q[0])) - 1.5,
      x1: Math.max(...pins.map((q) => q[0])) + 1.5,
      z0: Math.min(...pins.map((q) => q[1])) - 1.5,
      z1: Math.max(...pins.map((q) => q[1])) + 1.5,
      y0: 0,
      y1: P.standoffMm,
    });
  } else if (model === 'sensor.ultrasonic' || model === 'sensor.dht22') {
    // Sprint 12: the upright body on its header, and the header pins below it.
    const P = model === 'sensor.ultrasonic' ? HC_SR04_MODULE : DHT22_CASE;
    const pins = Object.values(P.pins);
    boxes.push({ x0, x1, z0, z1, y0: P.standoffMm, y1: top });
    boxes.push({
      x0: Math.min(...pins.map((q) => q[0])) - 1.5,
      x1: Math.max(...pins.map((q) => q[0])) + 1.5,
      z0: Math.min(...pins.map((q) => q[1])) - 1.5,
      z1: Math.max(...pins.map((q) => q[1])) + 1.5,
      y0: 0,
      y1: P.standoffMm,
    });
  } else if (model === 'display.lcd1602') {
    // The module (with the backpack under it), and the backpack's header pins beside it.
    const P = LCD1602_MODULE;
    const pins = Object.values(P.pins);
    boxes.push({ x0, x1, z0, z1, y0: 0, y1: top });
    boxes.push({
      x0: P.pinTipXMm,
      x1: x0,
      z0: Math.min(...pins.map((q) => q[1])) - 1.5,
      z1: Math.max(...pins.map((q) => q[1])) + 1.5,
      y0: 0,
      y1: P.pinHeightMm + 1.5,
    });
  } else boxes.push({ x0, x1, z0, z1, y0: 0, y1: top });
  if (UNDER_BODY.has(model)) {
    // Room for the fan-out too (freshWires): one lane pitch per further wired pin on the same
    // side, up to two (beyond that the lanes share distances and hop over each other).
    const exits = CATALOG[type].terminals.flatMap((t) => {
      if (!wired(t.id)) return [];
      const at = localAttach(type, model, t.id, true);
      return [{ t, at, exit: pinExit(type, model, t.id, at) }];
    });
    for (const { t, at, exit } of exits) {
      const node = wired(t.id)!;
      const [side, drop] = exit;
      const fan = Math.min(2, exits.filter((e) => e.exit[0] === side).length - 1) * LANE_PITCH;
      const half = WIRE.radiusMm + 0.15;
      const reach =
        FOOTPRINT[model][side] + (side % 2 === 0 ? -1 : 1) * (drop + fan + WIRE.radiusMm);
      const y1 = at.y + WIRE.radiusMm + 0.3;
      boxes.push(
        side < 2
          ? {
              x0: Math.min(at.x, reach),
              x1: Math.max(at.x, reach),
              z0: at.z - half,
              z1: at.z + half,
              y0: 0,
              y1,
              node,
            }
          : {
              x0: at.x - half,
              x1: at.x + half,
              z0: Math.min(at.z, reach),
              z1: Math.max(at.z, reach),
              y0: 0,
              y1,
              node,
            },
      );
    }
  }
  return boxes;
}

/** Every part's collision body at its 2D-derived (base) transform (separation.ts). */
export function collisionBodies(
  doc: ProjectDocument,
  g = connectivity(doc),
  wiredEnds = wiredTerminals(doc),
): Body[] {
  return doc.components.flatMap((c): Body[] => {
    const placement = doc.layout.components[c.id];
    if (!placement) return [];
    const model = MODEL_FOR[c.type] ?? 'generic';
    const farads =
      c.type === 'component.capacitor'
        ? ((c.params.capacitance as Quantity | undefined)?.value ?? 100e-6)
        : undefined;
    const nodeOf = (t: string) => g.nodeOf.get(`${c.id}:${t}`);
    return [
      {
        id: c.id,
        model,
        x: placement.x * SCALE,
        z: placement.y * SCALE,
        rotation: placement.rotation,
        boxes: collisionBoxes(c.type, model, farads, (t) =>
          wiredEnds.has(`${c.id}:${t}`) ? (nodeOf(t) ?? `${c.id}:${t}`) : null,
        ),
        nodes: CATALOG[c.type].terminals.flatMap((t) => nodeOf(t.id) ?? []),
        farads,
      },
    ];
  });
}

/** `component:terminal` keys of the terminals a wire ends on. */
function wiredTerminals(doc: ProjectDocument): Set<string> {
  return new Set(
    doc.layout.wires.flatMap((w) =>
      [w.from, w.to].flatMap((e) =>
        e.kind === 'terminal' ? [`${e.component}:${e.terminal}`] : [],
      ),
    ),
  );
}

/** One scene variant (diagnostics and tests): with or without separation, by either router. */
export const deriveSceneVariant = (
  doc: ProjectDocument,
  separate: boolean,
  router: 'fresh' | 'legacy',
): SceneDescription => buildScene(doc, separate, router);

function buildScene(
  doc: ProjectDocument,
  separate: boolean,
  router: 'fresh' | 'legacy' = 'fresh',
): SceneDescription {
  const g = connectivity(doc);
  // Wire colours: the one resolution the Circuit view uses too (wireColors.ts).
  const wireColor = resolveWireColors(doc, g);

  const wiredEnds = wiredTerminals(doc);
  // Base transforms from the 2D layout, then the visual-only separation of physical bodies that
  // the 2D symbols let overlap (separation.ts): parts joined by a direct contact or touching
  // terminals move together and are never pushed apart.
  const bodies = collisionBodies(doc, g, wiredEnds);
  const touching = [
    ...contacts(doc).flatMap((w) =>
      w.from.kind === 'terminal' && w.to.kind === 'terminal'
        ? [[w.from.component, w.to.component]]
        : [],
    ),
    ...touchingUnconnected(doc).map((t) => t.terminals.map((e) => e.component)),
  ];
  // Without separation: no move, every overlap reported (the fallback in deriveScene).
  const separation = separateBodies(bodies, touching, separate ? undefined : 0);

  const components: SceneComponent[] = [];
  for (const c of doc.components) {
    const placement = doc.layout.components[c.id];
    if (!placement) continue;
    const model = MODEL_FOR[c.type] ?? 'generic';
    const shift = separation.offsets.get(c.id);
    const origin = {
      x: placement.x * SCALE + (shift?.dx ?? 0),
      z: placement.y * SCALE + (shift?.dz ?? 0),
      rotation: placement.rotation,
    };
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
    if (c.type === 'component.capacitor')
      visual.farads = (c.params.capacitance as Quantity | undefined)?.value ?? 100e-6;
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

  const endKind = (e: WireEnd): WireEndKind => {
    if (e.kind !== 'terminal') return 'junction';
    const model = components.find((c) => c.id === e.component)?.model;
    return model === 'board.esp32_devkitc'
      ? 'jumper'
      : model === 'instrument.psu' || model === 'ground.post'
        ? 'post'
        : 'lead';
  };
  const wires: SceneWire[] = [];
  if (router === 'legacy') {
    // Plan routes in mm, each end moved onto its terminal's physical attach point.
    const routes = new Map<string, Route>();
    for (const w of doc.layout.wires) {
      const route = wireRoute(doc, w);
      if (!route || route.length < 2) continue;
      let flat: Point[] = route.map((p) => ({ x: p.x * SCALE, y: p.y * SCALE }));
      // A part moved by the visual separation drags its wire ends along, as a drag in 2D would:
      // the whole route when both ends moved together, else the end runs (dragEnd).
      const shiftOf = (e: WireEnd) =>
        e.kind === 'terminal' ? separation.offsets.get(e.component) : undefined;
      const sa = shiftOf(w.from);
      const sb = shiftOf(w.to);
      if (sa && sb && sa.dx === sb.dx && sa.dz === sb.dz)
        flat = flat.map((p) => ({ x: p.x + sa.dx, y: p.y + sa.dz }));
      else {
        if (sa) flat = dragEnd(flat, sa, 'start');
        if (sb) flat = dragEnd(flat, sb, 'end');
      }
      const endAt = (e: WireEnd, p: Point): Vec3 => {
        const a = e.kind === 'terminal' ? attachOf(e.component, e.terminal) : undefined;
        return a ? { x: a.x, y: a.y, z: a.z } : { x: p.x, y: WIRE.baseHeightMm, z: p.y };
      };
      const a = endAt(w.from, flat[0]!);
      const b = endAt(w.to, flat[flat.length - 1]!);
      // Pins under a part's body (relay, PIR module, matrix): the wire's last run reaches the pin
      // straight in from outside the body, perpendicular to the nearest edge, so wires to
      // neighbouring pins run side by side instead of overlapping (and passing over each other's
      // pins). Every other end keeps the Sprint 9/10 rule (moveEnd only).
      const approach = (e: WireEnd, at: Vec3): [Point, Point] | null =>
        e.kind === 'terminal' ? underBodyApproach(components, e.component, e.terminal, at) : null;
      const pa = approach(w.from, a);
      const pb = approach(w.to, b);
      // [pre, approach]: the run comes in along the pin's own perpendicular (unique per pin), drops
      // at the approach point and goes in at pin level.
      if (pa) flat = [{ x: a.x, y: a.z }, pa[1], ...moveEnd(flat, pa[0], 'start')];
      else flat = moveEnd(flat, { x: a.x, y: a.z }, 'start');
      if (pb) flat = [...moveEnd(flat, pb[0], 'end'), pb[1], { x: b.x, y: b.z }];
      else flat = moveEnd(flat, { x: b.x, y: b.z }, 'end');
      routes.set(w.id, { flat, ends: [a, b], under: [!!pa, !!pb] });
    }

    const heights = wireHeights(doc, components, routes);
    for (const w of doc.layout.wires) {
      const r = routes.get(w.id);
      if (!r) continue;
      const node = groupNode.get(nodeKey(w.from)) ?? null;
      const h = heights.get(w.id)!;
      const [a, b] = r.ends;
      // An end under a part's body: the wire drops at the approach point (outside the body) to the
      // pin's level and runs straight in at that level (under the body edge) to the pin.
      const run = r.flat.map((p) => ({ x: p.x, y: h, z: p.y }));
      if (r.under[0]) {
        const ap = run[1]!;
        run.splice(0, 2, { x: a.x, y: a.y, z: a.z }, { x: ap.x, y: a.y, z: ap.z }, ap);
      }
      if (r.under[1]) {
        const ap = run[run.length - 2]!;
        run.splice(run.length - 2, 2, ap, { x: ap.x, y: b.y, z: ap.z }, { x: b.x, y: b.y, z: b.z });
      }
      const points: Vec3[] = [a, ...run, b];
      wires.push({
        id: w.id,
        node,
        color: wireColor.get(w.id)?.hex ?? NEUTRAL_HEX,
        points: dedupe(points),
        ends: [endKind(w.from), endKind(w.to)],
      });
    }
  } else
    for (const w of freshWires(
      doc,
      components,
      bodies,
      separation.offsets,
      (w) => groupNode.get(nodeKey(w.from)) ?? null,
    )) {
      const src = doc.layout.wires.find((x) => x.id === w.id)!;
      const node = groupNode.get(nodeKey(src.from)) ?? null;
      wires.push({
        id: w.id,
        node,
        color: wireColor.get(w.id)?.hex ?? NEUTRAL_HEX,
        points: w.points,
        radii: w.radii,
        ends: [endKind(src.from), endKind(src.to)],
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

  return {
    components,
    wires,
    joints,
    ...extent(components, wires),
    separation: {
      moved: [...separation.offsets].map(([id, o]) => ({ id, ...o })),
      unresolved: separation.unresolved,
    },
  };
}

interface Route {
  flat: Point[];
  ends: [Vec3, Vec3];
  /** Whether each end reaches a pin under a part's body (its last plan run is at pin level). */
  under: [boolean, boolean];
}

/** The plan route at the wire's own height: without the pin-level runs under a body. */
const main = (r: Route): Point[] =>
  r.flat.slice(r.under[0] ? 1 : 0, r.under[1] ? r.flat.length - 1 : r.flat.length);

/** Models whose pins sit under their body. */
const UNDER_BODY: ReadonlySet<ModelKey> = new Set([
  'relay.cube',
  'sensor.pir',
  'display.matrix',
  'led.radial',
  'sensor.ultrasonic',
  'sensor.dht22',
]);

/**
 * For a pin under a part's body: the plan point just outside the body, straight out from the pin
 * across the nearest edge (perpendicular to it), from which the wire's last run goes to the pin.
 */
function underBodyApproach(
  components: SceneComponent[],
  id: string,
  terminal: string,
  at: Vec3,
): [Point, Point] | null {
  const c = components.find((x) => x.id === id);
  if (!c || !UNDER_BODY.has(c.model)) return null;
  // The pin in the part's local frame (undo the placement rotation).
  const back = rotatePoint(
    { x: at.x - c.x, y: at.z - c.z },
    ((360 - c.rotation) % 360) as Rotation,
  );
  const [x0, x1, z0, z1] = FOOTPRINT[c.model];
  const out = (k: number) => [
    { p: { x: x0 - k, y: back.y } },
    { p: { x: x1 + k, y: back.y } },
    { p: { x: back.x, y: z0 - k } },
    { p: { x: back.x, y: z1 + k } },
  ];
  const [side, drop, pre] = pinExit(c.type, c.model, terminal, { x: back.x, y: 0, z: back.y });
  const world = (q: Point) => {
    const r = rotatePoint(q, c.rotation);
    return { x: c.x + r.x, y: c.z + r.y };
  };
  return [world(out(pre)[side]!.p), world(out(drop)[side]!.p)];
}
/**
 * Where the wire of a pin under a body leaves it (local frame): the side it exits by (index into
 * FOOTPRINT: 0 -x, 1 +x, 2 -z, 3 +z, the edge nearest the pin), how far outside that edge it drops
 * (its riser) and where its run before the drop starts.
 */
function pinExit(
  type: ComponentTypeId,
  model: ModelKey,
  terminal: string,
  at: Vec3,
): [0 | 1 | 2 | 3, number, number] {
  const [x0, x1, z0, z1] = FOOTPRINT[model];
  const d = [at.x - x0, x1 - at.x, at.z - z0, z1 - at.z];
  const side = d.reduce((m, g, i) => (g < d[m]! ? i : m), 0) as 0 | 1 | 2 | 3;
  // The drop is at least CLEAR_OUT outside the body, and no nearer than the terminal's own 2D
  // position (a package whose pins have stubs in 2D: the drop is at the stub's end, where 2D
  // routing lets no other wire pass).
  const off = CATALOG[type].terminals.find((t) => t.id === terminal)!.offset;
  const tx = off.x * SCALE;
  const tz = off.y * SCALE;
  const beyond = [x0 - tx, tx - x1, z0 - tz, tz - z1][side]!;
  // Stubs reaching well beyond the body: turn in at the stub row and drop just inside it.
  const stub = beyond > CLEAR_OUT + STUB_IN;
  return [side, stub ? beyond - STUB_IN : CLEAR_OUT, stub ? beyond : CLEAR_OUT + PRE_OUT];
}

/** The run before the drop comes in along the pin's own line over this length (mm). */
const PRE_OUT = 2.5;
/** With 2D pin stubs: the drop is this far inside the stub row (mm). */
const STUB_IN = 1.5;
/** How far outside the body the last run starts (mm). */
const CLEAR_OUT = 2.0;

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

/**
 * Drag one end of an orthogonal plan route by (dx, dz), keeping it orthogonal: along its last run
 * the run stretches; across it the run moves with the end (the run before it stretches). A route
 * that is a single run gets a jog in its middle.
 */
function dragEnd(flat: Point[], d: { dx: number; dz: number }, which: 'start' | 'end'): Point[] {
  const pts = (which === 'start' ? [...flat].reverse() : [...flat]).map((p) => ({ ...p }));
  const n = pts.length;
  const last = pts[n - 1]!;
  const prev = pts[n - 2]!;
  const along = Math.abs(prev.y - last.y) < EPS ? 'x' : 'z';
  if (n === 2 && (along === 'x' ? d.dz : d.dx) !== 0) {
    // One straight run: split it, the far half stays, the near half moves across.
    const mid = { x: (prev.x + last.x) / 2, y: (prev.y + last.y) / 2 };
    const out =
      along === 'x'
        ? [prev, mid, { x: mid.x, y: mid.y + d.dz }, { x: last.x + d.dx, y: last.y + d.dz }]
        : [prev, mid, { x: mid.x + d.dx, y: mid.y }, { x: last.x + d.dx, y: last.y + d.dz }];
    return which === 'start' ? out.reverse() : out;
  }
  last.x += d.dx;
  last.y += d.dz;
  if (n > 2) {
    if (along === 'x') prev.y += d.dz;
    else prev.x += d.dx;
  }
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
  routes: Map<string, Route>,
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
  // Where a wire's riser stands outside a body (the approach point of a pin under it): another
  // wire passing there must clear that riser like a pin (assign: above the riser's own height).
  for (const r of routes.values())
    for (const k of [0, 1] as const)
      if (r.under[k]) {
        const m = main(r);
        spots.push({ p: k === 0 ? m[0]! : m[m.length - 1]!, h: r.ends[k].y });
      }
  // The pin-level runs under a body (deriveScene): other wires must clear them like a pin.
  const lowRuns: { wire: string; p: Point; h: number }[] = [];
  for (const [id, r] of routes)
    for (const k of [0, 1] as const) {
      if (!r.under[k]) continue;
      const [pin, ap] = k === 0 ? [r.flat[0]!, r.flat[1]!] : [r.flat.at(-1)!, r.flat.at(-2)!];
      const h = r.ends[k].y;
      for (const f of [0, 0.25, 0.5, 0.75])
        lowRuns.push({
          wire: id,
          p: { x: ap.x + (pin.x - ap.x) * f, y: ap.y + (pin.y - ap.y) * f },
          h,
        });
    }

  const floor = new Map<string, number>();
  const passes = new Map<string, Set<string>>();
  const endsAt = new Map<string, string[]>();
  for (const w of doc.layout.wires) {
    const r = routes.get(w.id);
    if (!r) continue;
    // Where this wire's risers stand: its route ends, or for a pin under a body the approach point
    // outside it (the wire drops there).
    const m = main(r);
    const ends = [m[0]!, m[m.length - 1]!];
    for (const e of ends) endsAt.set(key(e), [...(endsAt.get(key(e)) ?? []), w.id]);
    const own = new Set(
      [w.from, w.to].flatMap((e) => (e.kind === 'terminal' ? [e.component] : [])),
    );
    const underOwn = new Set(
      ([w.from, w.to] as const).flatMap((e, k) =>
        e.kind === 'terminal' && r.under[k] ? [e.component] : [],
      ),
    );
    const segs = segsOf(m);
    const passed = [...spots, ...lowRuns.filter((l) => l.wire !== w.id)].filter(
      (s) =>
        !ends.some((e) => Math.hypot(e.x - s.p.x, e.y - s.p.y) < NEAR_MM) &&
        segs.some((g) => nearSeg(s.p, g)),
    );
    passes.set(w.id, new Set(passed.map((s) => key(s.p))));
    const over = Math.max(
      ...passed.map((s) => s.h + WIRE.clearanceMm),
      ...bodies
        // A wire clears the bodies it crosses, its own part's too when it reaches a pin under
        // that body (its last run goes under the edge at pin level, see deriveScene).
        .filter((b) => (!own.has(b.id) || underOwn.has(b.id)) && crossesBody(main(r), b))
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
      const a = main(routes.get(ids[i]!)!);
      const b = main(routes.get(ids[j]!)!);
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
    // Wires that meet must be a full level apart (more than a wire's diameter), not merely at
    // different heights: two floors that differ by less than a level would still touch.
    const taken = [...meets.get(id)!]
      .map((o) => height.get(o))
      .filter((h): h is number => h !== undefined);
    const free = (h: number) => taken.every((t) => Math.abs(t - h) >= WIRE.levelStepMm - 1e-6);
    const levels = [i % 3, ...Array.from({ length: 64 }, (_, k) => k)];
    const level = levels.find((k) => free(round(base + k * WIRE.levelStepMm)))!;
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

// ---- Fresh 3D wire routes (Sprint 10 owner review: the PIR alarm and relay examples) ----------
//
// Order of operations (buildScene): base transforms from 2D -> body separation -> final
// transforms -> final terminal positions -> THESE ROUTES (plan path, then heights: route3d.ts)
// -> natural drape (wireShape.ts) -> labels (renderer). A wire is never routed before the
// separation and stretched afterwards.
//
// Plan path of a wire, from its final terminals:
// - a pin UNDER a part's body (relay, PIR, matrix, LED legs) leaves through an EXIT LANE: straight
//   out at pin level, past the body edge, on the side that suits its destination (the nearest
//   edge, or a farther one when the destination lies that way) and that passes no other pin of
//   the part; lanes of neighbouring pins are parallel;
// - FAN-OUT: wires turning the same way off one side of a part turn one after another, the one
//   nearest that way first, each a pin pitch further out, with concentric bends: a ribbon that
//   opens without crossing itself;
// - the 2D route supplies the topology in between; its stretch inside the part's 3D zone (where
//   the 2D terminal sits, often inside the real body) is dropped and the lane joins the rest of
//   the route by the shortest orthogonal connection that neither reverses nor crosses the part;
// - other ends (lead tips, posts, jumper housings, junctions) keep the 2D route's end moved onto
//   the real attach point; a part moved by the separation drags its end runs along;
// - zig-zags (back-and-forth spikes, collinear points) are removed.

type LayoutWire = ProjectDocument['layout']['wires'][number];

/** Routing rounds the last scene needed (1 normally; diagnostics and measurements). */
export const routeStats = { rounds: 0 };

/** Pitch between fanned-out lanes, and the innermost lane's bend radius (mm). */
const LANE_PITCH = 2.54;
const LANE_BEND = 2.5;
/** Straight exit up out of a jumper housing before the wire bends (mm). */
const JUMPER_EXIT = 2.5;
/** Around a part with pins under its body: the 2D route inside this margin is re-routed. */
const ZONE = CLEAR_OUT + 4;

interface UnderEnd {
  comp: SceneComponent;
  /** Pin plan point, exit direction (outward) and lateral axis, world. */
  pin: Point;
  u: Point;
  v: Point;
  side: number;
  /** From the pin to just outside the body edge, along u. */
  reach: number;
  turn: -1 | 0 | 1;
  lane: number;
  radius: number;
}

const add = (p: Point, d: Point, k: number): Point => ({ x: p.x + d.x * k, y: p.y + d.y * k });
const dotP = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const sub2 = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const plen = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** World plan rectangle of a part's footprint, padded. */
function footRect(c: SceneComponent, pad: number) {
  const [x0, x1, z0, z1] = FOOTPRINT[c.model];
  const pts = [
    [x0, z0],
    [x1, z0],
    [x0, z1],
    [x1, z1],
  ].map(([x, z]) => place(c, { x: x!, y: 0, z: z! }));
  return {
    x0: Math.min(...pts.map((p) => p.x)) - pad,
    x1: Math.max(...pts.map((p) => p.x)) + pad,
    z0: Math.min(...pts.map((p) => p.z)) - pad,
    z1: Math.max(...pts.map((p) => p.z)) + pad,
  };
}
const inRect = (p: Point, r: ReturnType<typeof footRect>) =>
  p.x > r.x0 && p.x < r.x1 && p.y > r.z0 && p.y < r.z1;

/** The route from its start, from where it first leaves `r` (null: it never does). */
function leave(route: Point[], r: ReturnType<typeof footRect>): Point[] | null {
  if (!inRect(route[0]!, r)) return route;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    if (inRect(b, r)) continue;
    // The crossing of a -> b with the rectangle's boundary (axis-aligned run).
    let t = 1;
    for (const [p, q, lo, hi] of [
      [a.x, b.x, r.x0, r.x1],
      [a.y, b.y, r.z0, r.z1],
    ] as const) {
      if (q > hi && p <= hi) t = Math.min(t, (hi - p) / (q - p));
      if (q < lo && p >= lo) t = Math.min(t, (lo - p) / (q - p));
    }
    return [{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, ...route.slice(i)];
  }
  return null;
}

/** Collinear points and back-and-forth spikes removed; `keep` indices are never removed. */
function simplify(pts: Point[], keep: (p: Point) => boolean): Point[] {
  // Near-duplicates dropped; the first and last points are always the exact ends.
  let out: Point[] = [];
  pts.forEach((p, i) => {
    const prev = out[out.length - 1];
    if (prev && plen(p, prev) <= 1e-6) {
      if (i === pts.length - 1) out[out.length - 1] = p;
      return;
    }
    out.push(p);
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1]!;
      const p = out[i]!;
      const b = out[i + 1]!;
      if (keep(p)) continue;
      const u = sub2(p, a);
      const w = sub2(b, p);
      const cross = u.x * w.y - u.y * w.x;
      if (Math.abs(cross) < 1e-6) {
        out = [...out.slice(0, i), ...out.slice(i + 1)];
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * From a lane's end E heading `u`, join a path (its first points): the shortest orthogonal
 * connection that turns at E when the wire must turn (fan-out), never reverses, never re-enters
 * the part. Returns the path from E.
 */
function connect(
  e: UnderEnd,
  E: Point,
  rest: Point[],
  body: ReturnType<typeof footRect>,
  others: Obstacle[],
) {
  // Crossing another part's body costs as much as a long detour: the connection keeps to the
  // 2D route's way around it rather than cutting across (and climbing over) it.
  const pad = WIRE.radiusMm + 0.3;
  const crosses = (a: Point, b: Point) =>
    others.some((o) => {
      const n = Math.max(1, Math.ceil(plen(a, b) / 0.5));
      for (let k = 0; k <= n; k++) {
        const q = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
        if (q.x > o.x0 - pad && q.x < o.x1 + pad && q.y > o.z0 - pad && q.y < o.z1 + pad)
          return true;
      }
      return false;
    });
  let best: { cost: number; path: Point[] } | null = null;
  for (let j = 0; j < Math.min(6, rest.length); j++) {
    const R = rest[j]!;
    const d = sub2(R, E);
    for (const lateral of [true, false]) {
      const corner = lateral ? add(E, e.v, dotP(d, e.v)) : add(E, e.u, dotP(d, e.u));
      const path = [E, corner, ...rest.slice(j)];
      let cost = 0;
      for (let i = 1; i < path.length; i++) cost += plen(path[i - 1]!, path[i]!);
      // Straight on first when the wire has to turn: the ribbon would not open (crossing lanes).
      if (!lateral && e.turn !== 0 && Math.abs(dotP(d, e.v)) > 1) cost += 15;
      // Reversals and runs back across the part.
      for (let i = 2; i < path.length; i++) {
        const u1 = sub2(path[i - 1]!, path[i - 2]!);
        const u2 = sub2(path[i]!, path[i - 1]!);
        const l1 = Math.hypot(u1.x, u1.y);
        const l2 = Math.hypot(u2.x, u2.y);
        if (l1 > 1e-6 && l2 > 1e-6 && dotP(u1, u2) / (l1 * l2) < -0.99) cost += 60;
      }
      if (dotP(sub2(corner, E), e.u) < -1e-6) cost += 60;
      for (let i = 1; i <= Math.min(2, path.length - 1); i++)
        if (crosses(path[i - 1]!, path[i]!)) cost += 120;
      for (let i = 1; i < 3 && i < path.length; i++) {
        const m = { x: (path[i - 1]!.x + path[i]!.x) / 2, y: (path[i - 1]!.y + path[i]!.y) / 2 };
        if (inRect(m, body)) cost += 60;
      }
      if (!best || cost < best.cost - 1e-9) best = { cost, path };
    }
  }
  return best ? best.path : [E];
}

/** Deepest shallow overlap a run may sidestep in plan, and the taper length of the sidestep. */
const DODGE_MAX = 3;
const DODGE_TAPER = 3;

/**
 * Small lateral offset first: a run that grazes a part's body (its 2D route hugs a 3D body larger
 * than the symbol) sidesteps it in plan with gentle tapers, instead of climbing over it. Only when
 * the sidestep is shallow, fits between the run's ends and hits nothing else; otherwise the run
 * is left for the height profile to lift over the body.
 */
function dodge(plan: Point[], obstacles: Obstacle[]): Point[] {
  const pad = WIRE.radiusMm + 0.3;
  const hit = (a: Point, b: Point, skip: Obstacle | null) =>
    obstacles.some((o) => {
      if (o === skip) return false;
      // Sample the run against the padded rectangle.
      const n = Math.max(1, Math.ceil(plen(a, b) / 0.5));
      for (let k = 0; k <= n; k++) {
        const q = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
        if (q.x > o.x0 - pad && q.x < o.x1 + pad && q.y > o.z0 - pad && q.y < o.z1 + pad)
          return true;
      }
      return false;
    });
  let out = [...plan];
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1]!;
    const b = out[i]!;
    const horizontal = Math.abs(a.y - b.y) < 1e-9;
    const vertical = Math.abs(a.x - b.x) < 1e-9;
    if (!horizontal && !vertical) continue;
    for (const o of obstacles) {
      // Along/lateral coordinates of this run and the padded rectangle.
      const [al0, al1, lat] = horizontal ? [a.x, b.x, a.y] : [a.y, b.y, a.x];
      const [lo, hi, rlo, rhi] = horizontal
        ? [o.x0 - pad, o.x1 + pad, o.z0 - pad, o.z1 + pad]
        : [o.z0 - pad, o.z1 + pad, o.x0 - pad, o.x1 + pad];
      if (lat <= rlo || lat >= rhi) continue;
      const s0 = Math.max(Math.min(al0, al1), lo);
      const s1 = Math.min(Math.max(al0, al1), hi);
      if (s1 <= s0) continue;
      const depth = Math.min(lat - rlo, rhi - lat);
      if (depth > DODGE_MAX) continue;
      const off = lat - rlo < rhi - lat ? rlo - 0.05 : rhi + 0.05;
      const dir = al1 > al0 ? 1 : -1;
      // The sidestep: taper out before the body, run beside it, taper back after it.
      const [e0, e1] = dir > 0 ? [s0, s1] : [s1, s0];
      const t0 = e0 - dir * DODGE_TAPER;
      const t1 = e1 + dir * DODGE_TAPER;
      if ((t0 - al0) * dir < 0.5 || (al1 - t1) * dir < 0.5) continue;
      const P = (along: number, l: number): Point =>
        horizontal ? { x: along, y: l } : { x: l, y: along };
      const side = [P(t0, lat), P(e0, off), P(e1, off), P(t1, lat)];
      const pts = [a, ...side, b];
      if (pts.slice(1).some((q, k) => hit(pts[k]!, q, null))) continue;
      out = [...out.slice(0, i), ...side, ...out.slice(i)];
      i += side.length;
      break;
    }
  }
  return out;
}

/**
 * What a wire must clear around a leaded part (route3d.ts obstacles), local frame: its body at
 * full height over its real length, and the leads beside it only as high as the leads run (a wire
 * reaching a lead end along the part does not climb over the whole part). Null: the part's
 * collision boxes (collisionBoxes) are used as they are.
 */
function routeBoxes(model: ModelKey, farads?: number): Box[] | null {
  const [x0, x1, z0, z1] = FOOTPRINT[model];
  const top = MODEL_HEIGHT[model];
  const LEADS = 2.8;
  const axial = (half: number, zHalf: number): Box[] => [
    { x0: -half, x1: half, z0, z1, y0: 0, y1: top },
    { x0, x1, z0: -zHalf, z1: zHalf, y0: 0, y1: LEADS },
  ];
  switch (model) {
    case 'resistor.axial':
      return axial(RESISTOR.bodyLengthMm / 2 + 0.2, 0.6);
    case 'diode.axial':
      return axial(DIODE_DO35.bodyLengthMm / 2 + 0.2, 0.6);
    case 'switch.toggle':
      return axial(TOGGLE.bodyXMm / 2, 0.8);
    case 'instrument.psu': {
      // The case, and its two binding posts sticking out of the front at post height (a wire may
      // pass under them on the bench).
      const r = PSU.postDiameterMm / 2;
      const post = (zc: number): Box => ({
        x0: PSU.frontXMm,
        x1,
        z0: zc - r,
        z1: zc + r,
        y0: PSU.attachHeightMm - r,
        y1: PSU.attachHeightMm + r,
      });
      return [{ x0, x1: PSU.frontXMm, z0, z1, y0: 0, y1: top }, post(-3.175), post(3.175)];
    }
    case 'transistor.to92': {
      // The D-shaped body, and each lead from under it to its terminal: high near the body, low
      // near the terminal (the leads splay down to the bench).
      const R = TO92.widthMm / 2;
      const boxes: Box[] = [{ x0: -R, x1: R, z0: -R, z1: TO92.depthMm - R, y0: 0, y1: top }];
      const lr = TO92.leadWidthMm / 2 + 0.1;
      for (const t of CATALOG['component.bjt_npn'].terminals) {
        const tx = t.offset.x * SCALE;
        const tz = t.offset.y * SCALE;
        const mx = tx / 2;
        const mz = tz / 2;
        const seg = (ax: number, az: number, bx: number, bz: number, y1: number): Box => ({
          x0: Math.min(ax, bx) - lr,
          x1: Math.max(ax, bx) + lr,
          z0: Math.min(az, bz) - lr,
          z1: Math.max(az, bz) + lr,
          y0: 0,
          y1,
        });
        boxes.push(seg(0, 0, mx, mz, TO92.standoffMm + 0.4), seg(mx, mz, tx, tz, 1.9));
      }
      return boxes;
    }
    case 'led.rgb': {
      const R = RGB_LED_5MM.flangeDiameterMm / 2;
      return [
        { x0: -R, x1: R, z0: -R, z1: R, y0: 0, y1: top },
        { x0, x1, z0, z1, y0: 0, y1: LEADS },
      ];
    }
    case 'ldr.disc':
      return axial(LDR_GL5528.diameterMm / 2, 0.6);
    case 'capacitor.radial': {
      // The disc or can over its leads; the leads low out to the terminals.
      const p = capacitorPackage(farads ?? 100e-6);
      const half = p.kind === 'disc' ? p.thicknessMm / 2 : p.diameterMm / 2;
      const bodyX = p.diameterMm / 2;
      const height = p.standoffMm + (p.kind === 'disc' ? p.diameterMm : p.heightMm);
      return [
        { x0: -bodyX, x1: bodyX, z0: -half, z1: half, y0: 0, y1: height },
        { x0, x1, z0: -0.6, z1: 0.6, y0: 0, y1: LEADS },
      ];
    }
    case 'ground.post': {
      // The plate, and the post standing on it.
      const zc = -3.175 + GROUND_POST.postOffsetZMm;
      const r = GROUND_POST.postDiameterMm / 2;
      return [
        { x0, x1, z0, z1, y0: 0, y1: GROUND_POST.plateThicknessMm },
        { x0: -r, x1: r, z0: zc - r, z1: zc + r, y0: 0, y1: top },
      ];
    }
    case 'board.esp32_devkitc':
      // The board up to the module's top (pins: spots; jumper housings: their own obstacles).
      return [{ x0, x1, z0, z1, y0: 0, y1: ESP32_PCB_TOP + 3.3 }];
    case 'switch.tactile':
      return [
        { x0: -TACTILE.bodyMm / 2, x1: TACTILE.bodyMm / 2, z0, z1, y0: 0, y1: top },
        { x0, x1, z0, z1, y0: 0, y1: LEADS },
      ];
    default:
      return null;
  }
}

/**
 * What wires must clear (route3d.ts): every part's routing volumes at its final transform
 * (routeBoxes, else its collision boxes), and each ESP32 jumper housing as an obstacle of its own
 * (only the wire plugged into it may start inside it).
 */
function routingObstacles(
  components: SceneComponent[],
  bodies: Body[],
  offsets: Map<string, { dx: number; dz: number }>,
): Obstacle[] {
  const out: Obstacle[] = bodies.flatMap((body) => {
    const o = offsets.get(body.id) ?? { dx: 0, dz: 0 };
    const lean = routeBoxes(body.model, body.farads);
    return worldBoxes(lean ? { ...body, boxes: lean } : body, o.dx, o.dz)
      .filter((q) => !q.node)
      .map((q) => ({
        part: body.id,
        x0: q.x0,
        x1: q.x1,
        z0: q.z0,
        z1: q.z1,
        bottom: q.y0,
        top: q.y1,
      }));
  });
  const half = ESP32_DEVKITC.dupontSizeMm / 2;
  for (const c of components)
    if (c.model === 'board.esp32_devkitc')
      for (const t of c.terminals)
        if (t.y === ESP32_ATTACH_HEIGHT)
          out.push({
            part: `${c.id}:${t.id}`,
            x0: t.x - half,
            x1: t.x + half,
            z0: t.z - half,
            z1: t.z + half,
            bottom: 0,
            top: ESP32_ATTACH_HEIGHT,
          });
  return out;
}

/** The routing obstacles of a derived scene (tests: no wire passes through a body). */
export function sceneObstacles(doc: ProjectDocument, scene: SceneDescription): Obstacle[] {
  const offsets = new Map(scene.separation.moved.map((m) => [m.id, { dx: m.dx, dz: m.dz }]));
  return routingObstacles(scene.components, collisionBodies(doc), offsets);
}

function freshWires(
  doc: ProjectDocument,
  components: SceneComponent[],
  bodies: Body[],
  offsets: Map<string, { dx: number; dz: number }>,
  nodeOf: (w: LayoutWire) => string | null,
): { id: string; points: Vec3[]; radii: number[] }[] {
  const comp = (id: string) => components.find((c) => c.id === id);
  const attach = (e: WireEnd) =>
    e.kind === 'terminal'
      ? comp(e.component)?.terminals.find((t) => t.id === e.terminal)
      : undefined;

  // 1. Plan routes from the 2D topology; non-lane ends dragged with a moved part and moved onto
  //    their attach points; lane ends' routes trimmed where they leave the part's zone.
  interface Prep {
    w: LayoutWire;
    route: Point[];
    ends: [Vec3, Vec3];
    under: [UnderEnd | null, UnderEnd | null];
  }
  const preps: Prep[] = [];
  for (const w of doc.layout.wires) {
    const r2 = wireRoute(doc, w);
    if (!r2 || r2.length < 2) continue;
    let route: Point[] = r2.map((p) => ({ x: p.x * SCALE, y: p.y * SCALE }));
    const ends = [w.from, w.to] as const;
    const isUnder = ends.map(
      (e) => e.kind === 'terminal' && UNDER_BODY.has(comp(e.component)?.model ?? 'generic'),
    );
    const shift = ends.map((e, k) =>
      e.kind === 'terminal' && !isUnder[k] ? offsets.get(e.component) : undefined,
    );
    if (shift[0] && shift[1] && shift[0].dx === shift[1].dx && shift[0].dz === shift[1].dz)
      route = route.map((p) => ({ x: p.x + shift[0]!.dx, y: p.y + shift[0]!.dz }));
    else {
      if (shift[0]) route = dragEnd(route, shift[0], 'start');
      if (shift[1]) route = dragEnd(route, shift[1], 'end');
    }
    const at = ends.map((e, k): Vec3 => {
      const t = attach(e);
      const p = k === 0 ? route[0]! : route[route.length - 1]!;
      return t ? { x: t.x, y: t.y, z: t.z } : { x: p.x, y: FLOOR, z: p.y };
    }) as [Vec3, Vec3];
    if (!isUnder[0]) route = moveEnd(route, { x: at[0].x, y: at[0].z }, 'start');
    if (!isUnder[1]) route = moveEnd(route, { x: at[1].x, y: at[1].z }, 'end');
    // Trim the stretch inside a lane part's zone (both ends).
    for (const k of [0, 1] as const) {
      const e = ends[k];
      if (!isUnder[k] || e.kind !== 'terminal') continue;
      const zone = footRect(comp(e.component)!, ZONE);
      if (!route.length) continue;
      const from = k === 0 ? route : [...route].reverse();
      const rest = leave(from, zone);
      route = rest ? (k === 0 ? rest : [...rest].reverse()) : [];
    }
    preps.push({ w, route, ends: at, under: [null, null] });
  }

  // 2. Exit lanes: side, direction, turn.
  for (const p of preps) {
    for (const k of [0, 1] as const) {
      const e = k === 0 ? p.w.from : p.w.to;
      if (e.kind !== 'terminal') continue;
      const c = comp(e.component);
      if (!c || !UNDER_BODY.has(c.model)) continue;
      const a = p.ends[k];
      const node = c.terminals.find((t) => t.id === e.terminal)?.node ?? null;
      const back = (q: { x: number; z: number }) =>
        rotatePoint({ x: q.x - c.x, y: q.z - c.z }, ((360 - c.rotation) % 360) as Rotation);
      const local = back(a);
      const [x0, x1, z0, z1] = FOOTPRINT[c.model];
      const dirs: Point[] = [
        { x: -1, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: -1 },
        { x: 0, y: 1 },
      ];
      const dist = [local.x - x0, x1 - local.x, local.y - z0, z1 - local.y];
      // Where the wire is going: the first point of its route outside the zone, else the other end.
      const other = k === 0 ? p.ends[1] : p.ends[0];
      const target = (k === 0 ? p.route[0] : p.route[p.route.length - 1]) ?? {
        x: other.x,
        y: other.z,
      };
      const pins = c.terminals
        .filter((t) => t.id !== e.terminal && (t.node === null || t.node !== node))
        .map((t) => back(t));
      let best: { cost: number; side: number } | null = null;
      for (let side = 0; side < 4; side++) {
        const d = dirs[side]!;
        const run = dist[side]! + CLEAR_OUT;
        // The lane must not pass another pin of the part (at pin level it would touch it).
        const blocked = pins.some((q) => {
          const along = (q.x - local.x) * d.x + (q.y - local.y) * d.y;
          const lateral = Math.abs((q.x - local.x) * d.y - (q.y - local.y) * d.x);
          return along > 0 && along < run + 1 && lateral < 1.6;
        });
        if (blocked) continue;
        const exitW = rotatePoint({ x: local.x + d.x * run, y: local.y + d.y * run }, c.rotation);
        const cost = dist[side]! + 0.5 * plen({ x: c.x + exitW.x, y: c.z + exitW.y }, target);
        if (!best || cost < best.cost - 1e-9) best = { cost, side };
      }
      const side = best?.side ?? dist.indexOf(Math.min(...dist));
      const u = rotatePoint(dirs[side]!, c.rotation);
      const v = { x: -u.y, y: u.x };
      const pin = { x: a.x, y: a.z };
      const reach = dist[side]! + CLEAR_OUT;
      const lat = dotP(sub2(target, add(pin, u, reach)), v);
      p.under[k] = {
        comp: c,
        pin,
        u,
        v,
        side,
        reach,
        turn: Math.abs(lat) < 1 ? 0 : lat > 0 ? 1 : -1,
        lane: reach,
        radius: LANE_BEND,
      };
    }
  }
  // 3. Fan-out: per part and side, every lane at its own distance (no two lateral runs on one
  //    line, a near-straight wire's jog included). Lanes turning the same way: the one nearest
  //    that way turns first, with concentric bends; straight lanes next; lanes turning the other
  //    way further out.
  const groups = new Map<string, UnderEnd[]>();
  for (const p of preps)
    for (const e of p.under)
      if (e) {
        const key = `${e.comp.id}|${e.side}`;
        groups.set(key, [...(groups.get(key) ?? []), e]);
      }
  for (const g of groups.values()) {
    const way = (t: number) =>
      g
        .filter((e) => e.turn === t)
        .sort((a, b) => (dotP(b.pin, b.v) - dotP(a.pin, a.v)) * (t || 1));
    const ordered = [...way(1), ...way(0), ...way(-1)];
    const within = new Map<UnderEnd, number>();
    for (const t of [1, 0, -1]) way(t).forEach((e, i) => within.set(e, t === 0 ? 0 : i));
    ordered.forEach((e, k) => {
      e.lane = e.reach + k * LANE_PITCH;
      e.radius = LANE_BEND + within.get(e)! * LANE_PITCH;
    });
  }

  const obstacles = routingObstacles(components, bodies, offsets);
  // A lane never runs into another part (a module separated from a neighbour has room for its
  // lanes' exits, not always for the whole fan): cut back to the longest clear distance (at least
  // the plain exit); lanes then sharing a distance hop over each other locally (route3d.ts).
  for (const p of preps)
    for (const e of p.under) {
      if (!e || e.lane <= e.reach) continue;
      const pad = WIRE.radiusMm + 0.3;
      const blocked = (d: number) => {
        const q = add(e.pin, e.u, d);
        return obstacles.some(
          (o) =>
            o.part !== e.comp.id &&
            o.bottom < 2 &&
            q.x > o.x0 - pad &&
            q.x < o.x1 + pad &&
            q.y > o.z0 - pad &&
            q.y < o.z1 + pad,
        );
      };
      let d = e.lane;
      while (d > e.reach && blocked(d)) d = Math.max(e.reach, d - 0.5);
      e.lane = d;
    }
  // 4. Plan paths, heads and tails, then heights (route3d.ts).
  const inputs: WireRouteInput[] = [];
  for (const p of preps) {
    const [ua, ub] = p.under;
    const [a, b] = p.ends;
    const A = { x: a.x, y: a.z };
    const B = { x: b.x, y: b.z };
    const Ea = ua ? add(ua.pin, ua.u, ua.lane) : A;
    const Eb = ub ? add(ub.pin, ub.u, ub.lane) : B;
    // The destination right in a lane's corridor (a lead end under the module's edge): straight.
    const inCorridor = (e: UnderEnd, q: Point) => {
      const d = sub2(q, e.pin);
      return Math.abs(dotP(d, e.v)) < 1 && dotP(d, e.u) > 0 && dotP(d, e.u) <= e.lane + 1e-6;
    };
    let plan: Point[];
    let laneA = !!ua;
    let laneB = !!ub;
    if (ua && !ub && inCorridor(ua, B)) {
      plan = [ua.pin, B];
      laneA = false;
    } else if (ub && !ua && inCorridor(ub, A)) {
      plan = [A, ub.pin];
      laneB = false;
    } else {
      let mid = p.route.length ? p.route : ua && ub ? [] : ua ? [B] : [A];
      const ground = (part: string) =>
        obstacles.filter((o) => o.bottom < 2 && o.part !== part && !o.part.startsWith(`${part}:`));
      if (ua)
        mid = connect(
          ua,
          Ea,
          mid.length ? mid : [Eb],
          footRect(ua.comp, WIRE.radiusMm),
          ground(ua.comp.id),
        );
      if (ub && plen(mid[mid.length - 1]!, Eb) > 1e-6)
        mid = [
          ...connect(
            ub,
            Eb,
            [...mid].reverse(),
            footRect(ub.comp, WIRE.radiusMm),
            ground(ub.comp.id),
          ),
        ].reverse();
      plan = mid;
      if (!ua) plan = plen(plan[0]!, A) > 1e-6 ? [A, ...plan] : [A, ...plan.slice(1)];
      if (!ub)
        plan = plen(plan[plan.length - 1]!, B) > 1e-6 ? [...plan, B] : [...plan.slice(0, -1), B];
    }
    const fixedPts = [plan[0]!, plan[plan.length - 1]!];
    plan = simplify(plan, (q) => fixedPts.some((f) => plen(f, q) < 1e-6));
    plan = dodge(
      plan,
      obstacles.filter(
        (o) =>
          o.bottom <= 2 &&
          !(p.w.from.kind === 'terminal' && o.part === p.w.from.component) &&
          !(p.w.to.kind === 'terminal' && o.part === p.w.to.component),
      ),
    );
    const kind = (e: WireEnd) =>
      e.kind !== 'terminal'
        ? 'junction'
        : comp(e.component)?.model === 'board.esp32_devkitc'
          ? 'jumper'
          : 'other';
    const endOf = (k: 0 | 1) => {
      const e = k === 0 ? p.w.from : p.w.to;
      const at3 = k === 0 ? a : b;
      const lane = k === 0 ? (laneA ? ua : null) : laneB ? ub : null;
      const P = k === 0 ? plan[0]! : plan[plan.length - 1]!;
      if (lane) return { pts: [at3, { x: P.x, y: at3.y, z: P.y }], y: at3.y };
      if (kind(e) === 'jumper') {
        const up = { ...at3, y: at3.y + JUMPER_EXIT };
        return { pts: [at3, up], y: up.y };
      }
      return { pts: [] as Vec3[], y: at3.y };
    };
    const ha = endOf(0);
    const hb = endOf(1);
    const radii = new Map<number, number>();
    if (laneA && ua) radii.set(0, ua.radius);
    if (laneB && ub) radii.set(plan.length - 1, ub.radius);
    inputs.push({
      id: p.w.id,
      node: nodeOf(p.w),
      plan,
      head: ha.pts,
      tail: [...hb.pts].reverse(),
      startY: ha.y,
      endY: hb.y,
      parts: [p.w.from, p.w.to].map((e) => (e.kind === 'terminal' ? e.component : null)) as [
        string | null,
        string | null,
      ],
      housings: [p.w.from, p.w.to].map((e) =>
        e.kind === 'terminal' ? `${e.component}:${e.terminal}` : null,
      ) as [string | null, string | null],
      ownEnds: [A, B],
      radii,
    });
  }

  const spots: Spot[] = doc.layout.junctions.map((j) => ({
    x: j.x * SCALE,
    z: j.y * SCALE,
    h: FLOOR,
  }));
  for (const c of components) {
    for (const t of c.terminals) spots.push({ x: t.x, z: t.z, h: t.y });
    if (c.model === 'board.esp32_devkitc') {
      // Every header pin's stub (a wired pin's jumper housing: routingObstacles).
      for (const pin of ESP32_DEVKITC_WROOM32.pins) {
        const local = boardPinPosition(pin);
        const q = place(c, {
          x: Math.sign(local.x) * (ESP32_DEVKITC.headerRowSpacingMm / 2),
          y: 0,
          z: realPinZ(pin.position),
        });
        spots.push({ x: q.x, z: q.z, h: ESP32_PIN_TOP });
      }
    }
  }
  // Routing order matters (a wire hops over those routed before it). If wires of different
  // nodes still touch (one passing right over another's terminal before that one was routed),
  // re-route with each such pair's earlier wire moved after the later one; a few rounds at
  // most, deterministic; the order with the fewest contacts wins (the document order on a tie).
  let order = [...inputs];
  let best: { routed: Map<string, WireRoute>; bad: number } | null = null;
  for (let round = 0; round < 4; round++) {
    routeStats.rounds = round + 1;
    const routed = routeWires(order, obstacles, spots);
    const pairs = touchingWires(order, routed);
    if (!best || pairs.length < best.bad) best = { routed, bad: pairs.length };
    if (!pairs.length) break;
    const later = new Set(pairs.map(([a]) => a));
    order = [...order.filter((w) => !later.has(w.id)), ...order.filter((w) => later.has(w.id))];
  }
  return inputs.map((i) => ({ id: i.id, ...best!.routed.get(i.id)! }));
}

/** Pairs of wires of different nodes whose routes touch, [earlier, later] in routing order. */
function touchingWires(
  order: WireRouteInput[],
  routed: Map<string, WireRoute>,
): [string, string][] {
  const out: [string, string][] = [];
  const pts = order.map((w) => routed.get(w.id)!.points);
  const box = pts.map((p) => ({
    x0: Math.min(...p.map((q) => q.x)) - 1.5,
    x1: Math.max(...p.map((q) => q.x)) + 1.5,
    z0: Math.min(...p.map((q) => q.z)) - 1.5,
    z1: Math.max(...p.map((q) => q.z)) + 1.5,
  }));
  for (let i = 0; i < order.length; i++)
    for (let j = i + 1; j < order.length; j++) {
      const a = order[i]!;
      const b = order[j]!;
      if (a.node !== null && a.node === b.node) continue;
      const p = box[i]!;
      const q = box[j]!;
      if (p.x0 > q.x1 || q.x0 > p.x1 || p.z0 > q.z1 || q.z0 > p.z1) continue;
      const A = pts[i]!;
      const B = pts[j]!;
      let hit = false;
      for (let m = 1; m < A.length && !hit; m++)
        for (let n = 1; n < B.length && !hit; n++)
          hit =
            segBoxesMeet(A[m - 1]!, A[m]!, B[n - 1]!, B[n]!, 1.4) &&
            segDistance(A[m - 1]!, A[m]!, B[n - 1]!, B[n]!) < 2 * WIRE_RADIUS + 0.05;
      if (hit) out.push([a.id, b.id]);
    }
  return out;
}
