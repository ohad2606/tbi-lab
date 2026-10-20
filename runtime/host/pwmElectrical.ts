/**
 * The electrical meaning of PWM outputs (runtime R4, architecture decision A1): the engine solves
 * DC operating points, and a pad switching faster than a load's response has no single one. For
 * loads that settle instantly (resistors, LEDs, diodes, contacts, the supply and the board), the
 * waveform alternates between two exact operating points, so the time-average of every current
 * and voltage is exact: the duty-weighted mean of the two points. That is what a DC meter reads and
 * what drives an LED's perceived brightness (the views use the average current); the peak is
 * what the ratings check. Anything else that the PWM output affects (a capacitor, a relay coil, a
 * sensor's supply, a transistor, an MCU input) is refused by name: averaging would invent physics.
 *
 * With several PWM pads the average of the combination is exact only when their effects are
 * independent: then the circuit's response is the sum of each pad's own change (superposition).
 * That is checked, not assumed: the all-high point must equal the sum of the single-pad changes.
 * If it does not (the outputs interact through a shared load), the run is refused.
 *
 * Sprint 17C (review item M6): an averaged part's discrete state must also be the same at every
 * point. A bench supply that is in constant-voltage mode at one point and current-limits at
 * another switches regulation loops within each cycle; how fast a real supply's current limit
 * responds is not modelled, so the average would be invented and the shown mode (taken from one
 * point) wrong: refused as `pwm_supply_limited`. Any other averaged part whose discrete state
 * differs between the points (none of the parts reachable in an ESP32 session has such a state;
 * the LED matrix's lit count is the case in principle) is refused as `pwm_load_unsupported`.
 */
import {
  interpretDigitalInput,
  type ComponentResult,
  type PinResult,
  type PwmComponentFigures,
  type SolveSuccess,
} from '@tbi-lab/engine';

/** Part types whose response to a pad is instantaneous at PWM rates (A1): averaged, never refused. */
export const PWM_AVERAGED_TYPES: ReadonlySet<string> = new Set([
  'instrument.lab_psu',
  'component.ground',
  'component.resistor',
  'component.led',
  'component.diode',
  'component.rgb_led',
  'display.led_matrix_8x8',
  'component.photoresistor',
  'component.push_button',
  'component.toggle_switch',
  'board.esp32_devkitc_wroom32',
  // R4: the servo's signal input is consumed as a waveform (edges), not averaged; it draws no
  // modelled current (decision R4-D3), so nothing of it changes between the points.
  'component.servo_sg90',
]);

/** Absolute and relative tolerance for "the same operating point" (solver residuals ~1e-12). */
const ABS_A = 1e-9;
const ABS_V = 1e-6;
const REL = 1e-6;
const same = (a: number, b: number, abs: number) =>
  Math.abs(a - b) <= Math.max(abs, REL * Math.max(Math.abs(a), Math.abs(b)));

export interface PwmPad {
  gpio: number;
  /** high / period, exact (0 < duty < 1). */
  duty: number;
}

export type PwmProblem =
  /** A part outside the averaged set is affected by a PWM output. */
  | { code: 'pwm_load_unsupported'; components: string[]; gpios: number[] }
  /** An MCU input pad's logic level changes with a PWM output. */
  | { code: 'pwm_input_unsupported'; inputs: number[]; gpios: number[] }
  /** Two or more PWM outputs act on a shared load (superposition fails). */
  | { code: 'pwm_outputs_interact'; components: string[]; gpios: number[] }
  /** A supply alternates between constant-voltage and current-limit operation (M6). */
  | { code: 'pwm_supply_limited'; components: string[]; gpios: number[] };

export interface PwmCombination {
  /** The time-averaged outcome, with `pwm` figures on each affected component and pad. */
  outcome: SolveSuccess;
  problems: PwmProblem[];
}

type Num = number | null;
const lin = (base: Num, deltas: Num[], duties: number[]): Num => {
  if (base === null || deltas.some((d) => d === null)) return null;
  return deltas.reduce((acc: number, d, i) => acc + duties[i]! * (d as number), base);
};
const minus = (a: Num, b: Num): Num => (a === null || b === null ? null : a - b);
/**
 * Sprint 17C (review V1/V2): the extremes of a quantity over EVERY combination of the PWM outputs
 * high or low, not only the solved points. Superposition holds for every accepted combination
 * (checked above: all pairs and all-high; refused otherwise), so a combination's value is the low
 * point plus the changes of its high pads, and the extremes are the low point plus all negative,
 * or all positive, changes. With one or two pads these are exactly solved points.
 */
