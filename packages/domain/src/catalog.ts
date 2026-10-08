/**
 * Component type definitions for the types Sprint 2 ships.
 *
 * Data, not code paths. Display text is referenced by translation KEY only; the app resolves
 * keys through its locale bundles. New types follow the approved component families of the PM-6
 * revision (product scope §6.0, 2026-10-06), each with a datasheet-sourced model.
 */

import type { ComponentTypeId, ParamValue, Point, UnitId } from './schema.js';
import { ESP32_DEVKITC_WROOM32, type BoardPin } from './boards/esp32DevkitcWroom32.js';
import { FIRMWARE_ARTIFACTS, PROGRAM_FIRMWARE } from './firmware.js';

export interface TerminalDef {
  /** Language-neutral terminal id, persisted in connections and wire endpoints. */
  id: string;
  /** Position relative to the component origin at rotation 0, in schematic units. */
  offset: Point;
  labelKey: string;
}

export type ParamDef =
  | {
      kind: 'quantity';
      key: string;
      unit: UnitId;
      min: number;
      max: number;
      default: number;
      labelKey: string;
      /** May change while a simulation runs (mirrored as a live control, not a restart). */
      live?: boolean;
      /**
       * Sprint 10: the value is the part's SIMULATED ENVIRONMENT (the light on a photoresistor),
       * not a property of the part. Always live; the inspector groups it as an environment
       * control. `scale` picks the control's scale (illuminance spans decades: logarithmic).
       */
      environment?: { scale: 'linear' | 'log' };
    }
  | {
      kind: 'boolean';
      key: string;
      default: boolean;
      labelKey: string;
      live?: boolean;
      /** Sprint 10: a simulated environment state (motion in front of a PIR sensor). */
      environment?: { scale?: never };
    }
  | {
      kind: 'enum';
      key: string;
      /** Language-neutral tokens; each has its own translation key. */
      options: { value: string; labelKey: string }[];
      default: string;
      labelKey: string;
      live?: boolean;
      environment?: never;
    };

export interface ComponentTypeDef {
  type: ComponentTypeId;
  typeVersion: number;
  /** Reference designator prefix used for automatic references (`R` -> R1, R2...). */
  refPrefix: string;
  nameKey: string;
  /** Symbol id rendered by the app. */
  symbol: string;
  terminals: TerminalDef[];
  params: ParamDef[];
  /** The terminal ties its net to the circuit reference (net role `ground`). */
  groundTerminal?: string;
  /** Search metadata keys; the full multilingual search is a later sprint. */
  aliases: string[];
  /**
   * The component has a momentary actuator whose state is TRANSIENT RUNTIME input only: it is
   * never stored in the project, never advances the revision and resets on Stop/reopen.
   */
  momentary?: boolean;
  /**
   * Sprint 10: the boolean parameter the part's on-canvas actuator toggles (a toggle switch's
   * position, the motion in front of a PIR sensor). A persistent, live edit.
   */
  toggleParam?: string;
  /**
   * Terminals that are normally left unwired (no "partially wired" warning): `all` for a board's
   * or a matrix's pins, or the listed ones (an RGB LED's channels, a relay's NO/NC).
   */
  optionalTerminals?: 'all' | readonly string[];
  /**
   * Sprint 10: false when the deployed ESP32 runtime (Session Host) does not know this type yet.
   * A project with an ESP32 board and such a part is refused at Run with a specific reason,
   * before any session starts; local circuits simulate it normally. Absent means supported.
   */
  mcuRuntime?: false;
  /**
   * Sprint 11 (R1): why `mcuRuntime` is false, when the reason is known and permanent for the
   * current runtime: `time_dependent` — the part's behaviour is defined over simulated time,
   * which the ESP32 runtime does not step (a capacitor). The product names that reason.
   */
  mcuRuntimeReason?: 'time_dependent';
}

/**
 * Classic ESP32 DevKitC geometry (Sprint 6). Header J2 runs down the left side and J3 down the
 * right side, in the board's own pin order, one grid step per header position. Only pins the
 * runtime supports (R1 capability map: digital I/O and input-only pads) and one GND are
 * connectable terminals; 3V3, 5V, EN, the other GND pins, the flash pins and the UART0 console
 * are drawn but not connectable, so no unsupported capability can be wired.
 */
