/**
 * Single logic gates (Sprint 19B, Exploration Foundation L1): SN74LVC1G devices (logic/lvc1g.ts),
 * with REAL supply pins. Electrical model, all from the device card at the part's own SOLVED
 * supply (V_CC pin − GND pin):
 *
 * - inputs draw no DC current (their leakage is a ± bound with no sign: never a conductance,
 *   which would invent a level). Each input is HIGH (≥ V_IH) or LOW (≤ V_IL), with V_IH/V_IL
 *   from the datasheet row that covers the supply. Anything else is REFUSED by name (Sprint 20,
 *   owner policy, the same contract as the SN74LVC08A package):
 *   - between V_IL and V_IH: `logic_input_undefined` (the sheet gives no level and no supply
 *     current there; the static-CMOS "a controlling input decides" inference is NOT used: the
 *     function table's X means "either valid level", not an invalid voltage);
 *   - outside the recommended V_I 0–5.5 V: `logic_input_out_of_range`;
 *   - on a net an undetermined level reaches: `logic_unknown_state`;
 *   - with no DC path to anything, or driven by nothing but an ESP32 pad in input mode (whose
 *     leakage model is a numerical reference, not a source): `logic_input_floating` ("Do not
 *     leave standard CMOS inputs floating at any time during operation", §7.3.3);
 * - the output follows the function table (defined inputs only);
 * - a HIGH output is a resistor from the part's V_CC pin to Y, a LOW output a resistor from Y to
 *   its GND pin (EF-D4 A, guaranteed characteristic, logic/lvc1g.ts `outputStageAt`). Output
 *   current therefore flows through the supply pins: fan-out, loading and supply current come
 *   out of the solve;
 * - an X output (only while the settle passes converge, or under a refusal) has NO element: the
 *   node it drives is unknown (the session marks it, and every result it reaches, as unknown);
 * - V_CC = 0 (unpowered): outputs off (the datasheet's I_off power-down specification);
 * - a supply the datasheet does not characterize (between input rows, below 1.65 V, above
 *   5.5 V, reversed) is refused (`logic_supply_uncharacterized`, EF-D3 A);
 * - at a supply without tabulated output points: over the 3.3 V ± 0.3 V class the 3 V points as a
 *   conservative bound (owner decision PM-1, logic/lvc1g.ts); elsewhere only the ±100 µA ranged
 *   row is guaranteed. A larger output current is refused (`logic_output_uncharacterized`).
 *
 * - the quiescent I_CC (10 µA) is reported only under its own test conditions (logic/lvc1g.ts
 *   `quiescentAt`: V_I = 5.5 V or GND for these sheets), otherwise "not characterized"; no bound
 *   is claimed for an unknown output's current (the ±50 mA I_O is an absolute-maximum STRESS
 *   rating, §5.1 note 1, and §7.3.1 "capable of driving larger currents than the device can
 *   sustain"): a current-limited supply feeding an unknown output is refused.
 *
 * Propagation delay is NOT simulated (DC sessions): circuits where it matters (feedback between
 * gates, PWM into a gate, clocks) are refused by the session and the host. The card carries t_pd
 * (per device, with its table) for display.
 */
import { PwlLoad } from '../pwl.js';
import {
  evaluate,
  inputRowAt,
  LVC1G_CARDS,
  outputStageAt,
  quiescentAt,
  RAIL_V,
  TABULATED_VCC_TOLERANCE_V,
  type LogicCard,
} from '../logic/lvc1g.js';
import {
  registerPart,
  validateCard,
  type PartContext,
  type PartModel,
  type PartRatingExcess,
  type PartSolution,
  type PartState,
} from '../parts.js';
import type { LogicInspection } from './logicInspection.js';

/** Level of an input or output: HIGH, LOW, unknown (X) or, for an output, off (unpowered). */
export type LogicLevel = 'high' | 'low' | 'x' | 'off';

/** An output forced past its own rail by more than this (V) is outside every test point. */
const WRONG_WAY_V = 1e-3;

/** |V_CC| at or below this is "unpowered" (the I_off condition, V_CC = 0). */
const UNPOWERED_V = 1e-3;

