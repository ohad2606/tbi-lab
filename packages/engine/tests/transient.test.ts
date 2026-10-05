/**
 * Sprint 10: the engine's internal time-domain core (unexposed: no catalog type, snapshot field
 * or UI uses it). Validated against closed-form solutions (RC charge and discharge), for its
 * convergence ORDER (backward Euler 1st, trapezoidal 2nd), charge conservation, determinism,
 * bounds, the unchanged DC path, and against ngspice (the Gate A independent reference) on a
 * nonlinear RC + LED discharge.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from 'eecircuit-engine';
import { Circuit, MAX_TRANSIENT_STEPS } from '../src/circuit.js';
import { Capacitor, Diode, LabPsu, Resistor, VoltageSource } from '../src/devices.js';
import { LED_TLHR5400 } from '../src/models.js';

/** Vs → R → n, C from n to ground (charging from a discharged capacitor). */
function rcCharge(vs: number, r: number, c: number) {
  const ckt = new Circuit();
  ckt.add(new VoltageSource('V1', 'in', '0', vs));
  ckt.add(new Resistor('R1', 'in', 'n', r));
  ckt.add(new Capacitor('C1', 'n', '0', c));
  return ckt;
}

function maxError(
  ckt: Circuit,
  opts: Parameters<Circuit['transient']>[0],
  exact: (t: number) => number,
  node: string,
) {
  const r = ckt.transient(opts);
  const v = r.nodeVoltages.get(node)!;
  let e = 0;
  for (let k = 0; k < r.time.length; k++) e = Math.max(e, Math.abs(v[k]! - exact(r.time[k]!)));
  return { e, r };
}

describe('time-domain core: closed-form references', () => {
  const VS = 5;
  const R = 1000;
  const C = 1e-6;
  const TAU = R * C;
  const charge = (t: number) => VS * (1 - Math.exp(-t / TAU));

  it('RC charging matches V(1 - e^(-t/RC)); trapezoidal error is second order, backward Euler first', () => {
    const run = (method: 'trapezoidal' | 'backward-euler', n: number) =>
      maxError(
        rcCharge(VS, R, C),
        { dt: TAU / n, steps: 5 * n, method, initial: 'zero' },
        charge,
        'n',
      ).e;
    const trap1 = run('trapezoidal', 50);
    const trap2 = run('trapezoidal', 100);
    const be1 = run('backward-euler', 50);
    const be2 = run('backward-euler', 100);
    expect(trap1).toBeLessThan(2e-4 * VS);
    expect(trap1 / trap2).toBeGreaterThan(3.6);
    expect(trap1 / trap2).toBeLessThan(4.4);
    expect(be1 / be2).toBeGreaterThan(1.8);
    expect(be1 / be2).toBeLessThan(2.2);
    expect(be1).toBeGreaterThan(trap1);
  });

  it('time zero of a discharged circuit is the true t = 0+ state', () => {
    const r = rcCharge(VS, R, C).transient({ dt: TAU / 50, steps: 1, initial: 'zero' });
    expect(Math.abs(r.nodeVoltages.get('n')![0]!)).toBeLessThan(1e-8);
    expect(r.nodeVoltages.get('in')![0]).toBe(VS);
    // The full V/R starts flowing at once.
    expect(r.deviceCurrents.get('C1')![0]).toBeCloseTo(VS / R, 9);
  });

  it('RC discharge from the DC operating point matches V0 e^(-t/RC), second order through a declared jump', () => {
    // Vs → R1 → n; C and R2 from n to ground. DC: n = Vs/2. At t = 0+ the source drops to 0 V:
    // n decays with tau = C (R1 || R2).
    const tau = 10e-6 * 500;
    const exact = (t: number) => (t === 0 ? 2 : 2 * Math.exp(-t / tau));
    const run = (n: number, declare: boolean) => {
      const ckt = new Circuit();
      const vs = ckt.add(new VoltageSource('V1', 'in', '0', 4));
      ckt.add(new Resistor('R1', 'in', 'n', 1000));
      ckt.add(new Resistor('R2', 'n', '0', 1000));
      ckt.add(new Capacitor('C1', 'n', '0', 10e-6));
      return maxError(
        ckt,
        {
          dt: tau / n,
          steps: 5 * n,
          // The source drops at t = 0+: a discontinuity, integrated with backward Euler.
          beforeStep: (k) => {
            if (k !== 1) return false;
            vs.voltageV = 0;
            return declare;
          },
        },
        exact,
        'n',
      );
    };
    const a = run(200, true);
    const b = run(400, true);
    expect(a.r.nodeVoltages.get('n')![0]).toBe(2); // the operating point: the capacitor is open at DC
    expect(a.e).toBeLessThan(3e-5);
    expect(a.e / b.e).toBeGreaterThan(3.5); // second order overall
    // Without declaring the jump, the trapezoidal rule integrates across it: a first-order error
    // two orders of magnitude larger.
    const naive = run(200, false).e;
    expect(naive).toBeGreaterThan(100 * a.e);
  });

  it('conserves charge: the integrated capacitor current equals C times its voltage change', () => {
    const r = rcCharge(VS, R, C).transient({ dt: TAU / 40, steps: 200, initial: 'zero' });
    const i = r.deviceCurrents.get('C1')!;
    const v = r.nodeVoltages.get('n')!;
    let q = 0;
    for (let k = 1; k < i.length; k++) q += (0.5 * (i[k]! + i[k - 1]!) * TAU) / 40;
    // Trapezoidal integration of i is exact for the trapezoidal companion model.
    expect(Math.abs(q - C * (v[v.length - 1]! - v[0]!))).toBeLessThan(1e-15);
  });
});

