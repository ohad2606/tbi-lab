/**
 * LEDC waveforms on the host (runtime R4, patch 0009). QEMU reports each high-speed timer and
 * channel state change as a `P` / `W` frame stamped with its virtual time; this module turns them
 * into the waveform on each LEDC output signal, exactly, by the hardware's update rules (ESP32 TRM
 * v5.8 ch. 28; ESP-IDF ledc.h):
 *
 * - releasing a timer's reset starts its counter at 0 at that instant;
 * - a running high-speed timer's new parameters take effect at its next overflow (glitch-free
 *   change-over): the new period sequence starts there;
 * - a channel's new duty and hpoint (duty_start) take effect at the next PWM cycle of its timer;
 *   a later write before that cycle replaces an earlier one;
 * - disabling a channel's output gives its idle level at once.
 *
 * Time is exact: one LEDC tick is div / 256 source clocks, so periods and high times are rationals
 * of nanoseconds (the servo's 16-bit duty 3277 at 50 Hz is 1 000 061.035 156 25 ns). Nothing here
 * steps a counter or depends on wall time, so the result is a pure function of the frames.
 *
 * - Sprint 17C (review item M2): an APB-clocked timer whose APB clock leaves 80 MHz (the CPU
 *   below 80 MHz) is refused, from that instant until the timer is reset. On hardware the new
 *   clock applies immediately, mid-period, at a counter value the frames do not carry; the model
 *   would otherwise apply it at the next overflow (up to a period late). REF_TICK is taken as
 *   1 MHz, which ESP-IDF always configures (a firmware that rewrites it is not detected).
 *
 * Not represented, by decision (reported as `unsupported` or `zero`, never approximated):
 * duty 0 (open item O-R4-1: the hardware's output when hpoint and hpoint + 0 coincide is not
 * documented), a channel whose timer is held or misconfigured, hpoint + duty reaching the period
 * end with hpoint > 0 (the output would never be latched low; undocumented), and whatever QEMU
 * itself refuses (dither, fade, interrupts, the low-speed group). Model resolution (O-R4-2): the
 * fractional divider spreads its extra source clocks over 256 ticks in an undocumented pattern, so
 * a real high time can differ from the nominal one here by up to one source clock (1 us on
 * REF_TICK, 12.5 ns on APB); periods are exact.
 */
import {
  LEDC_SIGNALS,
  type LedcChannelState,
  type LedcTimerState,
  type Level,
} from '../harness/protocol.js';

/** A non-negative rational number of nanoseconds, n / d, d > 0, reduced. */
export interface Rat {
  n: bigint;
  d: bigint;
}

const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  while (b) [a, b] = [b, a % b];
  return a;
};
const rat = (n: bigint, d = 1n): Rat => {
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
};
const add = (a: Rat, b: Rat) => rat(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Rat, b: Rat) => rat(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Rat, k: bigint) => rat(a.n * k, a.d);
export const ratCmp = (a: Rat, b: Rat): number => cmp(a, b);
const cmp = (a: Rat, b: Rat) => {
  const x = a.n * b.d - b.n * a.d;
  return x < 0n ? -1 : x > 0n ? 1 : 0;
};
const floorDiv = (n: bigint, d: bigint) => (n >= 0n ? n / d : -((-n + d - 1n) / d));
const ceilDiv = (n: bigint, d: bigint) => -floorDiv(-n, d);
/** The smallest integer k with a + k * p >= t. */
const ceilSteps = (t: Rat, a: Rat, p: Rat) => {
  const x = sub(t, a);
  return ceilDiv(x.n * p.d, x.d * p.n);
};
/** Floor to whole nanoseconds (event times handed to integer-time consumers). */
export const ratFloorNs = (a: Rat): bigint => floorDiv(a.n, a.d);
export const ratToNumber = (a: Rat): number => Number(a.n) / Number(a.d);
/** Round up to whole nanoseconds (the first integer time at or after `a`). */
export const ratCeilNs = (a: Rat): bigint => -floorDiv(-a.n, a.d);
/** `a` minus one nanosecond. */
export const ratMinus1Ns = (a: Rat): Rat => sub(a, rat(1n));
export const ns = (v: bigint): Rat => rat(v);
export const ratAdd = add;
export const ratSub = sub;
export const ratMul = mul;
/** floor(a / b) for b > 0. */
export const ratFloorDiv = (a: Rat, b: Rat): bigint => floorDiv(a.n * b.d, a.d * b.n);

/** One LEDC tick, ns: div / 256 source clocks. */
export const tickNs = (clockHz: number, div: number): Rat =>
  rat(BigInt(div) * 1_000_000_000n, 256n * BigInt(clockHz));

/** The output of one LEDC signal over time. */
export type Waveform =
  | { kind: 'static'; level: Level }
  | {
      kind: 'wave';
      periodNs: Rat;
      highNs: Rat;
      /** A rising edge; others are at `risingNs + k * periodNs` (k >= 0, within the segment). */
      risingNs: Rat;
      /** high / period, exact: duty / 2^res. */
      duty: number;
      /** The channel's duty in ticks and its timer's resolution, for display. */
      dutyTicks: number;
      res: number;
    }
  /** Duty 0 on a running timer: the level is not established (O-R4-1). */
  | { kind: 'zero'; periodNs: Rat }
  | { kind: 'unsupported'; why: string };

