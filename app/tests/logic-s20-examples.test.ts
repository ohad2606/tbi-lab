/**
 * Sprint 20 logic examples through the production engine, as the app and the Session Host solve
 * them: A `logic-and-switches`, B `logic-cascade`, C `esp32-logic-quad-and` (extended with the
 * 1A/1B pull-downs), D `esp32-logic-override`. For each: the netlist (what is connected to what),
 * the complete truth table through the solve, the operating points against the datasheet
 * envelope, and the EN/HE diagnostics of the refusals a user can provoke from the example.
 *
 * Datasheet figures: SN74LVC1G08 SCES217AA / SN74LVC1G32 SCES219W §5.5 at V_CC = 3.0 V
 * (V_OH ≥ V_CC − 0.1 V at 100 µA, ≥ 2.4 V at 16 mA; V_OL ≤ 0.1 V at 100 µA, ≤ 0.4 V at 16 mA);
 * SN74LVC08A SCAS283W §5.7 at 3.0 V (V_OH ≥ V_CC − 0.2 V at 100 µA, ≥ 2.4 V at 12 mA).
 */
import { describe, expect, it } from 'vitest';
import { createSnapshot, setParam, type ProjectDocument, MODEL_LIMITATIONS } from '@tbi-lab/domain';
import {
  EngineSession,
  LVC1G_CARDS,
  ratingWarnings,
  type RuntimePinMode,
  type SolveOutcome,
  type SolveSuccess,
} from '@tbi-lab/engine';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import { buildSessionRequest } from '../src/runtime/snapshot.js';
import { getLocale, translate } from '../src/i18n/i18n.js';
import type { MessageKey } from '../src/i18n/messages.en.js';
import { engineErrorMessage } from '../src/sim/format.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${JSON.stringify(o.error)}`);
  return o;
};
const doc = (id: string) => EXAMPLES.find((e) => e.id === id)!.document;
const en = getLocale('en');
const he = getLocale('he');
/** Strip the bidi isolation marks the formatter adds around technical runs. */
const plain = (s: string) => s.replace(/[⁦-⁩‎‏]/g, '');

/** Which terminals share a net with `component.terminal` (the netlist, from the snapshot). */
function netOf(d: ProjectDocument, component: string, terminal: string): string[] {
  const snap = createSnapshot(d);
  const net = snap.connections.find(
    (c) => c.component === component && c.terminal === terminal,
  )!.net;
  return snap.connections
    .filter((c) => c.net === net)
    .map((c) => `${c.component}.${c.terminal}`)
    .sort();
}
const groundNet = (d: ProjectDocument, component: string, terminal: string) => {
  const snap = createSnapshot(d);
  const net = snap.connections.find(
    (c) => c.component === component && c.terminal === terminal,
  )!.net;
  return snap.nets.find((n) => n.id === net)!.role === 'ground';
};
const withSwitches = (d: ProjectDocument, closed: Record<string, boolean>) => {
  let out = d;
  for (const [id, v] of Object.entries(closed)) {
    const r = setParam(out, id, 'closed', v);
    if (!r.ok) throw new Error(r.error);
    out = r.doc;
  }
  return out;
};
const local = (d: ProjectDocument) => new EngineSession(createSnapshot(d)).solve();

/** The board-less request and pad attachments, exactly as the app sends them to the host. */
function hosted(d: ProjectDocument) {
  const plan = buildSessionRequest(d, () => ({ sha256: '0'.repeat(64), origin: 'program' }));
  if (!plan.ok) throw new Error(JSON.stringify(plan.error));
  const { circuit, attachments } = plan.plan.request;
  return { s: new EngineSession(circuit, { pins: attachments }), attachments };
}

