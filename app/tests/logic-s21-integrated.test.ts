/**
 * Sprint 21 Phase 5 (logic, unit level): integrated circuits through the production path
 * (project document → snapshot → engine session, and the package export/import of schema v4),
 * validating SEPARATELY: the netlist, the logic states, the solved voltages and the physical
 * limits/guarantees. Figures: SN74LVC1G08 SCES217AA / SN74LVC1G32 SCES219W §5.3, §5.5 (−40 to
 * 85 °C); ESP32 Series Datasheet v5.3 Table 5-3 (V_OH ≥ 0.8 × VDD).
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  createPackage,
  createProject,
  createSnapshot,
  parsePackage,
  SCHEMA_VERSION,
  serializePackage,
  setParam,
  type ComponentTypeId,
  type ParamValue,
  type ProjectDocument,
} from '@tbi-lab/domain';
import {
  EngineSession,
  ratingWarnings,
  type EngineError,
  type SolveOutcome,
  type SolveSuccess,
} from '@tbi-lab/engine';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import { buildSessionRequest } from '../src/runtime/snapshot.js';
import { getLocale } from '../src/i18n/i18n.js';
import { engineErrorMessage } from '../src/sim/format.js';

const en = getLocale('en');
const he = getLocale('he');
const plain = (s: string) => s.replace(/[⁦-⁩‎‏]/g, '');
const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${JSON.stringify(o.error)}`);
  return o;
};
const refused = (o: SolveOutcome): EngineError => {
  if (o.ok) throw new Error('expected a refusal');
  return o.error;
};
const solve = (d: ProjectDocument) => new EngineSession(createSnapshot(d)).solve();
const example = (id: string) => EXAMPLES.find((e) => e.id === id)!.document;

/** A tiny document builder over the domain editing operations (as the editor applies them). */
class Doc {
  doc = createProject({ projectId: 'prj_s21l', deviceId: 'd', name: 'S21 logic', appVersion: '0' });
  private x = 0;
  add(type: ComponentTypeId): string {
    this.x += 160;
    const r = addComponent(this.doc, type, { x: this.x, y: 300 });
    if (!r.ok) throw new Error(r.error);
    this.doc = r.doc;
    return r.id;
  }
  wire(a: string, b: string): this {
    const [ac, at] = a.split('.') as [string, string];
    const [bc, bt] = b.split('.') as [string, string];
    const r = addWire(
      this.doc,
      { kind: 'terminal', component: ac, terminal: at },
      { kind: 'terminal', component: bc, terminal: bt },
    );
    if (!r.ok) throw new Error(`${a}->${b}: ${r.error}`);
    this.doc = r.doc;
    return this;
  }
  set(id: string, key: string, value: ParamValue): this {
    const r = setParam(this.doc, id, key, value);
    if (!r.ok) throw new Error(`${id}.${key}: ${r.error}`);
    this.doc = r.doc;
    return this;
  }
  psu(v: number, a = 0.1): this {
    return this.set('PSU1', 'setpointVoltage', { value: v, unit: 'volt' })
      .set('PSU1', 'currentLimit', { value: a, unit: 'ampere' })
      .set('PSU1', 'outputEnabled', true);
  }
  ohms(id: string, v: number): this {
    return this.set(id, 'resistance', { value: v, unit: 'ohm' });
  }
}

/** Export as a .tbilab package and import it back (schema v4, hash-checked). */
function roundTrip(d: ProjectDocument): ProjectDocument {
  const text = serializePackage(
    createPackage(d, { appVersion: 'test', exportedAt: '2026-10-25T00:00:00Z' }),
  );
  const back = parsePackage(text);
  if (!back.ok) throw new Error(JSON.stringify(back.error));
  return back.doc;
}

const netOf = (d: ProjectDocument, ref: string) => {
  const [c, t] = ref.split('.') as [string, string];
  const snap = createSnapshot(d);
  const net = snap.connections.find((x) => x.component === c && x.terminal === t)?.net;
  return snap.connections
    .filter((x) => x.net === net)
    .map((x) => `${x.component}.${x.terminal}`)
    .sort();
};

