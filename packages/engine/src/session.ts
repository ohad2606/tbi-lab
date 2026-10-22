/**
 * The production electrical-engine boundary (roadmap §8.1, ADR-008).
 *
 * Input: an immutable, language-neutral SimulationSnapshot (packages/domain). Output: typed,
 * language-neutral results or a structured error code the UI localizes. No I/O, timers, DOM
 * or locale. MNA/Newton internals never cross this boundary. The same module runs in the
 * browser Worker (Mode A) and, later, in the server Session Host (Mode B).
 *
 * The session holds the loaded snapshot plus RUNTIME copies of live PSU controls. It is never
 * authoritative for any project value: the browser persists a change first, then mirrors it
 * here with the project revision it came from (architecture §2.2, category 2).
 */

import type { ComponentInstance, SimulationSnapshot } from '@tbi-lab/domain';
import { liveControlProblem } from '@tbi-lab/domain';
import type { TimeStep } from './devices.js';
import { Circuit, ConvergenceError } from './circuit.js';
import { Diode, LabPsu, Resistor, VoltageSource, type Device } from './devices.js';
import { GpioPin, outsideCharacterizedRegion } from './esp32Gpio.js';
import { Npn } from './bjt.js';

/** The solver's default junction gmin (circuit.ts DEFAULTS), for exact device readouts. */
const DC_GMIN = 1e-12;
import { SingularMatrixError } from './linalg.js';
import { MODEL_CARDS, MODEL_VALID_CURRENT_A } from './registry.js';
import { logicFeedback, unknownClosure, type TopoElement } from './logic/topology.js';
import type { LogicInspection } from './parts/logicInspection.js';
import {
  partModel,
  sameState,
  type PartContext,
  type PartElement,
  type PartModel,
  type PartSolution,
  type PartState,
} from './parts.js';
import './parts/index.js';

export const ENGINE_VERSION = '0.1.0';

/** Where the solver's single reference node lives. Every GND symbol is this node. */
const REF = '0';

export type SupplyMode = 'cv' | 'cc' | 'off';

/**
 * Runtime R2: an MCU pad attached to a component terminal's electrical node. The pad is the
 * approved ESP32 pin model (`GpioPin`, esp32Gpio.ts) between that node and GND; its drive mode
 * is TRANSIENT runtime state set by the running firmware, never a project value. Until the MCU
 * becomes a project component (Sprint 6), attachments are supplied with the session. Without
 * attachments the engine is exactly the browser path.
 */
export interface McuPinAttachment {
  /** ESP32 GPIO number. Capability rules (flash pads, input-only pads) are enforced by the host. */
  gpio: number;
  component: string;
  terminal: string;
}

/** The drive modes a running firmware can put a pad in (internal pulls are not supported). */
export type RuntimePinMode = 'input' | 'output-high' | 'output-low';

export interface PinResult {
  gpio: number;
  mode: RuntimePinMode;
  /** Pad potential relative to GND, volts. */
  voltage: number;
  /** Current delivered by the pad into the circuit, amperes. */
  current: number;
  /**
   * Sprint 13 P2: present (true) only when a driven pad operates beyond its characterized point
   * (esp32Gpio.ts `outsideCharacterizedRegion`): `current` is then the linear model's
   * extrapolation, not a physical value, and must not be presented as one.
   */
  outsideModelRange?: true;
  /**
   * R4 (runtime host, architecture A1): the pad is a PWM output. `voltage` and `current` above are
   * then time-averages; these are the waveform and the two operating points it alternates between.
   */
  pwm?: PwmPadFigures;
  /** R4: the largest |current| over the PWM operating points, when it differs from the average. */
  peakCurrent?: number;
  /**
   * Sprint 17C (review V2): the lowest and highest pad voltage over every combination of the PWM
   * outputs (present when it changes), for the voltage ratings: they apply to the extremes.
   */
  voltageRange?: [number, number];
}

/** R4: a PWM pad's waveform (ns, exact to float precision) and its high/low pad currents (A). */
export interface PwmPadFigures {
  duty: number;
  periodNs: number;
  highNs: number;
  currentHigh: number;
  currentLow: number;
}

/**
 * R4: a component a PWM output switches. Its result is the time-average over the waveform; these
 * are the peaks over the operating points (A), which the ratings check instead of the average.
 */
export interface PwmComponentFigures {
  peakCurrent: number | null;
  peakCurrents?: Record<string, number | null>;
  peakArray?: number[];
  /**
   * Sprint 17C (review V2): [lowest, highest] over every combination of the PWM outputs, of the
   * voltage across the part and of each terminal potential (null where undefined).
   */
  voltageRange?: [number, number] | null;
  terminalRanges?: Record<string, [number, number] | null>;
}

export interface PsuControl {
  setpointVoltage?: number;
  currentLimit?: number;
  outputEnabled?: boolean;
}

/**
 * A LIVE PERSISTENT control: a value the browser has already persisted in the project, now
 * mirrored into the running session (architecture §2.2, category 2). PSU settings, and the
 * toggle-switch position (`closed`). Parts added from Sprint 10 on (parts.ts) mirror their own
 * declared live parameters (`liveParams`, e.g. a sensor's simulated environment) through `params`,
 * in SI units.
 */
export type LiveControl = PsuControl & {
  closed?: boolean;
  params?: Record<string, number | boolean | string>;
};

export type EngineErrorCode =
  | 'empty_circuit'
  | 'no_ground'
  | 'floating_circuit'
  | 'psu_shorted'
  | 'psu_parallel'
  | 'invalid_parameter'
  | 'unsupported_component'
  | 'invalid_attachment'
  | 'singular_circuit'
  | 'no_convergence'
  /**
   * Sprint 10: the circuit has no DC steady state because a part's discrete state contradicts the
   * operating point it produces (a relay that switches off its own coil: it chatters/buzzes).
   */
  | 'no_steady_state'
  /**
   * Sprint 19B (logic L1, each named, never approximated):
   * - `logic_input_floating`: a logic input with no DC path to anything (`param`: the pin);
   * - `logic_supply_missing`: a logic part's V_CC or GND pin is not connected to anything;
   * - `logic_supply_uncharacterized`: its supply is outside every datasheet row (EF-D3 A);
   * - `logic_output_uncharacterized`: an output current the datasheet does not guarantee at
   *   this supply (only the ±100 µA ranged row applies off the tabulated points);
   * - `logic_feedback_unsupported`: a logic output reaches an input of the same network
   *   (latches and oscillators need propagation delay, not simulated in DC sessions);
   * - `logic_unknown_state`: an unknown level reaches something that must have a value (an MCU
   *   input, a supply in current limit, a logic part's own supply).
   * L3 (packaged logic):
   * - `logic_unpowered_uncharacterized`: the device's V_CC is 0 V and its datasheet gives no
   *   power-off (I_off) specification (SN74LVC08A): an unpowered device is not simulated.
   */
  | 'logic_input_floating'
  | 'logic_supply_missing'
  | 'logic_supply_uncharacterized'
  | 'logic_output_uncharacterized'
  | 'logic_feedback_unsupported'
  | 'logic_unknown_state'
  | 'logic_unpowered_uncharacterized'
  | 'internal';

