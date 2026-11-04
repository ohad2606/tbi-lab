/**
 * Sprint 29: NOR (SN74LVC1G02) and XOR (SN74LVC1G86) single gates, and multi-stage logic made
 * possible by owner decisions S29-D1 (ΔI_CC bound) and S29-A3 (leakage-level tolerance).
 *
 * Every truth table here is the SOLVED operating point (levels from the DC solve, re-checked within
 * the datasheet bounds), never only a Boolean expression: each case asserts the gate's own output
 * level, the guaranteed I_CC bound it was evaluated with, and the LED current it drives.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, LVC1G_CARDS, quiescentAt, type SolveOutcome } from '../src/index.js';
import { Bench } from './build.js';

const ok = (o: SolveOutcome) => {
  if (!o.ok) throw new Error(`expected success, got ${o.error.code} ${JSON.stringify(o.error)}`);
  return o;
};
const fails = (o: SolveOutcome) => {
  if (o.ok) throw new Error('expected a refusal');
  return o.error;
};
const lvl = (on: boolean) => (on ? 'high' : 'low');
const COMBOS = [
  [false, false],
  [false, true],
  [true, false],
  [true, true],
] as const;

/** PSU1 at `vcc` powers one gate of `type`; inputs from PSU1+ or GND; Y → 1 kΩ → LED → GND. */
const single = (
  type: 'logic.gate_nor' | 'logic.gate_xor',
  vcc: number,
  a: boolean,
  b: boolean,
  load = true,
) => {
  const bench = new Bench();
  bench.psu(vcc, 0.1).wire('PSU1.negative', 'GND1.ref');
  const g = bench.add(type);
  const r = bench.add('component.resistor');
  const led = bench.add('component.led');
  bench.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
  bench.wire(`${g}.a`, a ? 'PSU1.positive' : 'GND1.ref');
  bench.wire(`${g}.b`, b ? 'PSU1.positive' : 'GND1.ref');
  if (load) {
    bench.ohms(r, 1000).wire(`${g}.y`, `${r}.a`).wire(`${r}.b`, `${led}.anode`);
    bench.wire(`${led}.cathode`, 'GND1.ref');
  }
  return { s: new EngineSession(bench.snapshot()), g, led };
};

describe('SN74LVC1G02 NOR and SN74LVC1G86 XOR: datasheet cards (SCES213Y, SCES222R)', () => {
  it('the cards carry each sheet’s own figures', () => {
    const nor = LVC1G_CARDS['model.logic.sn74lvc1g02']!;
    const xor = LVC1G_CARDS['model.logic.sn74lvc1g86']!;
    expect(nor).toMatchObject({ partNumber: 'SN74LVC1G02', function: 'nor', iccInputHigh: 5.5 });
    expect(nor.source).toContain('SCES213Y');
    expect(nor.ciF).toBe(4e-12);
    expect(nor.tpd33).toEqual([0.8e-9, 3.6e-9]);
    // SCES222R §5.5: I_CC "V_I = V_CC or GND, I_O = 0" — the one row that differs from the set.
    expect(xor).toMatchObject({ partNumber: 'SN74LVC1G86', function: 'xor', iccInputHigh: 'vcc' });
    expect(xor.source).toContain('SCES222R');
    expect(xor.ciF).toBe(6e-12);
    expect(xor.tpd33).toEqual([0.6e-9, 4e-9]);
    for (const c of [nor, xor])
      expect(c).toMatchObject({
        iccMaxA: 10e-6,
        deltaIccA: 500e-6,
        inputLeakageA: 5e-6,
        vccOperating: [1.65, 5.5],
        pins: { a: 1, b: 2, gnd: 3, y: 4, vcc: 5 },
      });
  });

  it('XOR: inputs at V_CC or GND meet its I_CC test condition (strict 10 µA); NOR: V_CC is not 5.5 V (ΔI_CC)', () => {
    const xor = LVC1G_CARDS['model.logic.sn74lvc1g86']!;
    const nor = LVC1G_CARDS['model.logic.sn74lvc1g02']!;
    expect(quiescentAt(xor, 3.3, [3.3, 0])).toEqual({ iccMaxA: 10e-6 });
    expect(quiescentAt(nor, 3.3, [3.3, 0])).toMatchObject({
      iccMaxA: 10e-6 + 2 * 500e-6,
      iccBasis: 'deltaIcc',
      deltaIccInputs: 2,
    });
    // Between the bands: not characterized for either.
    for (const c of [xor, nor])
      expect(quiescentAt(c, 3.3, [1.5, 0])).toMatchObject({ iccCondition: 'notInputs' });
  });
});