/** The APB clock the model's LEDC timing assumes (PLL; the CPU at 80 MHz or more). */
export const APB_HZ = 80_000_000;
/** REF_TICK as ESP-IDF configures it. */
export const REF_TICK_HZ = 1_000_000;

interface TimerTrack {
  state: LedcTimerState;
  /** While paused: when it paused and the configuration it was running with. */
  paused: { at: Rat; run: LedcTimerState & { kind: 'run' } } | null;
  /** Start of the current period sequence (the counter is 0 there). */
  origin: Rat;
  pending: { at: Rat; state: LedcTimerState & { kind: 'run' }; origin: Rat } | null;
}

interface ChannelTrack {
  state: LedcChannelState;
  pending: { at: Rat; state: LedcChannelState }[];
}

const periodOf = (s: LedcTimerState & { kind: 'run' }): Rat =>
  mul(tickNs(s.clockHz, s.div), 1n << BigInt(s.res));
const sameRun = (a: LedcTimerState, b: LedcTimerState) =>
  a.kind === 'run' &&
  b.kind === 'run' &&
  a.clockHz === b.clockHz &&
  a.div === b.div &&
  a.res === b.res;

export class LedcTracker {
  private readonly timers: TimerTrack[] = [0, 1, 2, 3].map(() => ({
    state: { kind: 'unsupported', why: 'resolution' },
    origin: rat(0n),
    pending: null,
    paused: null,
  }));
  private readonly channels = new Map<number, ChannelTrack>();
  /** Virtual time everything has been applied up to. */
  private now: Rat = rat(0n);

  /** The next counter overflow of timer `t` at or after `at` (its own current sequence). */
  private nextBoundary(t: number, at: Rat): Rat | null {
    const tr = this.timers[t]!;
    if (tr.state.kind !== 'run') return null;
    const p = periodOf(tr.state);
    const k = ceilSteps(at, tr.origin, p);
    return add(tr.origin, mul(p, k < 0n ? 0n : k));
  }

  /** The earliest pending change, or null. */
  private nextPending(): Rat | null {
    let best: Rat | null = null;
    for (const t of this.timers)
      if (t.pending && (!best || cmp(t.pending.at, best) < 0)) best = t.pending.at;
    for (const c of this.channels.values())
      for (const p of c.pending) if (!best || cmp(p.at, best) < 0) best = p.at;
    return best;
  }

  /**
   * Apply every change due at or before `vns`, in time order (timers before channels at the
   * same instant: a channel latched at an overflow sees the timer's new sequence). `visit` is
   * called before each instant at which effective states change, with that instant, so a
   * consumer can account for the waveform up to it; `after` once that instant's changes applied.
   */
  advance(vns: bigint, visit?: (at: Rat) => void, after?: (at: Rat) => void): void {
    const until = rat(vns);
    for (;;) {
      const at = this.nextPending();
      if (!at || cmp(at, until) > 0) break;
      visit?.(at);
      for (const t of this.timers) {
        if (t.pending && cmp(t.pending.at, at) === 0) {
          t.state = t.pending.state;
          t.origin = t.pending.origin;
          t.pending = null;
        }
      }
      for (const c of this.channels.values()) {
        while (c.pending.length && cmp(c.pending[0]!.at, at) === 0)
          c.state = c.pending.shift()!.state;
      }
      after?.(at);
    }
    if (cmp(until, this.now) > 0) this.now = until;
  }

  /** A `P` frame. Call `advance(vns)` first. */
  timer(vns: bigint, timer: number, state: LedcTimerState): void {
    const t = this.timers[timer]!;
    const at = rat(vns);
    // M2: a clock other than APB at 80 MHz or REF_TICK can only be APB after a CPU frequency
    // change. Refused at once and until a reset (the counter position is lost); a paused timer
    // keeps the refusal too, so a resume cannot revive a stale configuration.
    if (state.kind === 'run' && state.clockHz !== APB_HZ && state.clockHz !== REF_TICK_HZ)
      state = { kind: 'unsupported', why: 'apb-clock' };
    if (t.state.kind === 'unsupported' && t.state.why === 'apb-clock' && state.kind !== 'reset')
      return;
    if (state.kind !== 'run') {
      // A pause freezes the counter where it is (TRM: the counter stops); remember for resume.
      t.paused =
        state.kind === 'paused' && t.state.kind === 'run'
          ? { at, run: t.state }
          : state.kind === 'paused'
            ? t.paused
            : null;
      t.state = state;
      t.pending = null;
      return;
    }
    if (t.state.kind === 'paused' && t.paused && sameRun(t.paused.run, state)) {
      // Resumed with the same configuration: the counter continues from where it stopped, so the
      // period sequence is shifted by the time it was paused.
      t.origin = add(t.origin, sub(at, t.paused.at));
      t.state = state;
      t.paused = null;
      return;
    }
    t.paused = null;
    if (t.state.kind === 'run') {
      if (sameRun(t.state, state)) {
        t.pending = null; // a change back before the overflow: nothing changes
        return;
      }
      const b = this.nextBoundary(timer, at)!;
      t.pending = { at: b, state, origin: b };
      return;
    }
    // From reset (the counter restarts now) or from a held/unrepresentable state.
    t.state = state;
    t.origin = at;
    t.pending = null;
  }

