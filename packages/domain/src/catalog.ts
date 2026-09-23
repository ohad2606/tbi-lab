/**
 * Component type definitions for the types Sprint 2 ships.
 *
 * Data, not code paths. Display text is referenced by translation KEY only; the app resolves
 * keys through its locale bundles. The V1 catalog is closed (product scope PM-6): new types
 * require a PM scope decision.
 */

import type { ComponentTypeId, ParamValue, Point, UnitId } from './schema.js';

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
    }
  | { kind: 'boolean'; key: string; default: boolean; labelKey: string; live?: boolean }
  | {
      kind: 'enum';
      key: string;
      /** Language-neutral tokens; each has its own translation key. */
      options: { value: string; labelKey: string }[];
      default: string;
      labelKey: string;
      live?: boolean;
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
}

export const CATALOG: Record<ComponentTypeId, ComponentTypeDef> = {
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
        default: false,
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
        options: [{ value: 'model.led.vishay_tlhr5400', labelKey: 'model.led.vishay_tlhr5400' }],
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
    aliases: ['switch', 'toggle', 'spst'],
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