describe('NOR and XOR truth tables through the solve (3.0, 3.3, 4.5 V: tabulated output rows)', () => {
  for (const vcc of [3.0, 3.3, 4.5])
    it(`logic.gate_nor at ${vcc} V: every input combination, the LED on iff Y HIGH (a loaded 1G02 keeps its I_CC rule, §8.2.1.1)`, () => {
      for (const [a, b] of COMBOS) {
        const { s, g, led } = single('logic.gate_nor', vcc, a, b);
        const o = ok(s.solve());
        const y = !(a || b);
        const at = `NOR ${vcc} V a=${+a} b=${+b}`;
        expect(o.components[g]!.state, at).toMatchObject({ gateOutput: lvl(y) });
        if (y) expect(o.components[led]!.current!, at).toBeGreaterThan(0.5e-3);
        else expect(Math.abs(o.components[led]!.current!), at).toBeLessThan(1e-9);
        const st = o.components[g]!.state as Record<string, unknown>;
        if (a || b) expect(st, at).toMatchObject({ iccBasis: 'deltaIcc', deltaIccInputs: 2 });
        else expect(st, at).toMatchObject({ iccMaxA: 10e-6 });
      }
    });
  for (const vcc of [3.0, 3.3, 4.5])
    it(`logic.gate_xor at ${vcc} V, output unloaded: every input combination from the solve (strict 10 µA: inputs at V_CC or GND)`, () => {
      for (const [a, b] of COMBOS) {
        const { s, g } = single('logic.gate_xor', vcc, a, b, false);
        const o = ok(s.solve());
        const at = `XOR ${vcc} V a=${+a} b=${+b}`;
        expect(o.components[g]!.state, at).toMatchObject({
          gateOutput: lvl(a !== b),
          iccMaxA: 10e-6,
        });
      }
    });
  it('S29-D2: a LOADED SN74LVC1G86 output is refused by name (SCES222R gives I_CC only at I_O = 0; no power rule)', () => {
    for (const vcc of [3.0, 3.3, 4.5])
      for (const [a, b] of COMBOS.filter(([x, y]) => x !== y)) {
        const { s, g } = single('logic.gate_xor', vcc, a, b);
        expect(fails(s.solve()), `${vcc} V`).toMatchObject({
          code: 'logic_supply_current_uncharacterized',
          components: [g, 'PSU1'],
          param: 'y',
          detail: { part: 'SN74LVC1G86', condition: 'loaded' },
        });
      }
  });
  it('at 5.0 V (no tabulated output row: only ±100 µA is guaranteed) the 1 kΩ LED load is refused by name', () => {
    for (const type of ['logic.gate_nor', 'logic.gate_xor'] as const) {
      const { s, g } = single(type, 5.0, false, type === 'logic.gate_xor');
      expect(fails(s.solve())).toMatchObject({
        code: 'logic_output_uncharacterized',
        components: [g],
        detail: { vcc: 5, limit: 100e-6 },
      });
    }
  });
  it('deterministic: the same circuit gives byte-identical results', () => {
    const run = () => JSON.stringify(single('logic.gate_xor', 3.3, true, false).s.solve());
    expect(run()).toBe(run());
  });
  it('an input between the bands is still refused (XOR at 3.3 V, A at 1.5 V from a divider)', () => {
    const bench = new Bench();
    bench.psu(3.3, 0.1).wire('PSU1.negative', 'GND1.ref');
    const g = bench.add('logic.gate_xor');
    const r1 = bench.add('component.resistor');
    const r2 = bench.add('component.resistor');
    bench.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
    bench.ohms(r1, 1800).wire('PSU1.positive', `${r1}.a`).wire(`${r1}.b`, `${g}.a`);
    bench.ohms(r2, 1500).wire(`${g}.a`, `${r2}.a`).wire(`${r2}.b`, 'GND1.ref');
    bench.wire(`${g}.b`, 'GND1.ref');
    expect(fails(new EngineSession(bench.snapshot()).solve())).toMatchObject({
      code: 'logic_input_undefined',
      components: [g],
      param: 'a',
    });
  });
});

