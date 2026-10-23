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
  /**
   * Sprint 12 (R2/R3): a TRANSIENT runtime input the MCU runtime host sets for the part, e.g. the
   * state of a sensor's output stage while it answers a measurement (`runtimeInputs`). Undefined
   * outside a runtime session or before the host set it.
   */
  runtime(key: string): boolean | number | string | undefined;
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
  /** Sprint 19B: the terminal's node is unknown (reached from an unknown-driven output). */
  unknown?(terminal: string): boolean;
  /** A multi-terminal device's exact terminal currents at the solution (into the device). */
  deviceTerminalCurrents?(key: string): { ic: number; ib: number; ie: number } | undefined;
}

/** One datasheet-sourced part a model id stands for. */
export interface PartCard {
  /** The manufacturer part number: a language-neutral technical token (schematic value). */
  readonly partNumber: string;
}

/** A documented limit the solved result exceeds (ratings.ts turns it into a RatingWarning). */
/**
 * Sprint 13 H2 (Component Failure Framework): what kind of published limit was crossed.
 * - `absolute`: a datasheet ABSOLUTE MAXIMUM rating (or maximum allowable value) is exceeded: a
 *   real part risks damage;
 * - `operating`: outside the recommended OPERATING range but within a published absolute maximum:
 *   reliability and the simulated result are not guaranteed;
 * - `unrated`: outside the operating range (or a typical characteristic), and the manufacturer
 *   publishes NO damage threshold for it: the risk is unknown, never presented as safe.
 */
export type LimitKind = 'absolute' | 'operating' | 'unrated';

export interface PartRatingExcess {
  code: 'forward_current' | 'reverse_voltage' | 'power' | 'voltage' | 'current';
  value: number;
  limit: number;
  /** Absent = `absolute` (every Sprint 5-12 check was an absolute or allowable maximum). */
  kind?: LimitKind;
  /** Which element of the part (an RGB channel, a relay's coil or contact), if not the whole part. */
  channel?: string;
}

/** The supply across a part's terminals (`plus` - `minus`), or null when either is unknown. */
export function supplyAcross(
  terminals: Readonly<Record<string, number | null | undefined>>,
  plus: string,
  minus = 'gnd',
): number | null {
  const p = terminals[plus];
  const m = terminals[minus];
  return p != null && m != null ? p - m : null;
}

/**
 * Sprint 13 H2: a module supply (VCC - GND) against its datasheet. Above the specified operating
 * maximum: an `operating` row; above a PUBLISHED absolute maximum (when the datasheet gives one):
 * an `absolute` row instead. Nothing is reported below the minimum: a part there is modelled as
 * unpowered, which `supplyOutsideModel` marks as an unreliable result.
 */
export function supplyLimits(
  supplyV: number | null,
  spec: { maxOperatingV: number; absoluteMaxV?: number },
): PartRatingExcess[] {
  if (supplyV === null) return [];
  if (spec.absoluteMaxV !== undefined && supplyV > spec.absoluteMaxV)
    return [
      {
        kind: 'absolute',
        code: 'voltage',
        value: supplyV,
        limit: spec.absoluteMaxV,
        channel: 'supply',
      },
    ];
  if (supplyV > spec.maxOperatingV)
    return [
      {
        // Within a published absolute maximum: `operating`; none published: `unrated`.
        kind: spec.absoluteMaxV !== undefined ? 'operating' : 'unrated',
        code: 'voltage',
        value: supplyV,
        limit: spec.maxOperatingV,
        channel: 'supply',
      },
    ];
  return [];
}

/**
 * Sprint 13 H2 (unreliable-result indicator): the module is supplied (at least 0.1 V, so a part
 * that is simply switched off is not flagged) but outside its specified operating range. Below
 * the minimum the model shows the part as unpowered; a real part there may behave unpredictably.
 */
export function supplyOutsideModel(
  supplyV: number | null,
  range: { minV: number; maxV: number },
): boolean {
  return supplyV !== null && supplyV >= 0.1 && (supplyV < range.minV || supplyV > range.maxV);
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
  /**
   * Sprint 12: transient runtime inputs (key -> allowed tokens) the MCU runtime host may set
   * (EngineSession.setPartRuntime): never persisted, never a project value.
   */
  readonly runtimeInputs?: Readonly<Record<string, readonly string[]>>;
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
  /**
   * Sprint 19B (logic L1): terminals whose node this part drives to an UNKNOWN level in this
   * state (a gate output whose inputs leave it undetermined). The session marks that node, and
   * everything electrically reachable from it without crossing GND or a supply output, unknown:
   * no number is reported there, and parts reading it see `sol.unknown(terminal)`.
   */
  unknownDriven?(ctx: PartContext, state: PartState): readonly string[];
  /**
   * Sprint 19B: terminals that carry an UNKNOWN current in this state (the supply pins of a gate
   * with an unknown output). A supply output there reports an unknown current; a node there that
   * no supply holds is itself unknown.
   */
  unknownSupply?(ctx: PartContext, state: PartState): readonly string[];
  /**
   * Sprint 19B: the most current the part's unknown output may carry (A): its absolute-maximum
   * continuous output current (a datasheet bound), for the supply's current-limit margin.
   */
  unknownCurrentMaxA?(ctx: PartContext, state: PartState): number;
  /**
   * Sprint 19B: the part's logic inputs and outputs (for the session's combinational-feedback
   * check: an output reaching an input of the same logic network through external elements).
   */
  logicPins?(ctx: PartContext): { inputs: readonly string[]; outputs: readonly string[] };
  /**
   * L3: a packaged device's gates, each with its own inputs and output (all sharing the part's
   * supply pins). The feedback check runs between gates, not between parts.
   */
  logicUnits?(
    ctx: PartContext,
  ): readonly { unit: string; inputs: readonly string[]; outputs: readonly string[] }[];
  /**
   * Sprint 19B: a refusal the SETTLED state implies (e.g. a floating logic input), or null. The
   * session checks it only once every state has settled, never on an intermediate pass.
   */
  refusal?(ctx: PartContext, state: PartState): EngineError | null;
  report(
    ctx: PartContext,
    state: PartState,
    sol: PartSolution,
  ): Pick<ComponentResult, 'current' | 'voltage' | 'terminals'> &
    Partial<Pick<ComponentResult, 'currents' | 'state' | 'outsideModelRange' | 'array' | 'logic'>>;
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
