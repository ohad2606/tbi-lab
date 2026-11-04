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

/** PSU1 at `vcc` powers one gate of `type`; inputs from PSU1+ or GND; Y → 1 kΩ → LED → GND. */
const single = (type: 'logic.gate_nor' | 'logic.gate_xor', vcc: number, a: boolean, b: boolean) => {
  const bench = new Bench();
  bench.psu(vcc, 0.1).wire('PSU1.negative', 'GND1.ref');
  const g = bench.add(type);
  const r = bench.add('component.resistor');
  const led = bench.add('component.led');
  bench.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
  bench.wire(`${g}.a`, a ? 'PSU1.positive' : 'GND1.ref');
  bench.wire(`${g}.b`, b ? 'PSU1.positive' : 'GND1.ref');
  bench.ohms(r, 1000).wire(`${g}.y`, `${r}.a`).wire(`${r}.b`, `${led}.anode`);
  bench.wire(`${led}.cathode`, 'GND1.ref');
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
    for (const [type, f] of [
      ['logic.gate_nor', (a: boolean, b: boolean) => !(a || b)],
      ['logic.gate_xor', (a: boolean, b: boolean) => a !== b],
    ] as const)
      it(`${type} at ${vcc} V: every input combination, the LED on iff Y HIGH`, () => {
        for (const [a, b] of [
          [false, false],
          [false, true],
          [true, false],
          [true, true],
        ] as const) {
          const { s, g, led } = single(type, vcc, a, b);
          const o = ok(s.solve());
          const y = f(a, b);
          const at = `${type} ${vcc} V a=${+a} b=${+b}`;
          expect(o.components[g]!.state, at).toMatchObject({ gateOutput: lvl(y) });
          expect(o.components[g]!.logic!.gates[0]!.output.level, at).toBe(lvl(y));
          if (y) expect(o.components[led]!.current!, at).toBeGreaterThan(0.5e-3);
          else expect(Math.abs(o.components[led]!.current!), at).toBeLessThan(1e-9);
          // The bound the run was checked with is reported: XOR strict at V_CC/GND; NOR (test
          // voltage 5.5 V) on the ΔI_CC basis whenever an input is at V_CC < 5.5 V.
          const st = o.components[g]!.state as Record<string, unknown>;
          if (type === 'logic.gate_xor') expect(st, at).toMatchObject({ iccMaxA: 10e-6 });
          else if (a || b)
            expect(st, at).toMatchObject({ iccBasis: 'deltaIcc', deltaIccInputs: 2 });
          else expect(st, at).toMatchObject({ iccMaxA: 10e-6 });
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
 * A 1-bit full adder from five single gates at 3.3 V (three stages): X = A ⊕ B, S = X ⊕ Cin,
 * C1 = A·B, C2 = X·Cin, Cout = C1 + C2. Inputs from PSU1+ or GND; S and Cout each light an LED.
 */
const fullAdder = (a: boolean, b: boolean, cin: boolean, vcc = 3.3, limit = 0.2) => {
  const bench = new Bench();
  bench.psu(vcc, limit).wire('PSU1.negative', 'GND1.ref');
  const x = bench.add('logic.gate_xor');
  const sum = bench.add('logic.gate_xor');
  const c1 = bench.add('logic.gate_and');
  const c2 = bench.add('logic.gate_and');
  const cout = bench.add('logic.gate_or');
  for (const g of [x, sum, c1, c2, cout])
    bench.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
  const lv = (on: boolean) => (on ? 'PSU1.positive' : 'GND1.ref');
  bench.wire(`${x}.a`, lv(a)).wire(`${x}.b`, lv(b));
  bench.wire(`${c1}.a`, lv(a)).wire(`${c1}.b`, lv(b));
  bench.wire(`${sum}.a`, `${x}.y`).wire(`${sum}.b`, lv(cin));
  bench.wire(`${c2}.a`, `${x}.y`).wire(`${c2}.b`, lv(cin));
  bench.wire(`${cout}.a`, `${c1}.y`).wire(`${cout}.b`, `${c2}.y`);
  const leds: string[] = [];
  for (const y of [`${sum}.y`, `${cout}.y`]) {
    const r = bench.add('component.resistor');
    const led = bench.add('component.led');
    bench.ohms(r, 1000).wire(y, `${r}.a`).wire(`${r}.b`, `${led}.anode`);
    bench.wire(`${led}.cathode`, 'GND1.ref');
    leds.push(led);
  }
  return { s: new EngineSession(bench.snapshot()), ids: { x, sum, c1, c2, cout }, leds };
};

describe('multi-stage logic (S29-D1/A3): a 1-bit full adder from five single gates', () => {
  it('all 8 input combinations: every intermediate and final level is the solved, guaranteed operating point; S and Cout match A + B + Cin', () => {
    for (let m = 0; m < 8; m++) {
      const [a, b, cin] = [m & 4, m & 2, m & 1].map(Boolean) as [boolean, boolean, boolean];
      const { s, ids, leds } = fullAdder(a, b, cin);
      const o = ok(s.solve());
      const at = `A=${+a} B=${+b} Cin=${+cin}`;
      const level = (id: string) => o.components[id]!.logic!.gates[0]!.output.level;
      const xv = a !== b;
      expect(level(ids.x), at).toBe(lvl(xv));
      expect(level(ids.c1), at).toBe(lvl(a && b));
      expect(level(ids.c2), at).toBe(lvl(xv && cin));
      const total = +a + +b + +cin;
      expect(level(ids.sum), at).toBe(lvl(total % 2 === 1));
      expect(level(ids.cout), at).toBe(lvl(total >= 2));
      for (const [led, on] of [
        [leds[0]!, total % 2 === 1],
        [leds[1]!, total >= 2],
      ] as const)
        if (on) expect(o.components[led]!.current!, at).toBeGreaterThan(0.5e-3);
        else expect(Math.abs(o.components[led]!.current!), at).toBeLessThan(1e-9);
      // Every gate has a guaranteed quiescent-current bound: the first-stage XOR (inputs at V_CC
      // or GND, its own test condition) the strict 10 µA; the gates fed by a gate output (or, for
      // the 1G08/1G32, by V_CC < 5.5 V) on the ΔI_CC basis.
      const st = (id: string) => o.components[id]!.state as Record<string, unknown>;
      expect(st(ids.x), at).toMatchObject({ iccMaxA: 10e-6 });
      expect(st(ids.cout), at).toMatchObject({ iccBasis: 'deltaIcc', deltaIccInputs: 2 });
      expect(st(ids.sum).iccMaxA as number, at).toBeLessThanOrEqual(10e-6 + 2 * 500e-6 + 1e-12);
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
