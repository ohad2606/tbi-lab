/**
 * TBI Lab project schema v2 — core.
 *
 * FROZEN at the end of Sprint 2 (roadmap RC-1). From Sprint 3 on, changes are additive or
 * backward-compatible where possible, and any change to persistence semantics requires an
 * explicit migration (see migrate.ts) and a test. See ../SCHEMA.md for the field reference.
 *
 * Every identifier here is language-neutral. User-authored text (project name, net names) is
 * stored verbatim and never translated. Runtime/simulation values never appear in this model.
 */

export const SCHEMA_VERSION = 3;
export const DOCUMENT_FORMAT = 'tbi-lab.project';

/**
 * Canonical SI unit ids. Locale affects only how a value is displayed. `lux` (illuminance) was
 * added in Sprint 10 for a sensor's simulated environment (additive).
 */
export type UnitId =
  | 'ohm'
  | 'volt'
  | 'ampere'
  | 'lux'
  | 'farad'
  /** Sprint 12 (R2 environment quantities, additive). */
  | 'metre'
  | 'celsius'
  | 'percent_rh';

/** An engineering value: an SI number plus its canonical unit id. */
export interface Quantity {
  value: number;
  unit: UnitId;
}

/**
 * A parameter value: an engineering quantity, a boolean setting, or a language-neutral enum
 * token (for example a model card id). The enum form was added in Sprint 3 (additive).
 */
export type ParamValue = Quantity | boolean | string;

/** Component type ids are namespaced and language-neutral. */
export type ComponentTypeId =
  | 'instrument.lab_psu'
  | 'component.ground'
  | 'component.resistor'
  | 'component.led'
  | 'component.diode'
  | 'component.push_button'
  | 'component.toggle_switch'
  /** Classic ESP32 DevKitC V4 (ESP32-WROOM-32), Sprint 6 (additive). */
  | 'board.esp32_devkitc_wroom32'
  /** Sprint 10, PM-6 revision (additive): the approved component families. */
  | 'component.rgb_led'
  | 'component.photoresistor'
  | 'component.buzzer'
  | 'component.relay'
  | 'component.bjt_npn'
  | 'sensor.pir_hc_sr501'
  | 'display.led_matrix_8x8'
  | 'component.capacitor'
  /** Sprint 12 (Runtime v2, additive): R2 sensors and the R3 I2C display. */
  | 'sensor.hc_sr04'
  | 'sensor.dht22'
  | 'display.lcd1602_i2c'
  /** Sprint 15 (R4, additive): the SG90 servo, driven by an ESP32 PWM (LEDC) output. */
  | 'component.servo_sg90';

export interface ComponentInstance {
  /** Stable reference designator (`R1`, `PSU1`), unique per project, never reused. */
  id: string;
  type: ComponentTypeId;
  /** Version of the component type definition this instance was written against. */
  typeVersion: number;
  params: Record<string, ParamValue>;
}

export type NetRole = 'ground';

export interface Net {
  /** Opaque stable id (`N_1`). Never shown as a translated string. */
  id: string;
  /** `ground` exactly when the net contains a ground reference terminal; otherwise null. */
  role: NetRole | null;
  /** Optional user-authored name, stored verbatim, never translated. */
  userName: string | null;
}

/** One terminal's membership of one net. A terminal belongs to at most one net. */
export interface Connection {
  component: string;
  terminal: string;
  net: string;
}

/** Integer schematic units. The editor grid pitch is GRID units (layout.ts). */
export interface Point {
  x: number;
  y: number;
}

export type Rotation = 0 | 90 | 180 | 270;

export interface ComponentPlacement {
  x: number;
  y: number;
  rotation: Rotation;
}

/**
 * A wire endpoint. Wires attach to terminals or junctions by reference, never by geometry:
 * two wires that merely cross are not connected.
 */
export type WireEnd =
  | { kind: 'terminal'; component: string; terminal: string }
  | { kind: 'junction'; junction: string };

/**
 * Wire colours a user may choose (canonical, language-neutral ids; the app maps them to its
 * palette). Presentation only: a colour never changes a net.
 */
export const WIRE_COLORS = [
  'red',
  'black',
  'orange',
  'blue',
  'green',
  'purple',
  'yellow',
  'teal',
  'brown',
] as const;
export type WireColor = (typeof WIRE_COLORS)[number];

export interface Wire {
  id: string;
  from: WireEnd;
  to: WireEnd;
  /**
   * Intermediate waypoints. The drawn path is an orthogonal route through
   * from -> vertices... -> to, horizontal leg first (layout.ts `wireRoute`).
   */
  vertices: Point[];
  /**
   * The user's colour for this wire (Sprint 10, optional). Absent = automatic: derived from the
   * wire's electrical net (app/src/views/wireColors.ts). Older projects have none.
   */
  color?: WireColor;
}

/** A point where wires join. Part of exactly one net. */
export interface Junction {
  id: string;
  x: number;
  y: number;
}

/**
 * The schematic drawing. It defines connectivity through explicit wire endpoint references;
 * `nets` + `connections` are the canonical netlist derived from it (nets.ts) and are what a
 * simulation snapshot reads. Layout itself is excluded from any snapshot.
 */
export interface Layout {
  components: Record<string, ComponentPlacement>;
  wires: Wire[];
  junctions: Junction[];
}

export interface RevisionMetadata {
  /** Advances on every persisted local change. */
  localRevision: number;
  /** Last revision known to the cloud. Always null in V1: nothing acts on it. */
  cloudRevision: number | null;
  /** Local revision the cloud revision was derived from. Always null in V1. */
  baseRevision: number | null;
  /** ISO-8601 UTC. */
  updatedAt: string;
  /** Stable per-browser-profile id of the device that made the last change. */
  deviceId: string;
}

export interface ProjectDocument {
  format: typeof DOCUMENT_FORMAT;
  schemaVersion: number;
  /** Language-neutral project identity. Contains no locale. */
  projectId: string;
  createdWith: { app: string; schemaVersion: number };
  createdAt: string;
  revision: RevisionMetadata;
  /** User-authored, verbatim. */
  name: string;
  components: ComponentInstance[];
  nets: Net[];
  connections: Connection[];
  layout: Layout;
  /**
   * Last number issued per id prefix (`R` -> 3 means R1..R3 were issued). Guarantees that a
   * deleted reference is never reused within the project.
   */
  idCounters: Record<string, number>;
  /**
   * Authored programs, keyed by the id of the board component that runs them (schema v3,
   * Sprint 7). The source text is user-authored and stored exactly; build results, artifact
   * identities and runtime state are never part of the project. V1: at most one program, for a
   * Classic ESP32 board, in Arduino/C++.
   */
  programs: Record<string, ProgramSource>;
}

/** One board's program: its programming environment, pinned build profile and source file. */
export interface ProgramSource {
  /** Programming environment (V1: `arduino-cpp`). */
  language: string;
  /** Build profile id: board + environment + pinned toolchain configuration. */
  profile: string;
  /** The profile's source file name (V1: `sketch.ino`). */
  fileName: string;
  /** Exact source text. */
  text: string;
}

/** Deep copy of JSON data. Project documents are plain JSON by construction. */
export function cloneDocument<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
