/**
 * Sprint 10: the HC-SR501 PIR module (sensor environment: motion), electrical behaviour per its
 * published schematic: powered at 4.5-20 V, OUT = 3.3 V (motion) or 0 V behind R14 = 1 kOhm, the
 * output current taken from VCC, 50 uA quiescent.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, ratingWarnings, type SolveSuccess } from '../src/index.js';
import { HC_SR501 } from '../src/parts/pir.js';
import { Bench } from './build.js';

/** PSU -> VCC; GND; OUT -> R(load) -> GND. */
function pirBench(volts: number, motion: boolean, load = 1000) {
  const b = new Bench();
  const u = b.add('sensor.pir_hc_sr501');
  const r = b.add('component.resistor');
  b.wire('PSU1.positive', `${u}.vcc`)
    .wire(`${u}.gnd`, 'GND1.ref')
    .wire('PSU1.negative', 'GND1.ref')
    .wire(`${u}.out`, `${r}.a`)
    .wire(`${r}.b`, 'GND1.ref')
    .ohms(r, load)
    .psu(volts, 0.1)
    .set(u, 'motion', motion);
  return { b, u, r };
}
const solve = (b: Bench) => {
  const o = new EngineSession(b.snapshot()).solve();
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o as SolveSuccess;
};

describe('HC-SR501 PIR module', () => {
  it('motion: OUT = 3.3 V behind 1 kOhm; the output current is drawn from VCC with the 50 uA quiescent', () => {
    const { b, u, r } = pirBench(5, true);
    const o = solve(b);
    const vout = (3.3 * 1000) / (1000 + HC_SR501.outputOhm);
    expect(o.components[r]!.terminals.a).toBeCloseTo(vout, 9);
    expect(o.components[u]!.state).toEqual({ powered: true, output: 'high' });
    expect(o.components[u]!.currents!.output).toBeCloseTo(vout / 1000, 12);
    // The supply delivers exactly what the module draws.
    expect(o.components.PSU1!.current).toBeCloseTo(50e-6 + vout / 1000, 12);
    expect(o.components[u]!.currents!.supply).toBeCloseTo(50e-6 + vout / 1000, 12);
  });

  it('no motion: OUT low (0 V), only the quiescent current; motion is a live environment control', () => {
    const { b, u, r } = pirBench(5, false);
    const s = new EngineSession(b.snapshot());
    const quiet = s.solve() as SolveSuccess;
    expect(quiet.components[u]!.state).toEqual({ powered: true, output: 'low' });
    expect(Math.abs(quiet.components[r]!.terminals.a!)).toBeLessThan(1e-12);
    expect(quiet.components.PSU1!.current).toBeCloseTo(50e-6, 12);
    expect(s.applyControl(u, { params: { motion: true } }, 2)).toBeNull();
    const moving = s.solve() as SolveSuccess;
    expect(moving.components[u]!.state!.output).toBe('high');
    expect(moving.appliedRevision).toBe(2);
  });

  it('below 4.5 V (and reversed) the module is unpowered: OUT low, no supply current', () => {
    for (const v of [4.4, 3.3, 0]) {
      const { b, u } = pirBench(v, true);
      const o = solve(b);
      expect(o.components[u]!.state, `${v} V`).toEqual({ powered: false, output: 'low' });
      expect(Math.abs(o.components.PSU1!.current!)).toBeLessThan(1e-12);
    }
    expect(solve(pirBench(4.5, true).b).components.U1!.state!.powered).toBe(true);
  });

  it('above 20 V the supply rating is exceeded (a warning; the model keeps solving)', () => {
    const { b, u } = pirBench(24, true);
    const snap = b.snapshot();
    const o = new EngineSession(snap).solve() as SolveSuccess;
    expect(ratingWarnings(snap, o)).toContainEqual(
      expect.objectContaining({ component: u, code: 'voltage', limit: 20, channel: 'supply' }),
    );
  });
});