describe("PSU + gate: the owner's circuit (screenshot d855acf4), built as drawn and corrected", () => {
  /** PSU1 5 V / 100 mA; U1 SN74LVC1G08 V_CC, A, B on PSU+; GND on `gnd`. */
  const owner = (gnd: string) => {
    const b = new Doc();
    const u = b.add('logic.gate_and');
    b.psu(5, 0.1).wire('PSU1.negative', 'GND1.ref');
    b.wire(`${u}.vcc`, 'PSU1.positive').wire(`${u}.a`, 'PSU1.positive');
    b.wire(`${u}.b`, 'PSU1.positive').wire(`${u}.gnd`, gnd);
    return { d: b.doc, u };
  };

  it('as drawn (GND on PSU+): netlist, then V_CC − GND = 0 V: unpowered, output off, no level, no guarantee', () => {
    const { d, u } = owner('PSU1.positive');
    expect(netOf(d, `${u}.gnd`)).toEqual(
      ['PSU1.positive', `${u}.a`, `${u}.b`, `${u}.gnd`, `${u}.vcc`].sort(),
    );
    const r = ok(solve(d)).components[u]!;
    // Logic state.
    expect(r.state).toMatchObject({ gateOutput: 'off', supplyV: 0 });
    expect(r.logic!.gates[0]!.inputs.map((p) => p.level)).toEqual(['off', 'off']);
    expect(r.logic!.gates[0]!.output.level).toBe('off');
    // Voltages: every pin of U1 at the same potential (5 V to the circuit's GND, 0 V to its own).
    expect(r.terminals.vcc).toBeCloseTo(5, 12);
    expect(r.terminals.gnd).toBeCloseTo(5, 12);
    expect(r.logic!.gates[0]!.inputs.map((p) => p.volts)).toEqual([0, 0]);
    // Guarantees: none claimed.
    expect(r.logic!.gates[0]!.output.guarantee).toBeUndefined();
    expect(r.logic!.vih).toBeNull();
  });

  // Sprint 22 Q1 (owner decision, strict): with A and B on PSU+ at 5 V the inputs are not at the
  // I_CC test voltage (V_I = 5.5 V or GND, SCES217AA §5.5), so the gate's own supply current has no
  // bound and the supply's current-limit check is refused by name (every level held first).
  it('corrected (GND on PSU−), Q1 strict: inputs at 5 V (not 5.5 V): refused by the supply current limit, naming U1 and PSU1 (EN/HE)', () => {
    const { d, u } = owner('PSU1.negative');
    const e = refused(solve(d));
    expect(e).toEqual({
      code: 'logic_supply_current_uncharacterized',
      components: [u, 'PSU1'],
      param: 'vcc',
      detail: { part: 'SN74LVC1G08', vcc: 5, condition: 'notInputs', check: 'limit', psu: 'PSU1' },
    });
    expect(plain(engineErrorMessage(en, e, d))).toContain('V_I = 5.5 V or GND, I_O = 0');
    expect(plain(engineErrorMessage(he, e, d))).toContain('מגבלת הזרם');
  });

  it('corrected at 5.5 V (V_CC and inputs at 5.5 V, the test condition): Y HIGH; V_IH 3.85 V; guarantee V_OH ≥ 5.4 V (|I_OH| ≤ 100 µA, §5.5); limits clean', () => {
    const { d: d0, u } = owner('PSU1.negative');
    const r0 = setParam(d0, 'PSU1', 'setpointVoltage', { value: 5.5, unit: 'volt' });
    if (!r0.ok) throw new Error(r0.error);
    const d = r0.doc;
    const o = ok(solve(d));
    const r = o.components[u]!;
    expect(r.state).toMatchObject({
      gateOutput: 'high',
      outputModel: 'ranged',
      outputValidA: 100e-6,
      iccMaxA: 10e-6,
    });
    expect(r.logic!.gates[0]!.output.volts).toBeCloseTo(5.5, 9); // the model's zero-load value
    expect(r.logic!.gates[0]!.output.guarantee!.volts).toBeCloseTo(5.4, 12);
    expect(r.logic!.gates[0]!.output.guarantee!.atA).toBe(100e-6);
    expect(r.logic!.vih).toBeCloseTo(0.7 * 5.5, 12);
    expect(r.logic!.vil).toBeCloseTo(0.3 * 5.5, 12);
    expect(ratingWarnings(createSnapshot(d), o)).toEqual([]);
  });

  it('save → export (.tbilab, schema v4) → import → the same results, both wirings', () => {
    for (const gnd of ['PSU1.positive', 'PSU1.negative']) {
      const { d } = owner(gnd);
      const back = roundTrip(d);
      expect(back.schemaVersion).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(4);
      expect(createSnapshot(back).connections).toEqual(createSnapshot(d).connections);
      // The same outcome (a result, or the same refusal) after the round trip.
      expect(solve(back)).toEqual(solve(d));
    }
  });
});

