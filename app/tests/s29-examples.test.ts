/**
 * Sprint 29 examples (M2 / M4 evidence): every state of the new logic examples is SOLVED by the
 * production engine and checked within the datasheet bounds — the truth table shown is the
 * simulated operating point, never only a Boolean expression.
 *
 * - logic-half-adder: two switches → SN74LVC1G86 (S) and SN74LVC1G08 (C) at 3.3 V → two LEDs.
 * - mpy-adder-monitor: the same adder read by an ESP32 (GPIO32/33 switches, GPIO34/35 S/C), its
 *   MicroPython program passes the Build analysis, GPIO18 drives an LED; the request is the one the
 *   app sends to the Session Host (board-less circuit + pad attachments).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSnapshot, setParam, type ProjectDocument } from '@tbi-lab/domain';
import { EngineSession, type SolveOutcome, type SolveSuccess } from '@tbi-lab/engine';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import { buildSessionRequest } from '../src/runtime/snapshot.js';
import { analyzeMicroPython } from '../../runtime/builder/pyFeatures.js';
import { getLocale, translate } from '../src/i18n/i18n.js';
import { schematicLayout } from '../src/views/schematic/layout.js';
import type { MessageKey } from '../src/i18n/messages.en.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${JSON.stringify(o.error)}`);
  return o;
};
const doc = (id: string) => EXAMPLES.find((e) => e.id === id)!.document;
const withSwitches = (d: ProjectDocument, closed: Record<string, boolean>) => {
  let out = d;
  for (const [id, v] of Object.entries(closed)) {
    const r = setParam(out, id, 'closed', v);
    if (!r.ok) throw new Error(r.error);
    out = r.doc;
  }
  return out;
};
const lvl = (on: boolean) => (on ? 'high' : 'low');
const COMBOS = [
  [false, false],
  [false, true],
  [true, false],
  [true, true],
] as const;

/** Which terminal of which part a net reaches (for netlist assertions). */
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

describe('logic-half-adder (beginner): S = (A + B) · NAND(A, B), C = A · B, four gates at 3.3 V', () => {
  const H = doc('logic-half-adder');
  const G = { O: 'U1', N: 'U2', S: 'U3', C: 'U4' } as const;

  it('netlist: A and B → OR, NAND and the carry AND; OR and NAND → the sum AND; 10 kΩ pull-downs; S/C → 330 Ω → LED; no XOR part (S29-D2)', () => {
    const type = (id: string) => H.components.find((c) => c.id === id)!.type;
    expect([G.O, G.N, G.S, G.C].map(type)).toEqual([
      'logic.gate_or',
      'logic.gate_nand',
      'logic.gate_and',
      'logic.gate_and',
    ]);
    expect(H.components.some((c) => c.type === 'logic.gate_xor')).toBe(false);
    expect(netOf(H, G.O, 'a')).toEqual(
      expect.arrayContaining(['SW1.b', `${G.N}.a`, `${G.C}.a`, `${G.O}.a`]),
    );
    expect(netOf(H, G.O, 'b')).toEqual(
      expect.arrayContaining(['SW2.b', `${G.N}.b`, `${G.C}.b`, `${G.O}.b`]),
    );
    expect(netOf(H, G.O, 'y')).toEqual([`${G.O}.y`, `${G.S}.a`].sort());
    expect(netOf(H, G.N, 'y')).toEqual([`${G.N}.y`, `${G.S}.b`].sort());
    for (const u of Object.values(G))
      expect(netOf(H, u, 'vcc'), u).toEqual(expect.arrayContaining(['PSU1.positive']));
    const pulls = H.components.filter(
      (c) =>
        c.type === 'component.resistor' &&
        (c.params.resistance as { value: number }).value === 10_000,
    );
    expect(pulls).toHaveLength(2);
    expect(netOf(H, G.S, 'y').some((t) => /^R\d+\.a$/.test(t))).toBe(true);
  });

  it('all four switch states: S = A ⊕ B and C = A · B from the solve (the OR/NAND stage too); LEDs lit exactly when HIGH; I_CC bounded (ΔI_CC)', () => {
    for (const [a, b] of COMBOS) {
      const d = withSwitches(H, { SW1: a, SW2: b });
      const o = ok(new EngineSession(createSnapshot(d)).solve());
      const at = `A=${+a} B=${+b}`;
      const lv = (id: string) => o.components[id]!.logic!.gates[0]!.output.level;
      expect(lv(G.O), at).toBe(lvl(a || b));
      expect(lv(G.N), at).toBe(lvl(!(a && b)));
      expect(lv(G.S), at).toBe(lvl(a !== b));
      expect(lv(G.C), at).toBe(lvl(a && b));
      const leds = H.components.filter((c) => c.type === 'component.led').map((c) => c.id);
      expect(leds).toHaveLength(2);
      const [ledS, ledC] = leds as [string, string];
      for (const [led, on] of [
        [ledS, a !== b],
        [ledC, a && b],
      ] as const)
        if (on) expect(o.components[led]!.current!, at).toBeGreaterThan(2e-3);
        else expect(Math.abs(o.components[led]!.current!), at).toBeLessThan(1e-9);
      // The sum AND is fed by gate outputs: on the ΔI_CC basis with both inputs counted.
      expect(o.components[G.S]!.state, at).toMatchObject({
        iccBasis: 'deltaIcc',
        deltaIccInputs: 2,
      });
    }
  });

  it('deterministic and locale-neutral: the same document solves byte-identically (EN and HE share the project)', () => {
    const run = () => JSON.stringify(new EngineSession(createSnapshot(H)).solve());
    expect(run()).toBe(run());
  });

  it('title and summary exist in EN and HE', () => {
    for (const l of ['en', 'he'])
      for (const k of ['title', 'summary'])
        expect(
          translate(getLocale(l), `example.logic-half-adder.${k}` as MessageKey).length,
        ).toBeGreaterThan(10);
  });
});

