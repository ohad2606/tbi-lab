/**
 * Packaged logic (Exploration Foundation L3): a multi-gate IC (SN74LVC08A, logic/lvc08a.ts) as
 * ONE part with its datasheet pin map and ONE shared supply. Each gate uses exactly the L1 gate
 * model (parts/logicGate.ts), evaluated at the package's own solved supply (V_CC pin − GND pin):
 *
 * - inputs draw no DC current; HIGH (≥ V_IH), LOW (≤ V_IL) or UNKNOWN (X) between them, from the
 *   datasheet row covering the supply (where two rows share a boundary, the stricter);
 * - a floating input — of a used or an UNUSED gate — is refused (`logic_input_floating`, naming
 *   the pin): the datasheet requires every unused input held at V_CC or GND;
 * - each gate's HIGH output is a guaranteed-characteristic element from the SHARED V_CC pin to
 *   its Y, LOW from its Y to the SHARED GND pin; the supply-pin currents are therefore the sums
 *   over the four gates, out of the solve;
 * - an output current above the largest guaranteed test point at this supply (100 µA between
 *   tabulated supplies), or flowing the wrong way, is refused (`logic_output_uncharacterized`,
 *   naming the output pin);
 * - V_CC = 0: refused (`logic_unpowered_uncharacterized`): this sheet has no I_off specification;
 * - supply outside the rows / operating range: `logic_supply_uncharacterized`.
 *
 * - an input between V_IL and V_IH is refused (`logic_input_undefined`): the sheet gives neither a
 *   level nor a supply current there; one outside the recommended V_I 0–5.5 V is refused
 *   (`logic_input_out_of_range`); one on an undetermined net is refused (`logic_unknown_state`).
 *
 * Ratings (§5.1): ±50 mA per output, ±100 mA continuous through V_CC or GND (all gates together),
 * input and output voltage ranges, V_CC absolute maxima.
 */
import { PwlLoad } from '../pwl.js';
import {
  outputStageAt,
  inputRowAt,
  quiescentAt,
  RAIL_V,
  settledVcc,
  TABULATED_VCC_TOLERANCE_V,
} from '../logic/lvc1g.js';
import { LOGIC_PACKAGE_CARDS, type LogicPackageCard } from '../logic/lvc08a.js';
import {
  registerPart,
  validateCard,
  type PartContext,
  type PartModel,
  type PartRatingExcess,
  type PartSolution,
  type PartState,
} from '../parts.js';
import {
  classifyInput,
  gateOutput,
  guaranteeOf,
  logicRefusal,
  type LogicLevel,
} from './logicGate.js';
import type { LogicInspection } from './logicInspection.js';

const WRONG_WAY_V = 1e-3;
const UNPOWERED_V = 1e-3;

export function packageCardOf(ctx: PartContext): LogicPackageCard {
  return LOGIC_PACKAGE_CARDS[ctx.value('model') as string]!;
}

const outKey = (unit: string) => `out${unit}`;
const lvl = (s: PartState, k: string) => (s[k] ?? 'x') as LogicLevel | 'init';