describe('Example A (two switches → SN74LVC1G08 → LED): netlist, logic, voltages, limits — separately', () => {
  const A = example('logic-and-switches');
  const closed = (a: boolean, b: boolean) => {
    let d = A;
    for (const [id, v] of [
      ['SW1', a],
      ['SW2', b],
    ] as const) {
      const r = setParam(d, id, 'closed', v);
      if (!r.ok) throw new Error(r.error);
      d = r.doc;
    }
    return d;
  };

  it('logic: the four rows; voltages: inputs at 0 V or 5.5 V exactly (Sprint 22 Q1 redesign); limits: Y current within 16 mA, guarantee stated', () => {
    for (const [a, b] of [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ] as const) {
      const d = closed(a, b);
      const o = ok(solve(d));
      const g = o.components.U1!.logic!.gates[0]!;
      const where = `A=${+a} B=${+b}`;
      expect(
        g.inputs.map((p) => p.level),
        where,
      ).toEqual([a ? 'high' : 'low', b ? 'high' : 'low']);
      expect(g.output.level, where).toBe(a && b ? 'high' : 'low');
      expect(g.inputs[0]!.volts!, where).toBeCloseTo(a ? 5.5 : 0, 9);
      const iy = o.components.U1!.currents!.y!;
      if (a && b) {
        expect(iy, where).toBeGreaterThan(1e-3);
        expect(iy, where).toBeLessThanOrEqual(16e-3);
        // §5.5 at 3.0 V: V_OH ≥ 2.4 V up to 16 mA.
        expect(g.output.guarantee, where).toEqual({ volts: 2.4, atA: 16e-3 });
        expect(g.output.volts!, where).toBeGreaterThanOrEqual(2.4);
      } else expect(g.output.guarantee!.volts, where).toBeCloseTo(0.1, 12); // V_OL ≤ 0.1 V
      expect(ratingWarnings(createSnapshot(d), o), where).toEqual([]);
    }
  });

  it('save → export → import keeps the switch states and the result', () => {
    const d = closed(true, true);
    const back = roundTrip(d);
    expect(back.components.find((c) => c.id === 'SW1')!.params.closed).toBe(true);
    expect(ok(solve(back)).components.U1!.logic).toEqual(ok(solve(d)).components.U1!.logic);
  });

  it('high-value pull-down: R1 = 220 kΩ, SW1 open: 5 µA × 220 kΩ = 1.1 V > V_IL 0.8 V → refused (EN/HE)', () => {
    let d = closed(false, true);
    const r = setParam(d, 'R1', 'resistance', { value: 220_000, unit: 'ohm' });
    if (!r.ok) throw new Error(r.error);
    d = r.doc;
    const e = refused(solve(d));
    expect(e).toMatchObject({
      code: 'logic_input_not_guaranteed',
      components: ['U1'],
      param: 'a',
      detail: { level: 'low', causes: ['leakage'] },
    });
    expect((e.detail as { worst: number }).worst).toBeCloseTo(1.1, 6);
    const msg = plain(engineErrorMessage(en, e, d));
    expect(msg).toContain('input A is LOW in the simulation (0 V)');
    expect(msg).toContain('input leakage I_I');
    expect(msg).toContain('above V_IL 800 mV');
    const msgHe = plain(engineErrorMessage(he, e, d));
    expect(msgHe).toContain('זרם זליגה בכניסה I_I');
    expect(msgHe).toContain('V_IL 800 mV');
  });

  it('series supply resistance: 10 Ω between PSU+ and V_CC with switch inputs on PSU+: I_CC not characterized → refused (EN/HE)', () => {
    // Re-feed U1.vcc through a new 10 Ω resistor (the switches stay on PSU+). At 3.3 V with A
    // closed and B open, Y is LOW (no LED current through the 10 Ω), V_CC = 3.3 V in the solve,
    // but A sits at 3.3 V: not the I_CC test voltage (5.5 V or GND).
    const b = new Doc();
    b.doc = closed(true, false);
    b.psu(3.3);
    const r = b.add('component.resistor');
    b.ohms(r, 10);
    // Move U1.vcc: delete its wire and rewire through the resistor.
    const w = b.doc.layout.wires.find((x) =>
      [x.from, x.to].some(
        (e) => e.kind === 'terminal' && e.component === 'U1' && e.terminal === 'vcc',
      ),
    )!;
    b.doc = {
      ...b.doc,
      layout: { ...b.doc.layout, wires: b.doc.layout.wires.filter((x) => x !== w) },
    };
    b.wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, 'U1.vcc');
    const e = refused(solve(b.doc));
    expect(e).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      components: ['U1'],
      param: 'vcc',
      detail: { condition: 'notInputs' },
    });
    expect(plain(engineErrorMessage(en, e, b.doc))).toContain('every input at 5.5 V or GND');
    expect(plain(engineErrorMessage(he, e, b.doc))).toContain('I_CC');
  });
});

