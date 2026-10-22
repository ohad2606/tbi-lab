/**
 * Sprint 19B, Milestone T: the time-kernel PROTOTYPE (kernel/transient.ts) against closed-form
 * solutions. Isolated: no product path uses it. Every expected value is analytic.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, type SolveSuccess } from '../src/index.js';
import { TransientKernel } from '../src/kernel/transient.js';
import { Bench } from './build.js';
import { SRD_05VDC_SL_C } from '../src/parts/relay.js';

function rc(volts: number, ohms: number, farads: number) {
  const b = new Bench();
  const r = b.add('component.resistor');
  const c = b.add('component.capacitor');
  b.psu(volts, 1).ohms(r, ohms).set(c, 'capacitance', { value: farads, unit: 'farad' });
  b.set(c, 'ratedVoltage', { value: 50, unit: 'volt' });
  b.wire('PSU1.negative', 'GND1.ref').wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${c}.a`);
  b.wire(`${c}.b`, 'GND1.ref');
  return { b, r, c };
}
const kernelFor = (b: Bench, opts = {}) => {
  const snap = b.snapshot();
  const s = new EngineSession(snap);
  return {
    s,
    k: new TransientKernel(
      s,
      opts,
      snap.components.map((c) => c.type),
    ),
  };
};
const vAcross = (o: SolveSuccess, id: string) => {
  const t = o.components[id]!.terminals;
  return t.a! - t.b!;
};

describe('time kernel prototype (EF-1)', () => {
  it('RC charge against V(1 − e^{−t/RC}) within the error tolerance at every sample; measured cost', () => {
    const { b, c } = rc(5, 1000, 100e-6); // τ = 0.1 s
    const { k } = kernelFor(b, { absTolV: 1e-4, relTol: 1e-4 });
    const tau = 0.1;
    let worst = 0;
    const t0 = performance.now();
    for (let i = 1; i <= 50; i++) {
      const t = i * 0.01;
      const r = k.advanceTo(t);
      if (!r.ok) throw new Error(r.code);
      expect(r.time).toBe(t); // lands exactly on the requested time
      const exact = 5 * (1 - Math.exp(-t / tau));
      worst = Math.max(worst, Math.abs(vAcross(r.outcome, c) - exact));
    }
    const wallMs = performance.now() - t0;
    // Backward Euler with step-doubling control: the global error stays in the mV range.
    expect(worst).toBeLessThan(5e-3);
    // Bounded: far below the budget (200 000 solves / simulated s); recorded as a measurement.
    expect(k.solves).toBeLessThan(200_000 * 0.5);
    console.log(
      `kernel RC 0.5 s: steps ${k.steps}, solves ${k.solves}, rejected ${k.rejected}, worst ${(worst * 1e3).toFixed(3)} mV, ${wallMs.toFixed(0)} ms wall`,
    );
  });

  it('two-stage RC ladder against its closed form (two time constants)', () => {
    // V → R1 → C1 → R2 → C2 → GND, R1 = R2 = 1 kΩ, C1 = C2 = 100 µF.
    const b = new Bench();
    const [r1, r2] = [b.add('component.resistor'), b.add('component.resistor')];
    const [c1, c2] = [b.add('component.capacitor'), b.add('component.capacitor')];
    b.psu(5, 1).ohms(r1, 1000).ohms(r2, 1000);
    for (const c of [c1, c2])
      b.set(c, 'capacitance', { value: 100e-6, unit: 'farad' }).set(c, 'ratedVoltage', {
        value: 50,
        unit: 'volt',
      });
    b.wire('PSU1.negative', 'GND1.ref').wire('PSU1.positive', `${r1}.a`).wire(`${r1}.b`, `${c1}.a`);
    b.wire(`${c1}.b`, 'GND1.ref')
      .wire(`${c1}.a`, `${r2}.a`)
      .wire(`${r2}.b`, `${c2}.a`)
      .wire(`${c2}.b`, 'GND1.ref');
    const { k } = kernelFor(b, { absTolV: 1e-4, relTol: 1e-4 });
    // State-space: d/dt[v1, v2] = A[v1, v2] + B·V with RC = 0.1 s:
    //   A = (1/RC)[[-2, 1], [1, -1]]; eigenvalues λ = (−3 ± √5)/(2RC).
    const RC = 0.1;
    const l1 = (-3 + Math.sqrt(5)) / (2 * RC);
    const l2 = (-3 - Math.sqrt(5)) / (2 * RC);
    // v2(t) = V[1 + (l2 e^{l1 t} − l1 e^{l2 t})/(l1 − l2)] (both start at 0, v2'(0) = 0).
    const v2 = (t: number) => 5 * (1 + (l2 * Math.exp(l1 * t) - l1 * Math.exp(l2 * t)) / (l1 - l2));
    let worst = 0;
    for (const t of [0.05, 0.1, 0.2, 0.4, 0.8]) {
      const r = k.advanceTo(t);
      if (!r.ok) throw new Error(r.code);
      worst = Math.max(worst, Math.abs(vAcross(r.outcome, c2) - v2(t)));
    }
    expect(worst).toBeLessThan(5e-3);
  });

  it('event localization: a relay coil charged through RC pulls in at τ·ln 7, within the tolerance', () => {
    // 5 V → 10 Ω → node X; 10 mF from X to GND; relay coil (70 Ω) from X to GND.
    // Thevenin: V_th = 5·70/80 = 4.375 V, R_th = 10∥70 = 8.75 Ω, τ = 87.5 ms.
    // Pull-in at 3.75 V: t* = −τ ln(1 − 3.75/4.375) = τ ln 7.
    const b = new Bench();
    const r = b.add('component.resistor');
    const c = b.add('component.capacitor');
    const kk = b.add('component.relay');
    b.psu(5, 2).ohms(r, 10).set(c, 'capacitance', { value: 0.01, unit: 'farad' });
    b.set(c, 'ratedVoltage', { value: 50, unit: 'volt' });
    b.wire('PSU1.negative', 'GND1.ref').wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${c}.a`);
    b.wire(`${c}.b`, 'GND1.ref').wire(`${c}.a`, `${kk}.coil1`).wire(`${kk}.coil2`, 'GND1.ref');
    b.wire(`${kk}.com`, 'GND1.ref');
    const { k } = kernelFor(b, { absTolV: 1e-5, relTol: 1e-5, eventTolS: 1e-7 });
    const tau = 0.01 * ((10 * 70) / (10 + 70));
    const exact = tau * Math.log(7);
    expect(SRD_05VDC_SL_C.pullInV).toBe(3.75);
    const res = k.advanceTo(0.3);
    if (!res.ok) throw new Error(res.code);
    expect(res.events.map((e) => e.parts)).toEqual([[kk]]);
    // The event time: backward Euler's own (small) trajectory error plus the bisection tolerance.
    expect(Math.abs(res.events[0]!.time - exact)).toBeLessThan(2e-4);
    expect(res.outcome.components[kk]!.state).toMatchObject({ energized: true });
    console.log(
      `kernel relay pull-in: ${(res.events[0]!.time * 1e3).toFixed(4)} ms vs exact ${(exact * 1e3).toFixed(4)} ms`,
    );
  });

  it('deterministic: the same circuit and requests give bit-identical steps and values', () => {
    const run = () => {
      const { b, c } = rc(5, 1000, 100e-6);
      const { k } = kernelFor(b);
      k.addBreakpoint(0.0123);
      const vs: number[] = [];
      for (const t of [0.01, 0.02, 0.05, 0.1]) {
        const r = k.advanceTo(t);
        if (!r.ok) throw new Error(r.code);
        vs.push(vAcross(r.outcome, c));
      }
      return { vs, steps: k.steps, solves: k.solves };
    };
    expect(run()).toEqual(run());
  });

  it('bounded and honest: an impossible budget or step floor is refused by name; logic is refused', () => {
    const { b } = rc(5, 1000, 100e-6);
    expect(kernelFor(b, { budgetSolvesPerSimS: 10 }).k.advanceTo(0.1)).toMatchObject({
      ok: false,
      code: 'transient_budget_exceeded',
    });
    // A tolerance no step can meet at a floor of 1 ms: refused, never accepted with a larger error.
    expect(
      kernelFor(b, { absTolV: 1e-12, relTol: 0, dtMin: 1e-3, dtInitial: 1e-2 }).k.advanceTo(0.1),
    ).toMatchObject({ ok: false, code: 'transient_step_floor' });
    const g = new Bench();
    g.add('logic.gate_not');
    const s = new EngineSession(g.snapshot());
    expect(new TransientKernel(s, {}, ['logic.gate_not']).advanceTo(0.01)).toMatchObject({
      ok: false,
      code: 'transient_logic_unsupported',
    });
  });
});