function nextPackageState(ctx: PartContext, sol: PartSolution, state: PartState): PartState {
  const card = packageCardOf(ctx);
  const allX = (extra: Record<string, string | number>) => ({
    ...Object.fromEntries(card.units.map((u) => [outKey(u.unit), 'x'])),
    ...extra,
  });
  const unknown = (t: string) => sol.unknown?.(t) === true;
  if (unknown('vcc') || unknown('gnd'))
    return allX({ refuse: 'logic_unknown_state', at: unknown('vcc') ? 'vcc' : 'gnd' });
  const v = sol.potential('vcc');
  const g = sol.potential('gnd');
  if (v === null || g === null) return allX({ refuse: 'logic_supply_missing' });
  // Review round 4: a supply pin reached only through a junction or a capacitor (see logicGate.ts).
  for (const pin of ['vcc', 'gnd'] as const)
    if (sol.undriven?.(pin)) return allX({ refuse: 'logic_supply_undriven', at: pin });
  const vcc = settledVcc(v - g, state.vcc);
  if (Math.abs(vcc) <= UNPOWERED_V) {
    // No I_off specification in this sheet: an unpowered device has no characterized behaviour.
    if (card.ioffA === undefined)
      return allX({ refuse: 'logic_unpowered_uncharacterized', vcc: 0 });
    return { ...Object.fromEntries(card.units.map((u) => [outKey(u.unit), 'off'])), vcc: 0 };
  }
  const row = vcc > 0 ? inputRowAt(card, vcc) : undefined;
  if (!row || vcc < card.vccOperating[0] || vcc > card.vccOperating[1])
    return allX({ refuse: 'logic_supply_uncharacterized', value: vcc });
  const stage = outputStageAt(card, vcc);
  const s: Record<string, string | number | boolean> = {
    vcc,
    vih: row.vih,
    vil: row.vil,
    validA: stage.validA,
    tabulated: stage.tabulated,
    model: stage.model,
  };
  let refusal: Record<string, string | number> | undefined;
  for (const u of card.units) {
    const levels: LogicLevel[] = [];
    for (const t of u.inputs) {
      // The single gates' contract (parts/logicGate.ts classifyInput): floating (also: held only
      // by an ESP32 input pad's leakage), undetermined net, outside 0–5.5 V, between V_IL and V_IH.
      const c = classifyInput(card, sol, t, row, g);
      refusal ??= c.refusal;
      s[`in_${t}`] = c.level;
      levels.push(c.level);
    }
    const out = gateOutput(card, levels);
    s[outKey(u.unit)] = out;
    // The PREVIOUS pass's output of this gate, in this solution: beyond the guaranteed current,
    // or the wrong way, has no characteristic (refused, never extrapolated).
    const prev = lvl(state, outKey(u.unit));
    if (!refusal && (prev === 'high' || prev === 'low') && prev === out) {
      const i = sol.deviceCurrent(`${ctx.component.id}/${u.output}`);
      const y = sol.potential(u.output);
      const across = y === null ? 0 : prev === 'high' ? v - y : y - g;
      if (Math.abs(i) > stage.validA + 1e-12 || across < -WRONG_WAY_V)
        refusal = { refuse: 'logic_output_uncharacterized', at: u.output, value: Math.abs(i) };
    }
  }
  return refusal ? { ...s, ...refusal } : s;
}

/** The package's gate outputs that are unknown (X) in this state. */
const xOutputs = (card: LogicPackageCard, state: PartState) =>
  card.units.filter((u) => lvl(state, outKey(u.unit)) === 'x').map((u) => u.output);