/**
 * A 1-bit full adder from seven single gates at 3.3 V, every one from a sheet with the loaded-output
 * power rule (§8.2.1.1; owner decision S29-D2 keeps the XOR part strict): X = (A + B) · NAND(A, B),
 * S = (X + Cin) · NAND(X, Cin), Cout = NAND(NAND(A, B), NAND(X, Cin)) = A·B + X·Cin. Four stages.
 * Inputs from PSU1+ or GND; S and Cout each light an LED.
 */
const fullAdder = (a: boolean, b: boolean, cin: boolean, vcc = 3.3, limit = 0.2) => {
  const bench = new Bench();
  bench.psu(vcc, limit).wire('PSU1.negative', 'GND1.ref');
  const o1 = bench.add('logic.gate_or');
  const n1 = bench.add('logic.gate_nand');
  const x = bench.add('logic.gate_and');
  const o2 = bench.add('logic.gate_or');
  const n2 = bench.add('logic.gate_nand');
  const sum = bench.add('logic.gate_and');
  const cout = bench.add('logic.gate_nand');
  for (const g of [o1, n1, x, o2, n2, sum, cout])
    bench.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
  const lv = (on: boolean) => (on ? 'PSU1.positive' : 'GND1.ref');
  for (const g of [o1, n1]) bench.wire(`${g}.a`, lv(a)).wire(`${g}.b`, lv(b));
  bench.wire(`${x}.a`, `${o1}.y`).wire(`${x}.b`, `${n1}.y`);
  for (const g of [o2, n2]) bench.wire(`${g}.a`, `${x}.y`).wire(`${g}.b`, lv(cin));
  bench.wire(`${sum}.a`, `${o2}.y`).wire(`${sum}.b`, `${n2}.y`);
  bench.wire(`${cout}.a`, `${n1}.y`).wire(`${cout}.b`, `${n2}.y`);
  const leds: string[] = [];
  for (const y of [`${sum}.y`, `${cout}.y`]) {
    const r = bench.add('component.resistor');
    const led = bench.add('component.led');
    bench.ohms(r, 1000).wire(y, `${r}.a`).wire(`${r}.b`, `${led}.anode`);
    bench.wire(`${led}.cathode`, 'GND1.ref');
    leds.push(led);
  }
  return { s: new EngineSession(bench.snapshot()), ids: { o1, n1, x, o2, n2, sum, cout }, leds };
};

