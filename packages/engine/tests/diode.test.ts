/**
 * Sprint 4 A1/A2: the 1N4148 is a real nonlinear production component with authoritative
 * provenance, and representative circuits match an independent calculation.
 *
 * The independent reference solves the SAME physical equation by bisection, sharing no code
 * with the MNA/Newton solver: V = V_j + I * (R + R_S), I = I_S (exp(V_j / (N Vt)) - 1) +
 * gmin * V_j (gmin = 1e-12 S, part of the documented model).
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, type SolveOutcome, type SolveSuccess } from '../src/index.js';
import { DIODE_1N4148, VISHAY_1N4148_ANCHORS, thermalVoltage } from '../src/models.js';
import { Bench } from './build.js';

const REL = 1e-9;
const GMIN = 1e-12;
const nVt = DIODE_1N4148.emissionCoefficient * thermalVoltage(DIODE_1N4148.temperatureK);
const Is = DIODE_1N4148.saturationCurrentA;
const Rs = DIODE_1N4148.seriesResistanceOhm;
const junction = (vj: number) => Is * (Math.exp(vj / nVt) - 1) + GMIN * vj;

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o;
};
const relErr = (a: number | null, e: number) =>
  a === null ? Infinity : Math.abs(a - e) / Math.abs(e);

/** Independent operating point of supply -> R -> diode (forward if sign = +1). */
function reference(supplyV: number, r: number): { vj: number; i: number } {
  // f(vj) = V - vj - I(vj) * (R + Rs) is monotonically decreasing in vj over (-V, V).
  let lo = -Math.abs(supplyV) - 1;
  let hi = Math.abs(supplyV) + 1;
  for (let k = 0; k < 400; k++) {
    const mid = 0.5 * (lo + hi);
    if (supplyV - mid - junction(mid) * (r + Rs) > 0) lo = mid;
    else hi = mid;
  }
  const vj = 0.5 * (lo + hi);
  return { vj, i: junction(vj) };
}

/** PSU1 -> R1 -> D1 -> GND; `reversed` wires the diode cathode towards the supply. */
function diodeLoop(volts: number, limit: number, ohms: number, reversed = false) {
  const b = new Bench();
  const r = b.add('component.resistor');
  const d = b.add('component.diode');
  const [toR, toGnd] = reversed ? ['cathode', 'anode'] : ['anode', 'cathode'];
  b.wire('PSU1.positive', `${r}.a`)
    .wire(`${r}.b`, `${d}.${toR}`)
    .wire(`${d}.${toGnd}`, 'GND1.ref')
    .wire('PSU1.negative', 'GND1.ref')
    .psu(volts, limit)
    .ohms(r, ohms);
  return b;
}

describe('1N4148 model card (A1)', () => {
  it('reproduces every datasheet anchor within 2 mV', () => {
    for (const [i, v] of VISHAY_1N4148_ANCHORS.typicalForward) {
      const vf = nVt * Math.log(i / Is + 1) + i * Rs;
      expect(Math.abs(vf - v), `${i} A`).toBeLessThanOrEqual(2e-3);
    }
  });

  it('is the least-squares fit of those anchors (refit here, independently)', () => {
    const vt = thermalVoltage(DIODE_1N4148.temperatureK);
    const rows = VISHAY_1N4148_ANCHORS.typicalForward.map(([i]) => [vt * Math.log(i), 1, i]);
    const y = VISHAY_1N4148_ANCHORS.typicalForward.map(([, v]) => v);
    const m = [0, 1, 2].map((a) => [
      ...[0, 1, 2].map((b) => rows.reduce((s, r) => s + r[a]! * r[b]!, 0)),
      rows.reduce((s, r, k) => s + r[a]! * y[k]!, 0),
    ]);
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const f = m[r]![c]! / m[c]![c]!;
        m[r] = m[r]!.map((v, k) => v - f * m[c]![k]!);
      }
    }
    const [n, cc, rs] = [0, 1, 2].map((i) => m[i]![3]! / m[i]![i]!) as [number, number, number];
    expect(relErr(n, DIODE_1N4148.emissionCoefficient)).toBeLessThan(1e-9);
    expect(relErr(Math.exp(-cc / (n * vt)), Is)).toBeLessThan(1e-9);
    expect(relErr(rs, Rs)).toBeLessThan(1e-9);
  });

  it('respects the datasheet table limits: V_F(10 mA) <= 1 V, |I_R(20 V)| <= 25 nA', () => {
    const vf10 = nVt * Math.log(1e-2 / Is + 1) + 1e-2 * Rs;
    expect(vf10).toBeLessThanOrEqual(VISHAY_1N4148_ANCHORS.maxForwardVoltageAt10mA);
    expect(Math.abs(junction(-20))).toBeLessThanOrEqual(
      VISHAY_1N4148_ANCHORS.maxReverseCurrentAt20V,
    );
  });
});