  /** A `W` frame. Call `advance(vns)` first. */
  channel(vns: bigint, signal: number, state: LedcChannelState): void {
    // Sprint 17C (review V10): only the high-speed group (signals 71-78) is modelled; QEMU
    // reports the low-speed group unsupported itself, and the host does not rely on it.
    if (state.kind === 'on' && signal > LEDC_SIGNALS.highSpeedLast)
      state = { kind: 'unsupported', why: 'low-speed' };
    const c = this.channels.get(signal) ?? { state: { kind: 'idle', level: 0 }, pending: [] };
    this.channels.set(signal, c);
    if (state.kind !== 'on') {
      c.state = state;
      c.pending = [];
      return;
    }
    const b = this.nextBoundary(state.timer, rat(vns));
    if (!b) {
      // The timer is not running: there is no cycle to wait for; the state is judged as is.
      c.state = state;
      c.pending = [];
      return;
    }
    c.pending = c.pending.filter((p) => cmp(p.at, b) < 0);
    c.pending.push({ at: b, state });
  }

  /** The waveform of `signal` now (after `advance`). */
  waveform(signal: number): Waveform {
    const c = this.channels.get(signal);
    if (!c) return { kind: 'static', level: 0 };
    const s = c.state;
    if (s.kind === 'idle') return { kind: 'static', level: s.level };
    if (s.kind === 'unsupported') return { kind: 'unsupported', why: s.why };
    const t = this.timers[s.timer]!;
    if (t.state.kind !== 'run')
      return {
        kind: 'unsupported',
        why: t.state.kind === 'unsupported' ? `timer-${t.state.why}` : `timer-${t.state.kind}`,
      };
    const n = 1 << t.state.res;
    if (s.duty > n || s.hpoint >= n) return { kind: 'unsupported', why: 'hpoint' };
    const period = periodOf(t.state);
    if (s.duty === 0) return { kind: 'zero', periodNs: period };
    if (s.duty === n && s.hpoint === 0) return { kind: 'static', level: 1 };
    if (s.hpoint + s.duty >= n) return { kind: 'unsupported', why: 'hpoint' };
    const tick = tickNs(t.state.clockHz, t.state.div);
    return {
      kind: 'wave',
      periodNs: period,
      highNs: mul(tick, BigInt(s.duty)),
      risingNs: add(t.origin, mul(tick, BigInt(s.hpoint))),
      duty: s.duty / n,
      dutyTicks: s.duty,
      res: t.state.res,
    };
  }

  /** Signals this tracker has seen a channel for. */
  get signals(): number[] {
    return [...this.channels.keys()].sort((a, b) => a - b);
  }
}

/**
 * The edges of `w` in (from, to], in time order, as a static level or a wave whose pulses lie in
 * whole periods starting at or after `segStart` (a wave segment starts at a counter overflow, so
 * a pulse never straddles two segments). `prev` is the level just before `from`.
 */
export function edgesIn(
  w: Waveform,
  segStart: Rat,
  from: Rat,
  to: Rat,
  prev: Level,
): { at: Rat; level: Level }[] {
  if (w.kind === 'static') {
    if (w.level === prev) return [];
    const at = cmp(segStart, from) > 0 ? segStart : from;
    return cmp(at, to) <= 0 ? [{ at, level: w.level }] : [];
  }
  if (w.kind !== 'wave') return [];
  const out: { at: Rat; level: Level }[] = [];
  // Coming from a high level into a wave whose first period starts low (hpoint > 0): the output
  // drops at the segment start.
  const first = add(w.risingNs, mul(w.periodNs, ceilSteps(segStart, w.risingNs, w.periodNs)));
  if (prev === 1 && cmp(first, segStart) > 0 && cmp(segStart, from) > 0 && cmp(segStart, to) <= 0)
    out.push({ at: segStart, level: 0 });
  // First period whose rising edge is at or after the segment start.
  let k = ceilSteps(segStart, w.risingNs, w.periodNs);
  // Skip periods that end before `from`.
  const kf = ceilSteps(from, add(w.risingNs, w.highNs), w.periodNs);
  if (kf > k) k = kf;
  for (; ; k++) {
    const r = add(w.risingNs, mul(w.periodNs, k));
    if (cmp(r, to) > 0) break;
    const f = add(r, w.highNs);
    if (cmp(r, from) > 0) out.push({ at: r, level: 1 });
    if (cmp(f, from) > 0 && cmp(f, to) <= 0) out.push({ at: f, level: 0 });
    if (out.length > 100_000) throw new Error('edge expansion bound exceeded');
  }
  return out;
}
