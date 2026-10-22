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
    // Trapezoidal with step-doubling control (measured 0.33 mV): the global error stays below 1 mV.
    expect(worst).toBeLessThan(1e-3);
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

  it('second order pays: backward Euler throughout needs many more solves for the same tolerance', () => {
    const cost = (secondOrder: boolean) => {
      const { b } = rc(5, 1000, 100e-6);
      const { k } = kernelFor(b, { absTolV: 1e-5, relTol: 1e-5, secondOrder });
      const r = k.advanceTo(0.5);
      if (!r.ok) throw new Error(r.code);
      return r.solves;
    };
    const [trap, be] = [cost(true), cost(false)];
    // Local error h³ against h²: at a 10 µV tolerance BE needs several times the steps.
    expect(be).toBeGreaterThan(3 * trap);
    console.log(`kernel RC 0.5 s at 10 µV: trapezoidal ${trap} solves, backward Euler ${be}`);
  });

  it('a capacitor held by the ideal supply: no trapezoidal ringing in the reported currents', () => {
    // C directly across the PSU: once in CV the node voltages never move, so only the currents
    // can show trapezoidal ringing (i_n = −i_{n−1}); they must settle to zero.
    const b = new Bench();
    const c = b.add('component.capacitor');
    const r = b.add('component.resistor');
    b.psu(5, 1).ohms(r, 1000).set(c, 'capacitance', { value: 100e-6, unit: 'farad' });
    b.set(c, 'ratedVoltage', { value: 50, unit: 'volt' });
    b.wire('PSU1.negative', 'GND1.ref').wire('PSU1.positive', `${c}.a`).wire(`${c}.b`, 'GND1.ref');
    b.wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, 'GND1.ref');
    const { k } = kernelFor(b);
    // The 1 A limit charges C first (CC); C takes 1 A − v/1 kΩ, so the supply reaches 5 V and
    // switches to CV at t* = −C·1 kΩ·ln(1 − 5 V / (1 A · 1 kΩ)) = 501.25 µs: an event.
    const tStar = -100e-6 * 1000 * Math.log(1 - 5 / 1000);
    for (const t of [0.001, 0.002, 0.005, 0.01, 0.02]) {
      const res = k.advanceTo(t);
      if (!res.ok) throw new Error(res.code);
      if (t === 0.001) {
        expect(res.events.map((e) => e.parts)).toEqual([['PSU1']]);
        expect(Math.abs(res.events[0]!.time - tStar)).toBeLessThan(1e-7);
        expect(res.outcome.components.PSU1!.mode).toBe('cv');
      }
      expect(Math.abs(res.outcome.components[c]!.current!), `t=${t}`).toBeLessThan(1e-5);
      expect(res.outcome.components.PSU1!.current!).toBeCloseTo(5e-3, 6);
    }
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
    // eventTolS bounds the bracket on the COMPUTED trajectory; the event time's error against
    // the circuit is the trajectory's voltage error over 170 ms (~0.15 mV) divided by the slope
    // at the threshold (0.625 V / 87.5 ms = 7.14 V/s): ~21 µs measured.
    const errAt = Math.abs(res.events[0]!.time - exact);
    expect(errAt).toBeLessThan(5e-5);
    // ... and it follows the trajectory's accuracy: 100× tighter tolerances, a much better time.
    const tight = new Bench();
    {
      const r2 = tight.add('component.resistor');
      const c2 = tight.add('component.capacitor');
      const k2 = tight.add('component.relay');
      tight.psu(5, 2).ohms(r2, 10).set(c2, 'capacitance', { value: 0.01, unit: 'farad' });
      tight.set(c2, 'ratedVoltage', { value: 50, unit: 'volt' });
      tight.wire('PSU1.negative', 'GND1.ref').wire('PSU1.positive', `${r2}.a`);
      tight.wire(`${r2}.b`, `${c2}.a`).wire(`${c2}.b`, 'GND1.ref');
      tight.wire(`${c2}.a`, `${k2}.coil1`).wire(`${k2}.coil2`, 'GND1.ref');
      tight.wire(`${k2}.com`, 'GND1.ref');
    }
    const t2 = kernelFor(tight, {
      absTolV: 1e-7,
      relTol: 1e-7,
      absTolA: 1e-8,
      eventTolS: 1e-9,
    }).k.advanceTo(0.3);
    if (!t2.ok) throw new Error(t2.code);
    expect(Math.abs(t2.events[0]!.time - exact)).toBeLessThan(errAt / 5);
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
    const once = run();
    expect(once).toEqual(run());
  });

  it('breakpoints are step ends exactly; checkpoint/restore is exact; time cannot go back', () => {
    const { b, c } = rc(5, 1000, 100e-6);
    const { s, k } = kernelFor(b);
    k.addBreakpoint(0.0123);
    const r = k.advanceTo(0.02);
    if (!r.ok) throw new Error(r.code);
    expect(r.stepEnds).toContain(0.0123);
    expect(r.stepEnds.at(-1)).toBe(0.02);
    // The same step from the same checkpoint, twice: bit-identical.
    const cp = s.checkpoint();
    const a1 = s.advance(1e-3, 'trapezoidal');
    s.restore(cp);
    const a2 = s.advance(1e-3, 'trapezoidal');
    if (!a1.ok || !a2.ok) throw new Error('solve');
    expect(vAcross(a2, c)).toBe(vAcross(a1, c));
    expect(a2.components[c]!.current).toBe(a1.components[c]!.current);
    expect(k.advanceTo(0.01)).toMatchObject({ ok: false, code: 'transient_time_not_ahead' });
    // The same time again: the state there, no step.
    s.restore(cp);
    expect(k.advanceTo(0.02)).toMatchObject({ ok: true, steps: 0 });
  });

  // GATE NOT MET (2026-10-22): the controller bounds the LOCAL error per step; the global error
  // accumulates over the steps, and at loose tolerances dtMax (not the tolerance) caps the step:
  // 1e-3 and 1e-4 give the same 64 steps and 326 uV; 1e-5 gives 136 uV. Fix (next iteration):
  // error-per-unit-step control or a global-error estimate. `it.fails` turns red once it passes.
  it.fails('gate K3: tightening the tolerances x100 reduces the error at least x10', () => {
    const worst = (tol: number) => {
      const { b, c } = rc(5, 1000, 100e-6);
      const { k } = kernelFor(b, { absTolV: tol, relTol: tol });
      let w = 0;
      for (let i = 1; i <= 50; i++) {
        const t = i * 0.01;
        const r = k.advanceTo(t);
        if (!r.ok) throw new Error(r.code);
        w = Math.max(w, Math.abs(vAcross(r.outcome, c) - 5 * (1 - Math.exp(-t / 0.1))));
      }
      return w;
    };
    const [loose, tight] = [worst(1e-3), worst(1e-5)];
    expect(tight).toBeLessThan(loose / 10);
    expect(tight).toBeLessThan(20e-6); // gate K1 at 1e-5
  });

  it('gate K4: charge conservation — the integral of the capacitor current equals C times its voltage change', () => {
    const { b, c } = rc(5, 1000, 100e-6);
    const { k } = kernelFor(b, { absTolV: 1e-5, relTol: 1e-5 });
    // Trapezoidal integration of I_C over the kernel's own accepted steps.
    let q = 0;
    let tPrev = 0;
    let iPrev = 5 / 1000; // at t = 0+, the full current flows into the empty capacitor
    let v = 0;
    for (let i = 1; i <= 200; i++) {
      const t = i * 0.0025;
      const r = k.advanceTo(t);
      if (!r.ok) throw new Error(r.code);
      const iNow = r.outcome.components[c]!.current!;
      q += ((iPrev + iNow) / 2) * (t - tPrev);
      tPrev = t;
      iPrev = iNow;
      v = vAcross(r.outcome, c);
    }
    expect(Math.abs(q - 100e-6 * v) / (100e-6 * v)).toBeLessThan(1e-3);
  });

  it('gate K7: one window or many windows reach the same state within the tolerances', () => {
    const one = rc(5, 1000, 100e-6);
    const k1 = kernelFor(one.b).k;
    const r1 = k1.advanceTo(0.3);
    const many = rc(5, 1000, 100e-6);
    const kn = kernelFor(many.b).k;
    let rn = kn.advanceTo(0.01);
    for (let i = 2; i <= 30; i++) rn = kn.advanceTo(i * 0.01);
    if (!r1.ok || !rn.ok) throw new Error('kernel');
    const exact = 5 * (1 - Math.exp(-3));
    expect(Math.abs(vAcross(r1.outcome, one.c) - exact)).toBeLessThan(1e-3);
    expect(Math.abs(vAcross(rn.outcome, many.c) - exact)).toBeLessThan(1e-3);
  });

  it('gate P1/P2: RC over 5 tau within 300 solves and 200 ms; never more than budget + one trial per window', () => {
    const { b } = rc(5, 1000, 100e-6);
    const { k } = kernelFor(b);
    const t0 = performance.now();
    const r = k.advanceTo(0.5);
    const ms = performance.now() - t0;
    if (!r.ok) throw new Error(r.code);
    expect(r.solves).toBeLessThanOrEqual(300);
    expect(ms).toBeLessThan(200);
    // A window with a budget of 200 solves: refused, but after at most budget + one trial
    // (3 solves) + one bisection (log2(dtMax / eventTolS) + 1 = 21 solves).
    const tight = rc(5, 1000, 100e-6);
    const kt = kernelFor(tight.b, {
      budgetSolvesPerSimS: 400,
      minBudgetSolves: 0,
      absTolV: 1e-7,
      relTol: 1e-7,
    }).k;
    const res = kt.advanceTo(0.5);
    expect(res).toMatchObject({ ok: false, code: 'transient_budget_exceeded' });
    expect(kt.solves).toBeLessThanOrEqual(200 + 3 + 21);
  });

  it('bounded and honest: an impossible budget or step floor is refused by name; logic is refused', () => {
    const { b } = rc(5, 1000, 100e-6);
    expect(
      kernelFor(b, { budgetSolvesPerSimS: 10, minBudgetSolves: 0 }).k.advanceTo(0.1),
    ).toMatchObject({
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
