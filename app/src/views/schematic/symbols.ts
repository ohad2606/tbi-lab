/**
 * Schematic symbol registry (Sprint 9, D-S9-2): how each component TYPE appears in the generated
 * professional schematic — which conventional symbol, and how its project terminals map to that
 * symbol's pins. Data only: the layout and the renderer have no per-type code paths. A new
 * component type adds one entry here (and, if it needs a new symbol, one drawing in the renderer).
 *
 * Two-pin symbols are drawn horizontally at rotation 0 with pin `a` at (−40, 0) and pin `b` at
 * (+40, 0); `a`/`b` name the project terminals on those ends (e.g. an LED's anode is its `a` end,
 * so the triangle points from anode to cathode wherever the layout puts it).
 */

import {
  ESP32_DEVKITC_WROOM32,
  boardTerminalId,
  type ComponentInstance,
  type ComponentTypeId,
} from '@tbi-lab/domain';

export type SchematicSymbolKey =
  | 'resistor'
  | 'led'
  | 'diode'
  | 'switch.push'
  | 'switch.toggle'
  | 'source.dc'
  | 'module'
  | 'photoresistor'
  | 'buzzer';

export interface TwoPinSymbol {
  kind: 'two-pin';
  key: SchematicSymbolKey;
  /** Project terminal on the symbol's left end (rotation 0). */
  a: string;
  /** Project terminal on the symbol's right end (rotation 0). */
  b: string;
  /** A design value printed beside the symbol: the quantity parameter that names the part. */
  valueParam?: string;
}

export interface ModulePin {
  terminal: string;
  /** Technical pin name (silkscreen token), LTR in every locale. */
  name: string;
  side: 'left' | 'right';
  /** Order along its side, top to bottom. */
  order: number;
}

/**
 * Sprint 10: the conventional symbol drawn inside a multi-pin part's block (the block carries the
 * pin names; the glyph shows what the part IS: a relay's coil and change-over contact, an RGB
 * LED's three emitters on a common cathode, ...).
 */
export type ModuleGlyph = 'mcu' | 'rgb_led.cc' | 'relay.spdt' | 'bjt.npn' | 'pir' | 'led_matrix';

export interface ModuleSymbol {
  kind: 'module';
  key: 'module';
  /** Every connectable pin of the module, by side and order. */
  pins: ModulePin[];
  /** Short technical name printed inside the block (not translated: a part name). */
  partName: string;
  glyph: ModuleGlyph;
}

/** A reference symbol: the part itself is drawn as a ground mark at its connection. */
export interface GroundSymbol {
  kind: 'ground';
  terminal: string;
}

export type SchematicSymbol = TwoPinSymbol | ModuleSymbol | GroundSymbol;

/**
 * ESP32 DevKitC: a module block with its connectable header pins by NAME (IO4, IO34, GND); the
 * J2 header is the left side and J3 the right side, in header order — the same sides as on the
 * physical board, so the two views are easy to relate.
 */
const ESP32_PINS: ModulePin[] = ESP32_DEVKITC_WROOM32.pins.flatMap((pin) => {
  const terminal = boardTerminalId(pin);
  return terminal
    ? [
        {
          terminal,
          name: pin.headerLabel,
          side: pin.header === 'J2' ? ('left' as const) : ('right' as const),
          order: pin.position,
        },
      ]
    : [];
});

export const SCHEMATIC_SYMBOLS: Record<ComponentTypeId, SchematicSymbol> = {
  'component.resistor': {
    kind: 'two-pin',
    key: 'resistor',
    a: 'a',
    b: 'b',
    valueParam: 'resistance',
  },
  'component.led': { kind: 'two-pin', key: 'led', a: 'anode', b: 'cathode' },
  'component.diode': { kind: 'two-pin', key: 'diode', a: 'anode', b: 'cathode' },
  'component.push_button': { kind: 'two-pin', key: 'switch.push', a: 'a', b: 'b' },
  'component.toggle_switch': { kind: 'two-pin', key: 'switch.toggle', a: 'a', b: 'b' },
  // The lab supply is a DC voltage source: + on its `a` end.
  'instrument.lab_psu': {
    kind: 'two-pin',
    key: 'source.dc',
    a: 'positive',
    b: 'negative',
    valueParam: 'setpointVoltage',
  },
  'component.ground': { kind: 'ground', terminal: 'ref' },
  // Sprint 10 parts.
  'component.photoresistor': { kind: 'two-pin', key: 'photoresistor', a: 'a', b: 'b' },
  'component.buzzer': { kind: 'two-pin', key: 'buzzer', a: 'positive', b: 'negative' },
  'component.rgb_led': {
    kind: 'module',
    key: 'module',
    pins: [
      { terminal: 'red', name: 'R', side: 'left', order: 1 },
      { terminal: 'green', name: 'G', side: 'left', order: 2 },
      { terminal: 'blue', name: 'B', side: 'left', order: 3 },
      { terminal: 'cathode', name: 'K', side: 'right', order: 1 },
    ],
    partName: 'RGB LED',
    glyph: 'rgb_led.cc',
  },
  'component.bjt_npn': {
    kind: 'module',
    key: 'module',
    pins: [
      { terminal: 'base', name: 'B', side: 'left', order: 1 },
      { terminal: 'collector', name: 'C', side: 'right', order: 1 },
      { terminal: 'emitter', name: 'E', side: 'right', order: 2 },
    ],
    partName: 'NPN',
    glyph: 'bjt.npn',
  },
  'sensor.pir_hc_sr501': {
    kind: 'module',
    key: 'module',
    pins: [
      { terminal: 'vcc', name: 'VCC', side: 'left', order: 1 },
      { terminal: 'gnd', name: 'GND', side: 'left', order: 2 },
      { terminal: 'out', name: 'OUT', side: 'right', order: 1 },
    ],
    partName: 'PIR',
    glyph: 'pir',
  },
  'component.relay': {
    kind: 'module',
    key: 'module',
    pins: [
      { terminal: 'coil1', name: 'A1', side: 'left', order: 1 },
      { terminal: 'coil2', name: 'A2', side: 'left', order: 2 },
      { terminal: 'nc', name: 'NC', side: 'right', order: 1 },
      { terminal: 'com', name: 'COM', side: 'right', order: 2 },
      { terminal: 'no', name: 'NO', side: 'right', order: 3 },
    ],
    partName: 'Relay SPDT',
    glyph: 'relay.spdt',
  },
  'board.esp32_devkitc_wroom32': {
    kind: 'module',
    key: 'module',
    pins: ESP32_PINS,
    partName: 'ESP32-DevKitC',
    glyph: 'mcu',
  },
};

export function schematicSymbol(c: Pick<ComponentInstance, 'type'>): SchematicSymbol {
  return SCHEMATIC_SYMBOLS[c.type];
}
