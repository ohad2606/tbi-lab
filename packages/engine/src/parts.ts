/**
 * Part models (Sprint 10, PM-6 revision): how a catalog component that is more than one two-pin
 * element becomes engine devices, and how its result is reported. The eight original types keep
 * their dedicated, frozen path in session.ts (their DC results are bit-identical); every type added
 * from Sprint 10 on is a `PartModel` registered here, so the session has no per-type code for it.
 *
 * A part model is data plus three pure functions:
 * - `elements`: the electrical elements for the part's current discrete state. An element is
 *   either an engine `Device` (any number of nodes) or an ideal CONTACT (a 0 V branch when closed,
 *   nothing at all when open), which joins the same short/loop analysis as the switches;
 * - `nextState` (stateful parts only): the discrete state implied by a solved operating point, for
 *   the session's fixed-point loop (a relay armature, a module that is powered or not);
 * - `report`: the language-neutral result for the inspector, views and tests.
 *
 * The reference analysis ("every island reaches GND") follows the elements themselves: a device
 * element joins all of its nodes, a closed contact its two nodes, an open contact nothing. So a
 * relay's coil and contacts stay galvanically isolated, exactly as in the real part.
 */

import type { ComponentInstance } from '@tbi-lab/domain';
import type { Device, TimeStep } from './devices.js';
import type { ComponentResult, EngineError } from './session.js';

/** A part's discrete state (language-neutral keys; booleans, numbers or tokens). */
export type PartState = Readonly<Record<string, boolean | number | string>>;

export type PartElement =
  | {
      kind: 'device';
      /** Unique device id in the circuit (the component id, or `${id}/${sub}`). */
      key: string;
      /** Solver nodes it touches (two or more), for the reference analysis. */
      nodes: string[];
      make: () => Device;
    }
  | {
      kind: 'contact';
      key: string;
      nodes: [string, string];
      closed: boolean;
    };

/** What a part model sees of its component while compiling. */
export interface PartContext {
  readonly component: ComponentInstance;
  /** Solver node of one of its terminals. */
  node(terminal: string): string;
  /** A quantity parameter in SI units, with any live (mirrored) value applied. */
  quantity(key: string): number | undefined;
  /** A boolean or enum parameter, with any live value applied. */
  value(key: string): unknown;
  /** Time-stepped sessions only (Sprint 10): the step being solved; undefined for a DC solve. */
  readonly step?: TimeStep;
  /** Time-stepped sessions: the part's history from the last accepted step (undefined at t = 0). */
  history(): PartState | undefined;
}

/** The solved operating point, as a part model may read it. */
export interface PartSolution {
  /** Potential of a terminal relative to GND, or null where undefined. */
  potential(terminal: string): number | null;
  /** Current of one of the part's device elements (device sign convention). */
  deviceCurrent(key: string): number;
  /** Current through a closed contact element, from its first to its second node; null if its share is undefined (a redundant ideal path); 0 when open. */
  contactCurrent(key: string): number | null;
  /** The device object of one of the part's elements (for model-specific readouts). */
  device(key: string): Device | undefined;
  /** A multi-terminal device's exact terminal currents at the solution (into the device). */
  deviceTerminalCurrents?(key: string): { ic: number; ib: number; ie: number } | undefined;
}

/** One datasheet-sourced part a model id stands for. */
export interface PartCard {
  /** The manufacturer part number: a language-neutral technical token (schematic value). */
  readonly partNumber: string;
}

/** A documented limit the solved result exceeds (ratings.ts turns it into a RatingWarning). */
export interface PartRatingExcess {
  code: 'forward_current' | 'reverse_voltage' | 'power' | 'voltage' | 'current';
  value: number;
  limit: number;
  /** Which element of the part (an RGB channel, a relay's coil or contact), if not the whole part. */
  channel?: string;
}

export interface PartModel {
  /** Terminal ids, as in the domain catalog. */
  readonly terminals: readonly string[];
  /** The model ids (`params.model`) this part accepts, with their datasheet part. */
  readonly cards: Readonly<Record<string, PartCard>>;
  /**
   * Datasheet absolute-maximum checks on a solved result (warnings only, never physics).
   * `params` are the component's stored parameters.
   */
  ratings?(params: Readonly<Record<string, unknown>>, result: ComponentResult): PartRatingExcess[];
  /** Live parameters a running session accepts (mirrored after the browser persisted them). */
  readonly liveParams?: readonly string[];
  /** Parameter validation; null when the parameters are usable. */
  validate(ctx: PartContext): EngineError | null;
  /** Discrete state at the start of a run (stateful parts only). */
  initialState?(ctx: PartContext): PartState;
  elements(ctx: PartContext, state: PartState): PartElement[];
  /** Stateful parts: the state the solved operating point implies. */
  nextState?(ctx: PartContext, state: PartState, sol: PartSolution): PartState;
  /**
   * Time-dependent parts (a capacitor): the session runs time-stepped when the circuit holds one.
   * `history` is what the accepted step leaves for the next (integration history).
   */
  readonly timeDependent?: boolean;
  history?(ctx: PartContext, sol: PartSolution): PartState;
  report(
    ctx: PartContext,
    state: PartState,
    sol: PartSolution,
  ): Pick<ComponentResult, 'current' | 'voltage' | 'terminals'> &
    Partial<Pick<ComponentResult, 'currents' | 'state' | 'outsideModelRange' | 'array'>>;
}

const registry = new Map<string, PartModel>();

/** Register a part model for a catalog type (each type once). */
export function registerPart(type: string, model: PartModel): void {
  if (registry.has(type)) throw new Error(`part model already registered: ${type}`);
  registry.set(type, model);
}

export function partModel(type: string): PartModel | undefined {
  return registry.get(type);
}

/** The manufacturer part number behind a model id, for any registered part (or undefined). */
export function partNumber(modelId: unknown): string | undefined {
  if (typeof modelId !== 'string') return undefined;
  for (const m of registry.values()) if (m.cards[modelId]) return m.cards[modelId]!.partNumber;
  return undefined;
}

/** The standard model-id check: the stored model must be one of the part's cards. */
export function validateCard(ctx: PartContext, cards: PartModel['cards']): EngineError | null {
  const m = ctx.value('model');
  return typeof m === 'string' && cards[m]
    ? null
    : { code: 'invalid_parameter', components: [ctx.component.id], param: 'model' };
}

export const sameState = (a: PartState, b: PartState): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};