export const BOARD_PIN_PITCH = 20;
export const BOARD_HALF_WIDTH = 60;
export function boardPinPosition(pin: Pick<BoardPin, 'header' | 'position'>): Point {
  const x = pin.header === 'J2' ? -(BOARD_HALF_WIDTH + 20) : BOARD_HALF_WIDTH + 20;
  return { x, y: -200 + BOARD_PIN_PITCH * pin.position };
}
/** The terminal id of a connectable board pin, or undefined if it is not connectable. */
export function boardTerminalId(pin: BoardPin): string | undefined {
  if (pin.gpio !== null && pin.simulatorSupport !== 'none') return `gpio${pin.gpio}`;
  if (pin.role === 'ground' && pin.header === 'J3' && pin.position === 1) return 'gnd';
  return undefined;
}
const ESP32_TERMINALS: TerminalDef[] = ESP32_DEVKITC_WROOM32.pins.flatMap((pin) => {
  const id = boardTerminalId(pin);
  // Pin names are technical silkscreen tokens (IO32, GND): `pin.<terminal>` in every locale.
  return id ? [{ id, offset: boardPinPosition(pin), labelKey: `pin.${id}` }] : [];
});

/**
 * 1088AS 8x8 LED matrix pin map (Velleman VMP502 info sheet): pin n (1..16) -> the row (cathode) or
 * column (anode) line it carries. Columns 1-8 are pins 13, 3, 4, 10, 6, 11, 15, 16; rows 1-8 are pins
 * 9, 14, 8, 12, 1, 7, 2, 5.
 */
export const MATRIX_1088AS_PINS: readonly string[] = [
  'r5',
  'r7',
  'c2',
  'c3',
  'r8',
  'c5',
  'r6',
  'r3', // pins 1-8
  'r1',
  'c4',
  'c6',
  'r4',
  'c1',
  'r2',
  'c7',
  'c8', // pins 9-16
];

