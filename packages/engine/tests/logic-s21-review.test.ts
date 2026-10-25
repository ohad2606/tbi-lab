/**
 * Sprint 21 independent review of the logic guarantee bounds: the reviewer's probes
 * (scratchpad probe/ogap.ts, psu3.ts, psu4.ts, padin.ts, pull.ts) as regression tests.
 * Figures: SN74LVC1G08 SCES217AA §5.3 / §5.5 (−40 to 85 °C); ESP32 Series Datasheet v5.3
 * Table 5-3 (3.3 V, 25 °C): V_IH ≥ 0.75 × VDD, V_OH ≥ 0.8 × VDD with NO load current stated,
 * R_PU / R_PD typical 45 kΩ only.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, type RuntimePinMode, type SolveOutcome } from '../src/index.js';
import {
  evaluateBounds,
  type BoundsSolver,
  type Check,
  type CornerSpec,
  type Perturbation,
} from '../src/logic/bounds.js';
import { Bench, boardBench } from './build.js';

const solve = (b: Bench) => new EngineSession(b.snapshot()).solve();
const err = (o: SolveOutcome) => (o.ok ? null : o.error);

describe('review item 1 (BLOCKING): a downstream level against the upstream output band', () => {
  /** U1 (A, B HIGH) Y → 300 Ω to GND and 1708 Ω + Rb divider into U2.A (U2.B HIGH), 3.0 V. */
  const probe = (rb: number) => {
    const b = new Bench();
    const g1 = b.add('logic.gate_and');
    const g2 = b.add('logic.gate_and');
    const R = [
      b.add('component.resistor'),
      b.add('component.resistor'),
      b.add('component.resistor'),
    ];
    b.psu(3.0, 0.5).wire('PSU1.negative', 'GND1.ref');
    for (const g of [g1, g2])
      b.wire('PSU1.positive', `${g}.vcc`)
        .wire(`${g}.gnd`, 'GND1.ref')
        .wire(`${g}.b`, 'PSU1.positive');
    b.wire(`${g1}.a`, 'PSU1.positive');
    b.ohms(R[0]!, 300).wire(`${g1}.y`, `${R[0]}.a`).wire(`${R[0]}.b`, 'GND1.ref');
    b.ohms(R[1]!, 1708).wire(`${g1}.y`, `${R[1]}.a`).wire(`${R[1]}.b`, `${g2}.a`);
    b.ohms(R[2]!, rb).wire(`${g2}.a`, `${R[2]}.a`).wire(`${R[2]}.b`, 'GND1.ref');
    return { b, g2 };
  };
  /** True worst case: Y at its guaranteed 2.4 V (10 mA < 16 mA point), 5 µA out of the node. */
  const trueWorst = (rb: number) => (2.4 * rb) / (1708 + rb) - 5e-6 * ((1708 * rb) / (1708 + rb));

  for (const rb of [8000, 8290, 8400, 8500])
    it(`Rb ${rb} Ω: worst ${trueWorst(rb).toFixed(4)} V < V_IH 2.0 V → refused, worst reported exactly`, () => {
      const { b, g2 } = probe(rb);
      const e = err(solve(b));
      expect(e).toMatchObject({
        code: 'logic_input_not_guaranteed',
        components: [g2],
        param: 'a',
        detail: { level: 'high', vih: 2, causes: expect.arrayContaining(['output_guarantee']) },
      });
      expect((e!.detail as { worst: number }).worst).toBeCloseTo(trueWorst(rb), 6);
    });

  it('Rb 9500 Ω: worst 2.027 V ≥ 2.0 V → runs (the bound is not over-pessimistic)', () => {
    expect(trueWorst(9500)).toBeGreaterThan(2.0);
    const o = solve(probe(9500).b);
    expect(err(o)).toBeNull();
  });
});

