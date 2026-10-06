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
import type { Device } from './devices.js';
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
}

export interface PartModel {
  /** Terminal ids, as in the domain catalog. */
  readonly terminals: readonly string[];
  /** Live parameters a running session accepts (mirrored after the browser persisted them). */
  readonly liveParams?: readonly string[];
  /** Parameter validation; null when the parameters are usable. */
  validate(ctx: PartContext): EngineError | null;
  /** Discrete state at the start of a run (stateful parts only). */
  initialState?(ctx: PartContext): PartState;
  elements(ctx: PartContext, state: PartState): PartElement[];
  /** Stateful parts: the state the solved operating point implies. */
  nextState?(ctx: PartContext, state: PartState, sol: PartSolution): PartState;
  report(
    ctx: PartContext,
    state: PartState,
    sol: PartSolution,
  ): Pick<ComponentResult, 'current' | 'voltage' | 'terminals'> &
    Partial<Pick<ComponentResult, 'currents' | 'state' | 'outsideModelRange'>>;
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

export const sameState = (a: PartState, b: PartState): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};