export const logicPackageModel: PartModel = {
  terminals: Object.keys(LOGIC_PACKAGE_CARDS['model.logic.sn74lvc08a']!.pins),
  cards: Object.fromEntries(
    Object.entries(LOGIC_PACKAGE_CARDS).map(([k, c]) => [k, { partNumber: c.partNumber }]),
  ),
  validate: (ctx) => validateCard(ctx, logicPackageModel.cards!),
  initialState: () => ({ out1: 'init', out2: 'init', out3: 'init', out4: 'init' }),
  elements: (ctx, state) => {
    const card = packageCardOf(ctx);
    if (typeof state.vcc !== 'number' || state.vcc <= 0) return [];
    const stage = outputStageAt(card, state.vcc);
    const id = ctx.component.id;
    return card.units.flatMap((u) => {
      const out = lvl(state, outKey(u.unit));
      if (out !== 'high' && out !== 'low') return [];
      const y = ctx.node(u.output);
      const key = `${id}/${u.output}`;
      const [a, b, pts] =
        out === 'high' ? [ctx.node('vcc'), y, stage.high] : [y, ctx.node('gnd'), stage.low];
      return [
        { kind: 'device' as const, key, nodes: [a, b], make: () => new PwlLoad(key, a, b, pts) },
      ];
    });
  },
  unknownDriven: (ctx, state) => xOutputs(packageCardOf(ctx), state),
  // No supply current to make unknown when a supply pin is unconnected (refused by that name).
  // Review round 3 (A1): no unknown supply seeded from a refused state (see parts/logicGate.ts).
  unknownSupply: (ctx, state) =>
    xOutputs(packageCardOf(ctx), state).length && typeof state.refuse !== 'string'
      ? ['vcc', 'gnd']
      : [],
  // No `unknownCurrentMaxA`: the absolute maxima are stress ratings, not a bound on what an
  // output carries (§5.1 note 1, §7.3.1 "capable of driving larger currents than the device can
  // sustain"). A current-limited supply feeding an unknown output is therefore refused.
  logicPins: (ctx) => {
    const c = packageCardOf(ctx);
    return { inputs: c.inputs, outputs: c.units.map((u) => u.output) };
  },
  logicUnits: (ctx) =>
    packageCardOf(ctx).units.map((u) => ({ unit: u.unit, inputs: u.inputs, outputs: [u.output] })),
  nextState: (ctx, state, sol) => nextPackageState(ctx, sol, state),
  refusal: (ctx, state) => logicRefusal(ctx, state, packageCardOf(ctx).partNumber),
  logicBounds: (ctx, state) => {
    const card = packageCardOf(ctx);
    if (typeof state.refuse === 'string' || typeof state.vcc !== 'number' || state.vcc <= 0)
      return null;
    const inputs = card.inputs.map((pin) => ({
      pin,
      node: ctx.node(pin),
      level: lvl(state, `in_${pin}`) as 'high' | 'low',
    }));
    const outputs = card.units.map((u) => ({
      pin: u.output,
      node: ctx.node(u.output),
      key: `${ctx.component.id}/${u.output}`,
      level: lvl(state, outKey(u.unit)) as 'high' | 'low',
    }));
    const ok = (l: string) => l === 'high' || l === 'low';
    if (!inputs.every((i) => ok(i.level)) || !outputs.every((o) => ok(o.level))) return null;
    return {
      component: ctx.component.id,
      part: card.partNumber,
      card,
      vccNode: ctx.node('vcc'),
      gndNode: ctx.node('gnd'),
      vcc: state.vcc,
      powered: true,
      inputs,
      outputs,
    };
  },
  report: (ctx, state, sol) => {
    const id = ctx.component.id;
    const card = packageCardOf(ctx);
    const terminals: Record<string, number | null> = {};
    for (const t of Object.keys(card.pins)) terminals[t] = sol.potential(t);
    const g = terminals.gnd ?? null;
    const rel = (t: string) => {
      const p = terminals[t];
      return p == null || g === null ? null : p - g;
    };
    const currents: Record<string, number | null> = {};
    let vccI = 0;
    let gndI = 0;
    let allKnown = true;
    const gates: LogicInspection['gates'] = [];
    for (const u of card.units) {
      const out = lvl(state, outKey(u.unit));
      const raw = sol.deviceCurrent(`${id}/${u.output}`);
      // Out of the Y pin, positive = sourcing (as for the single gates).
      const iy = out === 'high' ? raw : out === 'low' ? -raw : out === 'off' ? 0 : null;
      currents[u.output] = iy;
      if (iy === null) allKnown = false;
      else if (out === 'high') vccI += iy;
      else if (out === 'low') gndI += -iy;
      gates.push({
        unit: u.unit,
        inputs: u.inputs.map((t) => ({
          pin: t,
          level: (state[`in_${t}`] ?? 'x') as LogicLevel,
          volts: rel(t),
        })),
        output: {
          pin: u.output,
          level: out === 'init' ? 'x' : out,
          volts: rel(u.output),
          ...guaranteeOf(card, typeof state.vcc === 'number' ? state.vcc : null, out, iy ?? 0),
        },
      });
    }
    // Into V_CC: the sum of the HIGH outputs' source currents; out of GND: the LOW outputs' sink
    // currents (the quiescent I_CC is a datasheet bound, reported separately).
    currents.vcc = allKnown ? vccI : null;
    currents.gnd = allKnown ? gndI : null;
    const supplyV = typeof state.vcc === 'number' ? state.vcc : null;
    return {
      current: null,
      voltage: null,
      terminals,
      currents,
      state: {
        ...(supplyV !== null ? { supplyV } : {}),
        outputModel:
          state.model === 'class' ? 'class' : state.tabulated === true ? 'tabulated' : 'ranged',
        outputValidA: typeof state.validA === 'number' ? state.validA : card.rangedOutput.amps,
        // I_CC (≤ 10 µA) is specified only at V_CC = 3.6 V with every input at V_CC or GND
        // (§5.7); otherwise the quiescent current is not characterized (ΔI_CC ≤ 500 µA per
        // input at V_CC − 0.6 V, 2.7–3.6 V).
        ...quiescentAt(
          card,
          supplyV,
          card.inputs.map((t) => rel(t)),
        ),
      },
      logic: {
        partNumber: card.partNumber,
        function: card.function,
        supplyV,
        vih: typeof state.vih === 'number' ? state.vih : null,
        vil: typeof state.vil === 'number' ? state.vil : null,
        gates,
      },
    };
  },
  ratings: (p, r) => packageRatings(LOGIC_PACKAGE_CARDS[p.model as string]!, r),
};

