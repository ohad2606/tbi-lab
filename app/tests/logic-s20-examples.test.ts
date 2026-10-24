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

/** HIGH into a light load at 3.0 V on the SN74LVC1G (100 µA, 16 mA) segment. */
const lvc1gHighInto = (ohms: number) => {
  const k = (3.0 - 2.4 - 0.1) / (16e-3 - 100e-6);
  const I = (3.0 - 0.1 + 100e-6 * k) / (ohms + k);
  return { I, V: I * ohms };
};

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
    expect(plain(engineErrorMessage(en, o.error, d))).toContain('input B is not connected');
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

  it('all 16 switch combinations: LED = (A·B·C) + D; every gate on its truth-table row; no warning', () => {
    for (let m = 0; m < 16; m++) {
      const [a, b, c, dd] = [8, 4, 2, 1].map((bit) => (m & bit) !== 0) as [
        boolean,
        boolean,
        boolean,
        boolean,
      ];
      const d = withSwitches(B, { SW1: a, SW2: b, SW3: c, SW4: dd });
      const o = ok(local(d));
      const at = `A=${+a} B=${+b} C=${+c} D=${+dd}`;
      const q = o.components.U1!.logic!.gates;
      const lv = (v: boolean) => (v ? 'high' : 'low');
      expect(q[0]!.output.level, at).toBe(lv(a && b));
      expect(
        q[1]!.inputs.map((p) => p.level),
        at,
      ).toEqual([lv(a && b), lv(c)]);
      expect(q[1]!.output.level, at).toBe(lv(a && b && c));
      expect(q[2]!.output.level, at).toBe('low');
      expect(q[3]!.output.level, at).toBe('low');
      const or = o.components.U2!.logic!.gates[0]!;
      expect(
        or.inputs.map((p) => p.level),
        at,
      ).toEqual([lv(a && b && c), lv(dd)]);
      const on = (a && b && c) || dd;
      expect(or.output.level, at).toBe(lv(on));
      const i = o.components.D1!.current!;
      if (on) {
        expect(i, at).toBeGreaterThan(3e-3);
        expect(i, at).toBeLessThan(16e-3);
      } else expect(i, at).toBeLessThan(1e-9);
      // The package drives only a gate input: no DC current out of 2Y, so it sits at its rail.
      expect(o.components.U1!.currents!.y2!, at).toBeCloseTo(0, 12);
      expect(q[1]!.output.volts!, at).toBeCloseTo(a && b && c ? 3 : 0, 9);
      expect(ratingWarnings(createSnapshot(d), o), at).toEqual([]);
    }
  });

  it('at 3.3 V the package is still fine (no load) but the single OR gate runs on the PM-1 class bound', () => {
    const r = setParam(withSwitches(B, { SW4: true }), 'PSU1', 'setpointVoltage', {
      value: 3.3,
      unit: 'volt',
    });
    if (!r.ok) throw new Error(r.error);
    const o = ok(local(r.doc));
    expect(o.components.U2!.state).toMatchObject({ gateOutput: 'high', outputModel: 'class' });
    expect(o.components.U1!.state).toMatchObject({ outputModel: 'ranged' });
  });

  it('a load on 2Y at 3.0 V beyond the package guarantee would be refused by pin (not the case here)', () => {
    const o = ok(local(withSwitches(B, { SW1: true, SW2: true, SW3: true })));
    expect(o.components.U1!.state).toMatchObject({ outputModel: 'tabulated', outputValidA: 24e-3 });
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

  it('before setup() (every pad an input) the session starts: 1A/1B LOW, both LEDs off', () => {
    const { s } = hosted(C);
    const o = ok(s.solve());
    expect(o.components.U2!.logic!.gates[0]!.inputs.map((p) => p.level)).toEqual(['low', 'low']);
    expect(o.components.D1!.current!).toBeLessThan(1e-9);
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
    expect(msgEn).toContain('input 1A is driven only by GPIO18');
    expect(msgEn).toContain('10 kΩ');
    const msgHe = plain(engineErrorMessage(he, o.error, d));
    expect(msgHe).toContain('1A');
    expect(msgHe).toContain('GPIO18');
    // Once the firmware drives the pads, it solves.
    s.setPinMode(18, 'output-high');
    s.setPinMode(19, 'output-high');
    expect(ok(s.solve()).components.U2!.logic!.gates[0]!.output.level).toBe('high');
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
    for (const sw of [false, true])
      for (const mode of ['output-low', 'output-high', 'input'] as RuntimePinMode[]) {
        const { s } = hosted(withSwitches(D, { SW1: sw }));
        s.setPinMode(18, mode);
        s.setPinMode(19, 'input');
        const o = ok(s.solve());
        const a = mode === 'output-high';
        const at = `GPIO18 ${mode}, switch ${sw ? 'closed' : 'open'}`;
        const g = o.components.U2!.logic!.gates[0]!;
        expect(
          g.inputs.map((p) => p.level),
          at,
        ).toEqual([a ? 'high' : 'low', sw ? 'high' : 'low']);
        const on = a || sw;
        expect(g.output.level, at).toBe(on ? 'high' : 'low');
        // GPIO19 sees the gate's output: above the ESP32 V_IH 2.475 V when HIGH, ~0 V when LOW.
        const pad = o.pins!.find((p) => p.gpio === 19)!;
        if (on) expect(pad.voltage, at).toBeGreaterThan(2.475);
        else expect(pad.voltage, at).toBeLessThan(0.825);
        const i = o.components.D1!.current!;
        if (on) {
          const exp = lvc1gHighInto(220);
          expect(i, at).toBeGreaterThan(3e-3);
          expect(i, at).toBeLessThan(exp.I);
        } else expect(i, at).toBeLessThan(1e-9);
        expect(ratingWarnings(createSnapshot(withSwitches(D, { SW1: sw })), o), at).toEqual([]);
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