describe('logic-full-adder (intermediate, M2): four stages, seven gates, every level from the solve', () => {
  const F = doc('logic-full-adder');
  const G = { O1: 'U1', N1: 'U2', X: 'U3', O2: 'U4', N2: 'U5', S: 'U6', CO: 'U7' } as const;

  it('netlist: X = (A + B)·NAND(A, B); S = (X + Cin)·NAND(X, Cin); Cout = NAND(NAND(A, B), NAND(X, Cin)); no XOR part', () => {
    const type = (id: string) => F.components.find((c) => c.id === id)!.type;
    expect(Object.values(G).map(type)).toEqual([
      'logic.gate_or',
      'logic.gate_nand',
      'logic.gate_and',
      'logic.gate_or',
      'logic.gate_nand',
      'logic.gate_and',
      'logic.gate_nand',
    ]);
    expect(netOf(F, G.O1, 'a')).toEqual(expect.arrayContaining(['SW1.b', `${G.N1}.a`]));
    expect(netOf(F, G.O1, 'b')).toEqual(expect.arrayContaining(['SW2.b', `${G.N1}.b`]));
    expect(netOf(F, G.X, 'a')).toEqual([`${G.O1}.y`, `${G.X}.a`].sort());
    expect(netOf(F, G.N1, 'y')).toEqual([`${G.CO}.a`, `${G.N1}.y`, `${G.X}.b`].sort());
    expect(netOf(F, G.X, 'y')).toEqual([`${G.N2}.a`, `${G.O2}.a`, `${G.X}.y`].sort());
    expect(netOf(F, G.O2, 'b')).toEqual(expect.arrayContaining(['SW3.b', `${G.N2}.b`]));
    expect(netOf(F, G.N2, 'y')).toEqual([`${G.CO}.b`, `${G.N2}.y`, `${G.S}.b`].sort());
    for (const u of Object.values(G))
      expect(netOf(F, u, 'vcc'), u).toEqual(expect.arrayContaining(['PSU1.positive']));
  });

  it('all eight switch states: every intermediate and final level, S and Cout = A + B + Cin, LEDs, I_CC bounded', () => {
    for (let m = 0; m < 8; m++) {
      const [a, b, cin] = [m & 4, m & 2, m & 1].map(Boolean) as [boolean, boolean, boolean];
      const o = ok(
        new EngineSession(createSnapshot(withSwitches(F, { SW1: a, SW2: b, SW3: cin }))).solve(),
      );
      const at = `A=${+a} B=${+b} Cin=${+cin}`;
      const lv = (id: string) => o.components[id]!.logic!.gates[0]!.output.level;
      const x = a !== b;
      const total = +a + +b + +cin;
      expect(lv(G.O1), at).toBe(lvl(a || b));
      expect(lv(G.N1), at).toBe(lvl(!(a && b)));
      expect(lv(G.X), at).toBe(lvl(x));
      expect(lv(G.O2), at).toBe(lvl(x || cin));
      expect(lv(G.N2), at).toBe(lvl(!(x && cin)));
      expect(lv(G.S), at).toBe(lvl(total % 2 === 1));
      expect(lv(G.CO), at).toBe(lvl(total >= 2));
      const leds = F.components.filter((c) => c.type === 'component.led').map((c) => c.id);
      const [ledS, ledC] = leds as [string, string];
      for (const [led, on] of [
        [ledS, total % 2 === 1],
        [ledC, total >= 2],
      ] as const)
        if (on) expect(o.components[led]!.current!, at).toBeGreaterThan(2e-3);
        else expect(Math.abs(o.components[led]!.current!), at).toBeLessThan(1e-9);
      for (const u of [G.X, G.S, G.CO])
        expect(o.components[u]!.state, `${at} ${u}`).toMatchObject({
          iccBasis: 'deltaIcc',
          deltaIccInputs: 2,
        });
    }
  });

  it('deterministic: byte-identical repeated solves', () => {
    const run = () => JSON.stringify(new EngineSession(createSnapshot(F)).solve());
    expect(run()).toBe(run());
  });
});