describe('cascaded gates: SN74LVC1G08 → SN74LVC1G32 → LED at 3.3 V (PM-1 class)', () => {
  // Sprint 22 Q1 (strict): U2.A is driven by U1.Y, guaranteed only within a band (V_OH ≥ 2.9 V /
  // V_OL ≤ 0.1 V at 100 µA, §5.5), never within 1 mV of 5.5 V or GND: U2's I_CC is unbounded and
  // the supply's current limit is refused — reported only after every level check (U2.A against
  // U1's guarantee included) has held.
  it('every level held through the cascade; then refused by the current limit, naming the downstream gate', () => {
    for (const [a, b, c] of [
      [true, true, false],
      [true, false, false],
      [false, false, true],
    ] as const) {
      const d = new Doc();
      const g1 = d.add('logic.gate_and');
      const g2 = d.add('logic.gate_or');
      const r = d.add('component.resistor');
      const led = d.add('component.led');
      d.psu(3.3).wire('PSU1.negative', 'GND1.ref').ohms(r, 220);
      const hi = d.add('instrument.lab_psu');
      d.set(hi, 'setpointVoltage', { value: 5.5, unit: 'volt' })
        .set(hi, 'currentLimit', { value: 0.1, unit: 'ampere' })
        .set(hi, 'outputEnabled', true)
        .wire(`${hi}.negative`, 'GND1.ref');
      for (const g of [g1, g2]) d.wire(`${g}.vcc`, 'PSU1.positive').wire(`${g}.gnd`, 'GND1.ref');
      const lv = (on: boolean) => (on ? `${hi}.positive` : 'GND1.ref');
      d.wire(`${g1}.a`, lv(a)).wire(`${g1}.b`, lv(b)).wire(`${g1}.y`, `${g2}.a`);
      d.wire(`${g2}.b`, lv(c)).wire(`${g2}.y`, `${r}.a`).wire(`${r}.b`, `${led}.anode`);
      d.wire(`${led}.cathode`, 'GND1.ref');
      const where = `${+a}${+b}${+c}`;
      // With U2.A HIGH (≈ 3.3 V, not 5.5 V) I_CC is unbounded at the operating point itself
      // (U2 and PSU1 named); with U2.A LOW the I_CC condition fails at U1's V_OL bound (param a).
      const e = refused(solve(d.doc));
      expect(e, where).toMatchObject({
        code: 'logic_supply_current_uncharacterized',
        param: a && b ? 'vcc' : 'a',
        detail: { condition: 'notInputs', check: 'limit' },
      });
      expect(e.components?.[0], where).toBe(g2);
    }
  });
});

