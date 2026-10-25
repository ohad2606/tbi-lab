/**
 * Sprint 21 (Phase 3, logic power and input modelling): GUARANTEE BOUNDS for a settled logic
 * operating point.
 *
 * The DC solve gives each logic part's levels from NOMINAL model values: input current exactly 0,
 * the quiescent supply current I_CC not in the solve, ESP32 pads at their model voltage, gate
 * outputs on the characteristic interpolated between the guaranteed test points. The real part
 * may differ from each of these by an amount the manufacturers bound. This module re-checks every
 * conclusion the solve drew (supply row, each input level, each output current) against those
 * bounds, and refuses when one is not guaranteed — or when a quantity it depends on has NO bound.
 *
 * Bounded quantities ("perturbations"), each a current injection with a datasheet range:
 * - `icc`: a logic part's quiescent supply current, from its V_CC pin to its GND pin, 0 … I_CC
 *   max — ONLY under the I_CC row's own test conditions (logic/lvc1g.ts `quiescentAt`), plus the
 *   inputs' leakage returning through the rails (n × I_I). Elsewhere it has no bound
 *   (`range: null`). 1G sheets §5.5 I_CC; SN74LVC08A SCAS283W §5.7 I_CC; the sheets' own power
 *   rule (1G §8.2.1.1 "Power Considerations": the supply must source all output current PLUS the
 *   maximum static supply current I_CC; the output current is already in the solve).
 * - `ii`: each input's leakage, ±I_I, between the input node and the part's GND pin, where the
 *   I_I row's supply condition holds (1G §5.5: V_CC 0–5.5 V; 08A §5.7: V_CC = 3.6 V only).
 *   Applied over the whole 0–5.5 V input range as the manufacturer's own pull-resistor design
 *   method does (1G §8.2.1.2: "leakage current into the device (as specified in the Electrical
 *   Characteristics) ... limits the resistor size"; 1G §7.3.3 / 08A §7.3.2 worst-case input
 *   resistance from the maximum input leakage) — owner confirmation S21-Q3.
 * - `ioff`: an UNPOWERED single gate's pins, ±I_off (1G §5.5, V_CC = 0).
 * - `pad`: an ESP32 output pad's level within its guarantee: HIGH ≥ V_OH min = 0.8 × VDD,
 *   LOW ≤ V_OL max = 0.1 × VDD (ESP32 Series Datasheet v5.3, Table 5-3, as pinned in
 *   esp32Gpio.ts), as a shift of the pad's Thevenin source (its Norton current change).
 * - `padleak`: an ESP32 input pad's leakage, ±50 nA (Table 5-3 I_IH/I_IL), on top of the model's
 *   leakage conductance.
 * - `ogap`: a gate output's voltage within its guarantee at the solved current: between the
 *   guaranteed bound of the next test point (logic/lvc1g.ts `outputGuaranteeAt`) and its own rail,
 *   as a series-voltage shift of its output stage (a parallel current g·δ, g the stage's
 *   incremental conductance). Applies to the checks of OTHER parts' pins (downstream levels);
 *   never to the output's own current check (the stronger-than-guaranteed side of an output is not
 *   bounded by the datasheet: owner question S21-Q5).
 *
 * Checks (margins that must stay ≥ 0 over every perturbation in its range):
 * - supply: V_CC stays inside the input row(s) it is in, and inside the output model's domain
 *   (exactly the tabulated supply, the PM-1 class, or the ranged row);
 * - inputs: HIGH stays ≥ V_IH(V_CC); LOW stays ≤ V_IL(V_CC) (the 0–5.5 V range is checked on the
 *   solved value, decision S21-D4);
 * - outputs: the current stays within the largest guaranteed point and never flows the wrong way;
 * - I_CC conditions: when a part's I_CC bound is relied on (its supply path has resistance), its
 *   inputs must stay at the I_CC test voltages and its supply in the I_CC row;
 * - supplies in CV stay below their current limit (bounded perturbations only: owner question
 *   S21-Q1 for an uncharacterized I_CC on a stiff supply).
 *
 * Method: the response to each perturbation is linear to first order (J⁻¹·b at the solution,
 * Circuit.sensitivity); for each check the ADVERSE end of every relevant range is chosen, and that
 * corner is then SOLVED exactly (the full nonlinear solve with the injections added). The network
 * is resistors, ideal sources, junctions and monotone piecewise-linear stages: its response to
 * each injection is monotone, so the adverse corner is the worst case. A perturbation with NO
 * range that any check depends on (sensitivity above the numerical resolution) is refused by name.
 */
import type { LogicCard } from './lvc1g.js';
import {
  inputRowAt,
  outputGuaranteeAt,
  outputStageAt,
  quiescentAt,
  RAIL_V,
  TABULATED_VCC_TOLERANCE_V,
} from './lvc1g.js';
import {
  R_DRIVE_HIGH_OHM,
  R_DRIVE_LOW_OHM,
  VDD_V,
  V_IH_V,
  V_IL_V,
  V_OH_CHAR_V,
} from '../esp32Gpio.js';