/** The board-less request and pad attachments, exactly as the app sends them to the host. */
function hosted(d: ProjectDocument) {
  const plan = buildSessionRequest(d, () => ({ sha256: '0'.repeat(64), origin: 'program' }));
  if (!plan.ok) throw new Error(JSON.stringify(plan.error));
  const { circuit, attachments } = plan.plan.request;
  return new EngineSession(circuit, { pins: attachments });
}

describe('mpy-adder-monitor (advanced, M4): switches + logic + MicroPython', () => {
  const M = doc('mpy-adder-monitor');

  it('the MicroPython program passes the Build analysis (nothing unsupported; Pin, PWM, time only)', () => {
    const src = readFileSync(
      new URL('./exampleSketches/mpy_adder_monitor.py', import.meta.url),
      'utf8',
    );
    const board = M.components.find((c) => c.type === 'board.esp32_devkitc_wroom32')!.id;
    expect(M.programs[board]!.files?.[0]?.text ?? M.programs[board]!.text).toBe(src);
    const r = analyzeMicroPython(src, ['gpio-irq', 'i2c', 'i2c-clock', 'input-read', 'pwm']);
    expect(r.unsupported).toEqual([]);
  });

  it('netlist: S → GPIO34, C → GPIO35, A → GPIO32, B → GPIO33; the gate outputs drive nothing else', () => {
    expect(netOf(M, 'U3', 'y')).toEqual(['U3.y', 'U5.gpio34']);
    expect(netOf(M, 'U4', 'y')).toEqual(['U4.y', 'U5.gpio35']);
    expect(netOf(M, 'U1', 'a')).toEqual(expect.arrayContaining(['U5.gpio32', 'SW1.b']));
    expect(netOf(M, 'U1', 'b')).toEqual(expect.arrayContaining(['U5.gpio33', 'SW2.b']));
  });

  it('every switch state, before the program runs (pads inputs) and with GPIO18 driving the LED: the pads read the guaranteed adder outputs', () => {
    for (const [a, b] of COMBOS)
      for (const led of ['input', 'output-high', 'output-low'] as const) {
        const s = hosted(withSwitches(M, { SW1: a, SW2: b }));
        for (const g of [32, 33, 34, 35]) expect(s.setPinMode(g, 'input')).toBeNull();
        expect(s.setPinMode(18, led)).toBeNull();
        const o = ok(s.solve());
        const at = `A=${+a} B=${+b} GPIO18 ${led}`;
        const pin = (g: number) => o.pins!.find((p) => p.gpio === g)!;
        const high = (v: number) => v >= 0.75 * 3.3;
        const low = (v: number) => v <= 0.25 * 3.3;
        expect(o.components.U3!.logic!.gates[0]!.output.level, at).toBe(lvl(a !== b));
        expect(o.components.U4!.logic!.gates[0]!.output.level, at).toBe(lvl(a && b));
        for (const [g, on] of [
          [34, a !== b],
          [35, a && b],
          [32, a],
          [33, b],
        ] as const)
          expect(on ? high(pin(g).voltage) : low(pin(g).voltage), `${at} GPIO${g}`).toBe(true);
        // S HIGH at GPIO34: the gate output carries only the pad's leakage, its V_OH guaranteed
        // ≥ V_CC − 0.1 V (the −100 µA row), above the ESP32's V_IH 2.475 V.
        if (a !== b) expect(pin(34).voltage, at).toBeGreaterThan(3.2);
        const d = M.components.find((c) => c.type === 'component.led')!.id;
        if (led === 'output-high') expect(o.components[d]!.current!, at).toBeGreaterThan(3e-3);
        else expect(Math.abs(o.components[d]!.current!), at).toBeLessThan(1e-9);
      }
  });

  it('generated schematic (S29 fix): gate outputs on different nets never share a label name (qualified "U3.Y", "U4.Y", not "Y" twice)', () => {
    const marks = schematicLayout(M).marks.filter((m) => m.kind === 'net') as {
      node: string;
      name: string;
    }[];
    const nodeOfName = new Map<string, string>();
    for (const m of marks) {
      const prev = nodeOfName.get(m.name);
      expect(prev === undefined || prev === m.node, `label ${m.name}`).toBe(true);
      nodeOfName.set(m.name, m.node);
    }
    expect(marks.map((m) => m.name).filter((n) => /^U\d\.Y$/.test(n)).length).toBeGreaterThan(1);
  });

  it('title and summary exist in EN and HE', () => {
    for (const l of ['en', 'he'])
      for (const k of ['title', 'summary'])
        expect(
          translate(getLocale(l), `example.mpy-adder-monitor.${k}` as MessageKey).length,
        ).toBeGreaterThan(10);
  });
});