describe('1N4148 circuits match the independent reference (A2)', () => {
  it('forward bias: 5 V -> 1 kΩ -> diode', () => {
    const r = ok(new EngineSession(diodeLoop(5, 0.1, 1000).snapshot()).solve());
    const ref = reference(5, 1000);
    expect(relErr(r.components.D1!.current, ref.i)).toBeLessThanOrEqual(REL);
    // Terminal voltage includes the series-resistance drop: V_j + I * R_S.
    expect(relErr(r.components.D1!.voltage, ref.vj + ref.i * Rs)).toBeLessThanOrEqual(REL);
    expect(r.components.D1!.voltage!).toBeGreaterThan(0.6);
    expect(r.components.D1!.voltage!).toBeLessThan(0.75);
    expect(r.components.D1!.outsideModelRange).toBe(false);
    expect(r.stats.maxKclResidualA).toBeLessThanOrEqual(1e-12);
  });

  it('reverse bias: the diode blocks; only the model reverse current (nA) flows', () => {
    const r = ok(new EngineSession(diodeLoop(5, 0.1, 1000, true).snapshot()).solve());
    // Reversed: current flows cathode -> anode, so the anode -> cathode current is negative.
    const ref = reference(-5, 1000);
    expect(r.components.D1!.current!).toBeLessThan(0);
    expect(Math.abs(r.components.D1!.current!)).toBeLessThan(10e-9);
    expect(relErr(r.components.D1!.current, ref.i)).toBeLessThanOrEqual(1e-6);
    // Almost the whole supply appears across the blocking diode (anode - cathode = -5 V).
    expect(r.components.D1!.voltage!).toBeLessThan(-4.9999);
    expect(r.components.D1!.outsideModelRange).toBeUndefined();
  });

  it('polarity reversal changes the circuit electrically (forward conducts, reverse blocks)', () => {
    const fwd = ok(new EngineSession(diodeLoop(5, 0.1, 1000).snapshot()).solve());
    const rev = ok(new EngineSession(diodeLoop(5, 0.1, 1000, true).snapshot()).solve());
    expect(fwd.components.R1!.current!).toBeGreaterThan(4e-3);
    expect(Math.abs(rev.components.R1!.current!)).toBeLessThan(1e-8);
  });

  it('series resistor sweep 10 Ω .. 1 MΩ agrees with the reference', () => {
    for (const ohms of [10, 100, 220, 1e3, 1e4, 1e5, 1e6]) {
      const r = ok(new EngineSession(diodeLoop(5, 1, ohms).snapshot()).solve());
      const ref = reference(5, ohms);
      expect(relErr(r.components.D1!.current, ref.i), `${ohms} Ω`).toBeLessThanOrEqual(REL);
    }
  });

  it('a current-limited supply into the diode enters CC at the limit', () => {
    const r = ok(new EngineSession(diodeLoop(5, 0.01, 10).snapshot()).solve());
    expect(r.components.PSU1!.mode).toBe('cc');
    expect(relErr(r.components.D1!.current, 0.01)).toBeLessThanOrEqual(REL);
    // CC fixes the current: the diode voltage is the model's V_F at exactly 10 mA.
    const vf = nVt * Math.log(0.01 / Is + 1) + 0.01 * Rs;
    expect(Math.abs(r.components.D1!.voltage! - vf)).toBeLessThan(1e-9);
  });

  it('flags forward operation beyond the fitted 0.1-100 mA range without changing numbers', () => {
    const r = ok(new EngineSession(diodeLoop(30, 5, 10).snapshot()).solve());
    expect(r.components.D1!.current!).toBeGreaterThan(0.1);
    expect(r.components.D1!.outsideModelRange).toBe(true);
  });
});