describe('A logic-and-switches: two switches → SN74LVC1G08 → LED', () => {
  const A = doc('logic-and-switches');

  it('netlist: each switch to its 10 kΩ pull-down and a gate input; Y → 220 Ω → LED; supply 3.0 V', () => {
    expect(netOf(A, 'U1', 'a')).toEqual(['R1.a', 'SW1.b', 'U1.a']);
    expect(netOf(A, 'U1', 'b')).toEqual(['R2.a', 'SW2.b', 'U1.b']);
    expect(netOf(A, 'U1', 'y')).toEqual(['R3.a', 'U1.y']);
    expect(netOf(A, 'D1', 'anode')).toEqual(['D1.anode', 'R3.b']);
    expect(netOf(A, 'U1', 'vcc')).toEqual(['PSU1.positive', 'SW1.a', 'SW2.a', 'U1.vcc']);
    for (const [c, t] of [
      ['R1', 'b'],
      ['R2', 'b'],
      ['U1', 'gnd'],
      ['D1', 'cathode'],
    ] as const)
      expect(groundNet(A, c, t), `${c}.${t}`).toBe(true);
    const params = (id: string) => A.components.find((c) => c.id === id)!.params;
    expect(params('PSU1').setpointVoltage).toEqual({ value: 3, unit: 'volt' });
    expect(params('R1').resistance).toEqual({ value: 10_000, unit: 'ohm' });
    expect(params('R3').resistance).toEqual({ value: 220, unit: 'ohm' });
    // As shipped: A closed, B open (the LED is off; toggling B lights it).
    expect(params('SW1').closed).toBe(true);
    expect(params('SW2').closed).toBe(false);
  });

  it('truth table through the solve; the LED current lies on the guaranteed envelope; no rating warning', () => {
    for (const [a, b] of [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ] as const) {
      const d = withSwitches(A, { SW1: a, SW2: b });
      const o = ok(local(d));
      const u = o.components.U1!;
      const at = `A=${+a} B=${+b}`;
      expect(
        u.logic!.gates[0]!.inputs.map((p) => p.level),
        at,
      ).toEqual([a ? 'high' : 'low', b ? 'high' : 'low']);
      // The inputs sit exactly at a rail: a closed switch to 3.0 V, an open one through 10 kΩ to GND.
      expect(
        u.logic!.gates[0]!.inputs.map((p) => p.volts),
        at,
      ).toEqual([a ? 3 : 0, b ? 3 : 0]);
      expect(u.logic!.gates[0]!.output.level, at).toBe(a && b ? 'high' : 'low');
      const i = o.components.D1!.current!;
      if (a && b) {
        expect(i, at).toBeGreaterThan(3e-3);
        expect(i, at).toBeLessThan(16e-3);
        const k = (3.0 - 2.4 - 0.1) / (16e-3 - 100e-6);
        expect(u.terminals.y!, at).toBeCloseTo(3.0 - (0.1 + (i - 100e-6) * k), 9);
        expect(u.currents!.y!, at).toBeCloseTo(i, 12);
      } else expect(i, at).toBeLessThan(1e-9);
      expect(ratingWarnings(createSnapshot(d), o), at).toEqual([]);
    }
  });

  it('removing a pull-down leaves B floating with SW2 open: refused, EN and HE name the pin', () => {
    const d = structuredClone(A);
    d.components = d.components.filter((c) => c.id !== 'R2');
    d.layout.wires = d.layout.wires.filter(
      (w) =>
        !(w.from.kind === 'terminal' && w.from.component === 'R2') &&
        !(w.to.kind === 'terminal' && w.to.component === 'R2'),
    );
    const o = local(d);
    if (o.ok) throw new Error('expected a refusal');
    expect(o.error).toMatchObject({ code: 'logic_input_floating', components: ['U1'], param: 'b' });
    expect(plain(engineErrorMessage(en, o.error, d))).toContain(
      'nothing drives input B: no resistive or source path',
    );
    expect(plain(engineErrorMessage(he, o.error, d))).toContain('כניסה B');
  });

  it('a supply of 5.0 V instead: the 3.0 V switch levels are fine, but the sheet characterizes 5 V outputs only to 100 µA: the LED is refused', () => {
    const r = setParam(withSwitches(A, { SW2: true }), 'PSU1', 'setpointVoltage', {
      value: 5,
      unit: 'volt',
    });
    if (!r.ok) throw new Error(r.error);
    const o = local(r.doc);
    if (o.ok) throw new Error('expected a refusal');
    expect(o.error).toMatchObject({ code: 'logic_output_uncharacterized', components: ['U1'] });
    expect(plain(engineErrorMessage(en, o.error, r.doc))).toContain('at 5 V');
    expect(plain(engineErrorMessage(he, o.error, r.doc))).toContain('5 V');
  });
});