export function cardOf(ctx: PartContext): LogicCard {
  return LVC1G_CARDS[ctx.value('model') as string]!;
}

const levelOf = (s: PartState, key: string) => (s[key] ?? 'x') as LogicLevel | 'init';

/**
 * The function table for DEFINED inputs; X when any input is not HIGH or LOW. Sprint 20: no
 * controlling-input inference (the datasheets' function tables give outputs for valid input
 * levels only; an undefined input is refused before this is used for a result).
 */
export function gateOutput(card: LogicCard, ins: readonly LogicLevel[]): 'high' | 'low' | 'x' {
  if (!ins.every((l) => l === 'high' || l === 'low')) return 'x';
  return evaluate(
    card.function,
    ins.map((l) => l === 'high'),
  )
    ? 'high'
    : 'low';
}

/** A refusal recorded in a logic part's state (applied by the session once states settle). */
export type InputRefusal = Record<string, string | number>;

/**
 * Sprint 20: classify one logic input at the solved supply, the SAME contract for single gates
 * and packages. `g` is the part's own GND potential, `row` the datasheet input row.
 */
export function classifyInput(
  card: LogicCard,
  sol: PartSolution,
  t: string,
  row: { vih: number; vil: number },
  g: number,
): { level: LogicLevel; volts: number | null; refusal?: InputRefusal } {
  if (sol.unknown?.(t))
    return { level: 'x', volts: null, refusal: { refuse: 'logic_unknown_state', at: t } };
  const p = sol.potential(t);
  if (p === null)
    return { level: 'x', volts: null, refusal: { refuse: 'logic_input_floating', at: t } };
  const undriven = sol.undriven?.(t);
  if (undriven)
    // Only an ESP32 input pad's leakage holds the node: floating, whatever 0 V it solves to.
    return {
      level: 'x',
      volts: null,
      refusal: {
        refuse: 'logic_input_floating',
        at: t,
        ...(undriven.inputPads.length ? { pads: undriven.inputPads.join(',') } : {}),
      },
    };
  const vi = p - g;
  const level: LogicLevel = vi >= row.vih ? 'high' : vi <= row.vil ? 'low' : 'x';
  // Recommended V_I 0–5.5 V: outside it "functional operation … is not implied" (§5.1 note 1).
  if (vi < card.inputRecommended[0] - RAIL_V || vi > card.inputRecommended[1] + RAIL_V)
    return { level, volts: vi, refusal: { refuse: 'logic_input_out_of_range', at: t, value: vi } };
  // Between V_IL and V_IH: no level, and no supply current (I_CC only at its test conditions,
  // ΔI_CC at V_CC − 0.6 V): refused, never a level, never a guessed output.
  if (level === 'x')
    return { level, volts: vi, refusal: { refuse: 'logic_input_undefined', at: t, value: vi } };
  return { level, volts: vi };
}

/** The supply across the part, or null when either supply pin's potential is undefined. */
function supplyOf(sol: PartSolution): number | null {
  const v = sol.potential('vcc');
  const g = sol.potential('gnd');
  return v === null || g === null ? null : v - g;
}

