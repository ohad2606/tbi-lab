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
import { R_DRIVE_HIGH_OHM, R_DRIVE_LOW_OHM, VDD_V, V_OH_CHAR_V } from '../esp32Gpio.js';

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
  offPins?: readonly { pin: string; node: string }[];
}

export type PertKind = 'icc' | 'ii' | 'ioff' | 'pad' | 'padleak' | 'ogap';

/** One bounded (or unbounded) current: `amps` out of `from` into `to`. */
export interface Perturbation {
  id: string;
  kind: PertKind;
  from: string;
  to: string;
  /** Datasheet range (A), or null: no bound exists (the refusal below then applies). */
  range: readonly [number, number] | null;
  /** The part / pin / pad it belongs to (for refusals and the explanation). */
  component?: string;
  pin?: string;
  gpio?: number;
  padLevel?: 'high' | 'low';
  /** For `null` ranges: the refusal when anything depends on it. */
  refusal?: { code: string; param?: string; detail: Record<string, unknown> };
}

export type CheckKind = 'supply' | 'iccCondition' | 'input' | 'output' | 'psu';

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
}

/** Numerical resolution of a margin (a change below it is zero): 1 nV, 1 pA. */
export const EPS = { V: 1e-9, A: 1e-12 } as const;
/** Probe magnitude for an unbounded perturbation (A): only whether anything responds matters. */
export const PROBE_A = 1e-3;
/** Step for the finite difference of a margin along a sensitivity (A). */
const H = 1e-6;