describe('B logic-cascade: (A·B·C) + D across an SN74LVC08A and an SN74LVC1G32', () => {
  const B = doc('logic-cascade');

  it('netlist: 1Y → 2A inside the package, 2Y → OR input A across packages, D → OR input B; gates 3/4 inputs to GND', () => {
    expect(netOf(B, 'U1', 'a1')).toEqual(['R1.a', 'SW1.b', 'U1.a1']);
    expect(netOf(B, 'U1', 'b1')).toEqual(['R2.a', 'SW2.b', 'U1.b1']);
    expect(netOf(B, 'U1', 'b2')).toEqual(['R3.a', 'SW3.b', 'U1.b2']);
    expect(netOf(B, 'U1', 'y1')).toEqual(['U1.a2', 'U1.y1']);
    expect(netOf(B, 'U1', 'y2')).toEqual(['U1.y2', 'U2.a']);
    expect(netOf(B, 'U2', 'b')).toEqual(['R4.a', 'SW4.b', 'U2.b']);
    expect(netOf(B, 'U2', 'y')).toEqual(['R5.a', 'U2.y']);
    for (const t of ['a3', 'b3', 'a4', 'b4', 'gnd']) expect(groundNet(B, 'U1', t), t).toBe(true);
    expect(netOf(B, 'U1', 'vcc')).toContain('U2.vcc');
    expect(netOf(B, 'U1', 'vcc')).toContain('PSU1.positive');
  });

  // Sprint 21 (guarantee bounds): SCAS283W §5.7 specifies the SN74LVC08A input leakage I_I only at
  // V_CC = 3.6 V. At the example's 3.0 V every package input that is held through a resistance
  // (a 10 kΩ pull-down; 2A held by gate 1's output stage) has no bounded level: refused by name,
  // EN and HE (owner question S21-Q2). At 3.6 V the same circuit runs (the 1G32 on PM-1 there).
  const at = (d: ProjectDocument, volts: number) => {
    const r = setParam(d, 'PSU1', 'setpointVoltage', { value: volts, unit: 'volt' });
    if (!r.ok) throw new Error(r.error);
    return r.doc;
  };

  it('as shipped (3.0 V): every switch combination is refused, input leakage not characterized (EN/HE)', () => {
    for (let m = 0; m < 16; m++) {
      const [a, b, c, dd] = [8, 4, 2, 1].map((bit) => (m & bit) !== 0);
      const d = withSwitches(B, { SW1: a!, SW2: b!, SW3: c!, SW4: dd! });
      const o = local(d);
      if (o.ok) throw new Error(`expected a refusal at m=${m}`);
      expect(o.error).toMatchObject({
        code: 'logic_input_leakage_uncharacterized',
        components: ['U1'],
        detail: { part: 'SN74LVC08A', iiVcc: [3.6, 3.6] },
      });
      if (m === 0) {
        const msg = plain(engineErrorMessage(en, o.error, d));
        expect(msg).toContain('held through a resistance');
        expect(msg).toContain('V_CC = 3.6 V');
        const msgHe = plain(engineErrorMessage(he, o.error, d));
        expect(msgHe).toContain('V_CC = 3.6 V');
        expect(msgHe).toContain('מוחזקת דרך התנגדות');
      }
    }
  });

  it('at 3.6 V: all 16 switch combinations: LED = (A·B·C) + D; every gate on its truth-table row; no warning', () => {
    for (let m = 0; m < 16; m++) {
      const [a, b, c, dd] = [8, 4, 2, 1].map((bit) => (m & bit) !== 0) as [
        boolean,
        boolean,
        boolean,
        boolean,
      ];
      const d = at(withSwitches(B, { SW1: a, SW2: b, SW3: c, SW4: dd }), 3.6);
      const o = ok(local(d));
      const where = `A=${+a} B=${+b} C=${+c} D=${+dd}`;
      const q = o.components.U1!.logic!.gates;
      const lv = (v: boolean) => (v ? 'high' : 'low');
      expect(q[0]!.output.level, where).toBe(lv(a && b));
      expect(
        q[1]!.inputs.map((p) => p.level),
        where,
      ).toEqual([lv(a && b), lv(c)]);
      expect(q[1]!.output.level, where).toBe(lv(a && b && c));
      expect(q[2]!.output.level, where).toBe('low');
      expect(q[3]!.output.level, where).toBe('low');
      const or = o.components.U2!.logic!.gates[0]!;
      expect(
        or.inputs.map((p) => p.level),
        where,
      ).toEqual([lv(a && b && c), lv(dd)]);
      const on = (a && b && c) || dd;
      expect(or.output.level, where).toBe(lv(on));
      const i = o.components.D1!.current!;
      if (on) {
        expect(i, where).toBeGreaterThan(3e-3);
        expect(i, where).toBeLessThan(24e-3);
      } else expect(i, where).toBeLessThan(1e-9);
      // The package drives only a gate input: no DC current out of 2Y, so it sits at its rail.
      expect(o.components.U1!.currents!.y2!, where).toBeCloseTo(0, 12);
      expect(q[1]!.output.volts!, where).toBeCloseTo(a && b && c ? 3.6 : 0, 9);
      // ...but what is GUARANTEED there is the §5.7 ranged row: V_OH ≥ V_CC − 0.2 V, V_OL ≤ 0.2 V.
      expect(q[1]!.output.guarantee, where).toEqual({
        volts: expect.closeTo(a && b && c ? 3.4 : 0.2, 12),
        atA: 100e-6,
      });
      expect(ratingWarnings(createSnapshot(d), o), where).toEqual([]);
    }
  });

  it('at 3.6 V the package is on its ±100 µA row (no PM-1 bound) and the single OR gate on the PM-1 class bound', () => {
    const o = ok(local(at(withSwitches(B, { SW4: true }), 3.6)));
    expect(o.components.U2!.state).toMatchObject({ gateOutput: 'high', outputModel: 'class' });
    expect(o.components.U1!.state).toMatchObject({ outputModel: 'ranged', outputValidA: 100e-6 });
  });
});