/** Sprint 10 (PM-6 revision, V1-PRODUCT-SCOPE.md §6.0): one datasheet-sourced part per type. */
const SPRINT10_TYPES = {
  'component.rgb_led': {
    type: 'component.rgb_led',
    typeVersion: 1,
    refPrefix: 'D',
    nameKey: 'component.component.rgb_led.name',
    symbol: 'symbol.rgb_led',
    // Common cathode (the declared package): one anode per channel, the shared cathode.
    terminals: [
      { id: 'red', offset: { x: -40, y: -20 }, labelKey: 'terminal.red' },
      { id: 'green', offset: { x: -40, y: 0 }, labelKey: 'terminal.green' },
      { id: 'blue', offset: { x: -40, y: 20 }, labelKey: 'terminal.blue' },
      { id: 'cathode', offset: { x: 40, y: 0 }, labelKey: 'terminal.commonCathode' },
    ],
    params: [
      {
        kind: 'enum',
        key: 'model',
        options: [
          {
            value: 'model.rgb_led.kingbright_wp154a4sureqbfzgc',
            labelKey: 'model.rgb_led.kingbright_wp154a4sureqbfzgc',
          },
        ],
        default: 'model.rgb_led.kingbright_wp154a4sureqbfzgc',
        labelKey: 'param.model',
      },
    ],
    aliases: ['rgb', 'rgb led', 'full colour led'],
    optionalTerminals: ['red', 'green', 'blue'],
  },
  'component.photoresistor': {
    type: 'component.photoresistor',
    typeVersion: 1,
    refPrefix: 'LDR',
    nameKey: 'component.component.photoresistor.name',
    symbol: 'symbol.photoresistor',
    terminals: [
      { id: 'a', offset: { x: -40, y: 0 }, labelKey: 'terminal.a' },
      { id: 'b', offset: { x: 40, y: 0 }, labelKey: 'terminal.b' },
    ],
    params: [
      {
        kind: 'enum',
        key: 'model',
        options: [{ value: 'model.ldr.senba_gl5528', labelKey: 'model.ldr.senba_gl5528' }],
        default: 'model.ldr.senba_gl5528',
        labelKey: 'param.model',
      },
      {
        // The light falling on the cell: the simulated environment, not a part property.
        kind: 'quantity',
        key: 'illuminance',
        unit: 'lux',
        min: 1,
        max: 10000,
        default: 100,
        labelKey: 'param.illuminance',
        live: true,
        environment: { scale: 'log' },
      },
    ],
    aliases: ['ldr', 'photoresistor', 'light sensor', 'cds', 'gl5528'],
    mcuRuntime: false,
  },
  'component.buzzer': {
    type: 'component.buzzer',
    typeVersion: 1,
    refPrefix: 'BZ',
    nameKey: 'component.component.buzzer.name',
    symbol: 'symbol.buzzer',
    terminals: [
      { id: 'positive', offset: { x: -40, y: 0 }, labelKey: 'terminal.positive' },
      { id: 'negative', offset: { x: 40, y: 0 }, labelKey: 'terminal.negative' },
    ],
    params: [
      {
        kind: 'enum',
        key: 'model',
        options: [
          { value: 'model.buzzer.cui_cem_1205_ic', labelKey: 'model.buzzer.cui_cem_1205_ic' },
        ],
        default: 'model.buzzer.cui_cem_1205_ic',
        labelKey: 'param.model',
      },
    ],
    aliases: ['buzzer', 'beeper', 'sounder', 'active buzzer'],
  },
  'component.bjt_npn': {
    type: 'component.bjt_npn',
    typeVersion: 1,
    refPrefix: 'Q',
    nameKey: 'component.component.bjt_npn.name',
    symbol: 'symbol.bjt_npn',
    terminals: [
      { id: 'collector', offset: { x: 20, y: -40 }, labelKey: 'terminal.collector' },
      { id: 'base', offset: { x: -40, y: 0 }, labelKey: 'terminal.base' },
      { id: 'emitter', offset: { x: 20, y: 40 }, labelKey: 'terminal.emitter' },
    ],
    params: [
      {
        kind: 'enum',
        key: 'model',
        options: [{ value: 'model.bjt.fairchild_2n3904', labelKey: 'model.bjt.fairchild_2n3904' }],
        default: 'model.bjt.fairchild_2n3904',
        labelKey: 'param.model',
      },
    ],
    aliases: ['transistor', 'npn', 'bjt', '2n3904', 'טרנזיסטור'],
    mcuRuntime: false,
  },
  'sensor.pir_hc_sr501': {
    type: 'sensor.pir_hc_sr501',
    typeVersion: 1,
    refPrefix: 'U',
    nameKey: 'component.sensor.pir_hc_sr501.name',
    symbol: 'symbol.pir',
    // The module's header, in its pin order (GND, OUT, +V).
    terminals: [
      { id: 'gnd', offset: { x: -60, y: -20 }, labelKey: 'terminal.moduleGnd' },
      { id: 'out', offset: { x: -60, y: 0 }, labelKey: 'terminal.out' },
      { id: 'vcc', offset: { x: -60, y: 20 }, labelKey: 'terminal.vcc' },
    ],
    params: [
      {
        kind: 'enum',
        key: 'model',
        options: [{ value: 'model.pir.hc_sr501', labelKey: 'model.pir.hc_sr501' }],
        default: 'model.pir.hc_sr501',
        labelKey: 'param.model',
      },
      {
        // What is in front of the sensor: the simulated environment, not a part property.
        kind: 'boolean',
        key: 'motion',
        default: false,
        labelKey: 'param.motion',
        live: true,
        environment: {},
      },
    ],
    toggleParam: 'motion',
    aliases: ['pir', 'motion sensor', 'hc-sr501', 'חיישן תנועה'],
    mcuRuntime: false,
  },
  'display.led_matrix_8x8': {
    type: 'display.led_matrix_8x8',
    typeVersion: 1,
    refPrefix: 'DS',
    nameKey: 'component.display.led_matrix_8x8.name',
    symbol: 'symbol.led_matrix',
    // The package's 16 pins as on the part: 1-8 along the front edge (left to right), 9-16 back
    // along the rear edge (DIP numbering), each the row (dot cathodes) or column (dot anodes) line
    // the 1088AS pin map gives it. Terminal ids name the LINE (r1..r8, c1..c8).
    terminals: MATRIX_1088AS_PINS.map((line, k) => {
      const n = k + 1;
      const front = n <= 8;
      const col = front ? n - 1 : 16 - n;
      return {
        id: line,
        offset: { x: -80 + 20 * col, y: front ? 140 : -140 },
        labelKey: line.startsWith('r')
          ? `terminal.row${line.slice(1)}`
          : `terminal.col${line.slice(1)}`,
      };
    }),
    params: [
      {
        kind: 'enum',
        key: 'model',
        options: [
          { value: 'model.led_matrix.oasis_1088as', labelKey: 'model.led_matrix.oasis_1088as' },
        ],
        default: 'model.led_matrix.oasis_1088as',
        labelKey: 'param.model',
      },
    ],
    aliases: ['led matrix', 'matrix', 'dot matrix', '1088as', '8x8'],
    optionalTerminals: 'all',
    mcuRuntime: false,
  },
  'component.capacitor': {
    type: 'component.capacitor',
    typeVersion: 1,
    refPrefix: 'C',
    nameKey: 'component.component.capacitor.name',
    symbol: 'symbol.capacitor',
    terminals: [
      { id: 'a', offset: { x: -40, y: 0 }, labelKey: 'terminal.a' },
      { id: 'b', offset: { x: 40, y: 0 }, labelKey: 'terminal.b' },
    ],
    // An ideal, non-polarised capacitor (engine: Capacitor). Its circuit runs time-stepped.
    params: [
      {
        kind: 'quantity',
        key: 'capacitance',
        unit: 'farad',
        min: 1e-9,
        max: 0.01,
        default: 100e-6,
        labelKey: 'param.capacitance',
      },
      {
        // A design value like a resistance: exceeding it is a rating warning.
        kind: 'quantity',
        key: 'ratedVoltage',
        unit: 'volt',
        min: 1,
        max: 1000,
        default: 16,
        labelKey: 'param.ratedVoltage',
      },
    ],
    aliases: ['capacitor', 'cap', 'קבל'],
    mcuRuntime: false,
    mcuRuntimeReason: 'time_dependent',
  },
  'component.relay': {
    type: 'component.relay',
    typeVersion: 1,
    refPrefix: 'K',
    nameKey: 'component.component.relay.name',
    symbol: 'symbol.relay',
    // Coil side (left) and contact side (right) are separate circuits, as in the part.
    terminals: [
      { id: 'coil1', offset: { x: -60, y: -20 }, labelKey: 'terminal.coil1' },
      { id: 'coil2', offset: { x: -60, y: 20 }, labelKey: 'terminal.coil2' },
      { id: 'com', offset: { x: 20, y: 40 }, labelKey: 'terminal.com' },
      { id: 'no', offset: { x: 60, y: 0 }, labelKey: 'terminal.no' },
      { id: 'nc', offset: { x: 60, y: -20 }, labelKey: 'terminal.nc' },
    ],
    params: [
      {
        kind: 'enum',
        key: 'model',
        options: [
          {
            value: 'model.relay.songle_srd_05vdc_sl_c',
            labelKey: 'model.relay.songle_srd_05vdc_sl_c',
          },
        ],
        default: 'model.relay.songle_srd_05vdc_sl_c',
        labelKey: 'param.model',
      },
    ],
    aliases: ['relay', 'spdt relay', 'srd-05vdc', 'ממסר', 'ריליי'],
    optionalTerminals: ['no', 'nc'],
    mcuRuntime: false,
  },
} satisfies Partial<Record<ComponentTypeId, ComponentTypeDef>>;