describe('review item 2: a 1 mA supply limit (probes psu3/psu4)', () => {
  /** 1G08 with both inputs at GND (Y LOW), Y pulled up to PSU+ through R; PSU limit `lim`. */
  const probe = (vcc: number, lim: number, r: number) => {
    const b = new Bench();
    const g = b.add('logic.gate_and');
    const res = b.add('component.resistor');
    b.psu(vcc, lim).wire('PSU1.negative', 'GND1.ref');
    b.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
    b.wire(`${g}.a`, 'GND1.ref').wire(`${g}.b`, 'GND1.ref');
    b.ohms(res, r).wire(`${g}.y`, `${res}.a`).wire(`${res}.b`, 'PSU1.positive');
    return b;
  };

  for (const vcc of [3.0, 3.3])
    for (const r of [3400, 10_000])
      it(`${vcc} V, 1 mA limit, ${r} Ω pull-up: runs (the corners are solved and verified)`, () => {
        expect(err(solve(probe(vcc, 0.001, r)))).toBeNull();
      });

  it('a 1 mA limit just above the nominal current: within the I_CC bound the supply can reach it → refused by name with the worst current (not "unsolved")', () => {
    // 3.3 V / 3.2 kΩ: the LOW output sinks ≈ 994.7 µA; I_CC + 2 × I_I adds up to 20 µA.
    const e = err(solve(probe(3.3, 0.001, 3200)));
    expect(e).toMatchObject({
      code: 'logic_supply_not_guaranteed',
      components: ['PSU1'],
      param: 'limit',
      detail: { limit: 0.001, causes: expect.arrayContaining(['supply_current']) },
    });
    // The exact corner puts the supply into current limit: the worst current IS the limit.
    expect((e!.detail as { worst: number }).worst).toBeGreaterThanOrEqual(0.001 - 1e-12);
  });
});