const range = (base: Num, deltas: Num[]): [number, number] | null => {
  if (base === null || deltas.some((d) => d === null)) return null;
  let lo = base;
  let hi = base;
  for (const d of deltas as number[]) {
    if (d < 0) lo += d;
    else hi += d;
  }
  return [lo, hi];
};
const peakOf = (r: [number, number] | null): Num =>
  r === null ? null : Math.max(Math.abs(r[0]), Math.abs(r[1]));

/** Every numeric quantity of a component result, keyed, for comparison. */
function quantities(r: ComponentResult): Map<string, { v: Num; volts: boolean }> {
  const q = new Map<string, { v: Num; volts: boolean }>();
  q.set('current', { v: r.current, volts: false });
  q.set('voltage', { v: r.voltage, volts: true });
  for (const [k, v] of Object.entries(r.terminals)) q.set(`t:${k}`, { v, volts: true });
  for (const [k, v] of Object.entries(r.currents ?? {})) q.set(`c:${k}`, { v, volts: false });
  r.array?.currents.forEach((v, i) => q.set(`a:${i}`, { v, volts: false }));
  for (const [k, v] of Object.entries(r.state ?? {}))
    q.set(`s:${k}`, {
      v: typeof v === 'number' ? v : v === true ? 1 : v === false ? 0 : Number.NaN,
      volts: false,
    });
  return q;
}

/** The discrete fields (supply mode, contact, part state) differ: never averaged (M6). */
function discreteDiffers(a: ComponentResult, b: ComponentResult): boolean {
  if (a.mode !== b.mode || a.closed !== b.closed) return true;
  const keys = new Set([...Object.keys(a.state ?? {}), ...Object.keys(b.state ?? {})]);
  for (const k of keys) if (a.state?.[k] !== b.state?.[k]) return true;
  return false;
}

function differs(a: ComponentResult, b: ComponentResult): boolean {
  if (a.closed !== b.closed || a.mode !== b.mode) return true;
  for (const [k, sb] of Object.entries(b.state ?? {})) if (a.state?.[k] !== sb) return true;
  const qa = quantities(a);
  for (const [k, { v: vb, volts }] of quantities(b)) {
    const va = qa.get(k)?.v;
    if (va === undefined) return true;
    if (va === null || vb === null) {
      if (va !== vb) return true;
      continue;
    }
    if (Number.isNaN(va) || Number.isNaN(vb)) continue;
    if (!same(va, vb, volts ? ABS_V : ABS_A)) return true;
  }
  return false;
}

/**
 * Sprint 18 (F-17C-2): everything about a set of operating points that does not depend on the
 * duties: which parts are refused (steps 1 and 3 below), and each part's and pad's peaks, ranges
 * and model-range flags. Computed once per pad configuration and reused while only duties change.
 */
export interface PwmAnalysis {
  /** Steps 1 and 3, without the pads (added by `combinePwm`). */
  load: string[];
  supplies: string[];
  interacting: string[];
  components: Record<
    string,
    { changed: boolean; outsideModelRange: boolean; fig?: PwmComponentFigures }
  >;
  pins: Record<
    number,
    { outsideModelRange: boolean; peakCurrent?: number; voltageRange?: [number, number] }
  >;
}

