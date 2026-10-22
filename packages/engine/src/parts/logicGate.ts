/**
 * Single logic gates (Sprint 19B, Exploration Foundation L1): SN74LVC1G devices (logic/lvc1g.ts),
 * with REAL supply pins. Electrical model, all from the device card at the part's own SOLVED
 * supply (V_CC pin − GND pin):
 *
 * - inputs draw no DC current (their leakage is a ± bound with no sign: never a conductance,
 *   which would invent a level). Each input is HIGH (≥ V_IH), LOW (≤ V_IL) or UNKNOWN (X, in
 *   between), with V_IH/V_IL from the datasheet row that covers the supply;
 * - an input on a node the session reports unknown (driven by an X output) is X;
 * - an input with no DC path to anything (nothing but gate inputs on its net, or nothing) is
 *   floating: the Run is refused (`logic_input_floating`), never assumed LOW or HIGH;
 * - the output follows the function with static-CMOS semantics: a controlling input decides the
 *   output even when another input is X (AND with a LOW input is LOW); otherwise X;
 * - a HIGH output is a resistor from the part's V_CC pin to Y, a LOW output a resistor from Y to
 *   its GND pin (EF-D4 A, guaranteed characteristic, logic/lvc1g.ts `outputStageAt`). Output
 *   current therefore flows through the supply pins: fan-out, loading and supply current come
 *   out of the solve;
 * - an X output has NO element: the node it drives is unknown (the session marks it, and every
 *   result it reaches, as unknown);
 * - V_CC = 0 (unpowered): outputs off (the datasheet's I_off power-down specification);
 * - a supply the datasheet does not characterize (between input rows, below 1.65 V, above
 *   5.5 V, reversed) is refused (`logic_supply_uncharacterized`, EF-D3 A);
 * - at a supply without tabulated output points: over the 3.3 V ± 0.3 V class the 3 V points as a
 *   conservative bound (owner decision PM-1, logic/lvc1g.ts); elsewhere only the ±100 µA ranged
 *   row is guaranteed. A larger output current is refused (`logic_output_uncharacterized`).
 *
 * Propagation delay is NOT simulated (DC sessions): circuits where it matters (feedback between
 * gates, PWM into a gate, clocks) are refused by the session and the host. The card carries t_pd
 * for display.
 */
import { PwlLoad } from '../pwl.js';
import {
  evaluate,
  inputRowAt,
  LVC1G_CARDS,
  outputStageAt,
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

/** Kleene evaluation (static CMOS): a controlling input decides; otherwise X. */
export function gateOutput(card: LogicCard, ins: readonly LogicLevel[]): 'high' | 'low' | 'x' {
  if (ins.every((l) => l === 'high' || l === 'low')) {
    return evaluate(
      card.function,
      ins.map((l) => l === 'high'),
    )
      ? 'high'
      : 'low';
  }
  // Some input is X: the output is defined only if every completion agrees.
  const unknown = ins.map((l, i) => (l === 'high' || l === 'low' ? -1 : i)).filter((i) => i >= 0);
  const results = new Set<boolean>();
  for (let m = 0; m < 1 << unknown.length; m++) {
    const v = ins.map((l) => l === 'high');
    unknown.forEach((idx, bit) => (v[idx] = ((m >> bit) & 1) === 1));
    results.add(evaluate(card.function, v));
  }
  return results.size === 1 ? ([...results][0] ? 'high' : 'low') : 'x';
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
  let firstX: string | undefined;
  for (const t of card.inputs) {
    if (unknown(t)) {
      levels[t] = 'x';
      firstX ??= t;
      continue;
    }
    const p = sol.potential(t);
    if (p === null) {
      levels[t] = 'x';
      return { out: 'x', refuse: 'logic_input_floating', at: t, vcc };
    }
    const v = p - g;
    levels[t] = v >= row.vih ? 'high' : v <= row.vil ? 'low' : 'x';
    if (levels[t] === 'x') firstX ??= t;
  }
  const out = gateOutput(
    card,
    card.inputs.map((t) => levels[t]!),
  );
  const stage = outputStageAt(card, vcc);
  const s: Record<string, string | number | boolean> = {
    out,
    vcc,
    validA: stage.validA,
    tabulated: stage.tabulated,
    model: stage.model,
  };
  for (const t of card.inputs) s[`in_${t}`] = levels[t]!;
  if (firstX) s.firstX = firstX;
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
    unknownSupply: (_ctx, state) => (levelOf(state, 'out') === 'x' ? ['vcc', 'gnd'] : []),
    unknownCurrentMaxA: (ctx) => cardOf(ctx).outputAbsA,
    logicPins: (ctx) => ({ inputs: cardOf(ctx).inputs, outputs: ['y'] }),
    nextState: (ctx, state, sol) => nextGateState(ctx, sol, state),
    refusal: (ctx, state) =>
      typeof state.refuse === 'string'
        ? {
            code: state.refuse as never,
            components: [ctx.component.id],
            ...(typeof state.at === 'string' ? { param: state.at } : {}),
            detail: {
              ...(typeof state.value === 'number' ? { value: state.value } : {}),
              ...(typeof state.vcc === 'number' ? { vcc: state.vcc } : {}),
              // The largest guaranteed output current at this supply (the limit exceeded).
              ...(state.refuse === 'logic_output_uncharacterized' &&
              typeof state.validA === 'number'
                ? { limit: state.validA }
                : {}),
            },
          }
        : null,
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
          iccMaxA: card.iccMaxA,
          ...(typeof state.firstX === 'string' ? { firstUnknownInput: state.firstX } : {}),
        },
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
    const recommended = card.outputRows
      .filter((row) => vccV !== null && Math.abs(row.vcc - vccV) <= TABULATED_VCC_TOLERANCE_V)
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
