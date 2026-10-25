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
  LOGIC_SOT23_BREAKOUT,
  LOGIC_SOIC14_BREAKOUT,
  SERVO_SG90,
  SERVO_SHAFT_X_MM,
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
  type Route3dBudget,
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
  | 'servo.sg90'
  | 'logic.sot23'
  | 'logic.soic14'
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
  'component.servo_sg90': 'servo.sg90',
  'logic.gate_and': 'logic.sot23',
  'logic.gate_nand': 'logic.sot23',
  'logic.gate_or': 'logic.sot23',
  'logic.gate_not': 'logic.sot23',
  'logic.quad_and': 'logic.soic14',
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
  /**
   * s20r5 (review r3, MAJOR 3): drawn as a SIMPLE cable (its plan path just above the bench, no
   * height profile, no drape) because the scene's work budget was spent or the wire is far longer
   * than any bench (SCENE_WORK_BUDGET, MAX_WIRE_MM). Always listed in `routeLimits`.
   */
  simple?: true;
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
  /**
   * Sprint 20 (s20r): wires the 3D router could not route safely (a wire touching a wire or a
   * terminal of another node, or passing through a part's body), sorted. The view says so plainly
   * instead of letting misleading geometry stand unexplained. Set by deriveScene.
   */
  routeLimits?: string[];
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
  'logic.sot23':
    LOGIC_SOT23_BREAKOUT.standoffMm +
    LOGIC_SOT23_BREAKOUT.boardThicknessMm +
    LOGIC_SOT23_BREAKOUT.bodyHeightMm,
  'logic.soic14':
    LOGIC_SOIC14_BREAKOUT.standoffMm +
    LOGIC_SOIC14_BREAKOUT.boardThicknessMm +
    LOGIC_SOIC14_BREAKOUT.bodyHeightMm,
  'sensor.pir': PIR_HC_SR501.standoffMm + PIR_HC_SR501.boardThicknessMm + PIR_HC_SR501.domeHeightMm,
  'display.matrix': LED_MATRIX_1088AS.standoffMm + LED_MATRIX_1088AS.heightMm,
  // The largest can (the body of a given value is in its visual).
  'capacitor.radial': 21,
  'sensor.ultrasonic': HC_SR04_MODULE.standoffMm + HC_SR04_MODULE.boardYMm,
  'sensor.dht22': DHT22_CASE.standoffMm + DHT22_CASE.heightMm,
  'display.lcd1602':
    LCD1602_MODULE.standoffMm + LCD1602_MODULE.pcbThicknessMm + LCD1602_MODULE.bezelHeightMm,
  'servo.sg90': SERVO_SG90.heightMm,
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
  'logic.sot23': [
    -LOGIC_SOT23_BREAKOUT.boardSizeMm / 2,
    LOGIC_SOT23_BREAKOUT.boardSizeMm / 2,
    -LOGIC_SOT23_BREAKOUT.boardSizeMm / 2,
    LOGIC_SOT23_BREAKOUT.boardSizeMm / 2,
  ],
  'logic.soic14': [
    -LOGIC_SOIC14_BREAKOUT.boardXMm / 2,
    LOGIC_SOIC14_BREAKOUT.boardXMm / 2,
    -LOGIC_SOIC14_BREAKOUT.boardZMm / 2,
    LOGIC_SOIC14_BREAKOUT.boardZMm / 2,
  ],
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
    HC_SR04_MODULE.centreZMm - HC_SR04_MODULE.boardZMm / 2,
    HC_SR04_MODULE.centreZMm + HC_SR04_MODULE.boardZMm / 2,
  ],
  'sensor.dht22': [
    -DHT22_CASE.depthXMm / 2,
    DHT22_CASE.depthXMm / 2,
    DHT22_CASE.centreZMm - DHT22_CASE.widthZMm / 2,
    DHT22_CASE.centreZMm + DHT22_CASE.widthZMm / 2,
  ],
  'display.lcd1602': [
    LCD1602_MODULE.pcbLeftXMm,
    LCD1602_MODULE.pcbLeftXMm + LCD1602_MODULE.pcbXMm,
    LCD1602_MODULE.pcbCentreZMm - LCD1602_MODULE.pcbZMm / 2,
    LCD1602_MODULE.pcbCentreZMm + LCD1602_MODULE.pcbZMm / 2,
  ],
  // Sprint 15: from the plug's sockets to the case's tabs, and the horn's sweep round the shaft.
  'servo.sg90': [
    SERVO_SG90.plugTipXMm,
    SERVO_SHAFT_X_MM + SERVO_SG90.hornReachMm + SERVO_SG90.hornTipWidthMm / 2,
    -SERVO_SG90.hornReachMm - SERVO_SG90.hornTipWidthMm / 2,
    SERVO_SG90.hornReachMm + SERVO_SG90.hornTipWidthMm / 2,
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
    // Sprint 19B: the breakout's header pins stand at the gate's terminals.
    case 'logic.sot23':
      return { x, y: LOGIC_SOT23_BREAKOUT.attachHeightMm, z };
    // L3: the 14-pin breakout's header pins stand at the package's terminals.
    case 'logic.soic14':
      return { x, y: LOGIC_SOIC14_BREAKOUT.attachHeightMm, z };
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
    // Sprint 15: the servo plug's sockets (on the 2D terminal column, at the real 2.54 mm pitch).
    case 'servo.sg90': {
      const [px, pz] = SERVO_SG90.pins[terminal]!;
      return { x: px, y: SERVO_SG90.attachHeightMm, z: pz };
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
  const touching = touchingNodesReport(first);
  let bad = touching.pairs.length;
  // (A scene past its work budget is not built again by the other routers: s20r5.)
  // Nor once its first build spent a quarter of it (the other routers cost as much again).
  // Nor when the contact check itself ran out of work (s20r6: as costly to repeat).
  if (
    !bad ||
    touching.unchecked.length ||
    first.wires.some((w) => w.simple) ||
    sceneStats.work > SCENE_WORK_BUDGET / 4
  )
    return withLimits(doc, first, touching);
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
    const n = touchingNodesReport(s).pairs.length;
    if (n < bad) {
      best = s;
      bad = n;
      if (!n) break;
    }
  }
  return withLimits(doc, best);
}