describe('C esp32-logic-quad-and (extended): the 1A/1B pull-downs make the pre-setup state defined', () => {
  const C = doc('esp32-logic-quad-and');

  it('netlist: GPIO18 → 1A and GPIO19 → 1B, each with a 10 kΩ pull-down', () => {
    expect(netOf(C, 'U2', 'a1')).toEqual(['R4.a', 'U1.gpio18', 'U2.a1']);
    expect(netOf(C, 'U2', 'b1')).toEqual(['R5.a', 'U1.gpio19', 'U2.b1']);
    expect(groundNet(C, 'R4', 'b')).toBe(true);
    expect(groundNet(C, 'R5', 'b')).toBe(true);
  });

  it('before setup() (every pad an input): 1A is held by its 10 kΩ pull-down, and at 3.0 V the SN74LVC08A input leakage has no bound: refused (Sprint 21, S21-Q2)', () => {
    const { s } = hosted(C);
    const o = s.solve();
    if (o.ok) throw new Error('expected a refusal');
    expect(o.error).toMatchObject({
      code: 'logic_input_leakage_uncharacterized',
      components: ['U2'],
      param: 'a1',
      detail: { part: 'SN74LVC08A', vcc: 3, iiVcc: [3.6, 3.6] },
    });
    expect(plain(engineErrorMessage(en, o.error, C))).toContain(
      'input 1A is held through a resistance',
    );
    expect(plain(engineErrorMessage(he, o.error, C))).toContain('1A');
  });

  it('WITHOUT the pull-downs the pre-setup state is refused (1A floating, held only by GPIO18 in input mode), EN and HE', () => {
    const d = structuredClone(C);
    d.components = d.components.filter((c) => c.id !== 'R4' && c.id !== 'R5');
    d.layout.wires = d.layout.wires.filter(
      (w) =>
        ![w.from, w.to].some(
          (e) => e.kind === 'terminal' && (e.component === 'R4' || e.component === 'R5'),
        ),
    );
    const { s } = hosted(d);
    const o = s.solve();
    if (o.ok) throw new Error('expected a refusal');
    expect(o.error).toMatchObject({
      code: 'logic_input_floating',
      components: ['U2'],
      param: 'a1',
      detail: { pads: [18] },
    });
    const msgEn = plain(engineErrorMessage(en, o.error, d));
    expect(msgEn).toContain('nothing drives input 1A');
    expect(msgEn).toContain('is GPIO18, an ESP32 pin in input mode');
    expect(msgEn).toContain('10 kΩ');
    const msgHe = plain(engineErrorMessage(he, o.error, d));
    expect(msgHe).toContain('1A');
    expect(msgHe).toContain('GPIO18');
    // Once the firmware drives the pads the inputs are driven, but through the pads' 16.5 Ω, and
    // at 3.0 V the package's input leakage has no bound (Sprint 21): refused by name.
    s.setPinMode(18, 'output-high');
    s.setPinMode(19, 'output-high');
    const o2 = s.solve();
    if (o2.ok) throw new Error('expected a refusal');
    expect(o2.error).toMatchObject({
      code: 'logic_input_leakage_uncharacterized',
      components: ['U2'],
    });
  });
});

