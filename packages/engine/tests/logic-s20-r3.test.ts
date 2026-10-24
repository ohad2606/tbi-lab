/**
 * Sprint 20 logic, review round 3 (probes /home/ubuntu/tbi-s20/review/r2-probes/probe3..8, ported).
 *
 * A1: a legitimate cascade on a rail behind a series supply element (closed switch, 10 Ω, series
 *     diode) settles; a genuinely unknown supply is still refused.
 * A2: an unpowered HC-SR501 PIR drives nothing (an input on OUT floats), as the HC-SR04 / DHT22;
 *     the other output-capable parts audited.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, type SolveOutcome, type SolveSuccess } from '../src/index.js';
import { Bench } from './build.js';

const solve = (b: Bench) => new EngineSession(b.snapshot()).solve();
const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${JSON.stringify(o.error)}`);
  return o;
};
const fails = (o: SolveOutcome) => {
  if (o.ok) throw new Error('expected a refusal');
  return o.error;
};

type Series = 'switch' | 'resistor' | 'diode' | 'direct';

/** PSU1 → [series element] → rail; returns the rail terminal and the bench. */
function railBench(series: Series, volts: number) {
  const b = new Bench();
  b.psu(volts, 0.5).wire('PSU1.negative', 'GND1.ref');
  if (series === 'direct') return { b, rail: 'PSU1.positive' };
  if (series === 'switch') {
    const sw = b.add('component.toggle_switch');
    b.set(sw, 'closed', true).wire('PSU1.positive', `${sw}.a`);
    return { b, rail: `${sw}.b` };
  }
  if (series === 'resistor') {
    const r = b.add('component.resistor');
    b.ohms(r, 10).wire('PSU1.positive', `${r}.a`);
    return { b, rail: `${r}.b` };
  }
  const d = b.add('component.diode');
  b.wire('PSU1.positive', `${d}.anode`);
  return { b, rail: `${d}.cathode` };
}

/** Two SN74LVC1G08 on the rail, U1.Y → U2.A, U2.Y into 10 kΩ (probe7/probe8). */
function singles(series: Series, volts: number) {
  const { b, rail } = railBench(series, volts);
  const u1 = b.add('logic.gate_and');
  const u2 = b.add('logic.gate_and');
  const rl = b.add('component.resistor');
  b.ohms(rl, 10_000);
  b.wire(rail, `${u1}.vcc`)
    .wire(`${u1}.gnd`, 'GND1.ref')
    .wire(`${u1}.a`, rail)
    .wire(`${u1}.b`, rail);
  b.wire(rail, `${u2}.vcc`).wire(`${u2}.gnd`, 'GND1.ref').wire(`${u2}.b`, rail);
  b.wire(`${u1}.y`, `${u2}.a`).wire(`${u2}.y`, `${rl}.a`).wire(`${rl}.b`, 'GND1.ref');
  return { b, u1, u2 };
}

/**
 * One SN74LVC08A on the rail, 1Y → 2A, 2Y into 100 kΩ, gates 3/4 inputs to GND (probe8). The
 * package guarantees only ±100 µA between its tabulated supplies (no PM-1 bound), so the load is
 * 100 kΩ, not probe8's 10 kΩ (330 µA at 3.3 V is refused, correctly, as uncharacterized).
 */
function pkg(series: Series, volts: number) {
  const { b, rail } = railBench(series, volts);
  const u = b.add('logic.quad_and');
  const rl = b.add('component.resistor');
  b.ohms(rl, 100_000);
  b.wire(rail, `${u}.vcc`).wire(`${u}.gnd`, 'GND1.ref').wire(`${u}.a1`, rail).wire(`${u}.b1`, rail);
  b.wire(`${u}.y1`, `${u}.a2`).wire(`${u}.b2`, rail).wire(`${u}.y2`, `${rl}.a`);
  b.wire(`${rl}.b`, 'GND1.ref');
  for (const t of ['a3', 'b3', 'a4', 'b4']) b.wire(`${u}.${t}`, 'GND1.ref');
  return { b, u };
}