function nextGateState(ctx: PartContext, sol: PartSolution, state: PartState): PartState {
  const card = cardOf(ctx);
  const unknown = (t: string) => sol.unknown?.(t) === true;
  if (unknown('vcc') || unknown('gnd'))
    return { out: 'x', refuse: 'logic_unknown_state', at: unknown('vcc') ? 'vcc' : 'gnd' };
  const vcc = supplyOf(sol);
  if (vcc === null) return { out: 'x', refuse: 'logic_supply_missing' };
  if (Math.abs(vcc) <= UNPOWERED_V) {
    // Unpowered: outputs off (I_off). Inputs may be driven within the absolute maximum.
    return { out: 'off', vcc: 0 };
  }
  const row = vcc > 0 ? inputRowAt(card, vcc) : undefined;
  if (!row || vcc < card.vccOperating[0] || vcc > card.vccOperating[1])
    return { out: 'x', refuse: 'logic_supply_uncharacterized', value: vcc };
  const g = sol.potential('gnd')!;
  const levels: Record<string, LogicLevel> = {};
  let refusal: InputRefusal | undefined;
  for (const t of card.inputs) {
    const c = classifyInput(card, sol, t, row, g);
    levels[t] = c.level;
    refusal ??= c.refusal;
  }
  const out = refusal
    ? 'x'
    : gateOutput(
        card,
        card.inputs.map((t) => levels[t]!),
      );
  const stage = outputStageAt(card, vcc);
  const s: Record<string, string | number | boolean> = {
    out,
    vcc,
    vih: row.vih,
    vil: row.vil,
    validA: stage.validA,
    tabulated: stage.tabulated,
    model: stage.model,
  };
  for (const t of card.inputs) s[`in_${t}`] = levels[t]!;
  if (refusal) return { ...s, ...refusal };
  // The output of the PREVIOUS stage, in this pass's solution: a current the datasheet does not
  // guarantee (above the largest guaranteed test point, at every supply), or one flowing the
  // wrong way (Y forced above V_CC while HIGH, below GND while LOW: no test point covers it), has
  // no characteristic: refused, never extrapolated (EF-D3 A / EF-D4 A).
  const prev = levelOf(state, 'out');
  if ((prev === 'high' || prev === 'low') && prev === out) {
    const i = sol.deviceCurrent(`${ctx.component.id}/y`);
    const y = sol.potential('y');
    const across = y === null ? 0 : prev === 'high' ? sol.potential('vcc')! - y : y - g;
    if (Math.abs(i) > stage.validA + 1e-12 || across < -WRONG_WAY_V) {
      s.refuse = 'logic_output_uncharacterized';
      s.value = Math.abs(i);
    }
  }
  return s;
}

/**
 * The refusal a logic part's settled state carries, with what the Inspector needs to explain it:
 * the pin (`param`), its voltage to the part's GND, the supply and that supply's V_IH/V_IL, the
 * largest guaranteed output current, and the ESP32 input pads that alone sit on a floating input.
 */
export function logicRefusal(ctx: PartContext, state: PartState, part: string) {
  if (typeof state.refuse !== 'string') return null;
  const num = (k: string) => (typeof state[k] === 'number' ? { [k]: state[k] as number } : {});
  const code = state.refuse;
  return {
    code: code as never,
    components: [ctx.component.id],
    ...(typeof state.at === 'string' ? { param: state.at } : {}),
    detail: {
      part,
      ...num('value'),
      ...num('vcc'),
      ...(code === 'logic_supply_uncharacterized' && typeof state.value === 'number'
        ? { vcc: state.value }
        : {}),
      ...(code === 'logic_input_undefined' || code === 'logic_input_out_of_range'
        ? { ...num('vih'), ...num('vil') }
        : {}),
      ...(code === 'logic_output_uncharacterized' && typeof state.validA === 'number'
        ? { limit: state.validA }
        : {}),
      ...(typeof state.pads === 'string'
        ? { pads: state.pads.split(',').map((x) => Number(x)) }
        : {}),
    },
  };
}