describe('D esp32-logic-override: ESP32 + manual switch → SN74LVC1G32 → LED, read back on GPIO19', () => {
  const D = doc('esp32-logic-override');

  it('netlist: GPIO18 → A (10 kΩ pull-down), switch → B (10 kΩ pull-down), Y → 220 Ω → LED and → GPIO19', () => {
    expect(netOf(D, 'U2', 'a')).toEqual(['R3.a', 'U1.gpio18', 'U2.a']);
    expect(netOf(D, 'U2', 'b')).toEqual(['R2.a', 'SW1.a', 'U2.b']);
    expect(netOf(D, 'U2', 'y')).toEqual(['R1.a', 'U1.gpio19', 'U2.y']);
    expect(netOf(D, 'SW1', 'b')).toContain('PSU1.positive');
    expect(netOf(D, 'U2', 'vcc')).toContain('PSU1.positive');
    const { attachments } = hosted(D);
    expect(attachments.map((a) => a.gpio).sort((x, y) => x - y)).toEqual([18, 19]);
  });

  it("the firmware's cases: GPIO18 HIGH/LOW × switch open/closed; GPIO19 (input) reads the gate", () => {
    // Sprint 21 review (item 3): whenever Y is HIGH it sources the LED (several mA), so at 3.0 V
    // only V_OH ≥ 2.4 V (the 16 mA test point) is guaranteed — below the ESP32's V_IH
    // 0.75 × 3.3 = 2.475 V: the read-back on GPIO19 is not guaranteed and the state is refused by
    // name. Y LOW (sinking only the pad's leakage) is guaranteed ≤ 0.1 V and runs.
    for (const sw of [false, true])
      for (const mode of ['output-low', 'output-high', 'input'] as RuntimePinMode[]) {
        const { s } = hosted(withSwitches(D, { SW1: sw }));
        s.setPinMode(18, mode);
        s.setPinMode(19, 'input');
        const o = s.solve();
        const a = mode === 'output-high';
        const at = `GPIO18 ${mode}, switch ${sw ? 'closed' : 'open'}`;
        const on = a || sw;
        if (on) {
          if (o.ok) throw new Error(`expected a refusal: ${at}`);
          expect(o.error, at).toMatchObject({
            code: 'logic_mcu_input_not_guaranteed',
            param: 'gpio19',
            detail: { gpio: 19, level: 'high', worst: expect.closeTo(2.4, 9) },
          });
          continue;
        }
        const ok1 = ok(o);
        const g = ok1.components.U2!.logic!.gates[0]!;
        expect(
          g.inputs.map((p) => p.level),
          at,
        ).toEqual(['low', 'low']);
        expect(g.output.level, at).toBe('low');
        expect(ok1.pins!.find((p) => p.gpio === 19)!.voltage, at).toBeLessThan(0.825);
        expect(ok1.components.D1!.current!, at).toBeLessThan(1e-9);
        expect(ratingWarnings(createSnapshot(withSwitches(D, { SW1: sw })), ok1), at).toEqual([]);
      }
  });

  it('firmware misuse: GPIO19 driven as an OUTPUT against the gate is refused by name (EN/HE)', () => {
    const { s } = hosted(D);
    s.setPinMode(18, 'output-low');
    s.setPinMode(19, 'output-high');
    const o = s.solve();
    if (o.ok) throw new Error('expected a refusal');
    expect(o.error).toMatchObject({ code: 'logic_output_uncharacterized', components: ['U2'] });
    expect(plain(engineErrorMessage(en, o.error, D))).toContain('guarantees the output only up to');
    expect(plain(engineErrorMessage(he, o.error, D))).toContain('גיליון הנתונים מבטיח');
  });

  it("the sketch is the example's program and blinks GPIO18, reading GPIO19", () => {
    const programs = Object.values(
      (D as unknown as { programs: Record<string, { text: string }> }).programs,
    );
    expect(programs).toHaveLength(1);
    expect(programs[0]!.text).toContain('const int A_PIN = 18;');
    expect(programs[0]!.text).toContain('const int Y_PIN = 19;');
    expect(programs[0]!.text).toContain('(switch override)');
  });
});