/** The duty-independent analysis of the operating points (see `combinePwm` for the arguments). */
export function analysePwm(
  low: SolveSuccess,
  single: SolveSuccess[],
  allHigh: SolveSuccess | null,
  types: Readonly<Record<string, string>>,
  pairs: readonly { i: number; j: number; o: SolveSuccess }[] = [],
): PwmAnalysis {
  const points = [low, ...single, ...(allHigh ? [allHigh] : [])];

  // 1. Parts outside the averaged set must not notice the PWM outputs at all.
  // M6: an averaged part whose discrete state changes between the points is not averaged either.
  const switching = Object.keys(low.components).filter(
    (id) =>
      PWM_AVERAGED_TYPES.has(types[id] ?? '') &&
      points.some(
        (p) => p.components[id] && discreteDiffers(low.components[id]!, p.components[id]!),
      ),
  );
  const supplies = switching.filter((id) => types[id] === 'instrument.lab_psu');
  const load = Object.keys(low.components).filter(
    (id) =>
      (!PWM_AVERAGED_TYPES.has(types[id] ?? '') &&
        points.some((p) => p.components[id] && differs(low.components[id]!, p.components[id]!))) ||
      (switching.includes(id) && !supplies.includes(id)),
  );

  // 3. Several pads: superposition must hold for every averaged quantity.
  let interacting: string[] = [];
  if (allHigh && single.length > 1) {
    // The response to a set of pads high together must be the sum of their single changes: for
    // the all-high point and (three or more pads) every pair. Higher-order interactions that
    // cancel in both are not detected (documented limitation).
    const checks = [
      { members: single.map((_, i) => i), o: allHigh },
      ...pairs.map((p) => ({ members: [p.i, p.j], o: p.o })),
    ];
    interacting = Object.keys(low.components).filter((id) => {
      const base = quantities(low.components[id]!);
      const singles = single.map((s) => quantities(s.components[id]!));
      for (const { members, o } of checks) {
        const all = quantities(o.components[id]!);
        for (const [k, { v: b, volts }] of base) {
          const sum = lin(
            b,
            members.map((i) => minus(singles[i]!.get(k)?.v ?? null, b)),
            members.map(() => 1),
          );
          const a = all.get(k)?.v ?? null;
          if (sum === null || a === null) {
            if (sum !== a) return true;
            continue;
          }
          if (Number.isNaN(sum) || Number.isNaN(a)) continue;
          if (!same(sum, a, volts ? ABS_V : ABS_A)) return true;
        }
      }
      return false;
    });
  }

  // 4 (duty-independent part). The peaks and ranges.
  const components: PwmAnalysis['components'] = {};
  for (const [id, base] of Object.entries(low.components)) {
    const singles = single.map((s) => s.components[id]!);
    const changed = points.some((p) => differs(base, p.components[id]!));
    const entry: PwmAnalysis['components'][string] = {
      changed,
      outsideModelRange: points.some((p) => p.components[id]!.outsideModelRange === true),
    };
    if (changed) {
      const span = (pick: (r: ComponentResult) => Num) =>
        range(
          pick(base),
          singles.map((s) => minus(pick(s), pick(base))),
        );
      const fig: PwmComponentFigures = {
        peakCurrent: peakOf(span((x) => x.current)),
        voltageRange: span((x) => x.voltage),
        terminalRanges: Object.fromEntries(
          Object.keys(base.terminals).map((k) => [k, span((x) => x.terminals[k] ?? null)]),
        ),
      };
      if (base.currents)
        fig.peakCurrents = Object.fromEntries(
          Object.keys(base.currents).map((k) => [k, peakOf(span((x) => x.currents?.[k] ?? null))]),
        );
      if (base.array)
        fig.peakArray = base.array.currents.map(
          (_, i) => peakOf(span((x) => x.array?.currents[i] ?? null)) ?? 0,
        );
      entry.fig = fig;
    }
    components[id] = entry;
  }
  const pins: PwmAnalysis['pins'] = {};
  for (const p of low.pins ?? []) {
    const singles = single.map((s) => s.pins!.find((x) => x.gpio === p.gpio)!);
    const entry: PwmAnalysis['pins'][number] = {
      outsideModelRange: points.some(
        (o) => o.pins?.find((x) => x.gpio === p.gpio)?.outsideModelRange === true,
      ),
    };
    const pk = peakOf(
      range(
        p.current,
        singles.map((s) => s.current - p.current),
      ),
    );
    if (
      pk !== null &&
      points.some((o) => o.pins?.find((x) => x.gpio === p.gpio)?.current !== p.current)
    )
      entry.peakCurrent = pk;
    const vr = range(
      p.voltage,
      singles.map((s) => s.voltage - p.voltage),
    );
    if (vr && vr[0] !== vr[1]) entry.voltageRange = vr;
    pins[p.gpio] = entry;
  }
  return { load, supplies, interacting, components, pins };
}

/**
 * Combine the operating points. `low`: every PWM pad low; `single[i]`: only pad i high; `allHigh`:
 * every PWM pad high (only needed with two or more pads). `prevInputs`: the input levels the MCU
 * currently sees (for the hysteresis of interpretDigitalInput). `analysis`: `analysePwm` of the
 * same points, when the caller keeps it (Sprint 18); computed here otherwise.
 */