/** The scene with its routing limitations (`routeLimits`) recorded. */
function withLimits(
  doc: ProjectDocument,
  s: SceneDescription,
  touching?: ReturnType<typeof touchingNodesReport>,
): SceneDescription {
  return { ...s, routeLimits: routeLimits(doc, s, touching) };
}

/**
 * Wires of a scene that are not routed safely (s20r): touching a wire or terminal of another
 * node (touchingNodes), or passing through the routing volume of a part they do not end on, or
 * through a raised volume of one they do (the same criterion as the 3D geometry tests:
 * app/tests/support/scene3dChecks.ts). Checked on the route; the drawn cable never comes closer
 * to anything than its route (wireShape.ts).
 */
export function routeLimits(
  doc: ProjectDocument,
  s: SceneDescription,
  touching: ReturnType<typeof touchingNodesReport> = touchingNodesReport(s),
): string[] {
  const out = new Set<string>(touching.unchecked);
  for (const k of touching.pairs) {
    const [kind, rest] = [k.slice(0, 1), k.slice(2)];
    if (kind === 'w') for (const id of rest.split('|')) out.add(id);
    else out.add(rest.split('|')[0]!);
  }
  const obstacles = sceneObstacles(doc, s);
  // (The first wire of an id, as a find would give.)
  const sources = new Map([...doc.layout.wires].reverse().map((x) => [x.id, x]));
  const m = WIRE.radiusMm * 0.8;
  for (const w of s.wires) {
    // A simple cable (the scene's work budget, s20r5) is a limitation by definition.
    if (w.simple) out.add(w.id);
    if (out.has(w.id)) continue;
    const src = sources.get(w.id);
    if (!src) continue;
    const own = [src.from, src.to].flatMap((e) =>
      e.kind === 'terminal' ? [e.component, `${e.component}:${e.terminal}`] : [],
    );
    const ends = [w.points[0]!, w.points[w.points.length - 1]!];
    const isOwn = (o: Obstacle) =>
      own.includes(o.part) || own.some((x) => o.part.startsWith(`${x}:`));
    // Only the volumes the wire's plan extent reaches.
    const xs = w.points.map((p) => p.x);
    const zs = w.points.map((p) => p.z);
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    const near = obstacles.filter(
      (o) => o.x1 + m > x0 && o.x0 - m < x1 && o.z1 + m > z0 && o.z0 - m < z1,
    );
    let hit = false;
    for (let i = 1; i < w.points.length && !hit; i++) {
      const a = w.points[i - 1]!;
      const b = w.points[i]!;
      // Every 0.5 mm, at most MAX_SAMPLES per segment (s20r5: never per length unbounded).
      const n = Math.min(
        MAX_SAMPLES,
        Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.5)),
      );
      for (let k = 0; k <= n && !hit; k++) {
        const t = k / n;
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
        for (const o of near)
          if (bodyHit(o, p, isOwn(o), ends)) {
            hit = true;
            break;
          }
      }
    }
    if (hit) out.add(w.id);
  }
  return [...out].sort(byWireId);
}
/**
 * Whether a point of a wire lies in a part's volume (routeLimits; s21r: the drawn-cable check
 * uses the same test). A body on the bench of a part the wire ends on (`own`) is exempt where the
 * wire is fastened (within 4 mm in plan of its end) or runs at pin level under it (an exit lane);
 * a pass through it anywhere else counts (s20r4, review B6; scene3dChecks the same).
 */
export function bodyHit(o: Obstacle, p: Vec3, own: boolean, ends: readonly Vec3[]): boolean {
  const m = WIRE.radiusMm * 0.8;
  if (
    own &&
    o.bottom < 2 &&
    (ends.some((e) => Math.hypot(e.x - p.x, e.z - p.z) < 4) ||
      ends.some((e) => p.y <= e.y + 2 * WIRE.radiusMm))
  )
    return false;
  if (own && ends.some((e) => Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z) < 3)) return false;
  return (
    p.x > o.x0 - m &&
    p.x < o.x1 + m &&
    p.z > o.z0 - m &&
    p.z < o.z1 + m &&
    p.y > o.bottom - m &&
    p.y < o.top + m
  );
}
export const byWireId = (a: string, b: string) => {
  const n = (x: string) => Number(/^W(\d+)$/.exec(x)?.[1] ?? Infinity);
  return n(a) - n(b) || (a < b ? -1 : a > b ? 1 : 0);
};

/**
 * Pairs of electrically different things that touch in a scene's geometry: two wires of
 * different nodes closer than their diameters, or a wire passing a terminal of another node (not
 * one of its ends) within a wire radius plus a lead's half-thickness. Plan bounding boxes first.
 */
export function touchingNodes(s: SceneDescription): string[] {
  return touchingNodesReport(s).pairs;
}

/**
 * touchingNodes with its work counted (s20r6: stacked wires made it all pairs): candidates
 * visited and segment pairs tested, at most TOUCH_WORK. Past it the check stops and `unchecked`
 * lists the wires (by id) whose pairs or terminals were not all checked: they are listed in
 * `routeLimits` (a contact that was not checked is not claimed absent). Deterministic.
 */