describe('Sprint 20 L1 diagnostics and limitations (EN/HE)', () => {
  it('each single gate shows its OWN t_pd figure and table (review #3), equal to its card', () => {
    const byType: Record<string, string> = {
      'logic.gate_and': 'model.logic.sn74lvc1g08',
      'logic.gate_nand': 'model.logic.sn74lvc1g00',
      'logic.gate_or': 'model.logic.sn74lvc1g32',
      'logic.gate_not': 'model.logic.sn74lvc1g04',
    };
    for (const [type, model] of Object.entries(byType)) {
      const card = LVC1G_CARDS[model]!;
      const ids = MODEL_LIMITATIONS[type as keyof typeof MODEL_LIMITATIONS]!;
      const delay = ids.find((x) => x.endsWith('_no_delay'))!;
      const ns = (s: number) => Number((s * 1e9).toFixed(3));
      const range = `${ns(card.tpd33[0])}–${ns(card.tpd33[1])} ns`;
      for (const loc of [en, he]) {
        const text = translate(loc, `limitation.${delay}` as MessageKey);
        expect(text, `${type} ${loc.code}`).toContain(card.partNumber);
        expect(text, `${type} ${loc.code}`).toContain(range);
        expect(text, `${type} ${loc.code}`).toContain('15 pF');
      }
    }
  });

  it('an undefined input names V_IL, V_IH and the supply in both languages', () => {
    const error = {
      code: 'logic_input_undefined' as const,
      components: ['U1'],
      param: 'a',
      detail: { part: 'SN74LVC1G08', value: 1.2, vcc: 3, vih: 2, vil: 0.8 },
    };
    expect(plain(engineErrorMessage(en, error, null))).toContain(
      'input A is at 1.2 V, between V_IL 800 mV and V_IH 2 V (V_CC = 3 V)',
    );
    const h = plain(engineErrorMessage(he, error, null));
    for (const s of ['1.2 V', '800 mV', '2 V', '3 V', 'A']) expect(h).toContain(s);
  });
});

