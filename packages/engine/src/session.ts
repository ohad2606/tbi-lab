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
import { Circuit, ConvergenceError } from './circuit.js';
import { Diode, LabPsu, Resistor, VoltageSource, type Device } from './devices.js';
import { GpioPin } from './esp32Gpio.js';
import { Npn } from './bjt.js';

/** The solver's default junction gmin (circuit.ts DEFAULTS), for exact device readouts. */
const DC_GMIN = 1e-12;
import { SingularMatrixError } from './linalg.js';
import { MODEL_CARDS, MODEL_VALID_CURRENT_A } from './registry.js';
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
   * TRANSIENT runtime state (Sprint 10): each stateful part's discrete state (a relay armature),
   * carried from one solve to the next within a run, so hysteresis behaves as in the real part.
   * A new session starts from each part's initial state.
   */
  private readonly discrete = new Map<string, PartState>();

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
    let states = new Map(this.discrete);
    const seen = new Set<string>();
    for (let pass = 1; ; pass++) {
      const next = new Map<string, PartState>();
      const outcome = this.solveOnce(states, next);
      if (!outcome.ok) return outcome;
      const changed = [...next].filter(([id, st]) => !sameState(st, states.get(id) ?? {}));
      if (changed.length === 0) {
        for (const [id, st] of next) this.discrete.set(id, st);
        return outcome;
      }
      const key = JSON.stringify([...next].sort(([a], [b]) => (a < b ? -1 : 1)));
      if (seen.has(key) || pass >= MAX_STATE_PASSES) {
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
      const terminals = c ? terminalsOf(c.type) : undefined;
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

    if (elements.length === 0) return this.fail({ code: 'empty_circuit' });

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
    const { floating } = islandsWithout(false);
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
      if (!e.active) continue;
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
        const r = circuit.solve();
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
        deviceTerminalCurrents: (key) => {
          const d = devices.get(key);
          if (!(d instanceof Npn) || !xSolution.length) return undefined;
          const t = d.terminalCurrents(xSolution, DC_GMIN);
          return { ic: clean(t.ic), ib: clean(t.ib), ie: clean(t.ie) };
        },
      };
      components[p.c.id] = { id: p.c.id, type: p.c.type, ...p.model.report(p.ctx, p.state, sol) };
      if (p.model.nextState) next.set(p.c.id, p.model.nextState(p.ctx, p.state, sol));
    }
    const outcome: SolveSuccess = {
      ok: true,
      ...this.base(),
      netVoltages,
      components,
      notConnected,
      stats,
    };
    if (pinDevices.length) {
      outcome.pins = pinDevices.map(({ pin, node }) => ({
        gpio: pin.gpio,
        mode: this.pinModes.get(pin.gpio)!,
        voltage: potential(node) ?? 0,
        current: clean(currents.get(`GPIO${pin.gpio}`) ?? 0),
      }));
    }
    return outcome;
  }
}
