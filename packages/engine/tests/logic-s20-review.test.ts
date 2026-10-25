/**
 * Sprint 20 logic, review round 2 (independent review probes, /home/ubuntu/tbi-s20/review/
 * logic-review-probes, as regression tests through the real EngineSession).
 *
 * BLOCKING 1 — an undriven input must never become a valid level through a high-impedance part.
 * The rule (session.ts): a node is driven only through resistive devices, enabled sources (supply,
 * closed switch/contact, regulated output), a POWERED gate's output stage, or an ESP32 output pad.
 * Junctions (LED, diode, BJT), capacitors, constant sinks and nonlinear loads do not drive: whether
 * a junction conducts would need a threshold no model states, so it is refused, never inferred.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, type SolveOutcome } from '../src/index.js';
import { Bench } from './build.js';

const solve = (b: Bench) => new EngineSession(b.snapshot()).solve();
const fails = (o: SolveOutcome) => {
  if (o.ok) throw new Error(`expected a refusal, got ${JSON.stringify(Object.keys(o.components))}`);
  return o.error;
};

/**
 * SN74LVC1G08 (U1) at `vcc`, B HIGH, Y into 10 kΩ; A left to the caller (probe.test.ts base).
 * Sprint 22 Q1 strict: B HIGH is 5.5 V from a second supply (the I_CC test voltage, §5.5).
 */
function base(vcc: number) {
  const b = new Bench();
  const g = b.add('logic.gate_and');
  const r = b.add('component.resistor');
  b.psu(vcc, 0.5).ohms(r, 10_000).wire('PSU1.negative', 'GND1.ref');
  const hi = b.rail(5.5);
  b.wire('PSU1.positive', `${g}.vcc`)
    .wire(`${g}.gnd`, 'GND1.ref')
    .wire(`${g}.b`, `${hi}.positive`)
    .wire(`${g}.y`, `${r}.a`)
    .wire(`${r}.b`, 'GND1.ref');
  return { b, g };
}
const floatingA = (g: string) => ({ code: 'logic_input_floating', components: [g], param: 'a' });