/** What a logic part exposes for the bounds (from its settled state). */
export interface LogicBoundSpec {
  component: string;
  part: string;
  card: LogicCard;
  vccNode: string;
  gndNode: string;
  /** Settled supply V_CC − GND (V). */
  vcc: number;
  /** Powered and evaluated (levels below); false: unpowered with I_off (outputs off). */
  powered: boolean;
  inputs: readonly { pin: string; node: string; level: 'high' | 'low' }[];
  outputs: readonly {
    pin: string;
    node: string;
    /** The output stage's device key. */
    key: string;
    level: 'high' | 'low';
  }[];
  /** Unpowered (I_off) pins: every input and output. */
  offPins?: { pin: string; node: string }[];
}

export type PertKind = 'icc' | 'ii' | 'ioff' | 'pad' | 'padleak' | 'padpull' | 'ogap';

/** A gate output stage whose voltage is bounded by its datasheet guarantee (`ogap`). */
export interface StageRef {
  /** The PwlLoad device key of the stage (replaced in a corner solve). */
  key: string;
  level: 'high' | 'low';
  card: LogicCard;
  vcc: number;
  vccNode: string;
  gndNode: string;
  yNode: string;
  /** The stage's solved current at x0 (A, forward). */
  i0: number;
}

/**
 * One bounded (or unbounded) quantity. For current perturbations: `amps` out of `from` into `to`
 * within `range`. For `ogap` (a gate output's guaranteed band): `from`/`to` is the unit injection
 * that RAISES Y (used only to read the sign of the response at x0); the corner replaces the stage
 * by an ideal source at its guaranteed bound or at its rail (`stage`).
 */
export interface Perturbation {
  id: string;
  kind: PertKind;
  from: string;
  to: string;
  /** Datasheet range (A), or null: no bound exists (the refusal below then applies). */
  range: readonly [number, number] | null;
  /** `ogap` only: the stage, and the largest Y excursion it can make (V, for relevance). */
  stage?: StageRef;
  swingV?: number;
  /** The part / pin / pad it belongs to (for refusals and the explanation). */
  component?: string;
  pin?: string;
  gpio?: number;
  padLevel?: 'high' | 'low';
  /** For `null` ranges: the refusal when anything depends on it. */
  refusal?: { code: string; param?: string; detail: Record<string, unknown> };
}

export type CheckKind =
  'supply' | 'iccCondition' | 'input' | 'output' | 'psu' | 'padInput' | 'padLoad';

export interface Check {
  id: string;
  kind: CheckKind;
  /** Volts or amperes: the numerical resolution below which a change is zero. */
  unit: 'V' | 'A';
  component: string;
  part?: string;
  pin?: string;
  /** Margin (≥ 0 = holds) at a solution vector. */
  margin(x: readonly number[]): number;
  /** The quantity reported as the worst value (V_I, V_CC, current), at a solution vector. */
  value(x: readonly number[]): number;
  /** Perturbations this check never considers. */
  excludes?(p: Perturbation): boolean;
  /** Extra detail for the refusal. */
  detail: Record<string, unknown>;
  /** The refusal code when this check fails (default by kind). */
  code?: string;
}

/** Numerical resolution of a margin (a change below it is zero): 1 nV, 1 pA. */
export const EPS = { V: 1e-9, A: 1e-12 } as const;
/** Probe magnitude for an unbounded perturbation (A): only whether anything responds matters. */
export const PROBE_A = 1e-3;
/** Step for the finite difference of a margin along a sensitivity (A, or V for a source). */
const H = 1e-6;
/** Re-linearisation rounds at a corner before the worst case is declared not established. */
const MAX_ROUNDS = 4;
/** Bracket steps of a stage held at its guarantee (its current may move to the next point). */
const MAX_BRACKETS = 6;
/**
 * Performance (review item 15): a check whose total linear change is below this fraction of its
 * nominal margin, with no gate output band involved, is accepted without an exact corner solve.
 * µA-level perturbations moving a margin by < 1 % cannot reverse its sign through second-order
 * terms of the resistive/junction network (the exact solve is kept for everything closer).
 */
const LINEAR_ACCEPT = 0.01;

/** Checks whose margin reads only node voltages (a solved corner's x is enough to evaluate). */
const NODE_ONLY: ReadonlySet<CheckKind> = new Set(['supply', 'iccCondition', 'input', 'padInput']);

/** A unit current injection between nodes, or a unit change of a corner source's voltage. */
export type Injection = { from: string; to: string } | { branch: string };

/** A corner: current injections plus stages replaced by ideal sources (`volts` = drop/rise). */
export interface CornerSpec {
  sinks: { from: string; to: string; amps: number }[];
  stages: { key: string; plus: string; minus: string; volts: number }[];
}