export const CATALOG: Record<ComponentTypeId, ComponentTypeDef> = {
  ...SPRINT10_TYPES,
  'instrument.lab_psu': {
    type: 'instrument.lab_psu',
    typeVersion: 1,
    refPrefix: 'PSU',
    nameKey: 'component.instrument.lab_psu.name',
    symbol: 'symbol.lab_psu',
    terminals: [
      { id: 'positive', offset: { x: 40, y: -20 }, labelKey: 'terminal.positive' },
      { id: 'negative', offset: { x: 40, y: 20 }, labelKey: 'terminal.negative' },
    ],
    params: [
      {
        kind: 'quantity',
        key: 'setpointVoltage',
        unit: 'volt',
        min: 0,
        max: 30,
        default: 5,
        labelKey: 'param.setpointVoltage',
        live: true,
      },
      {
        kind: 'quantity',
        key: 'currentLimit',
        unit: 'ampere',
        min: 0.001,
        max: 5,
        default: 0.1,
        labelKey: 'param.currentLimit',
        live: true,
      },
      {
        kind: 'boolean',
        key: 'outputEnabled',
        // A newly created supply is ready to power the circuit (Product Alpha maintenance).
        // Stored projects keep their own value: defaults apply only to new components.
        default: true,
        labelKey: 'param.outputEnabled',
        live: true,
      },
    ],
    aliases: ['psu', 'power supply'],
  },
  'component.ground': {
    type: 'component.ground',
    typeVersion: 1,
    refPrefix: 'GND',
    nameKey: 'component.component.ground.name',
    symbol: 'symbol.ground',
    terminals: [{ id: 'ref', offset: { x: 0, y: -20 }, labelKey: 'terminal.ref' }],
    params: [],
    groundTerminal: 'ref',
    aliases: ['gnd', '0V'],
  },
  'component.resistor': {
    type: 'component.resistor',
    typeVersion: 1,
    refPrefix: 'R',
    nameKey: 'component.component.resistor.name',
    symbol: 'symbol.resistor',
    terminals: [
      { id: 'a', offset: { x: -40, y: 0 }, labelKey: 'terminal.a' },
      { id: 'b', offset: { x: 40, y: 0 }, labelKey: 'terminal.b' },
    ],
    params: [
      {
        kind: 'quantity',
        key: 'resistance',
        unit: 'ohm',
        min: 0.001,
        max: 1e9,
        default: 1000,
        labelKey: 'param.resistance',
      },
    ],
    aliases: ['res'],
  },
  'component.led': {
    type: 'component.led',
    typeVersion: 1,
    refPrefix: 'D',
    nameKey: 'component.component.led.name',
    symbol: 'symbol.led',
    terminals: [
      { id: 'anode', offset: { x: -40, y: 0 }, labelKey: 'terminal.anode' },
      { id: 'cathode', offset: { x: 40, y: 0 }, labelKey: 'terminal.cathode' },
    ],
    params: [
      {
        kind: 'enum',
        key: 'model',
        // The curated list holds only datasheet-sourced model cards (product scope §6.1).
        options: [
          { value: 'model.led.vishay_tlhr5400', labelKey: 'model.led.vishay_tlhr5400' },
          // Sprint 10: the approved additional colour cards (§6.1 LED row), datasheet-sourced.
          { value: 'model.led.vishay_tlhy5400', labelKey: 'model.led.vishay_tlhy5400' },
          { value: 'model.led.vishay_tlhg4900', labelKey: 'model.led.vishay_tlhg4900' },
        ],
        default: 'model.led.vishay_tlhr5400',
        labelKey: 'param.model',
      },
    ],
    aliases: ['led', 'light'],
  },
  'component.diode': {
    type: 'component.diode',
    typeVersion: 1,
    refPrefix: 'D',
    nameKey: 'component.component.diode.name',
    symbol: 'symbol.diode',
    terminals: [
      { id: 'anode', offset: { x: -40, y: 0 }, labelKey: 'terminal.anode' },
      { id: 'cathode', offset: { x: 40, y: 0 }, labelKey: 'terminal.cathode' },
    ],
    params: [
      {
        kind: 'enum',
        key: 'model',
        // Datasheet-sourced card only (packages/engine/PROVENANCE.md).
        options: [{ value: 'model.diode.vishay_1n4148', labelKey: 'model.diode.vishay_1n4148' }],
        default: 'model.diode.vishay_1n4148',
        labelKey: 'param.model',
      },
    ],
    aliases: ['diode', '1n4148'],
  },
  'component.push_button': {
    type: 'component.push_button',
    typeVersion: 1,
    refPrefix: 'SW',
    nameKey: 'component.component.push_button.name',
    symbol: 'symbol.push_button',
    terminals: [
      { id: 'a', offset: { x: -40, y: 0 }, labelKey: 'terminal.a' },
      { id: 'b', offset: { x: 40, y: 0 }, labelKey: 'terminal.b' },
    ],
    // Normally open, momentary SPST. Its pressed state is runtime input, not a parameter.
    params: [],
    momentary: true,
    aliases: ['button', 'push button', 'momentary'],
  },
  'component.toggle_switch': {
    type: 'component.toggle_switch',
    typeVersion: 1,
    refPrefix: 'SW',
    nameKey: 'component.component.toggle_switch.name',
    symbol: 'symbol.toggle_switch',
    terminals: [
      { id: 'a', offset: { x: -40, y: 0 }, labelKey: 'terminal.a' },
      { id: 'b', offset: { x: 40, y: 0 }, labelKey: 'terminal.b' },
    ],
    // SPST. Its position is persistent project state and a live control while running.
    params: [
      { kind: 'boolean', key: 'closed', default: false, labelKey: 'param.closed', live: true },
    ],
    toggleParam: 'closed',
    aliases: ['switch', 'toggle', 'spst'],
  },
  'board.esp32_devkitc_wroom32': {
    type: 'board.esp32_devkitc_wroom32',
    typeVersion: 1,
    refPrefix: 'U',
    nameKey: 'component.board.esp32_devkitc_wroom32.name',
    symbol: 'symbol.esp32_devkitc',
    terminals: ESP32_TERMINALS,
    params: [
      {
        // What the board runs: its authored program (`program`, Sprint 7: the current build of
        // `programs[boardId]`), or a pinned reference image by content identity (sha256; examples,
        // tests and engineering). Not live: changing it while running is structural (Stop first).
        kind: 'enum',
        key: 'firmware',
        options: [
          { value: PROGRAM_FIRMWARE, labelKey: 'firmware.program' },
          ...FIRMWARE_ARTIFACTS.map((f) => ({ value: f.sha256, labelKey: f.nameKey })),
        ],
        default: PROGRAM_FIRMWARE,
        labelKey: 'param.firmware',
      },
    ],
    // The board GND is the circuit reference the runtime drives its pads against.
    groundTerminal: 'gnd',
    aliases: ['esp32', 'devkit', 'mcu', 'wroom'],
    optionalTerminals: 'all',
  },
};