/** Datasheet limits (§5.1 absolute maxima; §5.4 recommended operating conditions). */
export function packageRatings(
  card: LogicPackageCard,
  r: { terminals: Record<string, number | null>; currents?: Record<string, number | null> },
): PartRatingExcess[] {
  const out: PartRatingExcess[] = [];
  const g = r.terminals.gnd;
  const vccV = r.terminals.vcc != null && g != null ? r.terminals.vcc - g : null;
  if (vccV !== null && vccV > card.vccAbsMax)
    out.push({ code: 'voltage', value: vccV, limit: card.vccAbsMax, channel: 'vcc' });
  // §5.1 V_CC minimum −0.5 V (a reversed supply).
  else if (vccV !== null && vccV < -0.5)
    out.push({ code: 'voltage', value: vccV, limit: -0.5, channel: 'vcc' });
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
    else if (v < card.inputRecommended[0] - RAIL_V)
      out.push({
        code: 'voltage',
        value: v,
        limit: card.inputRecommended[0],
        channel: t,
        kind: 'operating',
      });
  }
  // At a tabulated supply the §5.4 I_OH / I_OL maximum; elsewhere the §5.7 ±100 µA test
  // condition (the largest guaranteed current there; the model refuses above it first).
  const recommended = card.outputRows
    .filter((row) => vccV !== null && Math.abs(row.vcc - vccV) <= TABULATED_VCC_TOLERANCE_V)
    .flatMap((row) => [...row.high, ...row.low].map((p) => p.amps));
  const opMax = recommended.length ? Math.max(...recommended) : card.rangedOutput.amps;
  for (const u of card.units) {
    const yv = r.terminals[u.output];
    if (yv != null && g != null) {
      const v = yv - g;
      const max = vccV === null ? card.vccAbsMax : vccV + card.outputAbsAboveVcc;
      if (v > max) out.push({ code: 'voltage', value: v, limit: max, channel: u.output });
      else if (v < card.inputAbsolute[0])
        out.push({ code: 'voltage', value: v, limit: card.inputAbsolute[0], channel: u.output });
    }
    const iy = r.currents?.[u.output];
    if (iy == null) continue;
    const a = Math.abs(iy);
    if (a > card.outputAbsA)
      out.push({ code: 'current', value: a, limit: card.outputAbsA, channel: u.output });
    else if (a > opMax)
      out.push({ code: 'current', value: a, limit: opMax, channel: u.output, kind: 'operating' });
  }
  // Continuous current through V_CC or GND: all four gates together (§5.1 ±100 mA).
  for (const pin of ['vcc', 'gnd'] as const) {
    const i = r.currents?.[pin];
    if (i != null && Math.abs(i) > card.supplyPinAbsA)
      out.push({ code: 'current', value: Math.abs(i), limit: card.supplyPinAbsA, channel: pin });
  }
  return out;
}

registerPart('logic.quad_and', logicPackageModel);
