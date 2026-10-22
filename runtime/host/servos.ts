/**
 * SG90 servos in a runtime session (Sprint 15, R4). A servo's position follows the pulses on its
 * signal wire over simulated time (engine `Servo`: valid 400-2600 us pulses, 1.0-2.0 ms -> 0-180
 * degrees, 10 us deadband, 600 degrees/s slew, holds without pulses). What reaches the wire is read
 * from the circuit, never assumed: after every solve the servo's signal potential (relative to its
 * own GND, thresholds of the part model) at each operating point says where its signal comes from:
 *
 * - the same logic level at every point: a static level (a GPIO the firmware sets, an LEDC idle or
 *   100 % output); a change is one edge at that frame's time;
 * - low with every PWM pad low and high with exactly one PWM pad high: that pad's LEDC waveform;
 *   its pulses are expanded analytically, exactly (pwm.ts), period by period, as time passes;
 * - anything else (between the thresholds, or several PWM pads acting on it): undefined; the servo
 *   sees no valid pulse and a warning names it.
 *
 * Outside its modelled supply range (4.8-6.0 V) a servo neither reads its signal nor moves.
 */
import { Servo, servoPowered, servoSignalLevel, type SolveSuccess } from '@tbi-lab/engine';
import type { SimulationSnapshot } from '@tbi-lab/domain';
import {
  edgesIn,
  ns,
  ratAdd,
  ratFloorDiv,
  ratMul,
  ratSub,
  ratCeilNs,
  ratCmp,
  ratMinus1Ns,
  ratToNumber,
  type Rat,
  type Waveform,
} from './pwm.js';

/** RC5 review (S1): the shortest servo frame read as pulses (ns): 20 ms nominal minus 10 %. */
export const SERVO_MIN_FRAME_NS = 18_000_000n;

type Wave = Extract<Waveform, { kind: 'wave' }>;

type Source =
  { kind: 'static'; level: 0 | 1 | null } | { kind: 'wave'; gpio: number; w: Wave; segStart: Rat };

interface Tracked {
  id: string;
  model: Servo;
  source: Source;
  /** Time up to which the signal has been fed (exclusive bound of the next expansion). */
  cursor: Rat;
  level: 0 | 1;
  powered: boolean;
  warned: boolean;
  /** RC5 review S1: the frame-rate warning was given. */
  warnedFrame: boolean;
  /** The servo model's own time (ns): it never goes backwards. */
  timeNs: bigint;
}

/** One PWM pad's operating point with only it high, and its waveform since `since`. */
export interface PwmPoint {
  gpio: number;
  w: Wave;
  since: Rat;
  high: SolveSuccess;
}

export interface ServoState {
  powered: boolean;
  angleDeg: number;
  commandedDeg: number;
  /** The last accepted pulse width (us), or null before the first. */
  pulseUs: number | null;
  /** What the signal wire carries: nothing, LEDC pulses, a static level, or an undefined level. */
  signal: 'none' | 'pulses' | 'static' | 'undefined';
}

/** Pulses outside 400-2600 us are never valid: a waveform made only of them is not expanded. */
const MIN_US = 400;
const MAX_US = 2600;

/** The latest cycle boundary of `w` (a counter overflow: segStart + k * period) at or before `t`. */
function lastBoundary(w: Wave, segStart: Rat, t: Rat): Rat {
  if (ratCmp(t, segStart) <= 0) return segStart;
  const k = ratFloorDiv(ratSub(t, segStart), w.periodNs);
  return ratAdd(segStart, ratMul(w.periodNs, k));
}

export class ServoBank {
  private readonly servos: Tracked[] = [];
  readonly diagnostics: { simNs: bigint; code: string; detail: Record<string, unknown> }[] = [];

  constructor(snapshot: SimulationSnapshot) {
    for (const c of snapshot.components)
      if (c.type === 'component.servo_sg90')
        this.servos.push({
          id: c.id,
          model: new Servo(),
          source: { kind: 'static', level: 0 },
          cursor: ns(0n),
          level: 0,
          powered: false,
          warned: false,
          warnedFrame: false,
          timeNs: 0n,
        });
  }

  get empty(): boolean {
    return this.servos.length === 0;
  }

  /**
   * Feed every servo its signal up to `to` (exact time, ns) and move it there (to the next whole
   * nanosecond). Monotonic: an earlier time is a no-op.
   */
  sync(to: Rat | bigint): void {
    const t = typeof to === 'bigint' ? ns(to) : to;
    const tNs = ratCeilNs(t);
    for (const s of this.servos) {
      if (ratCmp(t, s.cursor) > 0) {
        if (s.powered && s.source.kind === 'wave') {
          const { w, segStart } = s.source;
          const highUs = ratToNumber(w.highNs) / 1000;
          if (highUs >= MIN_US && highUs <= MAX_US)
            for (const e of edgesIn(w, segStart, s.cursor, t, s.level)) {
              const at = ratCeilNs(e.at);
              // Edges at or before what the servo has already seen were fed (a boundary edge can
              // be offered again when a waveform is re-anchored on it): never fed twice.
              if (at < s.timeNs || (at === s.timeNs && e.level === s.level)) continue;
              s.model.edge(at, e.level);
              s.level = e.level;
              s.timeNs = at;
            }
        }
        s.cursor = t;
      }
      if (tNs > s.timeNs) {
        if (s.powered) s.model.advanceTo(tNs);
        else s.model.holdUntil(tNs);
        s.timeNs = tNs;
      }
    }
  }