/** The gate model for one logic function: only that function's device cards are valid. */
export function gateModel(fn: LogicCard['function']): PartModel {
  const own = Object.entries(LVC1G_CARDS).filter(([, c]) => c.function === fn);
  const inputs = own[0]![1].inputs;
  const model: PartModel = {
    terminals: [...inputs, 'y', 'vcc', 'gnd'],
    cards: Object.fromEntries(own.map(([k, c]) => [k, { partNumber: c.partNumber }])),
    validate: (ctx) => validateCard(ctx, model.cards!),
    // Not yet evaluated: drives nothing and claims nothing (no unknown seeded); the first solve
    // classifies the inputs and the session settles the levels from there.
    initialState: () => ({ out: 'init' }),
    elements: (ctx, state) => {
      const id = ctx.component.id;
      const out = levelOf(state, 'out');
      if ((out !== 'high' && out !== 'low') || typeof state.vcc !== 'number') return [];
      // The guaranteed characteristic at the solved supply (logic/lvc1g.ts outputStageAt).
      const stage = outputStageAt(cardOf(ctx), state.vcc);
      const y = ctx.node('y');
      const [a, b, pts] =
        out === 'high' ? [ctx.node('vcc'), y, stage.high] : [y, ctx.node('gnd'), stage.low];
      return [
        {
          kind: 'device',
          key: `${id}/y`,
          nodes: [a, b],
          make: () => new PwlLoad(`${id}/y`, a, b, pts),
        },
      ];
    },
    // An X output drives nothing: its node is unknown. Its supply pins carry an unknown current
    // (`unknownSupply`): a supply output there reports an unknown current; a supply node behind
    // a resistor is itself unknown.
    unknownDriven: (_ctx, state) => (levelOf(state, 'out') === 'x' ? ['y'] : []),
    // A part with a supply pin unconnected has no supply current to make unknown: it is refused
    // as `logic_supply_missing` (seeding its floating pin would re-name it `logic_unknown_state`).
    unknownSupply: (_ctx, state) =>
      levelOf(state, 'out') === 'x' && state.refuse !== 'logic_supply_missing'
        ? ['vcc', 'gnd']
        : [],
    // No `unknownCurrentMaxA` (Sprint 20, review #1): the ±50 mA I_O is an absolute-maximum
    // stress rating (§5.1 note 1; §7.3.1 "capable of driving larger currents than the device can
    // sustain"), not a bound on what an undetermined output carries.
    logicPins: (ctx) => ({ inputs: cardOf(ctx).inputs, outputs: ['y'] }),
    nextState: (ctx, state, sol) => nextGateState(ctx, sol, state),
    refusal: (ctx, state) => logicRefusal(ctx, state, cardOf(ctx).partNumber),
    report: (ctx, state, sol) => {
      const id = ctx.component.id;
      const card = cardOf(ctx);
      const out = levelOf(state, 'out');
      const terminals: Record<string, number | null> = {};
      for (const t of [...card.inputs, 'y', 'vcc', 'gnd']) terminals[t] = sol.potential(t);
      // Signs: `y` out of the Y pin (positive = sourcing), `vcc` into the V_CC pin, `gnd` out of
      // the GND pin. A HIGH output's current enters through V_CC, a LOW output's leaves through
      // GND (the quiescent I_CC is a datasheet bound, reported separately).
      const iy =
        out === 'high'
          ? sol.deviceCurrent(`${id}/y`)
          : out === 'low'
            ? -sol.deviceCurrent(`${id}/y`)
            : 0;
      const known = out === 'high' || out === 'low' || out === 'off';
      const inputs: Record<string, string> = {};
      for (const t of card.inputs) inputs[t] = levelOf(state, `in_${t}`);
      const tabulated = state.tabulated === true;
      // L2: the gate's state for inspection, voltages relative to its own GND pin.
      const g = terminals.gnd ?? null;
      const rel = (t: string) => {
        const p = terminals[t];
        return p == null || g === null ? null : p - g;
      };
      const supplyV = typeof state.vcc === 'number' ? state.vcc : null;
      const row = supplyV !== null && supplyV > 0 ? inputRowAt(card, supplyV) : undefined;
      const logic: LogicInspection = {
        partNumber: card.partNumber,
        function: card.function,
        supplyV,
        vih: row?.vih ?? null,
        vil: row?.vil ?? null,
        gates: [
          {
            unit: '',
            inputs: card.inputs.map((t) => ({
              pin: t,
              level: (inputs[t] === 'init' ? 'x' : inputs[t]) as LogicLevel,
              volts: rel(t),
            })),
            output: { pin: 'y', level: out === 'init' ? 'x' : out, volts: rel('y') },
          },
        ],
      };
      const validA = typeof state.validA === 'number' ? state.validA : card.rangedOutput.amps;
      return {
        current: null,
        voltage: null,
        terminals,
        currents: (known
          ? { y: iy, vcc: out === 'high' ? iy : 0, gnd: out === 'low' ? -iy : 0 }
          : { y: null, vcc: null, gnd: null }) as Record<string, number | null>,
        state: {
          gateOutput: out,
          ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`input_${k}`, v])),
          ...(typeof state.vcc === 'number' ? { supplyV: state.vcc } : {}),
          outputModel: state.model === 'class' ? 'class' : tabulated ? 'tabulated' : 'ranged',
          outputValidA: validA,
          // I_CC only under its own test conditions (review #2); otherwise not characterized.
          ...quiescentAt(
            card,
            supplyV,
            card.inputs.map((t) => rel(t)),
          ),
        },
        logic,
      };
    },
    ratings: (p, r) => gateRatings(LVC1G_CARDS[p.model as string]!, r),
  };
  return model;
}