export interface CornerResult {
  x: readonly number[];
  /** dx per unit injection, linearised at this corner (null: singular). */
  sensitivity(injections: readonly Injection[]): number[][] | null;
  /** The current OUT of a replaced stage's Y pin while HIGH / INTO it while LOW (A). */
  stageCurrent(key: string): number;
  /** Re-prepare the main circuit (call after every evaluation at this corner). */
  release(): void;
}

export interface BoundsSolver {
  x0: readonly number[];
  /** Node name → index in x (ground has no entry). */
  nodeIndex: ReadonlyMap<string, number>;
  /** dx per unit injection (linearised at x0), or null when the matrix is singular. */
  sensitivity(injections: readonly Injection[]): number[][] | null;
  /** The exact operating point of a corner, or null if it cannot be solved and verified. */
  corner(spec: CornerSpec): CornerResult | null;
}

export interface BoundFailure {
  code: string;
  components: string[];
  param?: string;
  detail: Record<string, unknown>;
}

const add = (x: readonly number[], d: readonly number[], k: number) =>
  x.map((v, i) => v + d[i]! * k);

/** The causes a set of perturbations stands for (language-neutral tokens). */
function causesOf(perts: readonly Perturbation[]): { causes: string[]; pads: number[] } {
  const causes = new Set<string>();
  const pads = new Set<number>();
  for (const p of perts) {
    if (p.kind === 'icc') causes.add('supply_current');
    else if (p.kind === 'ii' || p.kind === 'ioff' || p.kind === 'padleak') causes.add('leakage');
    else if (p.kind === 'ogap') causes.add('output_guarantee');
    else if (p.kind === 'pad') causes.add(p.padLevel === 'high' ? 'esp32_voh' : 'esp32_vol');
    if ((p.kind === 'pad' || p.kind === 'padleak') && p.gpio !== undefined) pads.add(p.gpio);
  }
  return { causes: [...causes].sort(), pads: [...pads].sort((a, b) => a - b) };
}

const notEstablished = (reason: string, c?: Check): BoundFailure => ({
  code: 'logic_bound_not_established',
  components: c ? [c.component] : [],
  ...(c?.pin ? { param: c.pin } : {}),
  detail: { reason, ...(c?.part ? { part: c.part } : {}) },
});

/** A chosen corner: per bounded perturbation index, an amps value or a stage mode. */
type Choice = Map<number, number | 'bound' | 'rail'>;
const keyOf = (c: Choice) => JSON.stringify([...c].sort((a, b) => a[0] - b[0]));

/**
 * Evaluate the checks under the perturbations. Returns the first failure (in check order, after
 * any unbounded perturbation something depends on), or null when every conclusion is guaranteed.
 * `extraChecks(relied)` adds checks once it is known which perturbations are relied on.
 */