  /**
   * After a solve at `vns`: each servo's supply and signal source from the operating points (`low`:
   * every PWM pad low; `pwm`: each PWM pad high on its own). Call `sync(vns)` before.
   */
  observe(vns: bigint, low: SolveSuccess, pwm: readonly PwmPoint[]): void {
    for (const s of this.servos) {
      const r = low.components[s.id];
      if (!r) continue;
      const g = r.terminals.gnd ?? null;
      const supply = r.terminals.vcc != null && g !== null ? r.terminals.vcc - g : null;
      const powered = servoPowered(supply);
      if (powered !== s.powered) {
        if (vns > s.timeNs) {
          if (s.powered) s.model.advanceTo(vns);
          else s.model.holdUntil(vns);
          s.timeNs = vns;
        }
        s.powered = powered;
      }
      const level = (o: SolveSuccess) => {
        const t = o.components[s.id]?.terminals;
        return servoSignalLevel(t?.signal != null && t.gnd != null ? t.signal - t.gnd : null);
      };
      const atLow = level(low);
      const moving = pwm.filter((p) => level(p.high) !== atLow);
      let next: Source;
      if (moving.length === 0) next = { kind: 'static', level: atLow };
      else if (moving.length === 1 && atLow === 0 && level(moving[0]!.high) === 1) {
        const p = moving[0]!;
        // The same waveform (by value: the pad and the instant it took effect; a solve builds new
        // objects) continues; only a new one restarts the expansion at its own start.
        const same =
          s.source.kind === 'wave' &&
          s.source.gpio === p.gpio &&
          ratCmp(s.source.segStart, p.since) === 0;
        // RC5 review (S1): an SG90 is specified for a 20 ms frame (TowerPro: 50 Hz). A frame
        // shorter than SERVO_MIN_FRAME_NS (the nominal minus 10 %: a conservative bound, no
        // documented tolerance) has no documented reaction: no pulse is read, a warning names it,
        // the servo holds. (Longer frames, up to 50 ms, are the model's own rule.)
        if (p.w.kind === 'wave' && ratCmp(p.w.periodNs, ns(SERVO_MIN_FRAME_NS)) < 0) {
          next = { kind: 'static', level: null };
          if (!s.warnedFrame) {
            s.warnedFrame = true;
            this.diagnostics.push({
              simNs: vns,
              code: 'servo_frame_unsupported',
              detail: {
                component: s.id,
                gpio: p.gpio,
                periodUs: Math.round(ratToNumber(p.w.periodNs) / 1000),
              },
            });
          }
          s.warned = true; // not also the undefined-level warning
        } else next = same ? s.source : { kind: 'wave', gpio: p.gpio, w: p.w, segStart: p.since };
      } else next = { kind: 'static', level: null };
      if (next.kind === 'static' && next.level === null && !s.warned) {
        s.warned = true;
        this.diagnostics.push({
          simNs: vns,
          code: 'servo_signal_undefined',
          detail: { component: s.id, gpios: moving.map((p) => p.gpio) },
        });
      }
      if (next.kind === 'static' && next.level !== null && next.level !== s.level && s.powered) {
        const at = vns > s.timeNs ? vns : s.timeNs;
        s.model.edge(at, next.level);
        s.level = next.level;
        s.timeNs = at;
      }
      // A new waveform is expanded from its own start (an LEDC cycle boundary): edges re-fed at
      // the boundary are at the servo's current level and are ignored by the model. Sprint 17C
      // (review V6): a waveform that started long before this servo saw it (connected later, or
      // after a suspension) is expanded from its last cycle boundary at or before now, never
      // replayed from its start.
      if (next.kind === 'wave' && s.source !== next)
        s.cursor = ratMinus1Ns(lastBoundary(next.w, next.segStart, ns(vns)));
      s.source = next;
    }
  }

  /**
   * Sprint 17C (review V3/V4): the signal is not known (a PWM state awaiting refusal): no pulse in
   * progress is measured and nothing is fed until the next `observe` from a real operating point.
   */
  suspend(vns: bigint): void {
    for (const s of this.servos) {
      if (vns > s.timeNs) {
        if (s.powered) s.model.advanceTo(vns);
        else s.model.holdUntil(vns);
        s.timeNs = vns;
      }
      s.model.discardPulse();
      s.source = { kind: 'static', level: null };
      s.cursor = ns(vns);
    }
  }

  state(id: string): ServoState | undefined {
    const s = this.servos.find((x) => x.id === id);
    if (!s) return undefined;
    return {
      powered: s.powered,
      angleDeg: s.model.angleDeg,
      commandedDeg: s.model.commandedDeg,
      pulseUs: s.model.acceptedPulseUs,
      signal:
        s.source.kind === 'wave'
          ? 'pulses'
          : s.source.level === null
            ? 'undefined'
            : s.model.pulseCount === 0 && s.level === 0
              ? 'none'
              : 'static',
    };
  }

  get ids(): string[] {
    return this.servos.map((s) => s.id);
  }
}