describe('review item 3: an ESP32 input reading a gate output (probe padin)', () => {
  const probe = (r: number) => {
    let G = '';
    const bb = boardBench((b, u) => {
      G = b.add('logic.gate_and');
      const res = b.add('component.resistor');
      b.psu(3.0, 0.5)
        .ohms(res, r)
        .wire('PSU1.positive', `${G}.vcc`)
        .wire(`${G}.gnd`, 'GND1.ref')
        .wire(`${G}.a`, 'PSU1.positive')
        .wire(`${G}.b`, 'PSU1.positive')
        .wire(`${G}.y`, `${u}.gpio4`)
        .wire(`${G}.y`, `${res}.a`)
        .wire(`${res}.b`, 'GND1.ref');
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'input');
    return { s, G };
  };
  for (const r of [1000, 2700])
    it(`Y into ${r} Ω and GPIO4: only V_OH ≥ 2.4 V guaranteed (16 mA point) < V_IH 2.475 V → refused`, () => {
      expect(err(probe(r).s.solve())).toMatchObject({
        code: 'logic_mcu_input_not_guaranteed',
        param: 'gpio4',
        detail: {
          gpio: 4,
          level: 'high',
          worst: expect.closeTo(2.4, 9),
          vih: expect.closeTo(2.475, 12),
        },
      });
    });
  it('Y into 100 kΩ (30 µA): V_OH ≥ V_CC − 0.1 = 2.9 V ≥ 2.475 V → runs', () => {
    expect(err(probe(100_000).s.solve())).toBeNull();
  });
});

describe('review item 4: ESP32 internal pulls are typical only (probe pull)', () => {
  const probe = (mode: RuntimePinMode | 'input-pullup' | 'input-pulldown') => {
    let G = '';
    const bb = boardBench((b, u) => {
      G = b.add('logic.gate_and');
      b.psu(3.3, 0.5)
        .wire('PSU1.positive', `${G}.vcc`)
        .wire(`${G}.gnd`, 'GND1.ref')
        .wire(`${G}.b`, 'PSU1.positive')
        .wire(`${G}.a`, `${u}.gpio4`);
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, mode as RuntimePinMode);
    return s.solve();
  };
  for (const mode of ['input-pullup', 'input-pulldown'] as const)
    it(`${mode}: refused, the 45 kΩ is typical only`, () => {
      expect(err(probe(mode))).toMatchObject({
        code: 'logic_mcu_pull_uncharacterized',
        param: 'gpio4',
        detail: { gpio: 4, mode, role: 'holds' },
      });
    });
  it('plain input: floating, as before', () => {
    expect(err(probe('input'))).toMatchObject({ code: 'logic_input_floating', param: 'a' });
  });
});

describe('review item 5: the ESP32 V_OH has no stated load current', () => {
  it('GPIO18 HIGH straight into a gate input (leakage only): runs; with a 10 kΩ pull-down (≈ 330 µA): refused', () => {
    const build = (pd: boolean) => {
      let G = '';
      const bb = boardBench((b, u) => {
        G = b.add('logic.gate_and');
        b.psu(3.3, 0.5)
          .wire('PSU1.positive', `${G}.vcc`)
          .wire(`${G}.gnd`, 'GND1.ref')
          .wire(`${G}.b`, 'PSU1.positive')
          .wire(`${u}.gpio18`, `${G}.a`);
        if (pd) {
          const r = b.add('component.resistor');
          b.ohms(r, 10_000).wire(`${G}.a`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
        }
      });
      const s = new EngineSession(bb.projected, { pins: bb.pins });
      s.setPinMode(18, 'output-high');
      return s.solve();
    };
    expect(err(build(false))).toBeNull();
    expect(err(build(true))).toMatchObject({
      code: 'logic_mcu_output_uncharacterized',
      param: 'gpio18',
      detail: { gpio: 18, level: 'high' },
    });
  });
});

describe('review item 7: the output bracket follows the corner current', () => {
  /**
   * U1 at 3.0 V: Y → RL to GND and a 1 kΩ / 6 kΩ divider into U2.A. RL is chosen so that with Y at
   * exactly its 16 mA guarantee (2.4 V) the load draws 15.998 mA: within the 16 mA point at x0.
   * At the corner U2.A's leakage (5 µA, drawn through the divider) takes Y past 16 mA, where only
   * the 24 mA point's 2.3 V is guaranteed: U2.A then sees 2.3·6/7 − 5 µA·857 Ω ≈ 1.967 V < 2.0 V.
   * With the bracket frozen at the x0 current it would have seen 2.4·6/7 ≈ 2.053 V (≥ 2.0 V).
   */
  const build = (rl: number) => {
    const b = new Bench();
    const g1 = b.add('logic.gate_and');
    const g2 = b.add('logic.gate_and');
    const [r0, ra, rb] = [
      b.add('component.resistor'),
      b.add('component.resistor'),
      b.add('component.resistor'),
    ];
    b.psu(3.0, 0.5).wire('PSU1.negative', 'GND1.ref');
    for (const g of [g1, g2])
      b.wire('PSU1.positive', `${g}.vcc`)
        .wire(`${g}.gnd`, 'GND1.ref')
        .wire(`${g}.b`, 'PSU1.positive');
    b.wire(`${g1}.a`, 'PSU1.positive');
    b.ohms(r0, rl).wire(`${g1}.y`, `${r0}.a`).wire(`${r0}.b`, 'GND1.ref');
    b.ohms(ra, 1000).wire(`${g1}.y`, `${ra}.a`).wire(`${ra}.b`, `${g2}.a`);
    b.ohms(rb, 6000).wire(`${g2}.a`, `${rb}.a`).wire(`${rb}.b`, 'GND1.ref');
    return { b, g2 };
  };
  it('15.998 mA at 2.4 V: the corner crosses 16 mA → the 24 mA bound (2.3 V) applies → refused', () => {
    const { b, g2 } = build(2.4 / (15.998e-3 - 2.4 / 7000));
    const e = err(solve(b));
    expect(e).toMatchObject({ code: 'logic_input_not_guaranteed', components: [g2], param: 'a' });
    expect((e!.detail as { worst: number }).worst).toBeCloseTo(
      (2.3 * 6) / 7 - 5e-6 * ((1000 * 6000) / 7000),
      4,
    );
  });
  it('a lighter load (12 mA at 2.4 V) stays on the 16 mA point: 2.4·6/7 ≥ 2.0 V → runs', () => {
    expect(err(solve(build(2.4 / (12e-3 - 2.4 / 7000)).b))).toBeNull();
  });
});

describe('review item 8: the corner is re-linearised (a mock network)', () => {
  /** One margin m(x) = x[0]; two bounded currents; the corner solver is scripted. */
  const setup = (cornerSens: (spec: CornerSpec) => number[][]) => {
    const perts: Perturbation[] = [0, 1].map((k) => ({
      id: `ii:U${k}:a`,
      kind: 'ii',
      from: `n${k}`,
      to: '0',
      range: [-1e-6, 1e-6],
    }));
    const check: Check = {
      id: 'input:U1:a',
      kind: 'input',
      unit: 'V',
      component: 'U1',
      pin: 'a',
      margin: (x) => x[0]!,
      value: (x) => x[0]!,
      detail: {},
    };
    const specs: CornerSpec[] = [];
    const solver: BoundsSolver = {
      // A margin of 5 µV: close enough to its limit that the corner is solved exactly.
      x0: [5e-6],
      nodeIndex: new Map(),
      // At x0 only perturbation 0 moves the margin (-1 V/A); perturbation 1 is idle.
      sensitivity: () => [[-1], [0]],
      corner: (spec) => {
        specs.push(spec);
        const amps = spec.sinks.reduce((s, k) => s + k.amps, 0);
        return {
          x: [5e-6 - amps],
          sensitivity: () => cornerSens(spec),
          stageCurrent: () => 0,
          release: () => {},
        };
      },
    };
    return { perts, check, solver, specs };
  };

  it('a perturbation idle at x0 that is active at the corner is added and the corner re-solved', () => {
    const { perts, check, solver, specs } = setup(() => [[-1], [-1]]);
    expect(evaluateBounds(solver, perts, [check], () => [])).toBeNull();
    expect(specs.length).toBe(2);
    expect(specs[1]!.sinks.map((k) => k.from).sort()).toEqual(['n0', 'n1']);
  });

  it('a chosen side that is no longer adverse at the corner, oscillating: refused (not established)', () => {
    let flip = -1;
    const { perts, check, solver } = setup(() => {
      flip = -flip;
      return [[flip], [0]];
    });
    expect(evaluateBounds(solver, perts, [check], () => [])).toMatchObject({
      code: 'logic_bound_not_established',
      detail: { reason: 'not_monotone' },
    });
  });

  it('a singular linearisation at x0 is refused, never skipped (item 12)', () => {
    const { perts, check, solver } = setup(() => [[-1], [0]]);
    expect(
      evaluateBounds({ ...solver, sensitivity: () => null }, perts, [check], () => []),
    ).toMatchObject({ code: 'logic_bound_not_established', detail: { reason: 'singular' } });
  });

  it('a corner that cannot be solved and verified is refused by its own code (item 2)', () => {
    const { perts, check, solver } = setup(() => [[-1], [0]]);
    expect(
      evaluateBounds({ ...solver, corner: () => null }, perts, [check], () => []),
    ).toMatchObject({ code: 'logic_bound_not_established', detail: { reason: 'corner_unsolved' } });
  });
});

describe('final review B1: the LOW side of a gate output band (mirrors of items 1, 3, 7)', () => {
  /** U1 Y LOW (A at GND); Y → Ra → U2.A; U2.A → Rb → V_CC (pull-up); 3.0 V. */
  const ogapLow = (ra: number, rb: number) => {
    const b = new Bench();
    const g1 = b.add('logic.gate_and');
    const g2 = b.add('logic.gate_and');
    const [r1, r2] = [b.add('component.resistor'), b.add('component.resistor')];
    b.psu(3.0, 0.5).wire('PSU1.negative', 'GND1.ref');
    for (const g of [g1, g2])
      b.wire('PSU1.positive', `${g}.vcc`)
        .wire(`${g}.gnd`, 'GND1.ref')
        .wire(`${g}.b`, 'PSU1.positive');
    b.wire(`${g1}.a`, 'GND1.ref');
    b.ohms(r1, ra).wire(`${g1}.y`, `${r1}.a`).wire(`${r1}.b`, `${g2}.a`);
    b.ohms(r2, rb).wire(`${g2}.a`, `${r2}.a`).wire(`${r2}.b`, 'PSU1.positive');
    return { b, g2 };
  };
  /** True worst: Y at V_OL max 0.4 V (the 16 mA point at 3.0 V), 5 µA into the node. */
  const worstLow = (ra: number, rb: number) =>
    0.4 + (2.6 * ra) / (ra + rb) + 5e-6 * ((ra * rb) / (ra + rb));

  for (const [ra, rb] of [
    [2000, 8000],
    [2000, 9000],
  ] as const)
    it(`probe ogaplow ${ra}/${rb}: worst ${worstLow(ra, rb).toFixed(3)} V > V_IL 0.8 V → refused, worst exact`, () => {
      const { b, g2 } = ogapLow(ra, rb);
      const e = err(solve(b));
      expect(e).toMatchObject({
        code: 'logic_input_not_guaranteed',
        components: [g2],
        param: 'a',
        detail: { level: 'low', vil: 0.8, causes: expect.arrayContaining(['output_guarantee']) },
      });
      expect((e!.detail as { worst: number }).worst).toBeCloseTo(worstLow(ra, rb), 6);
    });
  it('probe ogaplow 1000/9000: worst 0.664 V ≤ 0.8 V → runs', () => {
    expect(worstLow(1000, 9000)).toBeLessThan(0.8);
    expect(err(solve(ogapLow(1000, 9000).b))).toBeNull();
  });

  /** U1 Y LOW → Ra → GPIO4; GPIO4 → Rb → V_CC (probe padinlow). */
  const padLow = (ra: number, rb: number) => {
    const bb = boardBench((b, u) => {
      const G = b.add('logic.gate_and');
      const [r1, r2] = [b.add('component.resistor'), b.add('component.resistor')];
      b.psu(3.0, 0.5)
        .ohms(r1, ra)
        .ohms(r2, rb)
        .wire('PSU1.positive', `${G}.vcc`)
        .wire(`${G}.gnd`, 'GND1.ref')
        .wire(`${G}.a`, 'GND1.ref')
        .wire(`${G}.b`, 'PSU1.positive')
        .wire(`${G}.y`, `${r1}.a`)
        .wire(`${r1}.b`, `${u}.gpio4`)
        .wire(`${u}.gpio4`, `${r2}.a`)
        .wire(`${r2}.b`, 'PSU1.positive');
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'input');
    return s.solve();
  };
  for (const [ra, rb] of [
    [2000, 8000],
    [2400, 7600],
  ] as const)
    it(`probe padinlow ${ra}/${rb}: GPIO4 can be at ${(0.4 + (2.6 * ra) / (ra + rb)).toFixed(3)} V > ESP32 V_IL 0.825 V → refused`, () => {
      const e = err(padLow(ra, rb));
      expect(e).toMatchObject({
        code: 'logic_mcu_input_not_guaranteed',
        param: 'gpio4',
        detail: { gpio: 4, level: 'low', vil: expect.closeTo(0.825, 12) },
      });
      expect((e!.detail as { worst: number }).worst).toBeCloseTo(0.4 + (2.6 * ra) / (ra + rb), 3);
    });
  it('probe padinlow 1000/9000: 0.66 V ≤ 0.825 V → runs', () => {
    expect(err(padLow(1000, 9000))).toBeNull();
  });

  /** Item 7 mirror: Y LOW sinks RL (to V_CC) + a 1 k / 6 k divider to U2.A (pull-up). */
  const bracketLow = (rl: number) => {
    const b = new Bench();
    const g1 = b.add('logic.gate_and');
    const g2 = b.add('logic.gate_and');
    const [r0, ra, rb] = [
      b.add('component.resistor'),
      b.add('component.resistor'),
      b.add('component.resistor'),
    ];
    b.psu(3.0, 0.5).wire('PSU1.negative', 'GND1.ref');
    for (const g of [g1, g2])
      b.wire('PSU1.positive', `${g}.vcc`)
        .wire(`${g}.gnd`, 'GND1.ref')
        .wire(`${g}.b`, 'PSU1.positive');
    b.wire(`${g1}.a`, 'GND1.ref');
    b.ohms(r0, rl).wire('PSU1.positive', `${r0}.a`).wire(`${r0}.b`, `${g1}.y`);
    b.ohms(ra, 1000).wire(`${g1}.y`, `${ra}.a`).wire(`${ra}.b`, `${g2}.a`);
    b.ohms(rb, 6000).wire(`${g2}.a`, `${rb}.a`).wire(`${rb}.b`, 'PSU1.positive');
    return { b, g2 };
  };
  it('15.998 mA sunk at 0.4 V: the corner crosses 16 mA → V_OL ≤ 0.55 V (24 mA point) applies → refused', () => {
    const { b, g2 } = bracketLow(2.6 / (15.998e-3 - 2.6 / 7000));
    const e = err(solve(b));
    expect(e).toMatchObject({ code: 'logic_input_not_guaranteed', components: [g2], param: 'a' });
    expect((e!.detail as { worst: number }).worst).toBeCloseTo(
      0.55 + 2.45 / 7 + 5e-6 * ((1000 * 6000) / 7000),
      4,
    );
  });
  it('12 mA sunk at 0.4 V stays on the 16 mA point: 0.4 + 2.6/7 + 4 mV ≤ 0.8 V → runs', () => {
    expect(err(solve(bracketLow(2.6 / (12e-3 - 2.6 / 7000)).b))).toBeNull();
  });
});

describe('final review S1: an ESP32 input that READS a gate output with its internal pull on (probe pullgate)', () => {
  for (const mode of ['input-pullup', 'input-pulldown'] as const)
    it(`${mode}: refused with role "reads" (remedy: turn the pull off)`, () => {
      const bb = boardBench((b, u) => {
        const G = b.add('logic.gate_and');
        const r = b.add('component.resistor');
        b.psu(3.0, 0.5)
          .ohms(r, 100_000)
          .wire('PSU1.positive', `${G}.vcc`)
          .wire(`${G}.gnd`, 'GND1.ref')
          .wire(`${G}.a`, 'PSU1.positive')
          .wire(`${G}.b`, 'PSU1.positive')
          .wire(`${G}.y`, `${u}.gpio4`)
          .wire(`${G}.y`, `${r}.a`)
          .wire(`${r}.b`, 'GND1.ref');
      });
      const s = new EngineSession(bb.projected, { pins: bb.pins });
      s.setPinMode(4, mode as RuntimePinMode);
      expect(err(s.solve())).toMatchObject({
        code: 'logic_mcu_pull_uncharacterized',
        param: 'gpio4',
        detail: { gpio: 4, mode, role: 'reads' },
      });
    });
});

describe('final review B1 follow-up (revised in Sprint 22): drivers tied onto an output', () => {
  const tie = (gateLevel: 'low' | 'high', pad: 'output-low' | 'output-high' | 'input') => {
    let G = '';
    const bb = boardBench((b, u) => {
      G = b.add('logic.gate_and');
      b.psu(3.0, 0.5)
        .wire('PSU1.positive', `${G}.vcc`)
        .wire(`${G}.gnd`, 'GND1.ref')
        .wire(`${G}.a`, gateLevel === 'high' ? 'PSU1.positive' : 'GND1.ref')
        .wire(`${G}.b`, 'PSU1.positive')
        .wire(`${G}.y`, `${u}.gpio4`);
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, pad);
    return { o: s.solve(), G };
  };
  it('GPIO4 driven LOW onto the gate output that is LOW: no current would have to flow backwards once the stage drops nothing at zero current — runs (Sprint 22: the reverse was an artifact of holding the stage at its bound)', () => {
    expect(err(tie('low', 'output-low').o)).toBeNull();
  });
  it('GPIO4 driven HIGH onto the gate output that is LOW (opposite states): far beyond the guaranteed current → refused naming the gate output', () => {
    const { o, G } = tie('low', 'output-high');
    expect(err(o)).toMatchObject({ code: 'logic_output_uncharacterized', components: [G] });
  });
  it('GPIO4 as an input on the LOW output: runs', () => {
    expect(err(tie('low', 'input').o)).toBeNull();
  });
});

describe('verification of ab8cbca (probes vprobe/undef, esp, outcur)', () => {
  /** A gate powered from PSU1: HIGH (A, B at V_CC), LOW (A at GND). */
  const gate = (b: Bench, kind: 'high' | 'low') => {
    const g = b.add('logic.gate_and');
    b.wire('PSU1.positive', `${g}.vcc`)
      .wire(`${g}.gnd`, 'GND1.ref')
      .wire(`${g}.b`, 'PSU1.positive');
    b.wire(`${g}.a`, kind === 'high' ? 'PSU1.positive' : 'GND1.ref');
    return g;
  };
  const res = (b: Bench, ohm: number, p: string, q: string) => {
    const r = b.add('component.resistor');
    b.ohms(r, ohm).wire(p, `${r}.a`).wire(`${r}.b`, q);
  };
  const esp = (vcc: number, build: (b: Bench, u: string) => void) => {
    const bb = boardBench((b, u) => {
      b.psu(vcc, 0.5);
      build(b, u);
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'input');
    return s.solve();
  };

  describe('B1: an ESP32 input at a nominally UNDEFINED level is refused (never skipped)', () => {
    for (const [r1, r2] of [
      [1000, 1000],
      [200, 800],
      [10_000, 10_000],
    ] as const)
      it(`gate HIGH → ${r1} Ω → GPIO4 → ${r2} Ω → GND: between V_IL and V_IH → refused`, () => {
        const e = err(
          esp(3.0, (b, u) => {
            const A = gate(b, 'high');
            res(b, r1, `${A}.y`, `${u}.gpio4`);
            res(b, r2, `${u}.gpio4`, 'GND1.ref');
          }),
        );
        expect(e).toMatchObject({
          code: 'logic_mcu_input_not_guaranteed',
          param: 'gpio4',
          detail: { gpio: 4, level: 'undefined' },
        });
      });
    it('monotone now: 1000/9000 and the worse 200/800 are both refused', () => {
      for (const [r1, r2] of [
        [1000, 9000],
        [200, 800],
      ] as const)
        expect(
          err(
            esp(3.0, (b, u) => {
              const A = gate(b, 'high');
              res(b, r1, `${A}.y`, `${u}.gpio4`);
              res(b, r2, `${u}.gpio4`, 'GND1.ref');
            }),
          )?.code,
        ).toBe('logic_mcu_input_not_guaranteed');
    });
  });

  describe('probe esp: refused exactly where the hand worst case leaves the ESP32 band', () => {
    const cases: [string, number, (b: Bench, u: string) => void, boolean][] = [
      [
        'E1 3.3 V 100k/327k (hand 2.444 V < 2.475)',
        3.3,
        (b, u) => {
          const A = gate(b, 'high');
          res(b, 100e3, `${A}.y`, `${u}.gpio4`);
          res(b, 327e3, `${u}.gpio4`, 'GND1.ref');
        },
        false,
      ],
      [
        'E1 3.3 V 100k/400k (hand 2.553 V)',
        3.3,
        (b, u) => {
          const A = gate(b, 'high');
          res(b, 100e3, `${A}.y`, `${u}.gpio4`);
          res(b, 400e3, `${u}.gpio4`, 'GND1.ref');
        },
        true,
      ],
      [
        'E1 3.0 V 150/850 (undefined at x0)',
        3.0,
        (b, u) => {
          const A = gate(b, 'high');
          res(b, 150, `${A}.y`, `${u}.gpio4`);
          res(b, 850, `${u}.gpio4`, 'GND1.ref');
        },
        false,
      ],
      [
        'E2 3.3 V 100k/290k (undefined at x0)',
        3.3,
        (b, u) => {
          const A = gate(b, 'low');
          res(b, 100e3, `${A}.y`, `${u}.gpio4`);
          res(b, 290e3, `${u}.gpio4`, 'PSU1.positive');
        },
        false,
      ],
      [
        'E2 3.0 V 1500/8500 (hand 0.790 V ≤ 0.825)',
        3.0,
        (b, u) => {
          const A = gate(b, 'low');
          res(b, 1500, `${A}.y`, `${u}.gpio4`);
          res(b, 8500, `${u}.gpio4`, 'PSU1.positive');
        },
        true,
      ],
      [
        'E3 3.3 V 30k/10.5k (undefined at x0)',
        3.3,
        (b, u) => {
          const A = gate(b, 'high');
          const B = gate(b, 'low');
          res(b, 30e3, `${A}.y`, `${u}.gpio4`);
          res(b, 10.5e3, `${B}.y`, `${u}.gpio4`);
        },
        false,
      ],
      [
        'E3 3.0 V 50/250 (undefined at x0)',
        3.0,
        (b, u) => {
          const A = gate(b, 'high');
          const B = gate(b, 'low');
          res(b, 50, `${A}.y`, `${u}.gpio4`);
          res(b, 250, `${B}.y`, `${u}.gpio4`);
        },
        false,
      ],
      [
        'E3 3.3 V 5k/30k (hand HIGH 2.743 V)',
        3.3,
        (b, u) => {
          const A = gate(b, 'high');
          const B = gate(b, 'low');
          res(b, 5e3, `${A}.y`, `${u}.gpio4`);
          res(b, 30e3, `${B}.y`, `${u}.gpio4`);
        },
        true,
      ],
    ];
    for (const [name, vcc, build, runs] of cases)
      it(`${name} → ${runs ? 'runs' : 'refused'}`, () => {
        const e = err(esp(vcc, build));
        if (runs) expect(e).toBeNull();
        else expect(e?.code).toBe('logic_mcu_input_not_guaranteed');
      });
  });

  describe('S3: an output current check counts the OTHER outputs bands (probe outcur)', () => {
    /** A HIGH –R– B LOW, 10 MΩ bleed on Y_A; optionally a reader input on Y_A. */
    const tied = (r: number, reader: boolean) => {
      const b = new Bench();
      b.psu(3.0, 0.5).wire('PSU1.negative', 'GND1.ref');
      const A = gate(b, 'high');
      const B = gate(b, 'low');
      res(b, r, `${A}.y`, `${B}.y`);
      res(b, 1e7, `${A}.y`, 'GND1.ref');
      if (reader) {
        const C = b.add('logic.gate_and');
        b.wire('PSU1.positive', `${C}.vcc`)
          .wire(`${C}.gnd`, 'GND1.ref')
          .wire(`${C}.b`, 'PSU1.positive');
        b.wire(`${A}.y`, `${C}.a`);
      }
      return { b, A, B };
    };
    // Sprint 22 (Q5): A's OWN stronger side counts too — with both outputs at their rails the
    // resistor carries V_CC / R: 37.5 mA at 80 Ω (was 28.108 mA with A on its weakest curve).
    for (const reader of [false, true]) {
      it(`R = 80 Ω${reader ? ' (+reader)' : ''}: both outputs at their rails: 3.0 V / 80 Ω = 37.5 mA > 24 mA → refused`, () => {
        const { b, A } = tied(80, reader);
        const e = err(solve(b));
        expect(e).toMatchObject({
          code: 'logic_output_uncharacterized',
          components: [A],
          param: 'y',
          detail: { limit: 0.024 },
        });
        // (+ the 10 MΩ bleed's 0.3 µA, + the reader's 5 µA leakage)
        expect((e!.detail as { value: number }).value).toBeCloseTo(3.0 / 80, 4);
      });
      it(`R = 130 Ω${reader ? ' (+reader)' : ''}: at most 23.08 mA ≤ 24 mA → runs`, () => {
        expect(err(solve(tied(130, reader).b))).toBeNull();
      });
    }
  });
});