export interface BoundsSolver {
  x0: readonly number[];
  /** dx per 1 A of each injection (linearised at x0). */
  sensitivity(injections: readonly { from: string; to: string }[]): number[][];
  /** The exact operating point with these injections added, or null if it cannot be solved. */
  solveWith(sinks: readonly { from: string; to: string; amps: number }[]): readonly number[] | null;
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

/**
 * Evaluate the checks under the perturbations. Returns the first failure (in check order, after
 * any unbounded perturbation something depends on), or null when every conclusion is guaranteed.
 * `extraChecks(relied)` adds checks once it is known which `icc` perturbations are relied on.
 */
export function evaluateBounds(
  solver: BoundsSolver,
  perts: readonly Perturbation[],
  baseChecks: readonly Check[],
  extraChecks: (relied: ReadonlySet<string>) => Check[],
): BoundFailure | null {
  if (!perts.length || !baseChecks.length) return null;
  const dx = solver.sensitivity(perts.map((p) => ({ from: p.from, to: p.to })));
  const x0 = solver.x0;
  const sens = (c: Check) => {
    const m0 = c.margin(x0);
    return perts.map((p, j) => (c.excludes?.(p) ? 0 : (c.margin(add(x0, dx[j]!, H)) - m0) / H));
  };
  const scale = (p: Perturbation) =>
    p.range ? Math.max(Math.abs(p.range[0]), Math.abs(p.range[1])) : PROBE_A;
  const relevant = (c: Check, s: readonly number[]) =>
    perts
      .map((p, j) => [p, j] as const)
      .filter(
        ([p, j]) => !(c.kind === 'psu' && !p.range) && Math.abs(s[j]!) * scale(p) > EPS[c.unit],
      );

  // Which `icc` perturbations matter at all (their part's supply path has resistance).
  let checks = [...baseChecks];
  const sensOf = new Map<string, number[]>();
  for (const c of checks) sensOf.set(c.id, sens(c));
  const relied = new Set<string>();
  // (A supply's current-limit margin does not make I_CC "relied on": with a stiff supply the
  // quiescent current cannot move any level; its current-limit side is owner question S21-Q1.)
  for (const c of checks)
    if (c.kind !== 'psu')
      for (const [p] of relevant(c, sensOf.get(c.id)!)) if (p.kind === 'icc') relied.add(p.id);
  const extra = extraChecks(relied);
  for (const c of extra) sensOf.set(c.id, sens(c));
  checks = [...checks, ...extra];

  // 1. An unbounded quantity that a conclusion depends on: refused by name (first in order).
  for (const p of perts) {
    if (p.range) continue;
    const j = perts.indexOf(p);
    if (
      checks.some(
        (c) => c.kind !== 'psu' && relevant(c, sensOf.get(c.id)!).some(([, k]) => k === j),
      )
    )
      return {
        code: p.refusal!.code,
        components: p.component ? [p.component] : [],
        ...(p.refusal!.param ? { param: p.refusal!.param } : {}),
        detail: p.refusal!.detail,
      };
  }

  // 2. Each check at its adverse corner: linear estimate first, then the exact solve.
  const corners = new Map<string, readonly number[] | null>();
  for (const c of checks) {
    const s = sensOf.get(c.id)!;
    const rel = relevant(c, s).filter(([p]) => p.range);
    if (!rel.length) continue;
    const m0 = c.margin(x0);
    const pick = rel.map(([p, j]) => {
      const [lo, hi] = p.range!;
      return { p, j, amps: s[j]! > 0 ? lo : hi };
    });
    const linear = m0 + pick.reduce((sum, { j, amps }) => sum + s[j]! * amps, 0);
    const key = JSON.stringify(pick.map(({ j, amps }) => [j, amps]));
    let x: readonly number[] | null | undefined;
    if (linear >= 0) {
      if (!corners.has(key))
        corners.set(
          key,
          solver.solveWith(
            pick
              .filter(({ amps }) => amps !== 0)
              .map(({ p, amps }) => ({ from: p.from, to: p.to, amps })),
          ),
        );
      x = corners.get(key);
    }
    const exact = x ? c.margin(x) : null;
    if (linear < 0 || exact === null || exact < 0) {
      const worst = x
        ? c.value(x)
        : c.value(x0) +
          pick.reduce(
            (sum, { j, amps }) => sum + ((c.value(add(x0, dx[j]!, H)) - c.value(x0)) / H) * amps,
            0,
          );
      const { causes, pads } = causesOf(
        pick.filter(({ j, amps }) => s[j]! * amps < 0).map(({ p }) => p),
      );
      return {
        code:
          c.kind === 'input'
            ? 'logic_input_not_guaranteed'
            : c.kind === 'output'
              ? 'logic_output_uncharacterized'
              : c.kind === 'iccCondition'
                ? 'logic_supply_current_uncharacterized'
                : 'logic_supply_not_guaranteed',
        components: [c.component],
        ...(c.pin ? { param: c.pin } : {}),
        detail: {
          ...(c.part ? { part: c.part } : {}),
          ...c.detail,
          ...(c.kind === 'output' ? { value: worst } : { worst }),
          causes,
          ...(pads.length ? { pads } : {}),
        },
      };
    }
  }
  return null;
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
}

/** An output stage's incremental conductance at drop `d` (the segment above d), and its points. */
function stageSlope(pts: readonly (readonly [number, number])[], d: number): number {
  const all = [[0, 0] as const, ...pts];
  for (let k = 1; k < all.length; k++)
    if (d < all[k]![0] - 1e-12 || k === all.length - 1)
      return (all[k]![1] - all[k - 1]![1]) / (all[k]![0] - all[k - 1]![0]);
  return 0;
}

export function buildBounds(
  specs: readonly LogicBoundSpec[],
  pads: readonly { gpio: number; node: string; mode: string }[],
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
    // The output's guarantee band at its solved current (downstream checks only).
    for (const o of s.outputs) {
      const stage = outputStageAt(card, s.vcc);
      const i = Math.abs(access.device(x0, o.key));
      const g = outputGuaranteeAt(card, s.vcc, o.level, i);
      if (!g) continue; // beyond the guarantee: the output check below refuses it
      const pts = o.level === 'high' ? stage.high : stage.low;
      const dm =
        o.level === 'high' ? V(x0, s.vccNode) - V(x0, o.node) : V(x0, o.node) - V(x0, s.gndNode);
      const dk = o.level === 'high' ? s.vcc - g.volts : g.volts;
      const slope = stageSlope(pts, Math.max(dm, 0));
      perts.push({
        id: `ogap:${s.component}:${o.pin}`,
        kind: 'ogap',
        // HIGH: a parallel current g·δ from Y into V_CC; LOW: from GND into Y.
        from: o.level === 'high' ? o.node : s.gndNode,
        to: o.level === 'high' ? s.vccNode : o.node,
        range: [-slope * Math.max(dm, 0), slope * Math.max(dk - dm, 0)],
        component: s.component,
        pin: o.pin,
      });
    }
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
    else
      perts.push({
        id: `padleak:${p.gpio}`,
        kind: 'padleak',
        from: p.node,
        to: ref,
        range: [-ESP32_INPUT_LEAKAGE_A, ESP32_INPUT_LEAKAGE_A],
        gpio: p.gpio,
      });
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

  // When a part's I_CC bound is relied on, its own test conditions must hold at every corner.
  const extra = (relied: ReadonlySet<string>): Check[] =>
    specs
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
      });
  return { perts, checks, extra };
}