describe('multi-stage logic (S29-D1/A3): a 1-bit full adder from seven single gates', () => {
  it('all 8 input combinations: every intermediate and final level is the solved, guaranteed operating point; S and Cout match A + B + Cin', () => {
    for (let m = 0; m < 8; m++) {
      const [a, b, cin] = [m & 4, m & 2, m & 1].map(Boolean) as [boolean, boolean, boolean];
      const { s, ids, leds } = fullAdder(a, b, cin);
      const o = ok(s.solve());
      const at = `A=${+a} B=${+b} Cin=${+cin}`;
      const level = (id: string) => o.components[id]!.logic!.gates[0]!.output.level;
      const xv = a !== b;
      expect(level(ids.o1), at).toBe(lvl(a || b));
      expect(level(ids.n1), at).toBe(lvl(!(a && b)));
      expect(level(ids.x), at).toBe(lvl(xv));
      expect(level(ids.o2), at).toBe(lvl(xv || cin));
      expect(level(ids.n2), at).toBe(lvl(!(xv && cin)));
      const total = +a + +b + +cin;
      expect(level(ids.sum), at).toBe(lvl(total % 2 === 1));
      expect(level(ids.cout), at).toBe(lvl(total >= 2));
      for (const [led, on] of [
        [leds[0]!, total % 2 === 1],
        [leds[1]!, total >= 2],
      ] as const)
        if (on) expect(o.components[led]!.current!, at).toBeGreaterThan(0.5e-3);
        else expect(Math.abs(o.components[led]!.current!), at).toBeLessThan(1e-9);
      // Every gate fed by a gate output is on the ΔI_CC basis with both inputs counted.
      const st = (id: string) => o.components[id]!.state as Record<string, unknown>;
      for (const id of [ids.x, ids.sum, ids.cout])
        expect(st(id), `${at} ${id}`).toMatchObject({ iccBasis: 'deltaIcc', deltaIccInputs: 2 });
    }
  });

  it('the bound is used: PSU1 limited just under the worst-case demand is refused, just over runs', () => {
    // A = B = Cin = 1: S and Cout HIGH, both LEDs on. A tight limit is refused and reports the
    // worst DEMANDED current (outputs at their rails, every I_CC bound, the input leakage).
    // 4.5 mA: above the nominal draw (≈ 2.55 mA, PSU1 stays in CV at every corner) and below the
    // worst demand; the refusal reports that worst demand on the settled I_CC basis.
    const nominal = ok(fullAdder(true, true, true).s.solve()).components.PSU1!.current!;
    expect(nominal).toBeCloseTo(2.55e-3, 4);
    const e = fails(fullAdder(true, true, true, 3.3, 4.5e-3).s.solve());
    expect(e).toMatchObject({ code: 'logic_supply_not_guaranteed', param: 'limit' });
    const worst = (e.detail as { worst: number }).worst;
    // It includes the ΔI_CC bounds: more than the nominal draw plus two ΔI_CC alone.
    expect(worst).toBeGreaterThan(nominal + 2 * 500e-6);
    expect(fails(fullAdder(true, true, true, 3.3, worst * 0.999).s.solve())).toMatchObject({
      code: 'logic_supply_not_guaranteed',
      param: 'limit',
    });
    ok(fullAdder(true, true, true, 3.3, worst * 1.001).s.solve());
  });

  it('deterministic: identical results on repeated solves', () => {
    const run = () => JSON.stringify(fullAdder(true, false, true).s.solve());
    expect(run()).toBe(run());
  });

  it('at 2.3 V (a tabulated output row, but below the ΔI_CC row 3.0–5.5 V) the cascade is refused by name', () => {
    expect(fails(fullAdder(true, false, true, 2.3).s.solve())).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
    });
  });
});

/**
 * Workstream C/D interoperability: logic → transistor → relay → LED, two supplies, one ground.
 * Switches A, B (10 kΩ pull-downs) → SN74LVC1G08 at 3.3 V (PSU1) → 1 kΩ → 2N3904 base; the
 * collector switches an SRD-05 coil from PSU2 at 5 V (1N4148 across the coil: reverse-biased at
 * DC); the relay's NO contact lights an LED from PSU2 through 330 Ω.
 */
const relayDriver = (a: boolean, b: boolean) => {
  const bench = new Bench();
  bench.psu(3.3, 0.1).wire('PSU1.negative', 'GND1.ref');
  const p2 = bench.rail(5.0, 0.5);
  // No bleeder: with the relay off PSU2 delivers only leakage; S29-A3 evaluates it (before the
  // S29 corner-cycle rule its no-sink check was not established: a resolution-level cycle).
  const g = bench.add('logic.gate_and');
  bench.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
  for (const [pin, on] of [
    ['a', a],
    ['b', b],
  ] as const) {
    const pd = bench.add('component.resistor');
    bench.ohms(pd, 10_000).wire(`${g}.${pin}`, `${pd}.a`).wire(`${pd}.b`, 'GND1.ref');
    if (on) bench.wire(`${g}.${pin}`, 'PSU1.positive');
  }
  const rb = bench.add('component.resistor');
  const q = bench.add('component.bjt_npn');
  const k = bench.add('component.relay');
  const d = bench.add('component.diode');
  bench.ohms(rb, 1000).wire(`${g}.y`, `${rb}.a`).wire(`${rb}.b`, `${q}.base`);
  bench.wire(`${q}.emitter`, 'GND1.ref');
  bench.wire(`${p2}.positive`, `${k}.coil1`).wire(`${k}.coil2`, `${q}.collector`);
  bench.wire(`${d}.cathode`, `${k}.coil1`).wire(`${d}.anode`, `${k}.coil2`);
  const rl = bench.add('component.resistor');
  const led = bench.add('component.led');
  bench.wire(`${p2}.positive`, `${k}.com`).wire(`${k}.no`, `${rl}.a`);
  bench.ohms(rl, 330).wire(`${rl}.b`, `${led}.anode`).wire(`${led}.cathode`, 'GND1.ref');
  return { s: new EngineSession(bench.snapshot()), g, q, k, led };
};