export interface EngineError {
  code: EngineErrorCode;
  /** Component references involved, in document order (language-neutral ids). */
  components?: string[];
  /** Net ids involved. */
  nets?: string[];
  /** For floating_circuit: the island is floating because these PSU outputs are off. */
  outputOffSupplies?: string[];
  param?: string;
  /** Technical detail for development logs. Never shown as user text. */
  detail?: Record<string, unknown>;
}

export interface ComponentResult {
  id: string;
  type: ComponentInstance['type'];
  /**
   * Current in amperes. Resistor and switches: terminal a -> b. LED and diode: anode ->
   * cathode. PSU: delivered out of the + terminal into the circuit. `null` only for a closed
   * switch in parallel with another ideal path, whose own share is not defined.
   */
  current: number | null;
  /** Voltage across the component in volts (a-b, anode-cathode, + minus -), or null if undefined. */
  voltage: number | null;
  /** Potential of each terminal relative to GND, or null where it is not defined. */
  terminals: Record<string, number | null>;
  /** PSU only: the operating state found by the solver. */
  mode?: SupplyMode;
  /** Switches only: whether the contact was closed for this solve. */
  closed?: boolean;
  /**
   * LED and diode only, and only when forward current flows: true when that current lies
   * outside the model card's documented validity range. A flag; it never alters numbers.
   */
  outsideModelRange?: boolean;
  /**
   * Sprint 19B: the result is UNKNOWN (the part is on a net an undetermined logic level reaches):
   * its currents and the potentials of the affected terminals are null, never a number.
   */
  unknown?: true;
  /**
   * Parts with several elements (Sprint 10): named currents in amperes, e.g. the RGB LED's
   * `red`/`green`/`blue` channel currents or a relay's `coil` current. Language-neutral keys.
   */
  currents?: Record<string, number | null>;
  /**
   * Parts with a discrete or derived state (Sprint 10), e.g. a relay's `energized`, a buzzer's
   * `sounding`. Language-neutral keys and values.
   */
  state?: Record<string, number | boolean | string>;
  /**
   * Arrays of identical elements (Sprint 10, LED matrices): their currents in row-major order,
   * amperes (a dot's forward current).
   */
  array?: { rows: number; cols: number; currents: number[] };
  /** R4: present when a PWM output switches this part: its values above are time-averages. */
  pwm?: PwmComponentFigures;
  /** L2: logic parts only: each gate's input/output levels and measured pin voltages. */
  logic?: LogicInspection;
}

export interface SolveStats {
  unknowns: number;
  newtonIterations: number;
  activeSetIterations: number;
  maxKclResidualA: number;
  maxBranchResidualV: number;
  maxBranchResidualA: number;
}

interface OutcomeBase {
  snapshotId: string;
  /** The project revision the snapshot was derived from. */
  snapshotRevision: number;
  /** The latest project revision mirrored into this session by a live control. */
  appliedRevision: number;
  engineVersion: string;
}

export interface SolveSuccess extends OutcomeBase {
  ok: true;
  /** Only when MCU pins are attached (runtime R2): one entry per attached pad, by GPIO order. */
  pins?: PinResult[];
  /** Net id -> potential relative to GND, volts. Nets with no defined potential are absent. */
  netVoltages: Record<string, number>;
  components: Record<string, ComponentResult>;
  /** Components with no wired terminal: not part of the circuit, not simulated. */
  notConnected: string[];
  stats: SolveStats;
  /** Time-stepped sessions (Sprint 10): simulated time of this state since Run, seconds. */
  time?: number;
  /**
   * Sprint 19B (logic L1): nets whose potential is UNKNOWN (reached from an unknown-driven logic
   * output). They are absent from `netVoltages`, and every component on them is `unknown`.
   */
  unknownNets?: string[];
}

export interface SolveFailure extends OutcomeBase {
  ok: false;
  error: EngineError;
}

export type SolveOutcome = SolveSuccess | SolveFailure;

type Params = Record<string, unknown>;

const quantity = (params: Params, key: string): number | undefined => {
  const v = params[key];
  return typeof v === 'object' && v !== null && typeof (v as { value?: unknown }).value === 'number'
    ? (v as { value: number }).value
    : undefined;
};