export function evaluateBounds(
  solver: BoundsSolver,
  perts: readonly Perturbation[],
  baseChecks: readonly Check[],
  extraChecks: (relied: ReadonlySet<string>) => Check[],
): BoundFailure | null {
  if (!perts.length || !baseChecks.length) return null;
  const inj = perts.map((p) => ({ from: p.from, to: p.to }));
  const dx0 = solver.sensitivity(inj);
  if (!dx0) return notEstablished('singular');
  const x0 = solver.x0;

  // Per-perturbation response of a check's margin, at x0: per A for currents; for a stage, per
  // VOLT of Y (the injection's response divided by Y's own response to it).
  const yGain = (st: StageRef, dx: readonly number[]) => {
    const k = solver.nodeIndex.get(st.yNode);
    return k === undefined ? 0 : (dx[k] ?? 0);
  };
  const sens0 = (c: Check, gains: readonly number[]) => {
    const m0 = c.margin(x0);
    return perts.map((p, j) => {
      if (c.excludes?.(p)) return 0;
      const d = (c.margin(add(x0, dx0[j]!, H)) - m0) / H;
      return p.kind === 'ogap' ? (gains[j]! > 0 ? d / gains[j]! : 0) : d;
    });
  };
  // Y's own response (V per A) to each stage's raising injection, at x0.
  const yNodeGain = perts.map((p, j) =>
    p.kind === 'ogap' && p.stage ? yGain(p.stage, dx0[j]!) : 0,
  );
  const scale = (p: Perturbation) =>
    p.kind === 'ogap'
      ? (p.swingV ?? 0)
      : p.range
        ? Math.max(Math.abs(p.range[0]), Math.abs(p.range[1]))
        : PROBE_A;
  const isRelevant = (c: Check, p: Perturbation, s: number) =>
    !(c.kind === 'psu' && !p.range) && Math.abs(s) * scale(p) > EPS[c.unit];

  let checks = [...baseChecks];
  const sensOf = new Map<string, number[]>();
  for (const c of checks) sensOf.set(c.id, sens0(c, yNodeGain));
  // Relied-on perturbations (any non-supply-limit check depends on them).
  const relied = new Set<string>();
  for (const c of checks)
    if (c.kind !== 'psu')
      perts.forEach((p, j) => {
        if (p.range && isRelevant(c, p, sensOf.get(c.id)![j]!)) relied.add(p.id);
      });
  const extra = extraChecks(relied);
  for (const c of extra) sensOf.set(c.id, sens0(c, yNodeGain));
  checks = [...checks, ...extra];

  // 1. An unbounded quantity that a conclusion depends on: refused by name (first in order).
  for (const [j, p] of perts.entries()) {
    if (p.range || p.kind === 'ogap') continue;
    if (checks.some((c) => isRelevant(c, p, sensOf.get(c.id)![j]!)))
      return {
        code: p.refusal!.code,
        components: p.component ? [p.component] : [],
        ...(p.refusal!.param ? { param: p.refusal!.param } : {}),
        detail: p.refusal!.detail,
      };
  }

  // 2. Each check at its adverse corner (exact solve, re-linearised until the corner is stable).
  const choose = (c: Check, s: readonly number[], prev?: Choice): Choice => {
    const out: Choice = new Map();
    perts.forEach((p, j) => {
      if (!(p.range || p.kind === 'ogap')) return;
      const relevant = isRelevant(c, p, s[j]!) || prev?.has(j);
      if (!relevant) return;
      if (p.kind === 'ogap') out.set(j, s[j]! > 0 ? 'bound' : 'rail');
      else out.set(j, s[j]! > 0 ? p.range![0] : p.range![1]);
    });
    return out;
  };
  const failure = (
    c: Check,
    worst: number,
    adverse: Perturbation[],
    extraDetail: Record<string, unknown> = {},
  ): BoundFailure => {
    const { causes, pads } = causesOf(adverse);
    const code =
      c.code ??
      (c.kind === 'input'
        ? 'logic_input_not_guaranteed'
        : c.kind === 'output'
          ? 'logic_output_uncharacterized'
          : c.kind === 'iccCondition'
            ? 'logic_supply_current_uncharacterized'
            : 'logic_supply_not_guaranteed');
    return {
      code,
      components: [c.component],
      ...(c.pin ? { param: c.pin } : {}),
      detail: {
        ...(c.part ? { part: c.part } : {}),
        ...c.detail,
        ...(c.kind === 'output' || c.kind === 'padLoad' ? { value: worst } : { worst }),
        causes,
        ...(pads.length ? { pads } : {}),
        ...extraDetail,
      },
    };
  };

  const cache = new Map<
    string,
    {
      x: readonly number[];
      dxc: number[][];
      stageOf: Map<number, { level: 'high' | 'low' }>;
      deviceMargins: { m: number; at: number[]; v: number } | null;
    }
  >();
  for (const c of checks) {
    const s0 = sensOf.get(c.id)!;
    let choice = choose(c, s0);
    if (!choice.size) continue;
    const m0 = c.margin(x0);
    const currents = [...choice].filter(([j]) => perts[j]!.kind !== 'ogap');
    const linear = m0 + currents.reduce((sum, [j, a]) => sum + s0[j]! * (a as number), 0);
    const adverseOf = (ch: Choice) => [...ch.keys()].map((j) => perts[j]!);
    if (linear < 0)
      return failure(
        c,
        c.value(x0) +
          currents.reduce(
            (sum, [j, a]) =>
              sum + ((c.value(add(x0, dx0[j]!, H)) - c.value(x0)) / H) * (a as number),
            0,
          ),
        adverseOf(choice),
      );
    // Item 15: far from its limit and no output band involved: the linear answer stands.
    if (currents.length === choice.size && m0 > 0 && m0 - linear <= LINEAR_ACCEPT * m0) continue;

    let accepted = false;
    // Item 15: a check that reads only node voltages reuses a corner another check already
    // solved with the same choice (its x and its re-linearisation are plain numbers).
    const nodeOnly = NODE_ONLY.has(c.kind);
    for (let round = 0; round < MAX_ROUNDS && !accepted; round++) {
      const key = keyOf(choice);
      let solved = nodeOnly ? cache.get(key) : undefined;
      if (!solved) {
        const r = solveCorner(solver, perts, choice);
        if (r.kind === 'unsolved') return notEstablished('corner_unsolved', c);
        if (r.kind === 'beyond')
          return failure(c, NaN, adverseOf(choice), { output: r.output, current: r.current });
        const { corner, stageOf } = r;
        try {
          // Item 8: re-linearise at the corner; every chosen side must still be adverse, and no
          // perturbation idle at x0 may have become active.
          const injections: Injection[] = perts.map((p, j) =>
            stageOf.has(j) ? { branch: perts[j]!.stage!.key } : { from: p.from, to: p.to },
          );
          const dxc = corner.sensitivity(injections);
          if (!dxc) return notEstablished('singular', c);
          // A device-reading check is evaluated here, while the corner's devices are prepared.
          const deviceMargins = nodeOnly
            ? null
            : {
                m: c.margin(corner.x),
                at: dxc.map((d) => c.margin(add(corner.x, d, H))),
                v: c.value(corner.x),
              };
          solved = { x: [...corner.x], dxc, stageOf, deviceMargins };
          if (nodeOnly) cache.set(key, solved);
        } finally {
          corner.release();
        }
      }
      const { x, dxc, stageOf, deviceMargins } = solved;
      const m = deviceMargins ? deviceMargins.m : c.margin(x);
      if (!(m >= 0))
        return failure(c, deviceMargins ? deviceMargins.v : c.value(x), adverseOf(choice));
      const sc = perts.map((p, j) => {
        if (c.excludes?.(p)) return 0;
        const d = ((deviceMargins ? deviceMargins.at[j]! : c.margin(add(x, dxc[j]!, H))) - m) / H;
        if (p.kind !== 'ogap') return d;
        const st = stageOf.get(j);
        // A replaced stage: dm per volt of its source; raising Y is −drop (HIGH), +rise (LOW).
        if (st) return st.level === 'high' ? -d : d;
        const g = yGain(p.stage!, dxc[j]!);
        return g > 0 ? d / g : 0;
      });
      const next = choose(c, sc, choice);
      if (keyOf(next) === keyOf(choice)) accepted = true;
      else choice = next;
    }
    if (!accepted) return notEstablished('not_monotone', c);
  }
  return null;
}

