/**
 * Sprint 10, Tier 5: the capacitor exposed through time-stepped sessions. The session advances a
 * fixed backward-Euler step; every run starts discharged at t = 0; live controls apply from the
 * next step; results are deterministic and the DC path is untouched for circuits without one.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, type SolveSuccess } from '../src/index.js';
import { Bench, ledLoop } from './build.js';

/** PSU -> SW (toggle) -> R -> node -> C -> GND; a bleed resistor across C. */
function rc(volts: number, ohms: number, farads: number, bleed?: number) {
  const b = new Bench();
  const sw = b.add('component.toggle_switch');
  const r = b.add('component.resistor');
  const c = b.add('component.capacitor');
  b.wire('PSU1.positive', `${sw}.a`)
    .wire(`${sw}.b`, `${r}.a`)
    .wire(`${r}.b`, `${c}.a`)
    .wire(`${c}.b`, 'GND1.ref')
    .wire('PSU1.negative', 'GND1.ref')
    .ohms(r, ohms)
    .set(c, 'capacitance', { value: farads, unit: 'farad' })
    .set(sw, 'closed', true)
    .psu(volts, 1);
  if (bleed) {
    const rb = b.add('component.resistor');
    b.ohms(rb, bleed).wire(`${c}.a`, `${rb}.a`).wire(`${rb}.b`, 'GND1.ref');
  }
  return { b, sw, r, c };
}
const ok = (o: ReturnType<EngineSession['advance']>) => {
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o as SolveSuccess;
};

describe('time-stepped sessions (capacitor)', () => {
  it('only circuits with a capacitor are time-dependent; others keep the DC path', () => {
    expect(new EngineSession(ledLoop(5, 0.1, 220).snapshot()).timeDependent).toBe(false);
    expect(new EngineSession(rc(5, 1000, 1e-6).b.snapshot()).timeDependent).toBe(true);
  });

  it('charges exactly as the backward-Euler recursion, and converges to V(1 - e^(-t/RC))', () => {
    const R = 1000;
    const C = 100e-6; // tau = 0.1 s
    const dt = 1e-3;
    const { b, c } = rc(5, R, C);
    const s = new EngineSession(b.snapshot());
    const a = dt / (R * C);
    let v = 0;
    for (let n = 1; n <= 300; n++) {
      const o = ok(s.advance(dt));
      v = (v + a * 5) / (1 + a);
      expect(o.components[c]!.voltage!).toBeCloseTo(v, 9);
      expect(o.time).toBeCloseTo(n * dt, 12);
      // KCL: the capacitor current equals the resistor current.
      expect(o.components[c]!.current!).toBeCloseTo((5 - v) / R, 9);
    }
    // First-order method: at dt = tau/100 the curve is within about 0.5 % of the exact one.
    const exact = 5 * (1 - Math.exp(-0.3 / (R * C)));
    expect(Math.abs(v - exact)).toBeLessThan(0.005 * 5);
    expect(s.simulatedTime).toBeCloseTo(0.3, 12);
  });

  it('a live switch change applies from the next step (the capacitor then discharges via the bleed)', () => {
    const { b, sw, c } = rc(5, 1000, 100e-6, 1000);
    const s = new EngineSession(b.snapshot());
    for (let n = 0; n < 500; n++) ok(s.advance(1e-3));
    const charged = ok(s.advance(1e-3)).components[c]!.voltage!;
    expect(charged).toBeCloseTo(2.5, 3); // divider steady state
    expect(s.applyControl(sw, { closed: false }, 2)).toBeNull();
    const first = ok(s.advance(1e-3)).components[c]!.voltage!;
    expect(first).toBeLessThan(charged);
    // The bleed alone: tau = 0.1 s; after 0.3 s about e^-3 of the voltage remains.
    let v = first;
    for (let n = 0; n < 299; n++) v = ok(s.advance(1e-3)).components[c]!.voltage!;
    expect(v / charged).toBeGreaterThan(Math.exp(-3) * 0.9);
    expect(v / charged).toBeLessThan(Math.exp(-3) * 1.1);
  });

  it('is deterministic, and every new session starts discharged at t = 0', () => {
    const run = () => {
      const s = new EngineSession(rc(9, 470, 47e-6).b.snapshot());
      return Array.from({ length: 50 }, () => ok(s.advance(5e-4)).components.C1!.voltage);
    };
    expect(run()).toEqual(run());
    const s = new EngineSession(rc(9, 470, 47e-6).b.snapshot());
    expect(s.simulatedTime).toBe(0);
    expect(ok(s.advance(5e-4)).components.C1!.voltage!).toBeLessThan(0.2);
  });

  it('refuses a bad step and does not advance time on a failed step', () => {
    const s = new EngineSession(rc(5, 1000, 1e-6).b.snapshot());
    expect(() => s.advance(0)).toThrow(/dt/);
    expect(s.simulatedTime).toBe(0);
  });

  it('flags a voltage beyond the rated voltage (a design value)', async () => {
    const { ratingWarnings } = await import('../src/index.js');
    const { b, c } = rc(24, 100, 1e-6);
    const snap = b.snapshot();
    const s = new EngineSession(snap);
    let o = ok(s.advance(1e-3));
    for (let n = 0; n < 20; n++) o = ok(s.advance(1e-3));
    expect(ratingWarnings(snap, o)).toContainEqual(
      expect.objectContaining({ component: c, code: 'voltage', limit: 16 }),
    );
  });
});