class UnionFind {
  private parent = new Map<string, string>();
  find(k: string): string {
    if (!this.parent.has(k)) this.parent.set(k, k);
    let r = k;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(k, r);
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/**
 * One electrical element in the compiled topology: which nodes it joins. The original types are
 * one element each, keyed by their component id; a part model (parts.ts) may add several, each
 * with its own key.
 */
interface Element {
  component: ComponentInstance;
  /** Device id in the circuit. */
  key: string;
  /** `switch`: an ideal contact (0 V branch when active). `part`: a part model's device. */
  kind: 'switch' | 'psu' | 'device' | 'part';
  nodes: [string, string, ...string[]];
  /**
   * Whether the element conducts in the solved topology. A PSU whose output is off and an
   * OPEN switch contribute no element at all: an open circuit, with no leakage added.
   */
  active: boolean;
  make?: () => Device;
}

const TERMINALS: Record<string, [string, string]> = {
  'component.resistor': ['a', 'b'],
  'component.led': ['anode', 'cathode'],
  'component.diode': ['anode', 'cathode'],
  'component.push_button': ['a', 'b'],
  'component.toggle_switch': ['a', 'b'],
  'instrument.lab_psu': ['positive', 'negative'],
};

const isSwitch = (type: string) =>
  type === 'component.push_button' || type === 'component.toggle_switch';

/** Terminal ids of a type the engine can simulate (original types, then part models). */
const terminalsOf = (type: string): readonly string[] | undefined =>
  TERMINALS[type] ?? partModel(type)?.terminals;

/**
 * Terminals an MCU pad may be attached at: every simulated terminal, and the ground symbol's `ref`
 * (Sprint 13 P3). The browser attaches a pad at the first other terminal on its net, which for a
 * pad wired straight to GND can be the ground symbol itself: that is the reference node, a valid
 * electrical place for a pad (previously refused as `invalid_attachment`).
 */
const attachableTerminals = (type: string): readonly string[] | undefined =>
  type === 'component.ground' ? ['ref'] : terminalsOf(type);

/** Upper bound on the passes of the discrete-state fixed point (bounded work). */
const MAX_STATE_PASSES = 32;

function partElement(component: ComponentInstance, el: PartElement): Element {
  return el.kind === 'contact'
    ? {
        component,
        key: el.key,
        kind: 'switch',
        nodes: [el.nodes[0], el.nodes[1]],
        active: el.closed,
      }
    : {
        component,
        key: el.key,
        kind: 'part',
        nodes: el.nodes as [string, string, ...string[]],
        active: true,
        make: el.make,
      };
}

export class EngineSession {
  private readonly overrides = new Map<string, LiveControl>();
  /** TRANSIENT runtime input: push buttons currently held. Never persisted anywhere. */
  private readonly pressed = new Set<string>();
  private appliedRevision: number;
  /** TRANSIENT runtime state: each attached pad's drive mode, set by the running firmware. */
  private readonly pinModes = new Map<number, RuntimePinMode>();
  private readonly pins: readonly McuPinAttachment[];
  /**
   * Time-stepped sessions (Sprint 10): simulated time since Run (seconds), the step being solved,
   * and each time-dependent part's history from the last accepted step. A new session starts at
   * t = 0 with every history empty (capacitors discharged): the deterministic reset.
   */
  /** Sprint 19B: the refusal the states solved in the last pass imply (applied once settled). */
  private passRefusal: EngineError | null = null;
  /** Sprint 19B: logic parts in the circuit (the settle loop allows one pass per level). */
  private logicParts = 0;
  private time = 0;
  private step: TimeStep | undefined;
  private readonly history = new Map<string, PartState>();
  private pendingHistory = new Map<string, PartState>();
  /**
   * TRANSIENT runtime state (Sprint 10): each stateful part's discrete state (a relay armature),
   * carried from one solve to the next within a run, so hysteresis behaves as in the real part.
   * A new session starts from each part's initial state.
   */
  private readonly discrete = new Map<string, PartState>();
  /** TRANSIENT runtime inputs of parts (Sprint 12), set by the MCU runtime host. */
  private readonly partRuntime = new Map<string, Record<string, string>>();

  constructor(
    private readonly snapshot: SimulationSnapshot,
    mcu?: { pins: readonly McuPinAttachment[] },
  ) {
    this.appliedRevision = snapshot.projectRevision;
    this.pins = [...(mcu?.pins ?? [])].sort((a, b) => a.gpio - b.gpio);
    for (const p of this.pins) this.pinModes.set(p.gpio, 'input');
  }

  /**
   * TRANSIENT runtime input from the MCU: the drive mode of an attached pad. Not a project value:
   * nothing is persisted and no revision is involved.
   */
  setPinMode(gpio: number, mode: RuntimePinMode): EngineError | null {
    if (!this.pinModes.has(gpio)) {
      return { code: 'invalid_attachment', detail: { gpio } };
    }
    this.pinModes.set(gpio, mode);
    return null;
  }

  get snapshotId(): string {
    return this.snapshot.snapshotId;
  }

  /**
   * Sprint 18 (F-17C-2): a canonical key of every transient input the next `solve` depends on (pad
   * modes, live controls, pressed buttons, part runtime inputs, stateful parts' discrete states,
   * the applied revision). The solve is deterministic, so two solves from equal keys return equal
   * outcomes and leave equal states. Null for time-stepped sessions (their history is not keyed).
   */
  get stateKey(): string | null {
    if (this.timeDependent) return null;
    const sorted = <K, V>(m: ReadonlyMap<K, V>) =>
      [...m].sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    return JSON.stringify([
      this.appliedRevision,
      sorted(this.pinModes),
      sorted(this.overrides),
      [...this.pressed].sort(),
      sorted(this.partRuntime),
      sorted(this.discrete),
    ]);
  }

  /** Whether the circuit holds a time-dependent part: then it runs time-stepped (advance). */
  get timeDependent(): boolean {
    return this.timeDependentParts.length > 0;
  }

  /** The time-dependent parts of the circuit, in circuit order (component ids). */
  get timeDependentParts(): string[] {
    return this.snapshot.components
      .filter((c) => partModel(c.type)?.timeDependent === true)
      .map((c) => c.id);
  }

  /** Simulated time since the session started, seconds (time-stepped sessions). */
  get simulatedTime(): number {
    return this.time;
  }

  /**
   * Advance a time-stepped session by one backward-Euler step of `dt` seconds (Sprint 10).
   * Live controls and pressed buttons apply from this step on (a step change, which backward
   * Euler integrates without ringing). The outcome is the state at the new time; on failure the
   * time and history do not advance.
   */
  advance(dt: number): SolveOutcome {
    if (!(dt > 0) || !Number.isFinite(dt)) throw new Error('advance: dt must be > 0');
    this.step = { dt, method: 'backward-euler' };
    try {
      const outcome = this.solve();
      if (outcome.ok) {
        for (const [id, h] of this.pendingHistory) this.history.set(id, h);
        this.time += dt;
        outcome.time = this.time;
      }
      return outcome;
    } finally {
      this.step = undefined;
    }
  }

  /**
   * Mirror a live persistent change that the browser has ALREADY persisted at
   * `projectRevision`: PSU setpoint / current limit / output enable, or a toggle-switch
   * position. Anything else needs a new snapshot.
   */
  applyControl(
    componentId: string,
    control: LiveControl,
    projectRevision: number,
  ): EngineError | null {
    const c = this.snapshot.components.find((x) => x.id === componentId);
    const refuse = { code: 'unsupported_component' as const, components: [componentId] };
    if (!c) return refuse;
    const psuKeys = ['setpointVoltage', 'currentLimit', 'outputEnabled'] as const;
    const hasPsuKeys = psuKeys.some((k) => control[k] !== undefined);
    if (c.type === 'instrument.lab_psu') {
      if (control.closed !== undefined || control.params) return refuse;
      if (
        control.setpointVoltage !== undefined &&
        !(control.setpointVoltage >= 0 && Number.isFinite(control.setpointVoltage))
      ) {
        return { code: 'invalid_parameter', components: [componentId], param: 'setpointVoltage' };
      }
      if (
        control.currentLimit !== undefined &&
        !(control.currentLimit > 0 && Number.isFinite(control.currentLimit))
      ) {
        return { code: 'invalid_parameter', components: [componentId], param: 'currentLimit' };
      }
    } else if (c.type === 'component.toggle_switch') {
      if (hasPsuKeys || typeof control.closed !== 'boolean' || control.params) return refuse;
    } else {
      // A part model's declared live parameters (e.g. a sensor's simulated environment).
      const live = partModel(c.type)?.liveParams ?? [];
      const params = control.params;
      if (hasPsuKeys || control.closed !== undefined || !params) return refuse;
      for (const [key, value] of Object.entries(params)) {
        if (!live.includes(key)) return refuse;
        if (typeof value === 'number' && !Number.isFinite(value))
          return { code: 'invalid_parameter', components: [componentId], param: key };
      }
      // Sprint 11 (ADR-010): the same domain rule the Session Host applies when the command
      // arrives: only the catalog's live parameters, of their declared kind, within range.
      const problem = liveControlProblem(c.type, { params });
      if (problem?.reason === 'unsupported_control') return refuse;
      if (problem)
        return { code: 'invalid_parameter', components: [componentId], param: problem.key };
      const prev = this.overrides.get(componentId);
      this.overrides.set(componentId, { params: { ...prev?.params, ...params } });
      this.appliedRevision = Math.max(this.appliedRevision, projectRevision);
      return null;
    }
    this.overrides.set(componentId, { ...this.overrides.get(componentId), ...control });
    this.appliedRevision = Math.max(this.appliedRevision, projectRevision);
    return null;
  }

  /** @deprecated Sprint 3 name, kept for the PSU-only callers: use `applyControl`. */
  applyPsuControl(
    componentId: string,
    control: PsuControl,
    projectRevision: number,
  ): EngineError | null {
    return this.applyControl(componentId, control, projectRevision);
  }

  /**
   * TRANSIENT runtime input: press or release a momentary push button. Not a project value:
   * no revision is involved and nothing is persisted.
   */
  setMomentary(componentId: string, pressed: boolean): EngineError | null {
    const c = this.snapshot.components.find((x) => x.id === componentId);
    if (!c || c.type !== 'component.push_button') {
      return { code: 'unsupported_component', components: [componentId] };
    }
    if (pressed) this.pressed.add(componentId);
    else this.pressed.delete(componentId);
    return null;
  }

  /**
   * TRANSIENT runtime input (Sprint 12, R2/R3): a part's runtime-driven state, e.g. whether an
   * HC-SR04 drives its ECHO output high. Only the keys and tokens the part model declares in
   * `runtimeInputs` are accepted. Not a project value: no revision, nothing persisted.
   */
  setPartRuntime(componentId: string, key: string, token: string): EngineError | null {
    const c = this.snapshot.components.find((x) => x.id === componentId);
    const allowed = c ? partModel(c.type)?.runtimeInputs?.[key] : undefined;
    if (!c || !allowed?.includes(token))
      return { code: 'unsupported_component', components: [componentId] };
    this.partRuntime.set(componentId, { ...this.partRuntime.get(componentId), [key]: token });
    return null;
  }

  /**
   * A part's quantity parameter with any live (mirrored) value applied, in SI units: what the
   * part's environment is right now (Sprint 12: the runtime host reads a sensor's distance,
   * temperature and humidity here, from the same values the solver uses).
   */
  liveQuantity(componentId: string, key: string): number | undefined {
    const c = this.snapshot.components.find((x) => x.id === componentId);
    if (!c) return undefined;
    const v = this.overrides.get(componentId)?.params?.[key];
    return typeof v === 'number' ? v : quantity(c.params, key);
  }

  private switchClosed(c: ComponentInstance): boolean {
    if (c.type === 'component.push_button') return this.pressed.has(c.id);
    return this.overrides.get(c.id)?.closed ?? c.params.closed === true;
  }

  private base(): OutcomeBase {
    return {
      snapshotId: this.snapshot.snapshotId,
      snapshotRevision: this.snapshot.projectRevision,
      appliedRevision: this.appliedRevision,
      engineVersion: ENGINE_VERSION,
    };
  }

  private fail(error: EngineError): SolveFailure {
    return { ok: false, ...this.base(), error };
  }

  private psuSettings(c: ComponentInstance) {
    const o = this.overrides.get(c.id) ?? {};
    return {
      setpointV: o.setpointVoltage ?? quantity(c.params, 'setpointVoltage'),
      limitA: o.currentLimit ?? quantity(c.params, 'currentLimit'),
      enabled: o.outputEnabled ?? c.params.outputEnabled === true,
    };
  }

  /** Solve the DC operating point of the loaded snapshot with the current live controls. */
  solve(): SolveOutcome {
    try {
      return this.solveUnchecked();
    } catch (e) {
      // Anything unexpected is reported as an internal error, never as a partial result.
      return this.fail({
        code: 'internal',
        detail: { message: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  /**
   * Solve, then settle every stateful part (Sprint 10): a part's discrete state (a relay armature)
   * determines the topology, and the solved operating point determines the state. Starting from
   * the state the previous solve left (hysteresis is real), solve, update each state from the
   * solution, and repeat until nothing changes. A circuit whose states never settle (a relay
   * interrupting its own coil) has no DC steady state and is refused with `no_steady_state`,
   * never shown in one of its transitory states. Without stateful parts this is one pass: the
   * original path, unchanged.
   */
  private solveUnchecked(): SolveOutcome {
    this.pendingHistory = new Map();
    let states = new Map(this.discrete);
    const seen = new Set<string>();
    // Sprint 19B: a logic part that left its datasheet rows in any pass of this settle.
    let outOfRows: [string, PartState] | undefined;
    for (let pass = 1; ; pass++) {
      const next = new Map<string, PartState>();
      const outcome = this.solveOnce(states, next);
      if (!outcome.ok) return outcome;
      outOfRows ??= [...next].find(([, st]) => st.refuse === 'logic_supply_uncharacterized');
      const changed = [...next].filter(([id, st]) => !sameState(st, states.get(id) ?? {}));
      if (changed.length === 0) {
        for (const [id, st] of next) this.discrete.set(id, st);
        // Sprint 19B: a refusal the settled states imply (a floating logic input...).
        if (this.passRefusal) return this.fail(this.passRefusal);
        return outcome;
      }
      const key = JSON.stringify([...next].sort(([a], [b]) => (a < b ? -1 : 1)));
      // A chain of d logic gates settles in about d passes (each output needs a solve).
      const cap = MAX_STATE_PASSES + this.logicParts;
      if (seen.has(key) || pass >= cap) {
        // Sprint 19B: a cycle through a logic part whose supply leaves the datasheet rows (a
        // supply in current limit pulling it down, then recovering) is that, not a chatter.
        const supply = outOfRows;
        if (supply)
          return this.fail({
            code: 'logic_supply_uncharacterized',
            components: [supply[0]],
            detail: {
              ...(typeof supply[1].value === 'number' ? { vcc: supply[1].value } : {}),
              cycle: true,
            },
          });
        return this.fail({
          code: 'no_steady_state',
          components: changed.map(([id]) => id),
          detail: { passes: pass },
        });
      }
      seen.add(key);
      states = next;
    }
  }

  private partContext(c: ComponentInstance, nodeOf: (c: string, t: string) => string): PartContext {
    const live = this.overrides.get(c.id)?.params ?? {};
    return {
      component: c,
      node: (terminal) => nodeOf(c.id, terminal),
      quantity: (key) => {
        const v = live[key];
        return typeof v === 'number' ? v : quantity(c.params, key);
      },
      value: (key) => (key in live ? live[key] : c.params[key]),
      ...(this.step ? { step: this.step } : {}),
      history: () => this.history.get(c.id),
      runtime: (key) => this.partRuntime.get(c.id)?.[key],
    };
  }

  private solveOnce(
    states: ReadonlyMap<string, PartState>,
    next: Map<string, PartState>,
  ): SolveOutcome {
    const snap = this.snapshot;
    const groundNets = new Set(snap.nets.filter((n) => n.role === 'ground').map((n) => n.id));
    const netOf = new Map<string, string>();
    for (const conn of snap.connections)
      netOf.set(`${conn.component}\u0000${conn.terminal}`, conn.net);
    const nodeOf = (component: string, terminal: string): string => {
      const net = netOf.get(`${component}\u0000${terminal}`);
      if (net === undefined) return `~${component}.${terminal}`; // unwired terminal: its own node
      return groundNets.has(net) ? REF : net;
    };
    const wired = (component: string) =>
      snap.connections.some((c) => c.component === component) ||
      this.pins.some((p) => p.component === component);

    // ---- MCU pad attachments (runtime R2): structural validation only ----------------------
    const pinNodes: { pin: McuPinAttachment; node: string }[] = [];
    for (const [i, p] of this.pins.entries()) {
      const c = snap.components.find((x) => x.id === p.component);
      const terminals = c ? attachableTerminals(c.type) : undefined;
      const ok =
        Number.isInteger(p.gpio) &&
        p.gpio >= 0 &&
        p.gpio < 40 &&
        (i === 0 || this.pins[i - 1]!.gpio !== p.gpio) &&
        !!terminals &&
        terminals.includes(p.terminal);
      if (!ok) {
        return this.fail({
          code: 'invalid_attachment',
          ...(c ? { components: [c.id] } : {}),
          detail: { gpio: p.gpio, component: p.component, terminal: p.terminal },
        });
      }
      pinNodes.push({ pin: p, node: nodeOf(p.component, p.terminal) });
    }

    // ---- Compile: validate, and turn components into topology elements -----------------
    const elements: Element[] = [];
    const parts: { c: ComponentInstance; model: PartModel; ctx: PartContext; state: PartState }[] =
      [];
    const notConnected: string[] = [];
    let hasGround = false;
    for (const c of snap.components) {
      if (c.type === 'component.ground') {
        if (wired(c.id)) hasGround = true;
        continue;
      }
      if (!wired(c.id)) {
        notConnected.push(c.id);
        continue;
      }
      switch (c.type) {
        case 'component.resistor': {
          const r = quantity(c.params, 'resistance');
          if (!(r !== undefined && r > 0 && Number.isFinite(r))) {
            return this.fail({
              code: 'invalid_parameter',
              components: [c.id],
              param: 'resistance',
            });
          }
          elements.push({
            component: c,
            key: c.id,
            kind: 'device',
            nodes: [nodeOf(c.id, 'a'), nodeOf(c.id, 'b')],
            active: true,
          });
          break;
        }
        case 'component.led':
        case 'component.diode': {
          if (typeof c.params.model !== 'string' || !MODEL_CARDS[c.params.model]) {
            return this.fail({ code: 'invalid_parameter', components: [c.id], param: 'model' });
          }
          elements.push({
            component: c,
            key: c.id,
            kind: 'device',
            nodes: [nodeOf(c.id, 'anode'), nodeOf(c.id, 'cathode')],
            active: true,
          });
          break;
        }
        case 'component.push_button':
        case 'component.toggle_switch':
          elements.push({
            component: c,
            key: c.id,
            kind: 'switch',
            nodes: [nodeOf(c.id, 'a'), nodeOf(c.id, 'b')],
            active: this.switchClosed(c),
          });
          break;
        case 'instrument.lab_psu': {
          const s = this.psuSettings(c);
          if (!(s.setpointV !== undefined && s.setpointV >= 0 && Number.isFinite(s.setpointV))) {
            return this.fail({
              code: 'invalid_parameter',
              components: [c.id],
              param: 'setpointVoltage',
            });
          }
          if (!(s.limitA !== undefined && s.limitA > 0 && Number.isFinite(s.limitA))) {
            return this.fail({
              code: 'invalid_parameter',
              components: [c.id],
              param: 'currentLimit',
            });
          }
          const nodes: [string, string] = [nodeOf(c.id, 'positive'), nodeOf(c.id, 'negative')];
          if (s.enabled && nodes[0] === nodes[1]) {
            // An enabled supply whose own terminals are joined by an ideal wire has no
            // meaningful operating point in this model: refused, never approximated.
            return this.fail({ code: 'psu_shorted', components: [c.id] });
          }
          elements.push({ component: c, key: c.id, kind: 'psu', nodes, active: s.enabled });
          break;
        }
        default: {
          // Sprint 10 parts: compiled by their registered model (parts.ts).
          const model = partModel(c.type);
          if (!model) return this.fail({ code: 'unsupported_component', components: [c.id] });
          const ctx = this.partContext(c, nodeOf);
          const invalid = model.validate(ctx);
          if (invalid) return this.fail(invalid);
          const state = states.get(c.id) ?? model.initialState?.(ctx) ?? {};
          parts.push({ c, model, ctx, state });
          for (const el of model.elements(ctx, state)) elements.push(partElement(c, el));
        }
      }
    }

    // ---- Sprint 19B: logic topology (feedback) and unknown nodes ----------------------------
    // Fixed nodes hold their potential whatever an unknown current does: GND and the outputs
    // of enabled supplies.
    const fixed = new Set<string>([REF]);
    for (const e of elements)
      if (e.kind === 'psu' && e.active) for (const n of e.nodes) fixed.add(n);
    const topo: TopoElement[] = elements.map((e) => ({
      key: e.key,
      component: e.component.id,
      nodes: e.nodes,
      active: e.active,
    }));
    // L3: a packaged device takes part gate by gate (`U1#2`), so a chain between its own gates
    // is a chain, and only a real loop is feedback.
    const logicParts = parts
      .filter((p) => p.model.logicPins)
      .flatMap((p) => {
        const units = p.model.logicUnits?.(p.ctx) ?? [{ unit: '', ...p.model.logicPins!(p.ctx) }];
        return units.map((u) => ({
          component: u.unit ? `${p.c.id}#${u.unit}` : p.c.id,
          owner: p.c.id,
          inputs: u.inputs.map((t) => p.ctx.node(t)),
          outputs: u.outputs.map((t) => p.ctx.node(t)),
        }));
      });
    this.logicParts = logicParts.length;
    if (logicParts.length) {
      // A logic part's own supply pins are rails, not signal paths (an input pull-up and an
      // output pull-up to the same rail are not feedback), powered or not.
      const rails = new Set(fixed);
      for (const p of parts)
        if (p.model.logicPins) for (const t of ['vcc', 'gnd']) rails.add(p.ctx.node(t));
      const cycle = logicFeedback(topo, logicParts, rails);
      if (cycle) {
        const owner = new Map(logicParts.map((l) => [l.component, l.owner]));
        const components = [...new Set(cycle.map((u) => owner.get(u) ?? u))].sort();
        const units = cycle.filter((u) => u.includes('#'));
        return this.fail({
          code: 'logic_feedback_unsupported',
          components,
          ...(units.length ? { detail: { units } } : {}),
        });
      }
    }
    const seeds: string[] = [];
    for (const p of parts)
      for (const t of [
        ...(p.model.unknownDriven?.(p.ctx, p.state) ?? []),
        ...(p.model.unknownSupply?.(p.ctx, p.state) ?? []),
      ])
        seeds.push(p.ctx.node(t));
    const unknown = unknownClosure(topo, seeds, fixed);
    const unknownSupply = (e: Element) =>
      e.kind === 'psu' && e.nodes.some((n) => n !== REF && unknown.fixedReached.has(n));
    // The most current the unknown outputs fed by a supply may carry: each part's absolute-
    // maximum output current (a datasheet bound), summed over the parts on its non-reference node.
    const unknownSupplyMaxA = (e: Element) =>
      parts
        .filter((p) => (p.model.unknownSupply?.(p.ctx, p.state) ?? []).length)
        .filter((p) => e.nodes.some((n) => n !== REF && n === p.ctx.node('vcc')))
        .reduce((sum, p) => sum + (p.model.unknownCurrentMaxA?.(p.ctx, p.state) ?? Infinity), 0);
    // The refusals these states imply, applied by solveUnchecked once they have settled.
    this.passRefusal = null;
    for (const p of parts) {
      const r = p.model.refusal?.(p.ctx, p.state);
      if (r) {
        this.passRefusal = r;
        break;
      }
    }
    if (!this.passRefusal) {
      // A stateful part whose state would be decided from an unknown level (a relay coil, a
      // capacitor's history...): no state may be derived from it.
      const reader = parts.find(
        (p) =>
          !p.model.logicPins &&
          (p.model.nextState || p.model.history) &&
          p.model.terminals.some((t) => unknown.nodes.has(p.ctx.node(t))),
      );
      if (reader) this.passRefusal = { code: 'logic_unknown_state', components: [reader.c.id] };
    }
    if (!this.passRefusal) {
      const pad = pinNodes.find(({ node }) => unknown.nodes.has(node));
      if (pad)
        this.passRefusal = {
          code: 'logic_unknown_state',
          components: [pad.pin.component],
          param: `gpio${pad.pin.gpio}`,
        };
    }

    // An attached MCU pad is a device too (Sprint 13 P3): a board whose pin is wired straight to
    // GND, with nothing else in the circuit, is a circuit to solve, not an empty one.
    if (elements.length === 0 && pinNodes.length === 0) return this.fail({ code: 'empty_circuit' });

    // Ideal conductors: nodes joined by closed switches are one electrical node. An enabled
    // supply whose terminals they join is shorted exactly as by a wire: refused, not guessed.
    const shorts = new UnionFind();
    const closedSwitches = elements.filter((e) => e.kind === 'switch' && e.active);
    for (const e of closedSwitches) shorts.union(e.nodes[0], e.nodes[1]);
    for (const e of elements) {
      if (e.component.type !== 'instrument.lab_psu' || !e.active) continue;
      if (shorts.find(e.nodes[0]) === shorts.find(e.nodes[1])) {
        const path = closedSwitches
          .filter((sw) => shorts.find(sw.nodes[0]) === shorts.find(e.nodes[0]))
          .map((sw) => sw.component.id);
        return this.fail({ code: 'psu_shorted', components: [e.component.id, ...path] });
      }
    }
    // Directly paralleled supplies: two enabled outputs across the same pair of electrical
    // nodes (either polarity). With the lab-PSU model (ideal CV source / ideal CC source) this has
    // no unique operating point: in CV-CV the current split is undetermined (equal setpoints) or
    // the voltages contradict (unequal); with equal setpoints, which one is in CC is ambiguous.
    // Only an all-CC state can be unique, and the solver cannot reach it from its CV start.
    // Refused as an unsupported configuration: no current sharing, balancing resistance or
    // source priority is invented.
    const byTerminals = new Map<string, string[]>();
    for (const e of elements) {
      if (e.component.type !== 'instrument.lab_psu' || !e.active) continue;
      const key = [shorts.find(e.nodes[0]), shorts.find(e.nodes[1])].sort().join('\u0000');
      byTerminals.set(key, [...(byTerminals.get(key) ?? []), e.component.id]);
    }
    for (const ids of byTerminals.values()) {
      if (ids.length > 1) return this.fail({ code: 'psu_parallel', components: ids });
    }
    if (!hasGround)
      return this.fail({ code: 'no_ground', components: elements.map((e) => e.component.id) });

    // ---- Reference analysis: every island of the solved topology must reach GND ------------
    const islandsWithout = (useInactive: boolean) => {
      const uf = new UnionFind();
      const used = elements.filter((e) => e.active || useInactive);
      for (const e of used) for (const n of e.nodes.slice(1)) uf.union(e.nodes[0], n);
      // An attached pad is referenced to GND through the MCU (its driver or input leakage).
      for (const { node } of pinNodes) uf.union(node, REF);
      const referenced = uf.find(REF);
      const floating = used.filter((e) => uf.find(e.nodes[0]) !== referenced);
      return { floating, uf };
    };
    const { floating: islandless } = islandsWithout(false);
    // Sprint 19B: an island that floats only because the level driving it is unknown is not a
    // wiring error: it is left out of the solve, and everything on it is reported unknown.
    const excluded = new Set(
      islandless.filter((e) => e.nodes.some((n) => unknown.nodes.has(n))).map((e) => e.key),
    );
    const floating = islandless.filter((e) => !excluded.has(e.key));
    if (floating.length) {
      const ids = floating.map((e) => e.component.id);
      const nets = [
        ...new Set(floating.flatMap((e) => e.nodes).filter((n) => !n.startsWith('~') && n !== REF)),
      ];
      // Would the island be referenced if the disabled supplies were on? Then say so.
      const withOff = islandsWithout(true).floating;
      const offSupplies = elements.filter((e) => !e.active).map((e) => e.component.id);
      const error: EngineError = { code: 'floating_circuit', components: ids, nets };
      if (withOff.length === 0 && offSupplies.length) error.outputOffSupplies = offSupplies;
      return this.fail(error);
    }

    // ---- Build and solve the circuit with the promoted Gate A devices ----------------------
    const circuit = new Circuit();
    const devices = new Map<string, Device>();
    // A closed switch is an ideal conductor: a 0 V branch whose current is an MNA unknown.
    // Closed switches forming a loop among themselves (or across one node) are redundant
    // ideal paths: their current split is not defined, so only a spanning forest is built.
    const forest = new UnionFind();
    const redundantSwitches = new Set<string>();
    for (const e of elements) {
      if (!e.active || excluded.has(e.key)) continue;
      const c = e.component;
      let d: Device;
      const [n0, n1] = e.nodes;
      if (e.kind === 'switch') {
        if (forest.find(n0) === forest.find(n1)) {
          redundantSwitches.add(e.key);
          continue;
        }
        forest.union(n0, n1);
        d = new VoltageSource(e.key, n0, n1, 0);
      } else if (e.kind === 'part') d = e.make!();
      else if (c.type === 'component.resistor')
        d = new Resistor(c.id, n0, n1, quantity(c.params, 'resistance')!);
      else if (c.type === 'component.led' || c.type === 'component.diode')
        d = new Diode(c.id, n0, n1, MODEL_CARDS[c.params.model as string]!);
      else {
        const s = this.psuSettings(c);
        d = new LabPsu(c.id, n0, n1, s.setpointV!, s.limitA!);
      }
      devices.set(e.key, circuit.add(d));
    }
    // Attached MCU pads: the approved ESP32 pin model, in the firmware's current drive mode.
    const pinDevices = pinNodes.map(({ pin, node }) => ({
      pin,
      node,
      device: circuit.add(new GpioPin(`GPIO${pin.gpio}`, node, this.pinModes.get(pin.gpio)!)),
    }));

    let nodeVoltages: ReadonlyMap<string, number> = new Map([[REF, 0]]);
    let currents: ReadonlyMap<string, number> = new Map();
    let modes: ReadonlyMap<string, string> = new Map();
    let xSolution: readonly number[] = [];
    let stats: SolveStats = {
      unknowns: 0,
      newtonIterations: 0,
      activeSetIterations: 0,
      maxKclResidualA: 0,
      maxBranchResidualV: 0,
      maxBranchResidualA: 0,
    };
    // Every device may sit entirely on GND (e.g. a resistor with both ends grounded): then
    // there are no unknowns, every potential is exactly 0 and every current exactly 0.
    const hasUnknowns =
      circuit.nodes().length > 0 || [...devices.values()].some((d) => d.hasBranch);
    if (!hasUnknowns) currents = new Map([...devices.keys()].map((id) => [id, 0]));
    if (hasUnknowns) {
      try {
        const r = this.step ? circuit.solveStep(this.step) : circuit.solve();
        xSolution = r.x;
        nodeVoltages = r.nodeVoltages;
        currents = r.deviceCurrents;
        modes = r.supplyModes;
        stats = {
          unknowns: r.x.length,
          newtonIterations: r.newtonIterations,
          activeSetIterations: r.activeSetIterations,
          maxKclResidualA: r.maxKclResidualA,
          maxBranchResidualV: r.maxBranchResidualV,
          maxBranchResidualA: r.maxBranchResidualA,
        };
      } catch (e) {
        if (e instanceof SingularMatrixError) {
          return this.fail({
            code: 'singular_circuit',
            components: [...devices.keys()],
            detail: { pivotRow: e.pivotRow },
          });
        }
        if (e instanceof ConvergenceError) {
          return this.fail({
            code: 'no_convergence',
            components: [...devices.keys()],
            detail: { message: e.message, ...e.detail },
          });
        }
        throw e;
      }
    }

    // ---- Report ------------------------------------------------------------------------------
    // IEEE -0 is normalised to 0 in everything reported (it is the same physical value).
    const clean = (v: number) => v + 0;
    const potential = (node: string): number | null => {
      if (unknown.nodes.has(node)) return null;
      const v = nodeVoltages.get(node);
      return v === undefined ? null : clean(v);
    };
    const netVoltages: Record<string, number> = {};
    for (const n of snap.nets) {
      const v = potential(groundNets.has(n.id) ? REF : n.id);
      if (v !== null) netVoltages[n.id] = v;
    }
    const components: Record<string, ComponentResult> = {};
    for (const e of elements) {
      const c = e.component;
      if (e.kind === 'part' || !TERMINALS[c.type]) continue; // part models report below
      const [a, b] = e.nodes.map(potential) as [number | null, number | null];
      const terminalIds = TERMINALS[c.type]!;
      let current: number | null;
      if (!e.active)
        current = 0; // open switch, output-off supply: exactly zero by construction
      else if (redundantSwitches.has(c.id)) current = null;
      else if (isSwitch(c.type))
        current = clean(-currents.get(c.id)!); // 0 V branch: a -> b
      else current = clean(currents.get(c.id)!);
      const result: ComponentResult = {
        id: c.id,
        type: c.type,
        current,
        voltage: a !== null && b !== null ? clean(a - b) : null,
        terminals: { [terminalIds[0]]: a, [terminalIds[1]]: b },
      };
      if (isSwitch(c.type)) result.closed = e.active;
      if ((c.type === 'component.led' || c.type === 'component.diode') && current !== null) {
        const range = MODEL_VALID_CURRENT_A[c.params.model as string];
        // Below ~1 µA the junction is simply off; the flag concerns meaningful conduction.
        if (range && current > 1e-6)
          result.outsideModelRange = current < range[0] || current > range[1];
      }
      if (c.type === 'instrument.lab_psu') {
        result.mode = !e.active ? 'off' : modes.get(c.id) === 'CC' ? 'cc' : 'cv';
        // An unknown current through a supply in current limit makes its voltage unknown too; in
        // CV it is unknown whether the unknown current would reach the limit unless the margin
        // covers the parts' own absolute-maximum supply-pin current (the most a part may draw).
        if (unknownSupply(e) && !this.passRefusal) {
          const s = this.psuSettings(c);
          const fedMax = unknownSupplyMaxA(e);
          if (result.mode === 'cc' || (s.limitA ?? 0) - Math.abs(result.current ?? 0) < fedMax)
            this.passRefusal = { code: 'logic_unknown_state', components: [c.id] };
        }
      }
      if (unknown.elements.has(e.key) || excluded.has(e.key) || unknownSupply(e)) {
        result.current = null;
        // A supply in CV holds its setpoint whatever the current: its voltage stays known.
        if (!(
          c.type === 'instrument.lab_psu' &&
          result.mode === 'cv' &&
          !unknown.elements.has(e.key)
        ))
          result.voltage = null;
        result.unknown = true;
        delete result.outsideModelRange;
      }
      components[c.id] = result;
    }
    // Part models (Sprint 10): each reports its own result and, if stateful, its next state.
    const active = new Map(elements.map((e) => [e.key, e.active]));
    for (const p of parts) {
      const sol: PartSolution = {
        potential: (terminal) => potential(p.ctx.node(terminal)),
        deviceCurrent: (key) => clean(currents.get(key) ?? 0),
        contactCurrent: (key) =>
          !active.get(key)
            ? 0
            : redundantSwitches.has(key)
              ? null
              : clean(-(currents.get(key) ?? 0)), // 0 V branch: first node -> second
        device: (key) => devices.get(key),
        unknown: (terminal) => unknown.nodes.has(p.ctx.node(terminal)),
        deviceTerminalCurrents: (key) => {
          const d = devices.get(key);
          if (!(d instanceof Npn) || !xSolution.length) return undefined;
          const t = d.terminalCurrents(xSolution, DC_GMIN);
          return { ic: clean(t.ic), ib: clean(t.ib), ie: clean(t.ie) };
        },
      };
      const reported: ComponentResult = {
        id: p.c.id,
        type: p.c.type,
        ...p.model.report(p.ctx, p.state, sol),
      };
      // Sprint 19B: a part on an unknown node reports no current (its potentials there are
      // already null); never a number computed with the unknown driver left out.
      // A logic part's INPUTS draw no current: an unknown level there leaves its own results
      // known (its output reports X by itself when the input decides it).
      const inputs = new Set(p.model.logicPins?.(p.ctx).inputs ?? []);
      if (p.model.terminals.some((t) => !inputs.has(t) && unknown.nodes.has(p.ctx.node(t)))) {
        reported.unknown = true;
        reported.current = null;
        reported.voltage = null;
        if (reported.currents)
          reported.currents = Object.fromEntries(
            Object.keys(reported.currents).map((k) => [k, null]),
          );
        delete reported.outsideModelRange;
      }
      components[p.c.id] = reported;
      if (p.model.nextState) next.set(p.c.id, p.model.nextState(p.ctx, p.state, sol));
      if (p.model.history) this.pendingHistory.set(p.c.id, p.model.history(p.ctx, sol));
    }
    const outcome: SolveSuccess = {
      ok: true,
      ...this.base(),
      netVoltages,
      components,
      notConnected,
      stats,
    };
    const unknownNets = snap.nets.filter((n) => unknown.nodes.has(n.id)).map((n) => n.id);
    if (unknownNets.length) outcome.unknownNets = unknownNets;
    if (pinDevices.length) {
      outcome.pins = pinDevices.map(({ pin, node, device }) => {
        const mode = this.pinModes.get(pin.gpio)!;
        const voltage = potential(node) ?? 0;
        // P3: a pad on GND has no unknown, and with no unknowns there is no solve: the pad
        // device's own model current at its (0 V) potential is still defined.
        const current = clean(currents.get(device.id) ?? device.current(xSolution));
        const result: PinResult = { gpio: pin.gpio, mode, voltage, current };
        if (outsideCharacterizedRegion(mode, voltage)) result.outsideModelRange = true;
        return result;
      });
    }
    return outcome;
  }
}