describe('ESP32 driving logic (pads as the app attaches them)', () => {
  const hosted = (d: ProjectDocument) => {
    const plan = buildSessionRequest(d, () => ({ sha256: '0'.repeat(64), origin: 'program' }));
    if (!plan.ok) throw new Error(JSON.stringify(plan.error));
    return new EngineSession(plan.plan.request.circuit, { pins: plan.plan.request.attachments });
  };

  it('example D: Y HIGH into the LED and GPIO19 is refused (2.4 V guaranteed < ESP32 V_IH 2.475 V); at 4.5 V GPIO18 HIGH is refused for the gate (EN/HE)', () => {
    const D = example('esp32-logic-override');
    const s = hosted(D);
    s.setPinMode(18, 'output-high');
    s.setPinMode(19, 'input');
    // Review item 3: the read-back pad reads the gate output against its own thresholds.
    const e0 = refused(s.solve());
    expect(e0).toMatchObject({ code: 'logic_mcu_input_not_guaranteed', param: 'gpio19' });
    expect(plain(engineErrorMessage(en, e0, D))).toContain('GPIO19');
    expect(plain(engineErrorMessage(en, e0, D))).toContain('V_IH 2.475 V');
    expect(plain(engineErrorMessage(he, e0, D))).toContain('GPIO19');
    const r = setParam(D, 'PSU1', 'setpointVoltage', { value: 4.5, unit: 'volt' });
    if (!r.ok) throw new Error(r.error);
    const s2 = hosted(r.doc);
    s2.setPinMode(18, 'output-high');
    const e = refused(s2.solve());
    expect(e).toMatchObject({
      code: 'logic_input_not_guaranteed',
      components: ['U2'],
      param: 'a',
      detail: { pads: [18] },
    });
    const msg = plain(engineErrorMessage(en, e, r.doc));
    expect(msg).toContain('driven HIGH by GPIO18');
    expect(msg).toContain('V_OH ≥ 2.64 V');
    expect(msg).toContain('V_IH 3.15 V');
    const msgHe = plain(engineErrorMessage(he, e, r.doc));
    expect(msgHe).toContain('GPIO18');
    expect(msgHe).toContain('2.64 V');
  });

  it('at 5.0 V the model level itself is undefined: the message explains the 3.3 V logic level (EN/HE)', () => {
    const r = setParam(example('esp32-logic-override'), 'PSU1', 'setpointVoltage', {
      value: 5,
      unit: 'volt',
    });
    if (!r.ok) throw new Error(r.error);
    const s = hosted(r.doc);
    s.setPinMode(18, 'output-high');
    const e = refused(s.solve());
    expect(e).toMatchObject({ code: 'logic_input_undefined', detail: { pads: [18] } });
    expect(plain(engineErrorMessage(en, e, r.doc))).toContain(
      '3.3 V logic, guaranteed only V_OH ≥ 2.64 V',
    );
    expect(plain(engineErrorMessage(he, e, r.doc))).toContain('3.3 V');
  });
});