describe('review round 2 (notes 6, 7): wording and locale formatting', () => {
  it('several ESP32 input pads on a floating input: plural wording, EN and HE', () => {
    const error = {
      code: 'logic_input_floating' as const,
      components: ['U1'],
      param: 'a1',
      detail: { part: 'SN74LVC08A', pads: [18, 19] },
    };
    const e = plain(engineErrorMessage(en, error, null));
    expect(e).toContain('are GPIO18, GPIO19, ESP32 pins in input mode');
    expect(e).toContain('directly or through resistors');
    const h = plain(engineErrorMessage(he, error, null));
    expect(h).toContain('GPIO18, GPIO19');
    expect(h).toContain('פינים של ESP32');
    const one = plain(engineErrorMessage(en, { ...error, detail: { pads: [18] } }, null));
    expect(one).toContain('is GPIO18, an ESP32 pin in input mode');
  });
});

describe('review round 2: layout-only moves keep the netlists (esp32-logic-and R3, esp32-logic-override GND6)', () => {
  it('esp32-logic-and: R3 still pulls A down; GPIO4 still reads Y', () => {
    const X1 = doc('esp32-logic-and');
    expect(netOf(X1, 'U2', 'a')).toEqual(['R3.a', 'U1.gpio18', 'U2.a']);
    expect(groundNet(X1, 'R3', 'b')).toBe(true);
    expect(netOf(X1, 'U2', 'y')).toEqual(['R1.a', 'U1.gpio4', 'U2.y']);
    expect(netOf(X1, 'U2', 'b')).toEqual(['R2.a', 'SW1.b', 'U2.b']);
  });
  it('esp32-logic-override: the board GND is on the ground net through GND6', () => {
    const D = doc('esp32-logic-override');
    expect(groundNet(D, 'U1', 'gnd')).toBe(true);
    expect(netOf(D, 'U1', 'gnd')).toContain('GND6.ref');
  });
});

describe('review round 3 (A3): the generic floating message names junction/capacitor paths', () => {
  it('EN and HE: "no resistive or source path", and the parts that set no level', () => {
    const error = {
      code: 'logic_input_floating' as const,
      components: ['U1'],
      param: 'a',
      detail: { part: 'SN74LVC1G08' },
    };
    const e = plain(engineErrorMessage(en, error, null));
    expect(e).toContain('nothing drives input A: no resistive or source path reaches it');
    for (const w of ['an LED', 'a diode', 'a transistor junction', 'a buzzer', 'a capacitor'])
      expect(e).toContain(w);
    expect(e).not.toContain('not connected to anything');
    const h = plain(engineErrorMessage(he, error, null));
    for (const w of ['מסלול נגדי או מקור', 'דיודה', 'קבל', 'צומת של טרנזיסטור'])
      expect(h).toContain(w);
    // The package's own wording keeps the datasheet rule.
    const p = plain(
      engineErrorMessage(en, { ...error, param: 'a3', detail: { part: 'SN74LVC08A' } }, null),
    );
    expect(p).toContain('no resistive or source path');
    expect(p).toContain('every unused input');
  });
});

describe('review round 4: an undetermined supply is refused by name (EN/HE)', () => {
  it('logic_supply_undriven names the pin and why (I_CC not simulated)', () => {
    const error = {
      code: 'logic_supply_undriven' as const,
      components: ['U1'],
      param: 'vcc',
      detail: { part: 'SN74LVC1G08' },
    };
    const e = plain(engineErrorMessage(en, error, null));
    expect(e).toContain('U1: its VCC pin is reached only through parts that do not set a voltage');
    expect(e).toContain('(I_CC) is not simulated');
    const h = plain(engineErrorMessage(he, error, null));
    expect(h).toContain('VCC');
    expect(h).toContain('I_CC');
  });
});