type CornerOutcome =
  | { kind: 'ok'; corner: CornerResult; stageOf: Map<number, { level: 'high' | 'low' }> }
  | { kind: 'unsolved' }
  | { kind: 'beyond'; output: string; current: number };

/**
 * Solve one corner. A stage at its guarantee starts at the bound of its NOMINAL current's test
 * point; when the corner current passes that point the next point's bound applies (item 7), and
 * beyond the largest guaranteed point there is no bound at all.
 */
function solveCorner(
  solver: BoundsSolver,
  perts: readonly Perturbation[],
  choice: Choice,
): CornerOutcome {
  const sinks: CornerSpec['sinks'] = [];
  const stages = new Map<
    number,
    { st: StageRef; mode: 'bound' | 'rail'; atA: number; volts: number }
  >();
  for (const [j, v] of choice) {
    const p = perts[j]!;
    if (p.kind === 'ogap') {
      const st = p.stage!;
      if (v === 'rail') stages.set(j, { st, mode: 'rail', atA: Infinity, volts: 0 });
      else {
        const g = outputGuaranteeAt(st.card, st.vcc, st.level, st.i0);
        if (!g) return { kind: 'beyond', output: st.key, current: st.i0 };
        stages.set(j, {
          st,
          mode: 'bound',
          atA: g.atA,
          volts: st.level === 'high' ? st.vcc - g.volts : g.volts,
        });
      }
    } else if (v !== 0) sinks.push({ from: p.from, to: p.to, amps: v as number });
  }
  for (let step = 0; step < MAX_BRACKETS; step++) {
    const spec: CornerSpec = {
      sinks,
      stages: [...stages.values()].map(({ st, volts }) =>
        st.level === 'high'
          ? { key: st.key, plus: st.vccNode, minus: st.yNode, volts }
          : { key: st.key, plus: st.yNode, minus: st.gndNode, volts },
      ),
    };
    const corner = solver.corner(spec);
    if (!corner) return { kind: 'unsolved' };
    let moved = false;
    for (const s of stages.values()) {
      if (s.mode !== 'bound') continue;
      const i = corner.stageCurrent(s.st.key);
      if (i > s.atA + 1e-15 || i < -1e-12) {
        const g = i < 0 ? null : outputGuaranteeAt(s.st.card, s.st.vcc, s.st.level, i);
        if (!g) {
          corner.release();
          return { kind: 'beyond', output: s.st.key, current: i };
        }
        s.atA = g.atA;
        s.volts = s.st.level === 'high' ? s.st.vcc - g.volts : g.volts;
        moved = true;
      }
    }
    if (!moved)
      return {
        kind: 'ok',
        corner,
        stageOf: new Map([...stages].map(([j, s]) => [j, { level: s.st.level }])),
      };
    corner.release();
  }
  return { kind: 'unsolved' };
}

// ---- Building the perturbations and checks from the settled parts --------------------------

/**
 * ESP32 Series Datasheet v5.3, Table 5-3 "DC Characteristics (3.3 V, 25 °C)": V_OL max 0.1 × VDD
 * (esp32Gpio.ts header). V_OH min 0.8 × VDD is `V_OH_CHAR_V`.
 */
export const ESP32_V_OL_MAX_V = 0.1 * VDD_V;
/** Table 5-3 I_IH / I_IL max 50 nA (esp32Gpio.ts header). */
export const ESP32_INPUT_LEAKAGE_A = 50e-9;