describe('A1: a cascade on a rail behind a series supply element settles (was logic_unknown_state)', () => {
  // Review round 4: a supply through a series DIODE is a junction path and is refused
  // (logic_supply_undriven, below); switch and resistor feeds are resistive/source paths.
  const cases: [Series, number][] = [
    ['direct', 3.3],
    ['switch', 3.3],
    ['resistor', 3.3],
  ];
  for (const [series, volts] of cases) {
    it(`two SN74LVC1G08, U1.Y → U2.A, rail via ${series}`, () => {
      const { b, u1, u2 } = singles(series, volts);
      const o = ok(solve(b));
      expect(o.components[u1]!.logic!.gates[0]!.output.level).toBe('high');
      expect(o.components[u2]!.logic!.gates[0]!.inputs.map((p) => p.level)).toEqual([
        'high',
        'high',
      ]);
      expect(o.components[u2]!.logic!.gates[0]!.output.level).toBe('high');
    });
    it(`SN74LVC08A, 1Y → 2A, rail via ${series}`, () => {
      const { b, u } = pkg(series, volts);
      const o = ok(solve(b));
      expect(o.components[u]!.logic!.gates.map((g) => g.output.level)).toEqual([
        'high',
        'high',
        'low',
        'low',
      ]);
    });
  }

  it('U1 behind 10 Ω and U2 on PSU+ directly (probe7): settles', () => {
    const { b, rail } = railBench('resistor', 3.3);
    const u1 = b.add('logic.gate_and');
    const u2 = b.add('logic.gate_and');
    const rl = b.add('component.resistor');
    b.ohms(rl, 10_000);
    b.wire(rail, `${u1}.vcc`).wire(`${u1}.gnd`, 'GND1.ref');
    b.wire(`${u1}.a`, 'PSU1.positive').wire(`${u1}.b`, 'PSU1.positive');
    b.wire('PSU1.positive', `${u2}.vcc`)
      .wire(`${u2}.gnd`, 'GND1.ref')
      .wire(`${u2}.b`, 'PSU1.positive');
    b.wire(`${u1}.y`, `${u2}.a`).wire(`${u2}.y`, `${rl}.a`).wire(`${rl}.b`, 'GND1.ref');
    expect(ok(solve(b)).components[u2]!.logic!.gates[0]!.inputs[0]!.level).toBe('high');
  });

  it('a GENUINELY unknown supply is still refused: a gate powered from another gate whose input is undefined', () => {
    // U1 (A at 1.5 V from a divider: undefined) drives U2's V_CC pin. The root cause is named.
    const b = new Bench();
    const u1 = b.add('logic.gate_and');
    const u2 = b.add('logic.gate_and');
    const top = b.add('component.resistor');
    const bot = b.add('component.resistor');
    b.psu(3.0, 0.5).ohms(top, 10_000).ohms(bot, 10_000).wire('PSU1.negative', 'GND1.ref');
    b.wire('PSU1.positive', `${u1}.vcc`)
      .wire(`${u1}.gnd`, 'GND1.ref')
      .wire(`${u1}.b`, 'PSU1.positive');
    b.wire('PSU1.positive', `${top}.a`).wire(`${top}.b`, `${u1}.a`).wire(`${u1}.a`, `${bot}.a`);
    b.wire(`${bot}.b`, 'GND1.ref');
    b.wire(`${u1}.y`, `${u2}.vcc`).wire(`${u2}.gnd`, 'GND1.ref');
    b.wire(`${u2}.a`, 'GND1.ref').wire(`${u2}.b`, 'GND1.ref');
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_input_undefined',
      components: [u1],
      param: 'a',
    });
  });

  it('a downstream gate with a PERMANENTLY floating input on a series-fed rail names that input (not the rail)', () => {
    // Two gates on a rail behind 10 Ω, U1.Y → U2.A, and U2.B left open.
    const v = new Bench();
    v.psu(3.3, 0.5).wire('PSU1.negative', 'GND1.ref');
    const r = v.add('component.resistor');
    const g1 = v.add('logic.gate_and');
    const g2 = v.add('logic.gate_and');
    v.ohms(r, 10).wire('PSU1.positive', `${r}.a`);
    v.wire(`${r}.b`, `${g1}.vcc`)
      .wire(`${g1}.gnd`, 'GND1.ref')
      .wire(`${g1}.a`, `${r}.b`)
      .wire(`${g1}.b`, `${r}.b`);
    v.wire(`${r}.b`, `${g2}.vcc`).wire(`${g2}.gnd`, 'GND1.ref').wire(`${g1}.y`, `${g2}.a`);
    expect(fails(solve(v))).toMatchObject({
      code: 'logic_input_floating',
      components: [g2],
      param: 'b',
    });
  });
});