/** Palette order. */
export const CATALOG_ORDER: readonly ComponentTypeId[] = [
  'instrument.lab_psu',
  'component.ground',
  'component.resistor',
  'component.led',
  'component.diode',
  'component.push_button',
  'component.toggle_switch',
  'component.rgb_led',
  'component.photoresistor',
  'component.buzzer',
  'component.relay',
  'component.bjt_npn',
  'sensor.pir_hc_sr501',
  'display.led_matrix_8x8',
  'component.capacitor',
  'board.esp32_devkitc_wroom32',
];

export function isComponentType(type: string): type is ComponentTypeId {
  return Object.prototype.hasOwnProperty.call(CATALOG, type);
}

export function getTypeDef(type: string): ComponentTypeDef | undefined {
  return isComponentType(type) ? CATALOG[type] : undefined;
}

export function defaultParams(def: ComponentTypeDef): Record<string, ParamValue> {
  const params: Record<string, ParamValue> = {};
  for (const p of def.params) {
    params[p.key] = p.kind === 'quantity' ? { value: p.default, unit: p.unit } : p.default;
  }
  return params;
}

/**
 * Sprint 10 product rule: a part is offered for a board project only when the board's runtime can
 * simulate it honestly. Why `type` cannot be placed in `doc` right now, or null:
 * - `part_needs_runtime`: the project has a Classic ESP32 and the part is not supported by the
 *   ESP32 runtime yet (catalog `mcuRuntime: false`);
 * - `board_needs_runtime`: `type` is the ESP32 board and the project already holds such parts.
 * Sprint 11: when the reason is the part's time-dependent behaviour (`mcuRuntimeReason`), the
 * block says so (`part_time_dependent`, `board_time_dependent`).
 * Local circuits (no board) can use every part.
 */
export type PlacementBlock =
  'part_needs_runtime' | 'board_needs_runtime' | 'part_time_dependent' | 'board_time_dependent';

export function placementBlock(
  doc: { components: readonly { type: ComponentTypeId }[] },
  type: ComponentTypeId,
): PlacementBlock | null {
  const isBoard = (t: ComponentTypeId) => t === 'board.esp32_devkitc_wroom32';
  const timed = (t: ComponentTypeId) => CATALOG[t].mcuRuntimeReason === 'time_dependent';
  if (CATALOG[type].mcuRuntime === false && doc.components.some((c) => isBoard(c.type)))
    return timed(type) ? 'part_time_dependent' : 'part_needs_runtime';
  if (isBoard(type)) {
    const held = doc.components.filter((c) => CATALOG[c.type].mcuRuntime === false);
    if (held.length)
      return held.every((c) => timed(c.type)) ? 'board_time_dependent' : 'board_needs_runtime';
  }
  return null;
}