/** Datasheet limits (card): absolute maxima and recommended operating conditions. */
function gateRatings(
  card: LogicCard,
  r: {
    terminals: Record<string, number | null>;
    currents?: Record<string, number | null>;
    state?: Record<string, unknown>;
  },
): PartRatingExcess[] {
  const out: PartRatingExcess[] = [];
  const g = r.terminals.gnd;
  const vccV = r.terminals.vcc != null && g != null ? r.terminals.vcc - g : null;
  if (vccV !== null && vccV > card.vccAbsMax)
    out.push({ code: 'voltage', value: vccV, limit: card.vccAbsMax, channel: 'vcc' });
  for (const t of card.inputs) {
    const p = r.terminals[t];
    if (p == null || g == null) continue;
    const v = p - g;
    if (v > card.inputAbsolute[1])
      out.push({ code: 'voltage', value: v, limit: card.inputAbsolute[1], channel: t });
    else if (v > card.inputRecommended[1])
      out.push({
        code: 'voltage',
        value: v,
        limit: card.inputRecommended[1],
        channel: t,
        kind: 'operating',
      });
    else if (v < card.inputAbsolute[0])
      out.push({ code: 'voltage', value: v, limit: card.inputAbsolute[0], channel: t });
  }
  // Output voltage: V_CC + 0.5 V while powered (high or low state); the high-impedance or
  // power-off range otherwise (both absolute maxima, §5.1).
  const yv = r.terminals.y;
  if (yv != null && g != null) {
    const v = yv - g;
    const off = r.state?.gateOutput === 'off';
    const max = off || vccV === null ? card.vccAbsMax : vccV + card.outputAbsAboveVcc;
    if (v > max) out.push({ code: 'voltage', value: v, limit: max, channel: 'y' });
    else if (v < card.inputAbsolute[0])
      out.push({ code: 'voltage', value: v, limit: card.inputAbsolute[0], channel: 'y' });
  }
  const iy = r.currents?.y;
  if (iy != null) {
    const a = Math.abs(iy);
    // At a tabulated supply its §5.3 I_OH/I_OL rows; over the PM-1 class (3.0–3.6 V) the same
    // 3 V rows the output model uses as its bound (Sprint 20: the operating limit and the model
    // agree; before, any load above 100 µA at 3.3 V was flagged though the bound covers 24 mA).
    const recommended = card.outputRows
      .filter(
        (row) =>
          vccV !== null &&
          (Math.abs(row.vcc - vccV) <= TABULATED_VCC_TOLERANCE_V ||
            (row.classVcc !== undefined &&
              vccV >= row.classVcc[0] - TABULATED_VCC_TOLERANCE_V &&
              vccV <= row.classVcc[1] + TABULATED_VCC_TOLERANCE_V)),
      )
      .flatMap((row) => [...row.high, ...row.low].map((p) => p.amps));
    const opMax = recommended.length ? Math.max(...recommended) : card.rangedOutput.amps;
    if (a > card.outputAbsA)
      out.push({ code: 'current', value: a, limit: card.outputAbsA, channel: 'y' });
    else if (a > opMax)
      out.push({ code: 'current', value: a, limit: opMax, channel: 'y', kind: 'operating' });
    if (a > card.supplyPinAbsA)
      out.push({ code: 'current', value: a, limit: card.supplyPinAbsA, channel: 'supply' });
  }
  return out;
}

/** Catalog type → logic function (one type per function; its `model` names the device card). */
export const GATE_TYPES = {
  'logic.gate_and': 'and',
  'logic.gate_nand': 'nand',
  'logic.gate_or': 'or',
  'logic.gate_not': 'not',
} as const;

for (const [type, fn] of Object.entries(GATE_TYPES))
  registerPart(type as keyof typeof GATE_TYPES, gateModel(fn));
