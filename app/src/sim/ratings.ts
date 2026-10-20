/**
 * Over-stress warnings for the running result (Sprint 5): the engine's datasheet check applied
 * to the current outcome, cached per outcome so re-renders do not repeat it. Presentation of a
 * documented limit, never physics: numbers shown elsewhere are the engine's, unchanged.
 */
import { createSnapshot, type ProjectDocument } from '@tbi-lab/domain';
import {
  ratingWarnings,
  type ComponentResult,
  type PinResult,
  type RatingWarning,
  type SolveSuccess,
} from '@tbi-lab/engine';

const cache = new WeakMap<SolveSuccess, RatingWarning[]>();

export function warningsFor(doc: ProjectDocument, outcome: SolveSuccess): RatingWarning[] {
  let w = cache.get(outcome);
  if (!w) {
    // Model parameters are structural (fixed while running), so the current document's
    // snapshot names the same models the outcome was solved with.
    const snapshot = createSnapshot(doc);
    // Sprint 17C (review V2): voltage limits apply to the extremes over the PWM combinations, so
    // the check runs at the lowest and at the highest voltages (each with the peak currents) and
    // keeps the worse row of each kind. Without PWM both corners are the outcome itself.
    w = worst([
      ...ratingWarnings(snapshot, peakOutcome(voltageCorner(outcome, 0))),
      ...ratingWarnings(snapshot, peakOutcome(voltageCorner(outcome, 1))),
    ]);
    cache.set(outcome, w);
  }
  return w;
}

/** One row per part, check, element and pad: the larger excess when both corners report it. */
function worst(rows: RatingWarning[]): RatingWarning[] {
  const out = new Map<string, RatingWarning>();
  for (const r of rows) {
    const key = [
      r.component,
      r.code,
      r.kind,
      r.channel ?? '',
      r.gpio ?? '',
      r.otherGpio ?? '',
    ].join('|');
    const prev = out.get(key);
    if (!prev || Math.abs(r.value) > Math.abs(prev.value)) out.set(key, r);
  }
  return [...out.values()];
}

/**
 * Sprint 17C (review V2): the outcome with every PWM-switched voltage at its lowest (`0`) or
 * highest (`1`) value over the PWM combinations. Each quantity is taken at its own extreme, so a
 * voltage formed from two terminals can be over-stated: the conservative side for a warning.
 */
export function voltageCorner(outcome: SolveSuccess, end: 0 | 1): SolveSuccess {
  const switched = Object.values(outcome.components).some((r) => r.pwm);
  const pinsSwitched = outcome.pins?.some((p) => p.voltageRange);
  if (!switched && !pinsSwitched) return outcome;
  const components: Record<string, ComponentResult> = {};
  for (const [id, r] of Object.entries(outcome.components)) {
    const p = r.pwm;
    if (!p) {
      components[id] = r;
      continue;
    }
    const at = (v: number | null, span: [number, number] | null | undefined) =>
      span === undefined ? v : span === null ? null : span[end];
    components[id] = {
      ...r,
      voltage: at(r.voltage, p.voltageRange),
      terminals: Object.fromEntries(
        Object.entries(r.terminals).map(([k, v]) => [k, at(v, p.terminalRanges?.[k])]),
      ),
    };
  }
  return {
    ...outcome,
    components,
    ...(outcome.pins
      ? {
          pins: outcome.pins.map((p) =>
            p.voltageRange ? { ...p, voltage: p.voltageRange[end] } : p,
          ),
        }
      : {}),
  };
}

/**
 * Sprint 15 (R4): what the ratings check under PWM. A part a PWM output switches reports
 * time-averages (its `current`, named `currents`, `array`), and a datasheet's maximum current
 * applies to the PEAK, which the runtime reports beside them (`pwm.peakCurrent`, `peakCurrents`,
 * `peakArray`). This copy of the outcome, used ONLY for the ratings, carries the peaks in place of
 * the averages; everything shown keeps the engine's values unchanged.
 *
 * - A peak is a magnitude: it takes the sign of the average it replaces (the current-rated parts
 *   are LEDs and diodes, whose current flows the same way at every operating point).
 * - Voltages: Sprint 17C (review V2) checks them at their extremes (voltageCorner, warningsFor).
 * - A PWM pad is checked at whichever of its two operating points carries the larger current, in
 *   that point's drive mode (sourcing while high, sinking while low: different limits). A pad whose
 *   current changes only because ANOTHER pad switches is checked at its peak, in its own mode.
 * - The cumulative output current then sums each pad's peak: an upper bound (the peaks of
 *   different pads need not coincide), the conservative side for a safety warning.
 */
export function peakOutcome(outcome: SolveSuccess): SolveSuccess {
  const switched = Object.values(outcome.components).some((r) => r.pwm);
  const pinsSwitched = outcome.pins?.some((p) => p.pwm || p.peakCurrent !== undefined);
  if (!switched && !pinsSwitched) return outcome;
  const components: Record<string, ComponentResult> = {};
  for (const [id, r] of Object.entries(outcome.components)) components[id] = peakComponent(r);
  return {
    ...outcome,
    components,
    ...(outcome.pins ? { pins: outcome.pins.map(peakPin) } : {}),
  };
}

/** The peak in place of an average (unchanged when no peak is reported for it). */
function signed(average: number | null, peak: number | null | undefined): number | null {
  if (peak === undefined) return average;
  if (peak === null) return null;
  return average !== null && average < 0 ? -peak : peak;
}

function peakComponent(r: ComponentResult): ComponentResult {
  const p = r.pwm;
  if (!p) return r;
  const out: ComponentResult = { ...r, current: signed(r.current, p.peakCurrent) };
  if (r.currents)
    out.currents = Object.fromEntries(
      Object.entries(r.currents).map(([k, v]) => [k, signed(v, p.peakCurrents?.[k])]),
    );
  if (r.array && p.peakArray)
    out.array = {
      ...r.array,
      currents: r.array.currents.map((v, i) => signed(v, p.peakArray![i]) ?? v),
    };
  return out;
}

function peakPin(pin: PinResult): PinResult {
  if (pin.pwm) {
    // The two points of its own waveform: HIGH sources `currentHigh`, LOW sinks `currentLow`.
    const high = Math.abs(pin.pwm.currentHigh) >= Math.abs(pin.pwm.currentLow);
    const at = high ? pin.pwm.currentHigh : pin.pwm.currentLow;
    // With several PWM pads its largest current may be at a combined point: never below that.
    const magnitude = Math.max(Math.abs(at), pin.peakCurrent ?? 0);
    return {
      ...pin,
      mode: high ? 'output-high' : 'output-low',
      current: (Math.sign(at) || (high ? 1 : -1)) * magnitude,
    };
  }
  if (pin.peakCurrent === undefined) return pin;
  const negative = pin.current < 0 || (pin.current === 0 && pin.mode === 'output-low');
  return { ...pin, current: negative ? -pin.peakCurrent : pin.peakCurrent };
}