export interface BoundsAccess {
  v(x: readonly number[], node: string): number;
  /** A part element's device current at x (PwlLoad: forward current a → b). */
  device(x: readonly number[], key: string): number;
  /** An ESP32 pad's current at x (its device convention; the magnitude is what is used). */
  pad(x: readonly number[], gpio: number): number;
}

/** ESP32 Table 5-3 input thresholds as the approved pad model pins them (esp32Gpio.ts). */
export const ESP32_V_IH_V = V_IH_V;
export const ESP32_V_IL_V = V_IL_V;

export function buildBounds(
  specs: readonly LogicBoundSpec[],
  pads: readonly {
    gpio: number;
    node: string;
    mode: string;
    /** The part terminal the pad is attached to (for the refusal). */
    component: string;
    /** A logic output reaches the pad's net (through wires, switches, resistors). */
    readsLogic: boolean;
  }[],
  psus: readonly { id: string; key: string; limitA: number; cv: boolean }[],
  access: BoundsAccess,
  x0: readonly number[],
  ref: string,
): { perts: Perturbation[]; checks: Check[]; extra: (relied: ReadonlySet<string>) => Check[] } {
  const perts: Perturbation[] = [];
  const checks: Check[] = [];
  const V = access.v;
  const vccAt = (s: LogicBoundSpec, x: readonly number[]) => V(x, s.vccNode) - V(x, s.gndNode);
  const vin = (s: LogicBoundSpec, node: string, x: readonly number[]) =>
    V(x, node) - V(x, s.gndNode);

  for (const s of specs) {
    const card = s.card;
    if (!s.powered) {
      for (const p of s.offPins ?? [])
        if (card.ioffA !== undefined)
          perts.push({
            id: `ioff:${s.component}:${p.pin}`,
            kind: 'ioff',
            from: p.node,
            to: s.gndNode,
            range: [-card.ioffA, card.ioffA],
            component: s.component,
            pin: p.pin,
          });
      continue;
    }
    // Quiescent supply current: bounded only under its own test conditions.
    const q = quiescentAt(
      card,
      s.vcc,
      s.inputs.map((i) => vin(s, i.node, x0)),
    );
    const leakIn =
      s.vcc >= card.iiVcc[0] - TABULATED_VCC_TOLERANCE_V &&
      s.vcc <= card.iiVcc[1] + TABULATED_VCC_TOLERANCE_V;
    perts.push({
      id: `icc:${s.component}`,
      kind: 'icc',
      from: s.vccNode,
      to: s.gndNode,
      range:
        'iccMaxA' in q && leakIn ? [0, q.iccMaxA + card.inputs.length * card.inputLeakageA] : null,
      component: s.component,
      refusal: {
        code: 'logic_supply_current_uncharacterized',
        param: 'vcc',
        detail: {
          part: s.part,
          vcc: s.vcc,
          condition: 'iccCondition' in q ? q.iccCondition : 'notLeakage',
        },
      },
    });
    for (const i of s.inputs)
      perts.push({
        id: `ii:${s.component}:${i.pin}`,
        kind: 'ii',
        from: i.node,
        to: s.gndNode,
        range: leakIn ? [-card.inputLeakageA, card.inputLeakageA] : null,
        component: s.component,
        pin: i.pin,
        refusal: {
          code: 'logic_input_leakage_uncharacterized',
          param: i.pin,
          detail: { part: s.part, vcc: s.vcc, iiVcc: [...card.iiVcc] },
        },
      });
    // The output's guarantee band (downstream checks only): Y between the guaranteed bound at its
    // current (logic/lvc1g.ts `outputGuaranteeAt`) and its own rail. Review item 1: the corner holds
    // Y ITSELF at that bound (an ideal source replacing the stage), never a Norton shift whose
    // effect a load would divide down.
    for (const o of s.outputs)
      perts.push({
        id: `ogap:${s.component}:${o.pin}`,
        kind: 'ogap',
        from: ref,
        to: o.node,
        range: null,
        stage: {
          key: o.key,
          level: o.level,
          card,
          vcc: s.vcc,
          vccNode: s.vccNode,
          gndNode: s.gndNode,
          yNode: o.node,
          i0: Math.abs(access.device(x0, o.key)),
        },
        swingV: s.vcc,
        component: s.component,
        pin: o.pin,
      });
  }
  for (const p of pads) {
    if (p.mode === 'output-high')
      perts.push({
        id: `pad:${p.gpio}`,
        kind: 'pad',
        from: p.node,
        to: ref,
        range: [0, (VDD_V - V_OH_CHAR_V) / R_DRIVE_HIGH_OHM],
        gpio: p.gpio,
        padLevel: 'high',
      });
    else if (p.mode === 'output-low')
      perts.push({
        id: `pad:${p.gpio}`,
        kind: 'pad',
        from: ref,
        to: p.node,
        range: [0, ESP32_V_OL_MAX_V / R_DRIVE_LOW_OHM],
        gpio: p.gpio,
        padLevel: 'low',
      });
    else {
      perts.push({
        id: `padleak:${p.gpio}`,
        kind: 'padleak',
        from: p.node,
        to: ref,
        range: [-ESP32_INPUT_LEAKAGE_A, ESP32_INPUT_LEAKAGE_A],
        gpio: p.gpio,
      });
      // Review item 4: the internal pull resistor is given ONLY as typical (Table 5-3: R_PU /
      // R_PD typ 45 kΩ, no min/max): no bound. A level that depends on it is refused.
      if (p.mode === 'input-pullup' || p.mode === 'input-pulldown')
        perts.push({
          id: `padpull:${p.gpio}`,
          kind: 'padpull',
          from: p.node,
          to: ref,
          range: null,
          gpio: p.gpio,
          component: p.component,
          refusal: {
            code: 'logic_mcu_pull_uncharacterized',
            param: `gpio${p.gpio}`,
            detail: { gpio: p.gpio, mode: p.mode },
          },
        });
    }
  }
  for (const s of specs) {
    if (!s.powered) continue;
    const card = s.card;
    const vcc0 = s.vcc;
    // Supply: inside the input row(s) it is in, and the output model's own domain.
    const rows = card.inputRows.filter((r) => vcc0 >= r.vcc[0] - 1e-9 && vcc0 <= r.vcc[1] + 1e-9);
    const lo = Math.max(...rows.map((r) => r.vcc[0]), card.vccOperating[0]) - 1e-9;
    const hi = Math.min(...rows.map((r) => r.vcc[1]), card.vccOperating[1]) + 1e-9;
    const stage = outputStageAt(card, vcc0);
    const tab = card.outputRows.find((r) => Math.abs(r.vcc - vcc0) <= TABULATED_VCC_TOLERANCE_V);
    const cls = card.outputRows.find((r) => r.classVcc)?.classVcc;
    const [mlo, mhi] =
      stage.model === 'tabulated' && tab
        ? [tab.vcc - TABULATED_VCC_TOLERANCE_V, tab.vcc + TABULATED_VCC_TOLERANCE_V]
        : stage.model === 'class' && cls
          ? [cls[0] - TABULATED_VCC_TOLERANCE_V, cls[1] + TABULATED_VCC_TOLERANCE_V]
          : [card.rangedOutput.vcc[0], card.rangedOutput.vcc[1]];
    const sLo = s.outputs.length ? Math.max(lo, mlo) : lo;
    const sHi = s.outputs.length ? Math.min(hi, mhi) : hi;
    checks.push({
      id: `supply:${s.component}`,
      kind: 'supply',
      unit: 'V',
      component: s.component,
      part: s.part,
      pin: 'vcc',
      margin: (x) => {
        const v = vccAt(s, x);
        return Math.min(v - sLo, sHi - v);
      },
      value: (x) => vccAt(s, x),
      detail: { vcc: vcc0, model: stage.model, range: [sLo, sHi] },
    });
    for (const i of s.inputs) {
      const th = (x: readonly number[]) => inputRowAt(card, vccAt(s, x));
      checks.push({
        id: `input:${s.component}:${i.pin}`,
        kind: 'input',
        unit: 'V',
        component: s.component,
        part: s.part,
        pin: i.pin,
        margin: (x) => {
          const r = th(x);
          const v = vin(s, i.node, x);
          if (!r) return -1;
          // The LEVEL is what the bounds re-check. The recommended V_I range (0–5.5 V) is
          // checked on the solved value (classifyInput); the excursion of a pulled input by
          // ±I_I × R around its rail is not counted as leaving that range: the sheets' own
          // recommended 10 kΩ pull-down (1G §7.3.3) does exactly that (decision S21-D4).
          return i.level === 'high' ? v - r.vih : r.vil - v;
        },
        value: (x) => vin(s, i.node, x),
        detail: {
          level: i.level,
          value: vin(s, i.node, x0),
          vcc: vcc0,
          ...(i.level === 'high'
            ? { vih: inputRowAt(card, vcc0)?.vih }
            : { vil: inputRowAt(card, vcc0)?.vil }),
        },
      });
    }
    for (const o of s.outputs) {
      checks.push({
        id: `output:${s.component}:${o.pin}`,
        kind: 'output',
        unit: 'A',
        component: s.component,
        part: s.part,
        pin: o.pin,
        // The FORWARD current (sourced while HIGH, sunk while LOW) against the largest guaranteed
        // point. The wrong-way case is refused on the solved value (nextState); in the bounds the
        // adverse side of every perturbation is the one that raises the forward current, so an
        // output stage is never driven backwards here (its reverse side has no characteristic).
        margin: (x) => stage.validA + 1e-12 - access.device(x, o.key),
        value: (x) => Math.abs(access.device(x, o.key)),
        excludes: (p) => p.kind === 'ogap',
        detail: { vcc: vcc0, limit: stage.validA },
      });
    }
  }
  for (const p of psus)
    if (p.cv)
      checks.push({
        id: `psu:${p.id}`,
        kind: 'psu',
        unit: 'A',
        component: p.id,
        pin: 'limit',
        margin: (x) => p.limitA - Math.abs(access.device(x, p.key)) - 1e-12,
        value: (x) => Math.abs(access.device(x, p.key)),
        detail: { limit: p.limitA },
      });

  // Review item 3: an ESP32 input that reads a logic output must read a GUARANTEED level against
  // its own thresholds (Table 5-3: V_IH ≥ 0.75 × VDD, V_IL ≤ 0.25 × VDD, esp32Gpio.ts).
  for (const p of pads) {
    if (p.mode.startsWith('output') || !p.readsLogic) continue;
    const v0 = V(x0, p.node);
    const level = v0 >= V_IH_V ? 'high' : v0 <= V_IL_V ? 'low' : 'undefined';
    checks.push({
      id: `padInput:${p.gpio}`,
      kind: 'padInput',
      unit: 'V',
      component: p.component,
      pin: `gpio${p.gpio}`,
      code: 'logic_mcu_input_not_guaranteed',
      margin: (x) => {
        const v = V(x, p.node);
        return level === 'high' ? v - V_IH_V : level === 'low' ? V_IL_V - v : -1;
      },
      value: (x) => V(x, p.node),
      detail: {
        gpio: p.gpio,
        level,
        value: v0,
        ...(level === 'low'
          ? { vil: V_IL_V }
          : level === 'high'
            ? { vih: V_IH_V }
            : { vil: V_IL_V, vih: V_IH_V }),
      },
    });
  }

  // Review item 5: the ESP32 V_OH ≥ 0.8 × VDD / V_OL ≤ 0.1 × VDD minimum/maximum is stated with NO
  // load current (Table 5-3; the 40 mA / 28 mA figures are TYPICAL, at 25 °C). It is relied on only
  // while the pad carries no more than leakage-level current: the guaranteed leakage of every
  // input in the circuit (Σ I_I, I_off, 50 nA per pad), never a resistive load.
  const leakage = perts
    .filter((p) => p.range && (p.kind === 'ii' || p.kind === 'ioff' || p.kind === 'padleak'))
    .reduce((sum, p) => sum + Math.max(Math.abs(p.range![0]), Math.abs(p.range![1])), 0);
  const padLoad = (relied: ReadonlySet<string>): Check[] =>
    pads
      .filter((p) => p.mode.startsWith('output') && relied.has(`pad:${p.gpio}`))
      .map((p) => ({
        id: `padLoad:${p.gpio}`,
        kind: 'padLoad' as const,
        unit: 'A' as const,
        component: p.component,
        pin: `gpio${p.gpio}`,
        code: 'logic_mcu_output_uncharacterized',
        margin: (x: readonly number[]) => leakage + 1e-15 - Math.abs(access.pad(x, p.gpio)),
        value: (x: readonly number[]) => Math.abs(access.pad(x, p.gpio)),
        // Its own level band is a shift of the driver's source, not a load: not counted here.
        excludes: (q: Perturbation) => q.id === `pad:${p.gpio}`,
        detail: { gpio: p.gpio, limit: leakage, level: p.mode === 'output-high' ? 'high' : 'low' },
      }));
  // When a part's I_CC bound is relied on, its own test conditions must hold at every corner.
  const extra = (relied: ReadonlySet<string>): Check[] => [
    ...padLoad(relied),
    ...specs
      .filter((s) => s.powered && relied.has(`icc:${s.component}`))
      .flatMap((s) => {
        const card = s.card;
        const high = card.iccInputHigh === 'vcc' ? null : card.iccInputHigh;
        const out: Check[] = [
          {
            id: `icc-supply:${s.component}`,
            kind: 'iccCondition',
            unit: 'V',
            component: s.component,
            part: s.part,
            pin: 'vcc',
            margin: (x) => {
              const v = vccAt(s, x);
              return Math.min(
                v - (card.iccVcc[0] - TABULATED_VCC_TOLERANCE_V),
                card.iccVcc[1] + TABULATED_VCC_TOLERANCE_V - v,
              );
            },
            value: (x) => vccAt(s, x),
            detail: { vcc: s.vcc, condition: 'notSupply' },
          },
        ];
        for (const i of s.inputs) {
          const target = (x: readonly number[]) =>
            Math.abs(vin(s, i.node, x0)) <= RAIL_V ? 0 : (high ?? vccAt(s, x));
          out.push({
            id: `icc-input:${s.component}:${i.pin}`,
            kind: 'iccCondition',
            unit: 'V',
            component: s.component,
            part: s.part,
            pin: i.pin,
            margin: (x) => RAIL_V - Math.abs(vin(s, i.node, x) - target(x)),
            value: (x) => vin(s, i.node, x),
            detail: { vcc: s.vcc, condition: 'notInputs' },
          });
        }
        return out;
      }),
  ];
  return { perts, checks, extra };
}