describe('BLOCKING 1: high-impedance parts do not drive a logic input', () => {
  it('A on the anode of an LED to GND: floating (was LOW 0 V)', () => {
    const { b, g } = base(3.3);
    const d = b.add('component.led');
    b.wire(`${g}.a`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref');
    expect(fails(solve(b))).toMatchObject(floatingA(g));
  });

  it('A on the cathode of an LED from V_CC: floating (was HIGH)', () => {
    const { b, g } = base(3.3);
    const d = b.add('component.led');
    b.wire(`${g}.a`, `${d}.cathode`).wire(`${d}.anode`, 'PSU1.positive');
    expect(fails(solve(b))).toMatchObject(floatingA(g));
  });

  it('A on a reverse diode to GND: floating (was LOW)', () => {
    const { b, g } = base(3.3);
    const d = b.add('component.diode');
    b.wire(`${g}.a`, `${d}.cathode`).wire(`${d}.anode`, 'GND1.ref');
    expect(fails(solve(b))).toMatchObject(floatingA(g));
  });

  it('A on the collector of an NPN in cutoff, no pull-up: floating (was LOW)', () => {
    const { b, g } = base(3.3);
    const q = b.add('component.bjt_npn');
    b.wire(`${g}.a`, `${q}.collector`)
      .wire(`${q}.emitter`, 'GND1.ref')
      .wire(`${q}.base`, 'GND1.ref');
    expect(fails(solve(b))).toMatchObject(floatingA(g));
  });

  it('…and with the collector pull-up (open-collector inverter), driven: HIGH through the resistor', () => {
    const { b, g } = base(3.3);
    const q = b.add('component.bjt_npn');
    const rp = b.add('component.resistor');
    b.ohms(rp, 10_000)
      .wire(`${g}.a`, `${q}.collector`)
      .wire(`${q}.emitter`, 'GND1.ref')
      .wire(`${q}.base`, 'GND1.ref')
      .wire('PSU1.positive', `${rp}.a`)
      .wire(`${rp}.b`, `${g}.a`);
    // Driven HIGH through the resistor (never floating; the HIGH level check held). Sprint 22 Q1
    // strict: A at ≈ 3.3 V (not 5.5 V) leaves the I_CC test condition, so PSU1's current limit is
    // refused by that name — deferred until every level check held.
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      components: [g, 'PSU1'],
      detail: { check: 'limit', condition: 'notInputs' },
    });
  });

  it("an unpowered SN74LVC1G08 (I_off: outputs off) whose Y feeds 220 Ω + LED and a second gate: the second gate's input floats (was LOW)", () => {
    const b = new Bench();
    const g = b.add('logic.gate_and');
    const h = b.add('logic.gate_and');
    const r = b.add('component.resistor');
    const d = b.add('component.led');
    const rp = b.add('component.resistor');
    b.psu(3.0, 0.5).ohms(r, 220).ohms(rp, 1000).wire('PSU1.negative', 'GND1.ref');
    b.wire(`${g}.vcc`, `${rp}.a`)
      .wire(`${rp}.b`, 'GND1.ref')
      .wire(`${g}.gnd`, 'GND1.ref')
      .wire(`${g}.a`, 'GND1.ref')
      .wire(`${g}.b`, 'GND1.ref');
    b.wire(`${g}.y`, `${r}.a`).wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref');
    b.wire('PSU1.positive', `${h}.vcc`)
      .wire(`${h}.gnd`, 'GND1.ref')
      .wire(`${h}.b`, 'PSU1.positive')
      .wire(`${h}.a`, `${g}.y`);
    expect(fails(solve(b))).toMatchObject({
      code: 'logic_input_floating',
      components: [h],
      param: 'a',
    });
  });

  it('two gate inputs tied only to each other: floating', () => {
    const b = new Bench();
    const g = b.add('logic.gate_and');
    const h = b.add('logic.gate_and');
    b.psu(3.0, 0.5).wire('PSU1.negative', 'GND1.ref');
    for (const x of [g, h])
      b.wire('PSU1.positive', `${x}.vcc`)
        .wire(`${x}.gnd`, 'GND1.ref')
        .wire(`${x}.b`, 'PSU1.positive');
    b.wire(`${g}.a`, `${h}.a`);
    expect(fails(solve(b)).code).toBe('logic_input_floating');
  });

  it('NOTE 4: a capacitor-only input is floating, not singular_circuit', () => {
    const { b, g } = base(3.3);
    const c = b.add('component.capacitor');
    b.wire(`${g}.a`, `${c}.a`).wire(`${c}.b`, 'GND1.ref');
    expect(fails(solve(b))).toMatchObject(floatingA(g));
  });

  it('still driven: a 1 kΩ pull-down (LOW); an LED clamp on a node with a pull-up is driven (refused only for its value)', () => {
    const pd = base(3.3);
    const r2 = pd.b.add('component.resistor');
    pd.b.ohms(r2, 1000).wire(`${pd.g}.a`, `${r2}.a`).wire(`${r2}.b`, 'GND1.ref');
    // Driven LOW (5 µA × 1 kΩ = 5 mV ≤ V_IL). Sprint 22 Q1 strict: 5 mV is not within 1 mV of
    // GND, so I_CC leaves its test condition: refused by the current limit, naming A (worst 5 mV).
    expect(fails(solve(pd.b))).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      components: [pd.g, 'PSU1'],
      param: 'a',
      detail: { check: 'limit', worst: expect.closeTo(0.005, 9) },
    });
    // V_CC → 220 Ω → node A → LED → GND: the node is driven through the resistor.
    const ind = base(3.0);
    const r3 = ind.b.add('component.resistor');
    const d = ind.b.add('component.led');
    ind.b
      .ohms(r3, 220)
      .wire('PSU1.positive', `${r3}.a`)
      .wire(`${r3}.b`, `${ind.g}.a`)
      .wire(`${ind.g}.a`, `${d}.anode`)
      .wire(`${d}.cathode`, 'GND1.ref');
    // The red LED clamps the node near its forward voltage (≈ 1.93 V here): DRIVEN (not floating),
    // and that voltage lies between V_IL and V_IH, so it is refused as undefined, by its value.
    expect(fails(solve(ind.b))).toMatchObject({
      code: 'logic_input_undefined',
      param: 'a',
      detail: { value: expect.closeTo(1.93, 1) },
    });
  });
});

describe('NOTE 5: single gates check V_CC below the −0.5 V absolute minimum (§5.1)', () => {
  it('a reversed supply (−1 V) is an absolute-maximum excess on V_CC; −0.4 V is not', async () => {
    const { partModel } = await import('../src/parts.js');
    const m = partModel('logic.gate_and')!;
    const at = (vcc: number) =>
      m.ratings!({ model: 'model.logic.sn74lvc1g08' }, {
        terminals: { a: 0, b: 0, y: null, vcc, gnd: 0 },
      } as never);
    expect(at(-1)).toContainEqual({ code: 'voltage', value: -1, limit: -0.5, channel: 'vcc' });
    expect(at(-0.4).filter((w) => w.channel === 'vcc')).toEqual([]);
  });
});

describe('MINOR 3: an unpowered single gate reports its inputs as unpowered, not X', () => {
  it('V_CC = 0: inputs `off` with their measured voltage, output `off`', () => {
    const b = new Bench();
    const g = b.add('logic.gate_and');
    const r = b.add('component.resistor');
    b.psu(0, 0.5)
      .ohms(r, 10_000)
      .wire('PSU1.negative', 'GND1.ref')
      .wire('PSU1.positive', `${g}.vcc`)
      .wire(`${g}.gnd`, 'GND1.ref')
      .wire(`${g}.a`, 'GND1.ref')
      .wire(`${g}.b`, 'GND1.ref')
      .wire(`${g}.y`, `${r}.a`)
      .wire(`${r}.b`, 'GND1.ref');
    const o = solve(b);
    if (!o.ok) throw new Error(JSON.stringify(o.error));
    const gate = o.components[g]!.logic!.gates[0]!;
    expect(gate.inputs).toEqual([
      { pin: 'a', level: 'off', volts: 0 },
      { pin: 'b', level: 'off', volts: 0 },
    ]);
    expect(gate.output.level).toBe('off');
  });
});
