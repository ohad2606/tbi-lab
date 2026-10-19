/**
 * T-R4-5 (architecture A1): the electrical meaning of PWM outputs, on the production engine.
 * Averages and peaks equal hand calculation; parts that do not settle instantly, MCU inputs that
 * would read the PWM signal, and outputs that interact through a shared load are refused by name.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, type SolveSuccess } from '@tbi-lab/engine';
import { combinePwm } from '../pwmElectrical.js';
import { Circuit } from './r1-support.js';

/** Solve `c` with every listed pad low, each high alone, and all high; then combine. */
function points(c: Circuit, pads: { gpio: number; duty: number }[]) {
  const req = c.request('0'.repeat(64));
  const e = new EngineSession(req.circuit, { pins: req.attachments });
  const solve = (high: number[]) => {
    for (const p of pads)
      e.setPinMode(p.gpio, high.includes(p.gpio) ? 'output-high' : 'output-low');
    const o = e.solve();
    if (!o.ok) throw new Error(JSON.stringify(o.error));
    return o as SolveSuccess;
  };
  const low = solve([]);
  const single = pads.map((p) => solve([p.gpio]));
  const all = pads.length > 1 ? solve(pads.map((p) => p.gpio)) : null;
  const types = Object.fromEntries(req.circuit.components.map((x) => [x.id, x.type]));
  const r = combinePwm(
    pads.map((p) => ({ ...p, periodNs: 1e6, highNs: p.duty * 1e6 })),
    low,
    single,
    all,
    types,
    new Map(),
  );
  return { ...r, low, single, all };
}