export function combinePwm(
  pads: (PwmPad & { periodNs: number; highNs: number })[],
  low: SolveSuccess,
  single: SolveSuccess[],
  allHigh: SolveSuccess | null,
  types: Readonly<Record<string, string>>,
  prevInputs: ReadonlyMap<number, 0 | 1>,
  /** Three or more pads: every pair high together (`i < j`), for the pairwise check. */
  pairs: readonly { i: number; j: number; o: SolveSuccess }[] = [],
  analysis: PwmAnalysis = analysePwm(low, single, allHigh, types, pairs),
): PwmCombination {
  const duties = pads.map((p) => p.duty);
  const gpios = pads.map((p) => p.gpio);
  const points = [low, ...single, ...(allHigh ? [allHigh] : [])];
  const problems: PwmProblem[] = [];
  const a = analysis;

  // 1. (analysePwm) Parts outside the averaged set, and averaged parts changing discrete state.
  if (a.load.length) problems.push({ code: 'pwm_load_unsupported', components: a.load, gpios });
  if (a.supplies.length)
    problems.push({ code: 'pwm_supply_limited', components: a.supplies, gpios });

  // 2. No MCU input may change level: reading a PWM signal needs edges, which A1 does not give.
  const pwmGpios = new Set(gpios);
  const inputs = (low.pins ?? [])
    .filter((p) => p.mode === 'input' && !pwmGpios.has(p.gpio))
    .filter((p) => {
      const prev = prevInputs.get(p.gpio) ?? 0;
      const at = (o: SolveSuccess) => {
        const q = o.pins?.find((x) => x.gpio === p.gpio);
        return q ? interpretDigitalInput(q.voltage, prev) : prev;
      };
      return points.some((o) => at(o) !== at(low));
    })
    .map((p) => p.gpio);
  if (inputs.length) problems.push({ code: 'pwm_input_unsupported', inputs, gpios });

  // 3. (analysePwm) Several pads: superposition.
  if (a.interacting.length)
    problems.push({ code: 'pwm_outputs_interact', components: a.interacting, gpios });

  // 4. The average (here: it depends on the duties) and the peaks (analysePwm).
  const components: Record<string, ComponentResult> = {};
  for (const [id, base] of Object.entries(low.components)) {
    const singles = single.map((s) => s.components[id]!);
    const avg = (pick: (r: ComponentResult) => Num) =>
      lin(
        pick(base),
        singles.map((s) => minus(pick(s), pick(base))),
        duties,
      );
    const r: ComponentResult = {
      ...base,
      current: avg((x) => x.current),
      voltage: avg((x) => x.voltage),
      terminals: Object.fromEntries(
        Object.keys(base.terminals).map((k) => [k, avg((x) => x.terminals[k] ?? null)]),
      ),
    };
    if (base.currents)
      r.currents = Object.fromEntries(
        Object.keys(base.currents).map((k) => [k, avg((x) => x.currents?.[k] ?? null)]),
      );
    if (base.array)
      r.array = {
        ...base.array,
        currents: base.array.currents.map((_, i) => avg((x) => x.array?.currents[i] ?? null) ?? 0),
      };
    const an = a.components[id]!;
    if (an.outsideModelRange) r.outsideModelRange = true;
    if (an.fig) r.pwm = an.fig;
    components[id] = r;
  }
  const netVoltages: Record<string, number> = {};
  for (const [net, v] of Object.entries(low.netVoltages)) {
    const av = lin(
      v,
      single.map((s) => minus(s.netVoltages[net] ?? null, v)),
      duties,
    );
    if (av !== null) netVoltages[net] = av;
  }
  const pins = low.pins?.map((p) => {
    const singles = single.map((s) => s.pins!.find((x) => x.gpio === p.gpio)!);
    const i = gpios.indexOf(p.gpio);
    const out: PinResult = {
      ...p,
      voltage: lin(
        p.voltage,
        singles.map((s) => s.voltage - p.voltage),
        duties,
      )!,
      current: lin(
        p.current,
        singles.map((s) => s.current - p.current),
        duties,
      )!,
    };
    const an = a.pins[p.gpio]!;
    if (an.outsideModelRange) out.outsideModelRange = true;
    if (i >= 0) {
      const hi = singles[i]!;
      out.pwm = {
        duty: duties[i]!,
        periodNs: pads[i]!.periodNs,
        highNs: pads[i]!.highNs,
        currentHigh: hi.current,
        currentLow: p.current,
      };
    }
    if (an.peakCurrent !== undefined) out.peakCurrent = an.peakCurrent;
    if (an.voltageRange) out.voltageRange = an.voltageRange;
    return out;
  });
  return {
    outcome: { ...low, components, netVoltages, ...(pins ? { pins } : {}) },
    problems,
  };
}