describe('dense mixed circuit: 8 single gates in chains + switches + pulls + LEDs, one solve', () => {
  it('Q1 strict: a chain of single gates is refused by the current limit, naming the first unbounded gate; bounded solve time', () => {
    const d = new Doc();
    d.psu(3.3, 0.5).wire('PSU1.negative', 'GND1.ref');
    const types = ['logic.gate_and', 'logic.gate_or', 'logic.gate_nand', 'logic.gate_not'] as const;
    const gates: string[] = [];
    const sw = d.add('component.toggle_switch');
    const pd = d.add('component.resistor');
    d.ohms(pd, 10_000).set(sw, 'closed', true);
    d.wire('PSU1.positive', `${sw}.a`).wire(`${sw}.b`, `${pd}.a`).wire(`${pd}.b`, 'GND1.ref');
    let prev = `${sw}.b`;
    for (let k = 0; k < 8; k++) {
      const t = types[k % 4]!;
      const g = d.add(t);
      gates.push(g);
      d.wire(`${g}.vcc`, 'PSU1.positive').wire(`${g}.gnd`, 'GND1.ref').wire(`${g}.a`, prev);
      if (t !== 'logic.gate_not') d.wire(`${g}.b`, k % 3 === 0 ? 'PSU1.positive' : 'GND1.ref');
      prev = `${g}.y`;
    }
    const r = d.add('component.resistor');
    const led = d.add('component.led');
    d.ohms(r, 330)
      .wire(prev, `${r}.a`)
      .wire(`${r}.b`, `${led}.anode`)
      .wire(`${led}.cathode`, 'GND1.ref');
    const t0 = performance.now();
    const e = refused(solve(d.doc));
    const ms = performance.now() - t0;
    // Expected chain: k=0 AND(1,b=1)=1; k=1 OR(1,0)=1; k=2 NAND(1,0)=1; k=3 NOT(1)=0;
    // k=4 AND(0,0)=0; ... Sprint 22 Q1 (strict): every gate after the first is driven by a gate
    // output, never within 1 mV of 5.5 V or GND, so its I_CC is unbounded and the supply's
    // current limit is refused. The first such check to fail is U5's (k=4, the first gate whose
    // inputs are all LOW at the operating point): A from U4's LOW output can sit at U4's
    // guaranteed V_OL 0.1 V (100 µA row, §5.5), 0.1 V > 1 mV.
    expect(e).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      components: [gates[4]],
      param: 'a',
      detail: { condition: 'notInputs', check: 'limit', worst: expect.closeTo(0.1, 9) },
    });
    expect(ms).toBeLessThan(10_000);
  });
});