describe('time-domain core: engineering properties', () => {
  it('a circuit without stateful devices gives its DC operating point at every step, unchanged', () => {
    const build = () => {
      const c = new Circuit();
      c.add(new LabPsu('PSU1', 'p', '0', 5, 0.1));
      c.add(new Resistor('R1', 'p', 'a', 220));
      c.add(new Diode('D1', 'a', '0', LED_TLHR5400));
      return c;
    };
    const dc = build().solve();
    const tr = build().transient({ dt: 1e-3, steps: 5 });
    for (const [node, v] of dc.nodeVoltages)
      for (const x of tr.nodeVoltages.get(node)!) expect(x).toBe(v);
  });

  it('is deterministic and bounded', () => {
    const a = rcCharge(5, 1000, 1e-6).transient({ dt: 2e-5, steps: 300, initial: 'zero' });
    const b = rcCharge(5, 1000, 1e-6).transient({ dt: 2e-5, steps: 300, initial: 'zero' });
    expect([...a.nodeVoltages.get('n')!]).toEqual([...b.nodeVoltages.get('n')!]);
    const c = rcCharge(5, 1000, 1e-6);
    expect(() => c.transient({ dt: 0, steps: 10 })).toThrow(/dt/);
    expect(() => c.transient({ dt: 1e-6, steps: MAX_TRANSIENT_STEPS + 1 })).toThrow(/steps/);
    expect(() => c.transient({ dt: 1e-6, steps: 1.5 })).toThrow(/steps/);
    expect(() => new Capacitor('C', 'a', 'b', 0)).toThrow(/capacitance/);
  });

  it('a capacitor is an open circuit at DC: a node reached only through it is refused, not invented', () => {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'in', '0', 5));
    c.add(new Capacitor('C1', 'in', 'float', 1e-6));
    c.add(new Capacitor('C2', 'float', '0', 1e-6));
    expect(() => c.solve()).toThrow();
  });
});

describe('time-domain core: ngspice cross-check (nonlinear)', () => {
  let sim: Simulation;
  beforeAll(async () => {
    sim = new Simulation();
    await sim.start();
  }, 120_000);

  it('an RC + LED discharge matches ngspice transient within 2e-4 relative', async () => {
    // Charged from 4 V through R1 (DC), then the source drops to 0 V: C discharges through R1
    // and through R2 + the red LED, whose current dies away below about 1.7 V.
    const C = 100e-6;
    const ckt = new Circuit();
    const vs = ckt.add(new VoltageSource('V1', 'in', '0', 4));
    ckt.add(new Resistor('R1', 'in', 'n', 1000));
    ckt.add(new Capacitor('C1', 'n', '0', C));
    ckt.add(new Resistor('R2', 'n', 'a', 220));
    ckt.add(new Diode('D1', 'a', '0', LED_TLHR5400));
    const dt = 10e-6;
    const steps = 3000; // 30 ms
    const ours = ckt.transient({
      dt,
      steps,
      beforeStep: (k) => {
        if (k !== 1) return false;
        vs.voltageV = 0;
        return true;
      },
    });
    const v0 = ours.nodeVoltages.get('n')![0]!;

    const m = LED_TLHR5400;
    sim.setNetList(
      [
        'rc led discharge',
        'R1 n 0 1000',
        `C1 n 0 ${C} IC=${v0}`,
        'R2 n a 220',
        'D1 a 0 TLHR',
        `.model TLHR D(IS=${m.saturationCurrentA} N=${m.emissionCoefficient} RS=0)`,
        '.options temp=25 tnom=25 reltol=1e-7 abstol=1e-14 vntol=1e-10 method=trap',
        `.tran ${dt / 4} ${dt * steps} 0 ${dt / 4} UIC`,
        '.end',
      ].join('\n'),
    );
    const res = await sim.runSim();
    expect(sim.getError()).toEqual([]);
    const col = (name: string) =>
      res.data.find((d: { name: string }) => d.name.toLowerCase() === name)!;
    const t = col('time').values as number[];
    const vn = col('v(n)').values as number[];
    const at = (time: number) => {
      let k = 1;
      while (k < t.length - 1 && t[k]! < time) k++;
      const f = (time - t[k - 1]!) / (t[k]! - t[k - 1]!);
      return vn[k - 1]! + f * (vn[k]! - vn[k - 1]!);
    };
    const mine = ours.nodeVoltages.get('n')!;
    let worst = 0;
    for (let k = 10; k <= steps; k += 10)
      worst = Math.max(
        worst,
        Math.abs(mine[k]! - at(k * dt)) / Math.max(1e-3, Math.abs(at(k * dt))),
      );
    expect(worst).toBeLessThan(2e-4);
  }, 120_000);
});