/** SN74LVC1G08 at `vcc`, B HIGH, Y into 10 kΩ; A from the caller (probe3 base). */
function base(vcc: number) {
  const b = new Bench();
  const g = b.add('logic.gate_and');
  const r = b.add('component.resistor');
  b.psu(vcc, 0.5)
    .ohms(r, 10_000)
    .wire('PSU1.negative', 'GND1.ref')
    .wire('PSU1.positive', `${g}.vcc`)
    .wire(`${g}.gnd`, 'GND1.ref')
    .wire(`${g}.b`, 'PSU1.positive')
    .wire(`${g}.y`, `${r}.a`)
    .wire(`${r}.b`, 'GND1.ref');
  return { b, g };
}
const floatingA = (g: string) => ({ code: 'logic_input_floating', components: [g], param: 'a' });

describe('round 4: a supply fed only through a junction or capacitor is undetermined, refused by name', () => {
  /** r3a.test.ts: U1 fed by `feed`, its inputs on its own V_CC (unless `ownRail` is false);
   *  U2 powered from PSU+, U1.Y → U2.A, U2.Y into 10 kΩ. */
  function chain(psu: number, feed: (b: Bench, u1: string) => void, ownRail = true) {
    const b = new Bench();
    const u1 = b.add('logic.gate_and');
    const u2 = b.add('logic.gate_and');
    const rl = b.add('component.resistor');
    b.psu(psu, 0.5).ohms(rl, 10_000).wire('PSU1.negative', 'GND1.ref');
    feed(b, u1);
    if (ownRail) b.wire(`${u1}.a`, `${u1}.vcc`).wire(`${u1}.b`, `${u1}.vcc`);
    else b.wire(`${u1}.a`, 'PSU1.positive').wire(`${u1}.b`, 'PSU1.positive');
    b.wire('PSU1.positive', `${u2}.vcc`)
      .wire(`${u2}.gnd`, 'GND1.ref')
      .wire(`${u2}.b`, 'PSU1.positive');
    b.wire(`${u1}.y`, `${u2}.a`).wire(`${u2}.y`, `${rl}.a`).wire(`${rl}.b`, 'GND1.ref');
    return { b, u1, u2 };
  }
  const undrivenSupply = (u1: string, pin: 'vcc' | 'gnd') => ({
    code: 'logic_supply_undriven',
    components: [u1],
    param: pin,
  });
  const reverseDiode = (b: Bench, u1: string) => {
    const d = b.add('component.diode');
    b.wire('PSU1.positive', `${d}.cathode`)
      .wire(`${d}.anode`, `${u1}.vcc`)
      .wire(`${u1}.gnd`, 'GND1.ref');
  };

  it('(a) V_CC through a REVERSE diode, inputs on its own V_CC: refused (was Y HIGH, supplyV 3.3 V)', () => {
    const { b, u1 } = chain(3.3, reverseDiode);
    expect(fails(solve(b))).toMatchObject(undrivenSupply(u1, 'vcc'));
  });
  it('(b) the same supply with the inputs on PSU+: refused', () => {
    const { b, u1 } = chain(3.3, reverseDiode, false);
    expect(fails(solve(b))).toMatchObject(undrivenSupply(u1, 'vcc'));
  });
  it('(c) SN74LVC08A with V_CC through the reverse diode, 1A/1B on its own V_CC: refused (was 1Y HIGH)', () => {
    const b = new Bench();
    const u = b.add('logic.quad_and');
    const g = b.add('logic.gate_and');
    const d = b.add('component.diode');
    b.psu(3.3, 0.5).wire('PSU1.negative', 'GND1.ref');
    b.wire('PSU1.positive', `${d}.cathode`)
      .wire(`${d}.anode`, `${u}.vcc`)
      .wire(`${u}.gnd`, 'GND1.ref');
    b.wire(`${u}.a1`, `${u}.vcc`).wire(`${u}.b1`, `${u}.vcc`);
    for (const t of ['a2', 'b2', 'a3', 'b3', 'a4', 'b4']) b.wire(`${u}.${t}`, `${u}.gnd`);
    b.wire('PSU1.positive', `${g}.vcc`)
      .wire(`${g}.gnd`, 'GND1.ref')
      .wire(`${g}.b`, 'PSU1.positive');
    b.wire(`${u}.y1`, `${g}.a`);
    expect(fails(solve(b))).toMatchObject(undrivenSupply(u, 'vcc'));
  });
  it('(d) V_CC through a forward LED from 5 V: refused (I_CC would drop ≈ 1.5 V, not simulated)', () => {
    const { b, u1 } = chain(5.0, (bb, uu) => {
      const d = bb.add('component.led');
      bb.wire('PSU1.positive', `${d}.anode`)
        .wire(`${d}.cathode`, `${uu}.vcc`)
        .wire(`${uu}.gnd`, 'GND1.ref');
    });
    expect(fails(solve(b))).toMatchObject(undrivenSupply(u1, 'vcc'));
  });
  it('GND through a reverse diode to GND: refused naming GND', () => {
    const { b, u1 } = chain(
      3.3,
      (bb, uu) => {
        const d = bb.add('component.diode');
        bb.wire('PSU1.positive', `${uu}.vcc`)
          .wire(`${uu}.gnd`, `${d}.cathode`)
          .wire(`${d}.anode`, 'GND1.ref');
      },
      false,
    );
    expect(fails(solve(b))).toMatchObject(undrivenSupply(u1, 'gnd'));
  });
  it('V_CC through a capacitor: refused', () => {
    const { b, u1 } = chain(3.3, (bb, uu) => {
      const c = bb.add('component.capacitor');
      bb.wire('PSU1.positive', `${c}.a`).wire(`${c}.b`, `${uu}.vcc`).wire(`${uu}.gnd`, 'GND1.ref');
    });
    expect(fails(solve(b))).toMatchObject({ code: 'logic_supply_undriven', components: [u1] });
  });
  it('V_CC through an NPN in cutoff (collector → emitter): refused', () => {
    const { b, u1 } = chain(3.3, (bb, uu) => {
      const q = bb.add('component.bjt_npn');
      bb.wire('PSU1.positive', `${q}.collector`)
        .wire(`${q}.base`, 'GND1.ref')
        .wire(`${q}.emitter`, `${uu}.vcc`)
        .wire(`${uu}.gnd`, 'GND1.ref');
    });
    expect(fails(solve(b))).toMatchObject(undrivenSupply(u1, 'vcc'));
  });
  it('V_CC through an OPEN switch: not undetermined but absent — refused, never a level downstream', () => {
    const { b } = chain(3.3, (bb, uu) => {
      const s = bb.add('component.toggle_switch');
      bb.set(s, 'closed', false)
        .wire('PSU1.positive', `${s}.a`)
        .wire(`${s}.b`, `${uu}.vcc`)
        .wire(`${uu}.gnd`, 'GND1.ref');
    });
    const o = solve(b);
    expect(o.ok).toBe(false);
  });
  it('round-2 probe "diode-fed rail" (4.0 V through a forward diode): refused as an undetermined supply, honestly', () => {
    const { b } = singles('diode', 4.0);
    expect(fails(solve(b))).toMatchObject({ code: 'logic_supply_undriven', param: 'vcc' });
  });
  it('a series diode in the supply is a junction path: refused by the same rule (decision, NOTES.md)', () => {
    const s1 = singles('diode', 3.6);
    expect(fails(solve(s1.b)).code).toBe('logic_supply_undriven');
    const p = pkg('diode', 3.6);
    expect(fails(solve(p.b)).code).toBe('logic_supply_undriven');
  });
  it("A1 still works: two gates powered by another gate's HIGH output (a driven rail through a powered stage)", () => {
    const b = new Bench();
    const src = b.add('logic.gate_and');
    const u1 = b.add('logic.gate_and');
    const rl = b.add('component.resistor');
    b.psu(3.0, 0.5).ohms(rl, 100_000).wire('PSU1.negative', 'GND1.ref');
    b.wire('PSU1.positive', `${src}.vcc`).wire(`${src}.gnd`, 'GND1.ref');
    b.wire(`${src}.a`, 'PSU1.positive').wire(`${src}.b`, 'PSU1.positive');
    b.wire(`${src}.y`, `${u1}.vcc`).wire(`${u1}.gnd`, 'GND1.ref');
    b.wire(`${u1}.a`, `${u1}.vcc`)
      .wire(`${u1}.b`, `${u1}.vcc`)
      .wire(`${u1}.y`, `${rl}.a`)
      .wire(`${rl}.b`, 'GND1.ref');
    const o = solve(b);
    // The powered source's Y is a driven node: U1 is powered from it (and refused only for a
    // reason of its own supply value, never as undriven).
    if (!o.ok) expect(o.error.code).not.toBe('logic_supply_undriven');
  });
});