describe('Sprint 21 refusal messages: every new code and variant renders fully in EN and HE', () => {
  const cases: EngineError[] = [
    {
      code: 'logic_supply_current_uncharacterized',
      components: ['U1'],
      param: 'vcc',
      detail: { part: 'SN74LVC1G08', vcc: 3.3, condition: 'notInputs' },
    },
    {
      code: 'logic_supply_current_uncharacterized',
      components: ['U1'],
      param: 'vcc',
      detail: { part: 'SN74LVC08A', vcc: 3.3, condition: 'notSupply' },
    },
    {
      code: 'logic_supply_not_guaranteed',
      components: ['U1'],
      param: 'vcc',
      detail: {
        part: 'SN74LVC1G08',
        vcc: 3.3,
        worst: 1.3,
        range: [3, 3.6],
        causes: ['supply_current'],
      },
    },
    {
      code: 'logic_supply_not_guaranteed',
      components: ['PSU1'],
      param: 'limit',
      detail: { limit: 0.001, worst: 0.0011, causes: ['supply_current'] },
    },
    {
      code: 'logic_input_leakage_uncharacterized',
      components: ['U1'],
      param: 'a1',
      detail: { part: 'SN74LVC08A', vcc: 3, iiVcc: [3.6, 3.6] },
    },
    {
      code: 'logic_input_not_guaranteed',
      components: ['U1'],
      param: 'a',
      detail: {
        part: 'SN74LVC1G08',
        level: 'high',
        value: 3.3,
        worst: 1.8,
        vih: 2,
        vcc: 3.3,
        causes: ['leakage', 'output_guarantee'],
      },
    },
    {
      code: 'logic_input_not_guaranteed',
      components: ['U2'],
      param: 'a',
      detail: {
        part: 'SN74LVC1G08',
        level: 'high',
        value: 3.3,
        worst: 2.64,
        vih: 3.15,
        vcc: 4.5,
        causes: ['esp32_voh'],
        pads: [18],
      },
    },
    {
      code: 'logic_input_undefined',
      components: ['U2'],
      param: 'a',
      detail: {
        part: 'SN74LVC1G08',
        value: 3.3,
        vcc: 5,
        vih: 3.5,
        vil: 1.5,
        pads: [18],
        padVoh: 2.64,
      },
    },
  ];
  // Sprint 22 Q1 (strict): a supply's current limit that needs an unbounded I_CC.
  cases.push(
    {
      code: 'logic_supply_current_uncharacterized',
      components: ['U1', 'PSU1'],
      param: 'vcc',
      detail: { part: 'SN74LVC1G08', vcc: 3, condition: 'notInputs', check: 'limit', psu: 'PSU1' },
    },
    {
      code: 'logic_supply_current_uncharacterized',
      components: ['U1', 'PSU1'],
      param: 'vcc',
      detail: { part: 'SN74LVC08A', vcc: 3, condition: 'notSupply', check: 'limit', psu: 'PSU1' },
    },
    {
      code: 'logic_supply_current_uncharacterized',
      components: ['U1'],
      param: 'b',
      detail: {
        part: 'SN74LVC1G08',
        vcc: 3,
        condition: 'notInputs',
        check: 'limit',
        worst: -0.005,
        causes: ['leakage'],
      },
    },
  );
  it('Q1: the current-limit wording cites the I_CC test condition (EN and HE)', () => {
    const e = (part: string, condition: string): EngineError => ({
      code: 'logic_supply_current_uncharacterized',
      components: ['U1', 'PSU1'],
      param: 'vcc',
      detail: { part, vcc: 3, condition, check: 'limit', psu: 'PSU1' },
    });
    const g = plain(engineErrorMessage(en, e('SN74LVC1G08', 'notInputs'), null));
    expect(g).toContain('current limit');
    expect(g).toContain('V_I = 5.5 V or GND, I_O = 0');
    expect(g).toContain('§5.5');
    expect(g).toContain('here an input is not at those voltages.');
    const q = plain(engineErrorMessage(en, e('SN74LVC08A', 'notSupply'), null));
    expect(q).toContain('V_CC = 3.6 V');
    expect(q).toContain('§5.7');
    expect(q).toContain('here the supply is outside that row.');
    const h = plain(engineErrorMessage(he, e('SN74LVC1G08', 'notInputs'), null));
    expect(h).toContain('מגבלת הזרם');
    expect(h).toContain('§5.5');
  });
  // Sprint 21 review: the new codes, and item 14 (the ESP32-HIGH wording only for a HIGH input).
  cases.push(
    {
      code: 'logic_bound_not_established',
      components: ['U1'],
      detail: { reason: 'corner_unsolved' },
    },
    {
      code: 'logic_mcu_input_not_guaranteed',
      components: ['U2'],
      param: 'gpio4',
      detail: {
        gpio: 4,
        level: 'high',
        value: 2.78,
        worst: 2.4,
        vih: 2.475,
        causes: ['output_guarantee'],
      },
    },
    {
      code: 'logic_mcu_input_not_guaranteed',
      components: ['U2'],
      param: 'gpio4',
      detail: { gpio: 4, level: 'undefined', value: 1.5, vih: 2.475, vil: 0.825 },
    },
    {
      code: 'logic_mcu_output_uncharacterized',
      components: ['U2'],
      param: 'gpio18',
      detail: { gpio: 18, level: 'high', value: 3.3e-4, limit: 1e-5 },
    },
    {
      code: 'logic_mcu_pull_uncharacterized',
      components: ['U2'],
      param: 'gpio4',
      detail: { gpio: 4, mode: 'input-pullup' },
    },
  );
  it('item 14: a LOW input whose causes include the ESP32 V_OH band is not worded as "driven HIGH"', () => {
    const e: EngineError = {
      code: 'logic_input_not_guaranteed',
      components: ['U1'],
      param: 'a',
      detail: {
        part: 'SN74LVC1G08',
        level: 'low',
        value: 0.1,
        worst: 0.9,
        vil: 0.8,
        vcc: 3,
        causes: ['esp32_voh', 'leakage'],
      },
    };
    expect(plain(engineErrorMessage(en, e, null))).not.toContain('driven HIGH');
    expect(plain(engineErrorMessage(en, e, null))).toContain('above V_IL 800 mV');
  });
  cases.push(
    {
      code: 'logic_mcu_input_not_guaranteed',
      components: ['R1'],
      param: 'gpio4',
      detail: {
        gpio: 4,
        level: 'low',
        value: 0.68,
        worst: 0.92,
        vil: 0.825,
        causes: ['output_guarantee'],
      },
    },
    {
      code: 'logic_mcu_pull_uncharacterized',
      components: ['U2'],
      param: 'gpio4',
      detail: { gpio: 4, mode: 'input-pullup', role: 'reads' },
    },
  );
  it('final review N1 / S1: level-specific and trigger-specific remedies (EN/HE)', () => {
    const low: EngineError = cases.find(
      (c) =>
        c.code === 'logic_mcu_input_not_guaranteed' &&
        (c.detail as { level: string }).level === 'low',
    )!;
    expect(plain(engineErrorMessage(en, low, null))).toContain('V_OL ≤ 0.1 V at up to 100 µA');
    expect(plain(engineErrorMessage(en, low, null))).toContain('above V_IL 825 mV');
    expect(plain(engineErrorMessage(en, low, null))).not.toContain('V_OH');
    expect(plain(engineErrorMessage(he, low, null))).toContain('V_OL ≤ 0.1 V');
    const high: EngineError = cases.find(
      (c) =>
        c.code === 'logic_mcu_input_not_guaranteed' &&
        (c.detail as { level: string }).level === 'high',
    )!;
    expect(plain(engineErrorMessage(en, high, null))).toContain(
      'V_OH ≥ V_CC − 0.1 V at up to 100 µA',
    );
    const reads: EngineError = cases.find(
      (c) =>
        c.code === 'logic_mcu_pull_uncharacterized' &&
        (c.detail as { role?: string }).role === 'reads',
    )!;
    expect(plain(engineErrorMessage(en, reads, null))).toContain('Turn the internal pull off');
    expect(plain(engineErrorMessage(en, reads, null))).not.toContain('external pull');
    expect(plain(engineErrorMessage(he, reads, null))).toContain('כבו את ה-pull הפנימי');
    const holds: EngineError = {
      code: 'logic_mcu_pull_uncharacterized',
      components: ['U2'],
      param: 'gpio4',
      detail: { gpio: 4, mode: 'input-pullup', role: 'holds' },
    };
    expect(plain(engineErrorMessage(en, holds, null))).toContain('Use an external pull resistor');
  });
  cases.push({
    code: 'logic_output_uncharacterized',
    components: ['U2'],
    param: 'y',
    detail: {
      part: 'SN74LVC1G08',
      vcc: 3,
      value: 5.66e-3,
      limit: 0.024,
      reverse: true,
      causes: ['output_guarantee', 'esp32_vol'],
    },
  });
  it('verification N5: a reverse output current has its own wording and names the causes (EN/HE)', () => {
    const rev = cases.find((c) => (c.detail as { reverse?: boolean }).reverse)!;
    const m = plain(engineErrorMessage(en, rev, null));
    expect(m).toContain('the wrong way');
    expect(m).toContain('between its guaranteed level and its own rail');
    expect(m).toContain('5.66 mA');
    expect(plain(engineErrorMessage(he, rev, null))).toContain('בכיוון ההפוך');
  });
  it('no placeholder left, the part and pin named, technical runs LTR-isolated', () => {
    for (const e of cases)
      for (const lc of [en, he]) {
        const m = engineErrorMessage(lc, e, null);
        expect(m, `${e.code} ${lc.code}`).not.toMatch(/[{}]/);
        expect(plain(m), `${e.code} ${lc.code}`).toContain(e.components![0]!);
        if (e.param && e.param !== 'vcc' && e.param !== 'limit')
          expect(plain(m), `${e.code} ${lc.code}`).toContain(
            e.param.startsWith('gpio')
              ? `GPIO${e.param.slice(4)}`
              : e.param.replace(/^([a-z])(\d)$/, '$2$1').toUpperCase(),
          );
      }
  });
});