export function touchingNodesReport(s: SceneDescription): {
  pairs: string[];
  unchecked: string[];
} {
  const out: string[] = [];
  let work = 0;
  const unchecked = (from: number) => ({
    pairs: out,
    unchecked: s.wires.slice(from).map((w) => w.id),
  });
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
  // Wires bucketed by their plan boxes (s20r5: all pairs were tested); a box over more than 64
  // cells goes to a list every query takes. Candidates in index order: the same output order.
  const C = 20;
  const cells = new Map<string, number[]>();
  const long: number[] = [];
  const span = (b: ReturnType<typeof boxOf>) => {
    const x0 = Math.floor(b.x0 / C);
    const x1 = Math.floor(b.x1 / C);
    const z0 = Math.floor(b.z0 / C);
    const z1 = Math.floor(b.z1 / C);
    return { x0, x1, z0, z1, n: (x1 - x0 + 1) * (z1 - z0 + 1) };
  };
  boxes.forEach((b, i) => {
    const sp = span(b);
    if (!(sp.n <= 64)) return void long.push(i);
    for (let x = sp.x0; x <= sp.x1; x++)
      for (let z = sp.z0; z <= sp.z1; z++) {
        const k = `${x},${z}`;
        (cells.get(k) ?? cells.set(k, []).get(k)!).push(i);
      }
  });
  // Candidates in index order, those `keep` refuses not collected (no copy of every long wire
  // per query: s20r6); each one visited is counted.
  const all = s.wires.map((_, i) => i);
  const candidates = (b: ReturnType<typeof boxOf>, keep: (i: number) => boolean): number[] => {
    const sp = span(b);
    const out: number[] = [];
    const take = (i: number) => {
      work++;
      if (keep(i)) out.push(i);
    };
    if (!(sp.n <= 64)) {
      all.forEach(take);
      return out;
    }
    long.forEach(take);
    const seen = new Set<number>(long);
    for (let x = sp.x0; x <= sp.x1; x++)
      for (let z = sp.z0; z <= sp.z1; z++)
        for (const i of cells.get(`${x},${z}`) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          take(i);
        }
    return out.sort((p, q) => p - q);
  };
  for (let i = 0; i < s.wires.length; i++) {
    if (work > TOUCH_WORK) return unchecked(i);
    const a = s.wires[i]!;
    const others = (j: number) =>
      j > i && !(a.node && a.node === s.wires[j]!.node) && meet(boxes[i]!, boxes[j]!);
    for (const j of candidates(boxes[i]!, others)) {
      const b = s.wires[j]!;
      work += segs[i]!.length * segs[j]!.length;
      if (
        segs[i]!.some(([p, q]) =>
          segs[j]!.some(
            ([u, v]) => segBoxesMeet(p, q, u, v, 1.4) && segDistance(p, q, u, v) < 2 * r + 0.05,
          ),
        )
      )
        out.push(`w:${a.id}|${b.id}`);
    }
  }
  for (const c of s.components)
    for (const t of c.terminals) {
      if (t.open) continue;
      if (work > TOUCH_WORK) return unchecked(0);
      const other = (i: number) => !(t.node && s.wires[i]!.node === t.node);
      for (const i of candidates({ x0: t.x, x1: t.x, z0: t.z, z1: t.z }, other)) {
        const w = s.wires[i]!;
        work += segs[i]!.length;
        const ends = [w.points[0]!, w.points.at(-1)!];
        if (ends.some((e) => e.x === t.x && e.y === t.y && e.z === t.z)) continue;
        const bx = boxes[i]!;
        if (t.x < bx.x0 || t.x > bx.x1 || t.z < bx.z0 || t.z > bx.z1) continue;
        if (segs[i]!.some(([p, q]) => segDistance(p, q, t, t) < r + 0.4))
          out.push(`t:${w.id}|${c.id}:${t.id}`);
      }
    }
  return { pairs: out, unchecked: [] };
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
  } else if (model === 'servo.sg90') {
    // The plug on the bench, the case with its tabs, the horn's sweep above the gear tower.
    const P = SERVO_SG90;
    const caseX0 = P.caseLeftXMm + P.caseXMm / 2 - P.tabSpanXMm / 2;
    boxes.push({
      x0: P.plugTipXMm,
      x1: P.plugTipXMm + P.plugXMm,
      z0: -P.plugZMm / 2,
      z1: P.plugZMm / 2,
      y0: 0,
      y1: P.plugHeightMm,
    });
    boxes.push({
      x0: caseX0,
      x1: caseX0 + P.tabSpanXMm,
      z0: -P.caseZMm / 2,
      z1: P.caseZMm / 2,
      y0: 0,
      y1: P.towerTopMm,
    });
    boxes.push({
      x0: SERVO_SHAFT_X_MM - (x1 - SERVO_SHAFT_X_MM),
      x1,
      z0,
      z1,
      y0: P.towerTopMm,
      y1: top,
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
): SceneDescription => withLimits(doc, buildScene(doc, separate, router));

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
  // Rounds bounded by counted work (s20r5: each round tests every pair of parts; 1 500 parts
  // took 17 s): 48 rounds up to ~200 parts, fewer beyond, none past ~1 400; overlaps left are
  // reported (separation.unresolved, the 3D view's note).
  const rounds = Math.min(48, Math.floor(SEPARATION_WORK / Math.max(1, bodies.length ** 2)));
  const separation = separateBodies(bodies, touching, separate ? rounds : 0);

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
        ...(w.simple ? { simple: true as const } : {}),
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
  'logic.sot23',
  'logic.soic14',
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
/** Below this sideways offset (mm) an end keeps the former short jog (s21r: a jumper's neck). */
const SHIFT_MIN = 1;
function moveEnd(flat: Point[], to: Point, which: 'start' | 'end', shift = true): Point[] {
  const pts = which === 'start' ? [...flat].reverse() : [...flat];
  const last = pts[pts.length - 1]!;
  if (last.x === to.x && last.y === to.y) return flat;
  const prev = pts[pts.length - 2];
  const before = pts[pts.length - 3];
  if (prev && prev.y === last.y && to.y === last.y) pts[pts.length - 1] = { ...to };
  else if (prev && prev.x === last.x && to.x === last.x) pts[pts.length - 1] = { ...to };
  else if (
    shift &&
    // Sprint 21 (s21r): the attach point lies beside the last run (a part's 3D lead end is not
    // where its symbol's terminal is). The last run moves over with the end and the run before it
    // stretches or shortens, instead of a jog at the very end: that jog turned back across the
    // last run's approach (a hook at the terminal, e.g. an LED cathode reached from above).
    before &&
    prev &&
    ((prev.x === last.x &&
      before.y === prev.y &&
      before.x !== prev.x &&
      Math.sign(prev.x - before.x) === Math.sign(to.x - before.x) &&
      Math.abs(to.x - last.x) > SHIFT_MIN &&
      Math.abs(to.y - prev.y) > EPS) ||
      (prev.y === last.y &&
        before.x === prev.x &&
        before.y !== prev.y &&
        Math.sign(prev.y - before.y) === Math.sign(to.y - before.y) &&
        Math.abs(to.y - last.y) > SHIFT_MIN &&
        Math.abs(to.x - prev.x) > EPS))
  ) {
    pts[pts.length - 2] = prev.x === last.x ? { x: to.x, y: prev.y } : { x: prev.x, y: to.y };
    pts[pts.length - 1] = { ...to };
  } else if (last.y === to.y || last.x === to.x) pts.push({ ...to });
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

/** Work the last fresh routing spent (s20r5: counted units of SCENE_WORK_BUDGET). */
export const sceneStats = { work: 0 };
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

/**
 * A join running back across its own part (connect): lifted over the whole module, the arch of
 * the s20r owner report. Dearer than any lane-side detour or run beside another wire.
 */
const OWN_ACROSS = 1000;
/** A step aside shorter than this between two opposite runs makes a hook (connect, mm). */
const HOOK = 8;
/** Cost per mm of a 3D plan run lying on another wire's plan run (connect). */
const COINCIDENT_COST = 3;
/** Two parallel plan runs closer than a wire's diameter plus the gap lie on one another (mm). */
const COINCIDENT = 2 * WIRE.radiusMm + 0.3;
/** Plan distance from q to the run a-b. */
function pointToRun(q: Point, a: Point, b: Point): number {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t =
    l2 < 1e-12
      ? 0
      : Math.max(0, Math.min(1, ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / l2));
  return plen(q, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
}
/** Plan distance between the segments a-b and c-d (0 where they cross). */
function segDist2(a: Point, b: Point, c: Point, d: Point): number {
  const o = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return 0;
  return Math.min(
    pointToRun(a, c, d),
    pointToRun(b, c, d),
    pointToRun(c, a, b),
    pointToRun(d, a, b),
  );
}
/** An axis-aligned plan run: horizontal (along x at y = lat) or vertical (along y at x = lat). */
interface Run {
  h: boolean;
  lat: number;
  lo: number;
  hi: number;
}
/** The axis-aligned runs of some paths that reach a box (grown by COINCIDENT). */
function runsNear(
  paths: readonly Point[][],
  box: { x0: number; x1: number; y0: number; y1: number },
): Run[] {
  const out: Run[] = [];
  for (const q of paths)
    for (let k = 1; k < q.length; k++) {
      const c = q[k - 1]!;
      const d = q[k]!;
      if (
        Math.max(c.x, d.x) < box.x0 - COINCIDENT ||
        Math.min(c.x, d.x) > box.x1 + COINCIDENT ||
        Math.max(c.y, d.y) < box.y0 - COINCIDENT ||
        Math.min(c.y, d.y) > box.y1 + COINCIDENT
      )
        continue;
      const h = Math.abs(c.y - d.y) < EPS;
      const v = Math.abs(c.x - d.x) < EPS;
      if (h === v) continue;
      out.push(
        h
          ? { h, lat: c.y, lo: Math.min(c.x, d.x), hi: Math.max(c.x, d.x) }
          : { h, lat: c.x, lo: Math.min(c.y, d.y), hi: Math.max(c.y, d.y) },
      );
    }
  return out;
}
/** Length (mm) of the axis-aligned runs of `path` that lie on (within COINCIDENT of) `runs`. */
function coincident(path: Point[], runs: readonly Run[]): number {
  let n = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const h = Math.abs(a.y - b.y) < EPS;
    const v = Math.abs(a.x - b.x) < EPS;
    if (h === v) continue;
    const lat = h ? a.y : a.x;
    const lo = h ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
    const hi = h ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    for (const r of runs)
      if (r.h === h && Math.abs(r.lat - lat) < COINCIDENT)
        n += Math.max(0, Math.min(hi, r.hi) - Math.max(lo, r.lo));
  }
  return n;
}

/** How far apart (plan, axis to axis) runs of two wires laid side by side are (mm). */
const SIDE_BY_SIDE = COINCIDENT + 0.3;

/**
 * Sprint 20 (s20r, owner report round 2): wires of one node may share a run in 2D (a trunk: the
 * router lets them, route.ts criterion 8b). Physically they are separate wires: laid side by
 * side, not through or on top of each other. Each plan run lying on a run of a wire planned
 * before it (any node; in 2D only wires of one node share runs) is moved sideways by
 * SIDE_BY_SIDE, in document order:
 *  - an interior run (both ends are corners) moves as a whole; its neighbours lengthen or shorten
 *    (never folding back);
 *  - a run ending at the wire's own end keeps its first SHARED_JOG mm at the end (wires on one
 *    terminal converge there by design), then steps aside.
 * The side is the one that lies on no other run; nothing moves when neither side is free or the
 * move would enter a part on the bench. Plan only: ends, heights and connectivity are untouched.
 */
function separatePlans(inputs: WireRouteInput[], obstacles: Obstacle[]): void {
  const SHARED_JOG = 3;
  const pad = WIRE.radiusMm + 0.3;
  const ground = obstacles.filter((o) => o.bottom < 2);
  // Any part, its own end parts included (the stretch kept at a fixed end is not tested).
  const inPart = (a: Point, b: Point) =>
    ground.some((o) =>
      across(a, b, { x0: o.x0 - pad, x1: o.x1 + pad, z0: o.z0 - pad, z1: o.z1 + pad }),
    );
  const done: Point[][] = [];
  for (const w of inputs) {
    let plan = w.plan.map((p) => ({ ...p }));
    const lastIndex = plan.length - 1;
    for (let i = 1; i < plan.length; i++) {
      const a = plan[i - 1]!;
      const b = plan[i]!;
      const h = Math.abs(a.y - b.y) < EPS;
      const v = Math.abs(a.x - b.x) < EPS;
      if (h === v || plen(a, b) < 1) continue;
      const runs = runsNear(done, {
        x0: Math.min(a.x, b.x),
        x1: Math.max(a.x, b.x),
        y0: Math.min(a.y, b.y),
        y1: Math.max(a.y, b.y),
      });
      if (coincident([a, b], runs) < 1) continue;
      const first = i === 1;
      const last = i === plan.length - 1;
      if (first && last) continue; // a single straight run between two fixed ends
      const shift = (p: Point, d: number): Point =>
        h ? { x: p.x, y: p.y + d } : { x: p.x + d, y: p.y };
      const along = (p: Point, q: Point, k: number): Point => {
        const l = plen(p, q);
        return { x: p.x + ((q.x - p.x) * k) / l, y: p.y + ((q.y - p.y) * k) / l };
      };
      // A neighbour run may lengthen or shorten, never fold back (a hook).
      const keeps = (q: Point, from: Point, to: Point) =>
        Math.sign((h ? to.y - q.y : to.x - q.x) || 1) ===
          Math.sign((h ? from.y - q.y : from.x - q.x) || 1) && plen(q, to) > 0.05;
      // Of the sides that work, the one whose moved stretch crosses the fewest earlier wires (a
      // run laid beside a wire that turns away on that side would cross it twice).
      let chosen: { next: Point[]; crossings: number } | null = null;
      for (const d of [SIDE_BY_SIDE, -SIDE_BY_SIDE]) {
        let next: Point[];
        if (!first && !last) {
          // Interior: both corners move; the neighbours must not fold back.
          const p0 = plan[i - 2]!;
          const p1 = plan[i + 1]!;
          const sa = shift(a, d);
          const sb = shift(b, d);
          if (!keeps(p0, a, sa) || !keeps(p1, b, sb)) continue;
          next = [...plan.slice(0, i - 1), sa, sb, ...plan.slice(i + 1)];
        } else if (first) {
          if (plen(a, b) < SHARED_JOG + 1.5) continue;
          const j = along(a, b, SHARED_JOG);
          const p1 = plan[i + 1];
          const sb = shift(b, d);
          // Toward the next run only (stepping the other way and back is a hook).
          if (p1 && (!keeps(p1, b, sb) || Math.sign(h ? p1.y - b.y : p1.x - b.x) !== Math.sign(d)))
            continue;
          next = [a, j, shift(j, d), sb, ...plan.slice(i + 1)];
        } else {
          if (plen(a, b) < SHARED_JOG + 1.5) continue;
          const j = along(b, a, SHARED_JOG);
          const p0 = plan[i - 2]!;
          const sa = shift(a, d);
          if (!keeps(p0, a, sa) || Math.sign(h ? p0.y - a.y : p0.x - a.x) !== Math.sign(d))
            continue;
          next = [...plan.slice(0, i - 1), sa, shift(j, d), j, b];
        }
        // The moved stretch lies on no other run and enters no part.
        // The moved run itself lies on no other run (its neighbours only stretch: they keep their
        // lines); the moved stretch, without what is kept at a fixed end, enters no part.
        const run = first ? next.slice(2, 4) : last ? next.slice(-4, -2) : next.slice(i - 1, i + 1);
        if (coincident(run, runsNear(done, bboxOf(run))) >= 1) continue;
        const moved = first
          ? next.slice(1, 5)
          : last
            ? next.slice(Math.max(0, next.length - 5), next.length - 1)
            : next.slice(Math.max(0, i - 2), Math.min(next.length, i + 3));
        if (moved.slice(1).some((q, k) => inPart(moved[k]!, q))) continue;
        const crossings = planCrossings(moved, done);
        if (!chosen || crossings < chosen.crossings) chosen = { next, crossings };
      }
      if (chosen) plan = chosen.next;
    }
    // A neighbour shortened to almost nothing leaves a tiny jog: collinear points merged.
    const fixed = [plan[0]!, plan[plan.length - 1]!];
    if (plan.length !== w.plan.length || plan.some((p, k) => plen(p, w.plan[k]!) > 1e-9))
      plan = simplify(plan, (q) => fixed.some((f) => plen(f, q) < 1e-6));
    // Corner radii are keyed by plan index: the last point's moves with it.
    if (plan.length !== w.plan.length && w.radii?.has(lastIndex)) {
      const r = w.radii.get(lastIndex)!;
      w.radii.delete(lastIndex);
      w.radii.set(plan.length - 1, r);
    }
    w.plan = plan;
    done.push(plan);
  }
}
/** Proper crossings (strictly inside both) of the runs of `path` with the runs of `paths`. */
function planCrossings(path: Point[], paths: readonly Point[][]): number {
  let n = 0;
  const inside = (v: number, p: number, q: number) =>
    v > Math.min(p, q) + EPS && v < Math.max(p, q) - EPS;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const ah = Math.abs(a.y - b.y) < EPS;
    for (const q of paths)
      for (let k = 1; k < q.length; k++) {
        const c = q[k - 1]!;
        const d = q[k]!;
        const ch = Math.abs(c.y - d.y) < EPS;
        if (ah === ch) continue;
        const [h0, h1, v0, v1] = ah ? [a, b, c, d] : [c, d, a, b];
        if (inside(v0.x, h0.x, h1.x) && inside(h0.y, v0.y, v1.y)) n++;
      }
  }
  return n;
}
const bboxOf = (pts: Point[]) => ({
  x0: Math.min(...pts.map((p) => p.x)),
  x1: Math.max(...pts.map((p) => p.x)),
  y0: Math.min(...pts.map((p) => p.y)),
  y1: Math.max(...pts.map((p) => p.y)),
});

/** Whether the straight run a-b passes through the interior of `r` (exact clipping). */
function across(a: Point, b: Point, r: ReturnType<typeof footRect>): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Liang-Barsky against the open rectangle: p * t < q on every side.
  for (const [p, q] of [
    [-dx, a.x - r.x0],
    [dx, r.x1 - a.x],
    [-dy, a.y - r.z0],
    [dy, r.z1 - a.y],
  ] as const) {
    if (Math.abs(p) < 1e-12) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}

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
  planned: readonly Point[][] = [],
  risers: readonly Point[] = [],
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
  // The other wires' runs near any join this can make (s20r: priced by `coincident`).
  const reach = [E, ...rest.slice(0, 6)];
  const runs = runsNear(planned, {
    x0: Math.min(...reach.map((p) => p.x)),
    x1: Math.max(...reach.map((p) => p.x)),
    y0: Math.min(...reach.map((p) => p.y)),
    y1: Math.max(...reach.map((p) => p.y)),
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
      // A hook (s20r): out one way, a short step aside, and back the other way.
      const q = simplify(path, () => false);
      for (let i = 3; i < q.length; i++) {
        const u0 = sub2(q[i - 2]!, q[i - 3]!);
        const u2 = sub2(q[i]!, q[i - 1]!);
        if (
          plen(q[i - 1]!, q[i - 2]!) < HOOK &&
          dotP(u0, u2) / (Math.hypot(u0.x, u0.y) * Math.hypot(u2.x, u2.y)) < -0.99
        )
          cost += 60;
      }
      if (dotP(sub2(corner, E), e.u) < -1e-6) cost += 60;
      for (let i = 1; i <= Math.min(2, path.length - 1); i++)
        if (crosses(path[i - 1]!, path[i]!)) cost += 120;
      // Runs back across the part itself (s20r owner report). Formerly only each run's MIDPOINT
      // was tested: a long join straight across the part (its far end well beyond the part, the
      // midpoint outside it) passed, and the height profile then lifted the wire over the whole
      // module from the far side, an arch over its own part next to the pin (a loop). Every run
      // of the join is tested along its length now.
      for (let i = 1; i < path.length; i++)
        if (across(path[i - 1]!, path[i]!, body)) cost += OWN_ACROSS;
      // Running along another wire's plan path (s20r): a join that takes a short cut onto the
      // line another wire already runs on puts the two on top of each other for the whole run
      // (the height profile can then only stack them). Each mm of such a run costs as much as
      // 3 mm of detour, so the join keeps to the 2D route's own, separate line. Only the join's
      // own runs (to the point where it meets the 2D route): the 2D route itself may share a run
      // with a wire of its node on purpose (route.ts trunk, s20r round 2), laid side by side
      // below (separatePlans).
      // Sprint 21 (s21r): the join's own runs are E -> corner and, from the corner, only what is
      // not already the 2D route's own run (a corner ON the route's run rest[j-1] -> rest[j] joins
      // it there: the rest of that run is the route itself, priced for every join alike).
      // Formerly the whole corner -> rest[j] run was priced, so a join straight onto a long trunk
      // run looked dear and a short hook around it (out, a step aside, back) was taken instead.
      const prevR = j > 0 ? rest[j - 1]! : null;
      const onRoute =
        prevR !== null &&
        ((Math.abs(prevR.y - R.y) < EPS && Math.abs(corner.y - R.y) < EPS) ||
          (Math.abs(prevR.x - R.x) < EPS && Math.abs(corner.x - R.x) < EPS));
      const within = onRoute && pointToRun(corner, prevR, R) < EPS;
      const tail = !onRoute ? [corner, R] : within ? null : [corner, prevR];
      cost +=
        COINCIDENT_COST * (coincident([E, corner], runs) + (tail ? coincident(tail, runs) : 0));
      // Through the point where another wire's lane ends and it rises from pin level.
      for (const q of risers)
        for (let i = 1; i < path.length; i++)
          if (pointToRun(q, path[i - 1]!, path[i]!) < COINCIDENT) {
            cost += 60;
            break;
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
 * Sprint 21 (s21r): an INTERIOR run (both ends are corners) that runs along the side of one of
 * `own` (the wire's own end parts' bodies) within DODGE_MAX moves sideways as a whole to just
 * outside it; its neighbouring runs stretch or shorten (never fold back). Only when the moved run
 * and its stretched neighbours hit none of `all`. Plan only.
 */
function shiftOffOwn(plan: Point[], own: Obstacle[], all: Obstacle[]): Point[] {
  if (!own.length || plan.length < 4) return plan;
  const pad = WIRE.radiusMm + 0.3;
  const hit = (a: Point, b: Point) =>
    all.some((o) =>
      across(a, b, { x0: o.x0 - pad, x1: o.x1 + pad, z0: o.z0 - pad, z1: o.z1 + pad }),
    );
  const out = plan.map((p) => ({ ...p }));
  for (let i = 2; i < out.length - 1; i++) {
    const a = out[i - 1]!;
    const b = out[i]!;
    const h = Math.abs(a.y - b.y) < EPS;
    const v = Math.abs(a.x - b.x) < EPS;
    if (h === v) continue;
    for (const o of own) {
      const [lo, hi, rlo, rhi] = h
        ? [o.x0 - pad, o.x1 + pad, o.z0 - pad, o.z1 + pad]
        : [o.z0 - pad, o.z1 + pad, o.x0 - pad, o.x1 + pad];
      const lat = h ? a.y : a.x;
      if (lat <= rlo || lat >= rhi) continue;
      const s0 = Math.max(Math.min(h ? a.x : a.y, h ? b.x : b.y), lo);
      const s1 = Math.min(Math.max(h ? a.x : a.y, h ? b.x : b.y), hi);
      if (s1 - s0 < 1) continue;
      const depth = Math.min(lat - rlo, rhi - lat);
      if (depth > DODGE_MAX) continue;
      const off = lat - rlo < rhi - lat ? rlo - 0.05 : rhi + 0.05;
      const mv = (p: Point): Point => (h ? { x: p.x, y: off } : { x: off, y: p.y });
      const p0 = out[i - 2]!;
      const p1 = out[i + 1]!;
      const sa = mv(a);
      const sb = mv(b);
      // Neighbours keep their direction (no fold back) and a little length.
      const keeps = (q: Point, from: Point, to: Point) =>
        Math.sign((h ? to.y - q.y : to.x - q.x) || 1) ===
          Math.sign((h ? from.y - q.y : from.x - q.x) || 1) && plen(q, to) > 0.5;
      if (!keeps(p0, a, sa) || !keeps(p1, b, sb)) continue;
      if (hit(p0, sa) || hit(sa, sb) || hit(sb, p1)) continue;
      out[i - 1] = sa;
      out[i] = sb;
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
      // Each post is tagged with its terminal (wire routing integrity, rt2): a wire fastened to
      // one post is exempt from that post only; the other post (the other node) is an obstacle
      // it must clear like any other body (route3d.ts pads and checks it), not "its own part".
      const r = PSU.postDiameterMm / 2;
      const post = (terminal: string): Box => {
        const zc =
          CATALOG['instrument.lab_psu'].terminals.find((t) => t.id === terminal)!.offset.y * SCALE;
        return {
          x0: PSU.frontXMm,
          x1,
          z0: zc - r,
          z1: zc + r,
          y0: PSU.attachHeightMm - r,
          y1: PSU.attachHeightMm + r,
          terminal,
        };
      };
      return [{ x0, x1: PSU.frontXMm, z0, z1, y0: 0, y1: top }, post('positive'), post('negative')];
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
        part: q.terminal ? `${body.id}:${q.terminal}` : body.id,
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
): { id: string; points: Vec3[]; radii: number[]; simple?: true }[] {
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
    /** The 2D-derived plan route before the zone trim (s20r: where the wire will run). */
    full: Point[];
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
    // (A jumper's end keeps the short jog: its neck rises straight from the housing, s21r.)
    const jumper = ends.map(
      (e) => e.kind === 'terminal' && comp(e.component)?.model === 'board.esp32_devkitc',
    );
    if (!isUnder[0]) route = moveEnd(route, { x: at[0].x, y: at[0].z }, 'start', !jumper[0]);
    if (!isUnder[1]) route = moveEnd(route, { x: at[1].x, y: at[1].z }, 'end', !jumper[1]);
    const full = route;
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
    preps.push({ w, route, full, ends: at, under: [null, null] });
  }

  // s20r5 (review r3, MAJOR 3: the 3D scene ran unbounded on the UI thread; 640 wires 41 s, one
  // wire 2e6 units long 25 s). A counted work budget, in document order: each wire costs its
  // plan length in height-profile cells (0.25 mm) plus a share per wire already routed (its
  // routing scans them). A wire past the budget, or longer than MAX_WIRE_MM, is drawn as a
  // simple cable instead, and listed in routeLimits. Deterministic: counted, never timed.
  const simple = new Map<string, Prep>();
  {
    let work = 0;
    let routed = 0;
    for (const p of preps) {
      let len = 0;
      for (let i = 1; i < p.full.length; i++) len += plen(p.full[i - 1]!, p.full[i]!);
      const cost = len / 0.25 + SCENE_WORK_PER_WIRE * (1 + routed);
      if (!(len <= MAX_WIRE_MM) || work + cost > SCENE_WORK_BUDGET) simple.set(p.w.id, p);
      else {
        work += cost;
        routed++;
      }
    }
    sceneStats.work = work;
  }
  const simpleOut = [...simple.values()].map((p) => ({
    id: p.w.id,
    points: simpleCable(p.full, p.ends),
    radii: [] as number[],
    simple: true as const,
  }));
  if (simple.size) preps.splice(0, preps.length, ...preps.filter((p) => !simple.has(p.w.id)));

  const obstacles = routingObstacles(components, bodies, offsets);
  // Sprint 22 (s22r): lanes are assigned, then checked against each other: two lanes of
  // DIFFERENT nodes whose corridors (pin to lane end, at pin level, where no wire can hop) come
  // closer than a cable diameter touch (two parts' facing pins in the narrow gap between them,
  // a lane crossing a neighbour's lane). The later wire's lane then takes its next side, a few
  // rounds at most; the assignment with the fewest such contacts is kept (the first on a tie).
  const assignLanes = (forbid: Map<string, Set<number>>) => {
    for (const p of preps) p.under = [null, null];
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
        let inside: { cost: number; side: number } | null = null;
        const banned = forbid.get(`${p.w.id}|${k}`);
        for (let side = 0; side < 4; side++) {
          if (banned?.has(side)) continue;
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
          // Nor end inside another part standing on the bench (s20r: two breakouts a millimetre
          // apart; the lane's riser went straight up through the neighbour's board). Such a side
          // is used only when every side is (the cut-back below then keeps the plain exit).
          const pad = WIRE.radiusMm + 0.3;
          const ex = c.x + exitW.x;
          const ez = c.z + exitW.y;
          const far = k === 0 ? p.w.to : p.w.from;
          const mine = (o: Obstacle) =>
            [c.id, far.kind === 'terminal' ? far.component : null].some(
              (id) => id !== null && (o.part === id || o.part.startsWith(`${id}:`)),
            );
          const inOther = obstacles.some(
            (o) =>
              !mine(o) &&
              o.bottom < 2 &&
              ex > o.x0 - pad &&
              ex < o.x1 + pad &&
              ez > o.z0 - pad &&
              ez < o.z1 + pad,
          );
          const cost = dist[side]! + 0.5 * plen({ x: c.x + exitW.x, y: c.z + exitW.y }, target);
          if (inOther) {
            if (!inside || cost < inside.cost - 1e-9) inside = { cost, side };
            continue;
          }
          if (!best || cost < best.cost - 1e-9) best = { cost, side };
        }
        const side = best?.side ?? inside?.side ?? dist.indexOf(Math.min(...dist));
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
    // A lane's end is where its wire rises from pin level (s20r owner report): when it falls on
    // another wire's path, that riser goes straight up through the other wire. Such a lane runs on
    // (up to one more lane pitch, never into another part) until its end is clear of the others'
    // paths; the other wire then passes over the low lane like any crossing.
    for (const p of preps)
      for (const e of p.under) {
        if (!e) continue;
        const paths = preps.filter((q) => q !== p).map((q) => q.full);
        const onPath = (d: number) => {
          const q = add(e.pin, e.u, d);
          return paths.some((r) =>
            r.some((b, i) => i > 0 && pointToRun(q, r[i - 1]!, b) < COINCIDENT),
          );
        };
        const pad = WIRE.radiusMm + 0.3;
        const free = (d: number) => {
          const q = add(e.pin, e.u, d);
          return !obstacles.some(
            (o) =>
              o.part !== e.comp.id &&
              o.bottom < 2 &&
              q.x > o.x0 - pad &&
              q.x < o.x1 + pad &&
              q.y > o.z0 - pad &&
              q.y < o.z1 + pad,
          );
        };
        if (!onPath(e.lane)) continue;
        // The fan-out's other lanes off the same side keep their own distances (no two lateral runs
        // on one line).
        const group = groups.get(`${e.comp.id}|${e.side}`) ?? [];
        const own = (d: number) =>
          group.every((o) => o === e || Math.abs(o.lane - d) >= COINCIDENT);
        for (let d = e.lane + 0.5; d <= e.lane + LANE_PITCH + 1e-9 && free(d); d += 0.5)
          if (!onPath(d) && own(d)) {
            e.lane = d;
            break;
          }
      }
  };
  const laneContacts = (): { key: string; side: number }[] => {
    const lanes: {
      key: string;
      idx: number;
      node: string | null;
      side: number;
      a: Point;
      b: Point;
      pin: Point;
    }[] = [];
    preps.forEach((p, idx) =>
      p.under.forEach((e, k) => {
        if (e)
          lanes.push({
            key: `${p.w.id}|${k}`,
            idx: idx * 2 + k,
            node: nodeOf(p.w),
            side: e.side,
            a: e.pin,
            b: add(e.pin, e.u, e.lane),
            pin: e.pin,
          });
      }),
    );
    const out: { key: string; side: number }[] = [];
    const lim = 2 * WIRE.radiusMm + 0.3;
    for (let i = 0; i < lanes.length; i++)
      for (let j = i + 1; j < lanes.length; j++) {
        const A = lanes[i]!;
        const B = lanes[j]!;
        if (A.node !== null && A.node === B.node) continue;
        if (plen(A.pin, B.pin) < 1e-6) continue;
        if (segDist2(A.a, A.b, B.a, B.b) >= lim) continue;
        const later = A.idx > B.idx ? A : B;
        out.push({ key: later.key, side: later.side });
      }
    return out;
  };
  {
    const forbid = new Map<string, Set<number>>();
    assignLanes(forbid);
    let contacts = laneContacts();
    let best = { forbid: new Map(forbid), n: contacts.length };
    for (let round = 0; round < 3 && contacts.length; round++) {
      let changed = false;
      for (const c of contacts) {
        const set = forbid.get(c.key) ?? new Set<number>();
        if (set.has(c.side) || set.size >= 3) continue;
        set.add(c.side);
        forbid.set(c.key, set);
        changed = true;
      }
      if (!changed) break;
      assignLanes(forbid);
      contacts = laneContacts();
      if (contacts.length < best.n)
        best = {
          forbid: new Map([...forbid].map(([k, v]) => [k, new Set(v)])),
          n: contacts.length,
        };
    }
    if (contacts.length > best.n) assignLanes(best.forbid);
  }
  // 4. Plan paths, heads and tails, then heights (route3d.ts).
  const inputs: WireRouteInput[] = [];
  // Where every lane ends: the wire rises there from pin level (s20r). Another wire's join must
  // not run through that point, or the riser goes up through it.
  const laneEnds = preps.flatMap((p) =>
    p.under.flatMap((e) => (e ? [{ wire: p.w.id, at: add(e.pin, e.u, e.lane) }] : [])),
  );
  for (const p of preps) {
    const [ua, ub] = p.under;
    const risers = laneEnds.filter((l) => l.wire !== p.w.id).map((l) => l.at);
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
          inputs.map((i) => i.plan),
          risers,
        );
      if (ub && plen(mid[mid.length - 1]!, Eb) > 1e-6)
        mid = [
          ...connect(
            ub,
            Eb,
            [...mid].reverse(),
            footRect(ub.comp, WIRE.radiusMm),
            ground(ub.comp.id),
            inputs.map((i) => i.plan),
            risers,
          ),
        ].reverse();
      plan = mid;
      if (!ua) plan = plen(plan[0]!, A) > 1e-6 ? [A, ...plan] : [A, ...plan.slice(1)];
      if (!ub)
        plan = plen(plan[plan.length - 1]!, B) > 1e-6 ? [...plan, B] : [...plan.slice(0, -1), B];
    }
    const fixedPts = [plan[0]!, plan[plan.length - 1]!];
    plan = simplify(plan, (q) => fixedPts.some((f) => plen(f, q) < 1e-6));
    const ownBody = (e: WireEnd, o: Obstacle) => e.kind === 'terminal' && o.part === e.component;
    plan = dodge(
      plan,
      obstacles.filter((o) => o.bottom <= 2 && !ownBody(p.w.from, o) && !ownBody(p.w.to, o)),
    );
    // Sprint 21 (s21r, owner screenshot): an interior run along the side of the wire's OWN end
    // part (a 2D route on the supply symbol's outline, which is the 3D case wall) steps off it
    // as a whole, instead of the height profile lifting the wire over the whole case.
    plan = shiftOffOwn(
      plan,
      obstacles.filter((o) => o.bottom <= 2 && (ownBody(p.w.from, o) || ownBody(p.w.to, o))),
      obstacles.filter((o) => o.bottom <= 2),
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

  separatePlans(inputs, obstacles);

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
  // The height profiles share one counted budget (s20r6); a later round that runs out of it is
  // not taken (its wires would be simple cables).
  const budget: Route3dBudget = { work: ROUTE3D_WORK };
  for (let round = 0; round < 4; round++) {
    routeStats.rounds = round + 1;
    const routed = routeWires(order, obstacles, spots, budget);
    if (round > 0 && [...routed.values()].some((r) => r.simple)) break;
    const pairs = touchingWires(order, routed);
    if (!best || pairs.length < best.bad) best = { routed, bad: pairs.length };
    if (!pairs.length) break;
    const later = new Set(pairs.map(([a]) => a));
    order = [...order.filter((w) => !later.has(w.id)), ...order.filter((w) => later.has(w.id))];
  }
  const full = new Map(inputs.map((i) => [i.id, { id: i.id, ...best!.routed.get(i.id)! }]));
  const simples = new Map(simpleOut.map((w) => [w.id, w]));
  // In document order, as before.
  return doc.layout.wires.flatMap((w) => {
    const r = full.get(w.id) ?? simples.get(w.id);
    return r ? [r] : [];
  });
}

/** Pair tests the body separation may spend (rounds x parts^2, s20r5). */
const SEPARATION_WORK = 2_000_000;
/** touchingNodesReport's work: candidates visited and segment pairs tested (s20r6). */
const TOUCH_WORK = 3_000_000;
/** Work the height profiles of one scene may spend (route3d.ts Route3dBudget, s20r6). */
const ROUTE3D_WORK = 8_000_000;
/** Samples per wire segment at most, wherever sampling is per length (s20r5). */
export const MAX_SAMPLES = 4000;
/** The 3D scene's work budget (freshWires, s20r5): ~1-2 s of routing on the 1-vCPU DEV host. */
export const SCENE_WORK_BUDGET = 200_000;
/** Work charged per wire for each wire already routed (its routing scans their segments). */
const SCENE_WORK_PER_WIRE = 40;
/** Longer plan paths are drawn as simple cables (mm; 2 m: no bench is that large). */
export const MAX_WIRE_MM = 2000;

/** A simple cable: the plan path just above the bench, from end to end (s20r5). */
function simpleCable(plan: Point[], ends: [Vec3, Vec3]): Vec3[] {
  const pts: Vec3[] = [ends[0]];
  for (const q of plan) pts.push({ x: q.x, y: FLOOR, z: q.y });
  pts.push(ends[1]);
  return pts.filter(
    (p, i) =>
      i === 0 || Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y, p.z - pts[i - 1]!.z) > 1e-9,
  );
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