describe('T-R4-5: A1 averages, peaks and refusals', () => {
  it('pad -> 1 kΩ -> GND: the average is duty x the high-point current (16.5 Ω pad model)', () => {
    const c = new Circuit();
    const r = c.add('component.resistor');
    c.ohms(r, 1000).wire(`${r}.b`, 'GND1.ref').pad(18, `${r}.a`);
    for (const duty of [0.25, 0.5, 0.75]) {
      const { outcome, problems } = points(c, [{ gpio: 18, duty }]);
      expect(problems).toEqual([]);
      const iHigh = 3.3 / (1000 + 16.5); // hand calculation: 3.3 V behind 16.5 Ω into 1 kΩ
      expect(outcome.components[r]!.current).toBeCloseTo(duty * iHigh, 9);
      expect(outcome.components[r]!.pwm!.peakCurrent).toBeCloseTo(iHigh, 9);
      expect(outcome.components[r]!.voltage).toBeCloseTo(duty * iHigh * 1000, 6);
      const pin = outcome.pins!.find((p) => p.gpio === 18)!;
      expect(pin.pwm).toMatchObject({ duty, currentLow: 0 });
      expect(pin.peakCurrent).toBeCloseTo(iHigh, 9);
    }
  });

  it('an LED: average forward current = duty x I_F(high); peak = I_F(high) (what ratings check)', () => {
    const c = new Circuit();
    const r = c.add('component.resistor');
    const d = c.add('component.led');
    c.ohms(r, 220).wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref').pad(2, `${r}.a`);
    const { outcome, problems, single } = points(c, [{ gpio: 2, duty: 0.1 }]);
    expect(problems).toEqual([]);
    const iHigh = single[0]!.components[d]!.current!;
    expect(iHigh).toBeGreaterThan(0.001);
    expect(outcome.components[d]!.current).toBeCloseTo(0.1 * iHigh, 12);
    expect(outcome.components[d]!.pwm!.peakCurrent).toBeCloseTo(iHigh, 12);
  });

  it('a relay coil on the PWM net is refused, named (it does not settle instantly)', () => {
    const c = new Circuit();
    const k = c.add('component.relay');
    c.wire(`${k}.coil2`, 'GND1.ref').wire(`${k}.com`, 'GND1.ref').pad(18, `${k}.coil1`);
    const { problems } = points(c, [{ gpio: 18, duty: 0.5 }]);
    expect(problems).toEqual([{ code: 'pwm_load_unsupported', components: [k], gpios: [18] }]);
  });

  it('an MCU input that would read the PWM signal is refused, named', () => {
    const c = new Circuit();
    const r = c.add('component.resistor');
    const r2 = c.add('component.resistor');
    c.ohms(r, 1000).ohms(r2, 10_000).wire(`${r}.b`, `${r2}.a`).wire(`${r2}.b`, 'GND1.ref');
    c.pad(18, `${r}.a`).pad(5, `${r}.b`);
    const { problems } = points(c, [{ gpio: 18, duty: 0.5 }]);
    expect(problems).toEqual([{ code: 'pwm_input_unsupported', inputs: [5], gpios: [18] }]);
  });

  it('two outputs on separate loads: independent, each averaged on its own', () => {
    const c = new Circuit();
    const a = c.add('component.resistor');
    const b = c.add('component.resistor');
    c.ohms(a, 1000).ohms(b, 2000).wire(`${a}.b`, 'GND1.ref').wire(`${b}.b`, 'GND1.ref');
    c.pad(18, `${a}.a`).pad(19, `${b}.a`);
    const { outcome, problems, single } = points(c, [
      { gpio: 18, duty: 0.25 },
      { gpio: 19, duty: 0.5 },
    ]);
    expect(problems).toEqual([]);
    expect(outcome.components[a]!.current).toBeCloseTo(
      0.25 * single[0]!.components[a]!.current!,
      12,
    );
    expect(outcome.components[b]!.current).toBeCloseTo(
      0.5 * single[1]!.components[b]!.current!,
      12,
    );
  });

  it('two outputs into one LED interact (the LED is non-linear): refused, naming the shared parts', () => {
    const c = new Circuit();
    const a = c.add('component.resistor');
    const b = c.add('component.resistor');
    const d = c.add('component.led');
    c.ohms(a, 220).ohms(b, 220);
    c.wire(`${a}.b`, `${d}.anode`).wire(`${b}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref');
    c.pad(18, `${a}.a`).pad(19, `${b}.a`);
    const { problems } = points(c, [
      { gpio: 18, duty: 0.5 },
      { gpio: 19, duty: 0.5 },
    ]);
    expect(problems[0]).toMatchObject({ code: 'pwm_outputs_interact', gpios: [18, 19] });
    expect((problems[0] as { components: string[] }).components).toContain(d);
  });

  // Sprint 17C (review M6): PSU1+ (5 V) -> 1 kΩ -> GPIO18. Pad low: 5 V / 1016.5 Ω = 4.9 mA; pad
  // high: 1.7 V / 1016.5 Ω = 1.67 mA. With a 2 mA limit the supply current-limits only while the
  // pad is low: one mode cannot be shown and the average would be invented, so it is refused.
  const sink = (limitA: number) => {
    const c = new Circuit().psu(5).set('PSU1', 'currentLimit', { value: limitA, unit: 'ampere' });
    const r = c.add('component.resistor');
    c.ohms(r, 1000).wire('PSU1.positive', `${r}.a`).pad(18, `${r}.b`);
    return points(c, [{ gpio: 18, duty: 0.5 }]);
  };

  it('M6: a supply that current-limits during part of each cycle is refused, named', () => {
    const { problems, low, single } = sink(0.002);
    expect(low.components.PSU1!.mode).not.toBe(single[0]!.components.PSU1!.mode);
    expect(problems).toEqual([{ code: 'pwm_supply_limited', components: ['PSU1'], gpios: [18] }]);
  });

  it('M6 control: the same circuit within the limit at both points is averaged (no problem)', () => {
    const { problems, outcome, low, single } = sink(0.1);
    expect(low.components.PSU1!.mode).toBe(single[0]!.components.PSU1!.mode);
    expect(problems).toEqual([]);
    const avg = 0.5 * (low.components.PSU1!.current! + single[0]!.components.PSU1!.current!);
    expect(outcome.components.PSU1!.current).toBeCloseTo(avg, 12);
  });
});
