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
 * - at a supply without tabulated output points, only the ±100 µA ranged row is guaranteed: a
 *   larger output current is refused (`logic_output_uncharacterized`).
 *
 * Propagation delay is NOT simulated (DC sessions): circuits where it matters (feedback between
 * gates, PWM into a gate, clocks) are refused by the session and the host. The card carries t_pd
 * for display.
 */
import { Resistor } from '../devices.js';
import {
  evaluate,
  inputRowAt,
  LVC1G_CARDS,
  outputStageAt,
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

/** |V_CC| at or below this is "unpowered" (the I_off condition, V_CC = 0). */
const UNPOWERED_V = 1e-3;

export function cardOf(ctx: PartContext): LogicCard {
  return LVC1G_CARDS[ctx.value('model') as string]!;
}

const levelOf = (s: PartState, key: string) => (s[key] ?? 'x') as LogicLevel;

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

/** A refusal recorded in the state (enforced by the session once states have settled). */
type Refusal = { refuse: string; at?: string; value?: number };

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
  const extra: Refusal | Record<string, never> = {};
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
    rHigh: stage.rHigh,
    rLow: stage.rLow,
    validA: stage.validA,
    tabulated: stage.tabulated,
    ...extra,
  };
  for (const t of card.inputs) s[`in_${t}`] = levels[t]!;
  if (firstX) s.firstX = firstX;
  // The output current at the PREVIOUS stage (the solution of this pass): beyond a ranged-only
  // characteristic it is refused (EF-D3 A).
  const prev = levelOf(state, 'out');
  if ((prev === 'high' || prev === 'low') && !stage.tabulated) {
    const i = Math.abs(sol.deviceCurrent(`${ctx.component.id}/y`));
    if (i > stage.validA) {
      s.refuse = 'logic_output_uncharacterized';
      s.value = i;
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
    // Unknown until the first solve has classified the inputs (the session settles it).
    initialState: () => ({ out: 'x' }),
    elements: (ctx, state) => {
      const id = ctx.component.id;
      const out = levelOf(state, 'out');
      const y = ctx.node('y');
      if (out === 'high') {
        const r = state.rHigh as number;
        const vcc = ctx.node('vcc');
        return [
          {
            kind: 'device',
            key: `${id}/y`,
            nodes: [vcc, y],
            make: () => new Resistor(`${id}/y`, vcc, y, r),
          },
        ];
      }
      if (out === 'low') {
        const r = state.rLow as number;
        const gnd = ctx.node('gnd');
        return [
          {
            kind: 'device',
            key: `${id}/y`,
            nodes: [y, gnd],
            make: () => new Resistor(`${id}/y`, y, gnd, r),
          },
        ];
      }
      return [];
    },
    // An X output, and its supply pins: the current it would carry is unknown, so a supply
    // feeding it reports an unknown current (a supply OUTPUT is a fixed node: the unknown stops
    // there), and a supply node behind a resistor is itself unknown.
    unknownDriven: (_ctx, state) => (levelOf(state, 'out') === 'x' ? ['y', 'vcc', 'gnd'] : []),
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
            },
          }
        : null,
    report: (ctx, state, sol) => {
      const id = ctx.component.id;
      const card = cardOf(ctx);
      const out = levelOf(state, 'out');
      const terminals: Record<string, number | null> = {};
      for (const t of [...card.inputs, 'y', 'vcc', 'gnd']) terminals[t] = sol.potential(t);
      // Output current out of Y (positive = sourcing); it enters through V_CC when HIGH and
      // leaves through GND when LOW, so the supply-pin currents follow from it.
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
          outputModel: tabulated ? 'tabulated' : 'ranged',
          outputValidA: validA,
          iccMaxA: card.iccMaxA,
          ...(typeof state.firstX === 'string' ? { firstUnknownInput: state.firstX } : {}),
        },
        ...(known && Math.abs(iy) > validA ? { outsideModelRange: true } : {}),
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
  const iy = r.currents?.y;
  if (iy != null) {
    const a = Math.abs(iy);
    const recommended = card.outputRows
      .filter((row) => vccV !== null && Math.abs(row.vcc - vccV) <= 1e-3)
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
