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

/**
 * v4 (Sprint 20, owner-approved DP-rt2-1): no new field. A v4 document is a v3 document that may
 * carry automatic wires (`Wire.auto`, added during v3 by the wire routing integrity work); the
 * bump makes builds before it refuse such a file BY NAME ("made by a newer version") and open
 * such a stored project read-only, instead of calling the file invalid or editing it blindly.
 */
/**
 * v5 (Sprint POT-UNITS, 2026-10-30): no new field. v5 adds the component type
 * `component.potentiometer` and the unit `percent` (its wiper position); the bump makes builds
 * before it refuse a file that may hold one BY NAME ("made by a newer version") and open such a
 * stored project read-only, instead of calling it invalid (unknown type). Migration v4 -> v5 is
 * the identity.
 */
/**
 * v6 (Sprint 26, multi-file programs and managed libraries): a program may carry further project
 * files (`ProgramSource.files`) and the managed libraries pinned for it
 * (`ProgramSource.libraries`); both optional. A v5 document means exactly the same in v6
 * (migration v5 -> v6 is the identity); builds before v6 open a v6 file read-only, by name.
 */
export const SCHEMA_VERSION = 6;
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
  | 'percent_rh'
  /** Sprint POT-UNITS (v5, additive): a fraction in percent (a potentiometer's wiper position). */
  | 'percent';

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
  | 'component.servo_sg90'
  /**
   * Sprint 19B (Exploration Foundation L1, additive): single logic gates with real supply pins,
   * one type per function; `model` names the device (TI SN74LVC1G series).
   */
  | 'logic.gate_and'
  | 'logic.gate_nand'
  | 'logic.gate_or'
  | 'logic.gate_not'
  /**
   * Exploration Foundation L3 (additive): a packaged multi-gate device with its datasheet pin map
   * and one shared supply; `model` names the device (TI SN74LVC08A, quad 2-input AND).
   */
  | 'logic.quad_and'
  /**
   * Sprint POT-UNITS (v5, additive): a three-terminal linear potentiometer (Bourns PTV09A,
   * linear taper): end A, wiper W, end B.
   */
  | 'component.potentiometer';

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
   * Wire routing integrity (2026-10-22): present = an AUTOMATIC wire. Its `vertices` are then the
   * router's, recomputed from scratch after every layout change (route.ts `routeAutoWires`), so
   * its drawing is a function of the current positions and these `waypoints`: the points the user
   * placed while drawing it, which the route passes through in order (intentional constraints).
   * Absent = a MANUAL wire: `vertices` are the user's own geometry (a dragged segment, or a wire
   * drawn before automatic routing existed) and are kept as they are.
   */
  auto?: { waypoints: Point[] };
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

/** One board's program: its programming environment, pinned build profile and source files. */
export interface ProgramSource {
  /** Programming environment (`arduino-cpp`, `micropython`). */
  language: string;
  /** Build profile id: board + environment + pinned toolchain configuration. */
  profile: string;
  /** The entry file: the profile's file name (`sketch.ino`, `main.py`); never renamed or removed. */
  fileName: string;
  /** Exact source text of the entry file. */
  text: string;
  /**
   * Sprint 26 (schema v6): further project files, by relative path (program.ts
   * `programPathIssue`), sorted by path; never the entry file. Absent or empty: a one-file program.
   */
  files?: ProgramFile[];
  /**
   * Sprint 26 (schema v6): the managed libraries pinned for this program (libraryRegistry.ts), by
   * id and exact version, sorted by id. Kept by the product (components that need them, code that
   * includes them); the build uses exactly these versions.
   */
  libraries?: LibraryRef[];
}

/** Sprint 26: one further project file of a program (user-authored, stored exactly). */
export interface ProgramFile {
  /** Relative path, `/`-separated (e.g. `display.h`, `src/util.cpp`, `sensors/dht.py`). */
  path: string;
  text: string;
}

/** Sprint 26: a managed library pinned for a program (an entry of the library registry). */
export interface LibraryRef {
  id: string;
  version: string;
}

/** Deep copy of JSON data. Project documents are plain JSON by construction. */
export function cloneDocument<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