describe('interoperability: logic gate → 2N3904 → relay → LED (two supplies)', () => {
  it('the LED is on exactly when A·B; the transistor saturates, the gate output stays within its guarantee', () => {
    for (const [a, b] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      const { s, g, k, led } = relayDriver(a, b);
      const o = ok(s.solve());
      const at = `A=${+a} B=${+b}`;
      expect(o.components[g]!.state, at).toMatchObject({ gateOutput: lvl(a && b) });
      if (a && b) {
        expect(o.components[led]!.current!, at).toBeGreaterThan(5e-3);
        // Base current through 1 kΩ from a ≤ 3.3 V output: well inside the 24 mA test point.
        expect(Math.abs(o.components[g]!.currents!.y!), at).toBeLessThan(3e-3);
      } else expect(Math.abs(o.components[led]!.current!), at).toBeLessThan(1e-9);
      expect(o.components[k]!.state, at).toMatchObject({ energized: a && b });
    }
  });
});

describe('independent review regressions (Sprint 29)', () => {
  it('M2: a supply that would sink a QUIESCENT current (a gate GND on a second supply) is refused even when unrelated leakage inflates the budget', () => {
    const bench = new Bench();
    bench.psu(5.0, 0.1).wire('PSU1.negative', 'GND1.ref');
    const p2 = bench.rail(1.8, 0.1); // the gate's GND pin on PSU2+ (a stacked ground)
    const u1 = bench.add('logic.gate_and');
    bench.wire('PSU1.positive', `${u1}.vcc`).wire(`${u1}.gnd`, `${p2}.positive`);
    bench.wire(`${u1}.a`, `${p2}.positive`).wire(`${u1}.b`, `${p2}.positive`);
    // Unrelated gates: their leakage would cover U1's I_CC if the budget were global and blind.
    for (let k = 0; k < 3; k++) {
      const g = bench.add('logic.gate_and');
      bench.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
      bench.wire(`${g}.a`, 'GND1.ref').wire(`${g}.b`, 'GND1.ref');
    }
    const e = fails(new EngineSession(bench.snapshot()).solve());
    expect(e).toMatchObject({
      code: 'logic_supply_not_guaranteed',
      components: [p2],
      param: 'sink',
      detail: { cause: 'not_leakage' },
    });
  });

  it('M3 / S29-D3: an input overdriven ABOVE V_CC by a real source (3.8 V through 10 kΩ into a gate at 3.3 V) is refused; the same input at V_CC runs', () => {
    const at = (volts: number) => {
      const bench = new Bench();
      bench.psu(3.3, 0.1).wire('PSU1.negative', 'GND1.ref');
      const src = bench.rail(volts, 0.1);
      const g = bench.add('logic.gate_and');
      const r = bench.add('component.resistor');
      bench.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
      bench.ohms(r, 10_000).wire(`${src}.positive`, `${r}.a`).wire(`${r}.b`, `${g}.a`);
      bench.wire(`${g}.b`, 'PSU1.positive');
      return new EngineSession(bench.snapshot()).solve();
    };
    expect(fails(at(3.8))).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      detail: { condition: 'notInputs' },
    });
    expect(ok(at(3.3)).ok).toBe(true);
  });
});