describe('A2: unpowered output-capable parts drive nothing (owner policy: unpowered drivers)', () => {
  it('HC-SR501 PIR with V_CC open: OUT drives nothing, the gate input floats (was LOW)', () => {
    const { b, g } = base(3.3);
    const p = b.add('sensor.pir_hc_sr501');
    b.wire(`${p}.gnd`, 'GND1.ref').wire(`${p}.out`, `${g}.a`);
    expect(fails(solve(b))).toMatchObject(floatingA(g));
  });

  it('HC-SR501 PIR at 3.3 V, below its 4.5 V minimum: unpowered, floats (was LOW, no warning)', () => {
    const { b, g } = base(3.3);
    const p = b.add('sensor.pir_hc_sr501');
    b.wire(`${p}.gnd`, 'GND1.ref').wire(`${p}.vcc`, 'PSU1.positive').wire(`${p}.out`, `${g}.a`);
    expect(fails(solve(b))).toMatchObject(floatingA(g));
  });

  it('HC-SR501 PIR powered (5 V) with motion: OUT HIGH through R14 = 1 kΩ (3.3 V into the gate)', () => {
    const b = new Bench();
    const g = b.add('logic.gate_and');
    const p = b.add('sensor.pir_hc_sr501');
    b.psu(5, 0.5).wire('PSU1.negative', 'GND1.ref');
    const p2 = b.add('instrument.lab_psu');
    b.set(p2, 'setpointVoltage', { value: 3, unit: 'volt' })
      .set(p2, 'currentLimit', { value: 0.1, unit: 'ampere' })
      .set(p2, 'outputEnabled', true)
      .wire(`${p2}.negative`, 'GND1.ref');
    b.wire(`${p2}.positive`, `${g}.vcc`)
      .wire(`${g}.gnd`, 'GND1.ref')
      .wire(`${g}.b`, `${p2}.positive`);
    b.wire('PSU1.positive', `${p}.vcc`).wire(`${p}.gnd`, 'GND1.ref').wire(`${p}.out`, `${g}.a`);
    b.set(p, 'motion', true);
    const o = ok(solve(b));
    expect(o.components[g]!.logic!.gates[0]!.inputs[0]).toMatchObject({ level: 'high' });
    expect(o.components[g]!.logic!.gates[0]!.inputs[0]!.volts!).toBeCloseTo(3.3, 9);
    // Without motion: LOW through R14 to the module's GND.
    b.set(p, 'motion', false);
    expect(ok(solve(b)).components[g]!.logic!.gates[0]!.inputs[0]!.level).toBe('low');
  });

  it('HC-SR04 unpowered: ECHO drives nothing (already so), the input floats', () => {
    const { b, g } = base(3.3);
    const p = b.add('sensor.hc_sr04');
    b.wire(`${p}.gnd`, 'GND1.ref').wire(`${p}.echo`, `${g}.a`);
    expect(fails(solve(b))).toMatchObject(floatingA(g));
  });

  it('relay contacts are passive switches: NO open floats; NC closed to a GND COM is a real LOW', () => {
    for (const [term, expected] of [
      ['no', 'floating'],
      ['nc', 'low'],
    ] as const) {
      const { b, g } = base(3.3);
      const k = b.add('component.relay');
      b.wire(`${k}.coil1`, 'GND1.ref').wire(`${k}.coil2`, 'GND1.ref').wire(`${k}.com`, 'GND1.ref');
      b.wire(`${k}.${term}`, `${g}.a`);
      const o = solve(b);
      if (expected === 'floating') expect(fails(o)).toMatchObject(floatingA(g));
      else expect(ok(o).components[g]!.logic!.gates[0]!.inputs[0]!.level).toBe('low');
    }
  });

  it('relay NC closed with COM open: floats (the contact connects to nothing)', () => {
    const { b, g } = base(3.3);
    const k = b.add('component.relay');
    b.wire(`${k}.coil1`, 'GND1.ref').wire(`${k}.coil2`, 'GND1.ref').wire(`${k}.nc`, `${g}.a`);
    // The contact's open COM leaves an island no source references: refused (as floating).
    expect(['logic_input_floating', 'floating_circuit']).toContain(fails(solve(b)).code);
  });

  it('a photoresistor to GND is resistive: a real LOW', () => {
    const { b, g } = base(3.3);
    const z = b.add('component.photoresistor');
    b.wire(`${z}.a`, `${g}.a`).wire(`${z}.b`, 'GND1.ref');
    expect(ok(solve(b)).components[g]!.logic!.gates[0]!.inputs[0]!.level).toBe('low');
  });

  it('a buzzer to GND is a nonlinear load, not a driver: floats', () => {
    const { b, g } = base(3.3);
    const z = b.add('component.buzzer');
    b.wire(`${z}.positive`, `${g}.a`).wire(`${z}.negative`, 'GND1.ref');
    expect(fails(solve(b))).toMatchObject(floatingA(g));
  });
});
