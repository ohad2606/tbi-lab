/**
 * Exploration Foundation L3 interop: the `esp32-logic-quad-and` example as a GOLDEN numeric test
 * through the production engine. ESP32 GPIO18/GPIO19 → gate 1 of an SN74LVC08A at 3.0 V →
 * 220 Ω + LED D1; 1Y → 2A (a chain inside the package); push button SW1 with 10 kΩ pull-down (R3) → 2B;
 * 2Y → 220 Ω (R2) + LED D2; the unused gates' inputs tied to GND.
 *
 * The ESP32 pads are attached exactly as the Session Host attaches them (each board pin to the
 * part terminal on its net); the firmware's pad modes are set directly. Every relation below is
 * the device card's guaranteed characteristic (SCAS283W §5.7 at V_CC = 3.0 V) and Kirchhoff's
 * laws, checked on the solved numbers: nothing about the chain is assumed.
 */
import { describe, expect, it } from 'vitest';
import { createSnapshot, setParam, type ProjectDocument } from '@tbi-lab/domain';
import {
  EngineSession,
  ratingWarnings,
  type RuntimePinMode,
  type SolveOutcome,
  type SolveSuccess,
} from '@tbi-lab/engine';
import doc from '../src/examples/data/esp32-logic-quad-and.json';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${JSON.stringify(o.error)}`);
  return o;
};
const DOC = doc as unknown as ProjectDocument;

function session(d: ProjectDocument) {
  const full = createSnapshot(d);
  const board = full.components.find((c) => c.type === 'board.esp32_devkitc_wroom32')!.id;
  const projected = {
    ...full,
    components: full.components.filter((c) => c.id !== board),
    connections: full.connections.filter((c) => c.component !== board),
  };
  const pins = full.connections
    .filter((c) => c.component === board && /^gpio\d+$/.test(c.terminal))
    .map((c) => {
      const at = projected.connections.find((x) => x.net === c.net)!;
      return { gpio: Number(c.terminal.slice(4)), component: at.component, terminal: at.terminal };
    });
  return { s: new EngineSession(projected, { pins }), full, pins };
}

/**
 * SN74LVC08A at V_CC = 3.0 V, guaranteed HIGH envelope: the drop V_CC − V_OH through
 * (0.2 V, 100 µA), (0.6 V, 12 mA), (0.8 V, 24 mA). A few-mA LED load is on the first segment.
 */
const dropAt = (i: number) => 0.2 + (i - 100e-6) * (0.4 / 11.9e-3);

describe('ESP32 → SN74LVC08A → LEDs (golden)', () => {
  it('the attachments are the two gate-1 inputs', () => {
    const { pins } = session(DOC);
    expect(pins.map((p) => [p.gpio, p.component, p.terminal]).sort()).toEqual([
      [18, 'U2', 'a1'],
      [19, 'U2', 'b1'],
    ]);
  });

  it('the truth table of the chain (1Y = A·B, 2Y = 1Y·button) through the solve; LED currents on the guaranteed envelope', () => {
    const { s, full } = session(DOC);
    const lv = (b: boolean) => (b ? 'high' : 'low');
    for (const a of [false, true])
      for (const b of [false, true])
        for (const btn of [false, true]) {
          const at = `A=${+a} B=${+b} btn=${+btn}`;
          s.setPinMode(18, a ? 'output-high' : 'output-low');
          s.setPinMode(19, b ? 'output-high' : 'output-low');
          s.setMomentary('SW1', btn);
          const o = ok(s.solve());
          const u = o.components.U2!;
          const g = u.logic!.gates;
          const y1 = a && b;
          const y2 = y1 && btn;
          expect(
            g.map((x) => x.output.level),
            at,
          ).toEqual([lv(y1), lv(y2), 'low', 'low']);
          expect(
            g[0]!.inputs.map((p) => p.level),
            at,
          ).toEqual([lv(a), lv(b)]);
          expect(
            g[1]!.inputs.map((p) => p.level),
            at,
          ).toEqual([lv(y1), lv(btn)]);
          const d1 = o.components.D1!.current!;
          const d2 = o.components.D2!.current!;
          for (const [on, i, y, led, r] of [
            [y1, d1, 'y1', 'D1', 'R1'],
            [y2, d2, 'y2', 'D2', 'R2'],
          ] as const) {
            if (on) {
              expect(i, at).toBeGreaterThan(3e-3);
              expect(i, at).toBeLessThan(6e-3);
              // The output sources exactly the LED's current (2A draws none), on the envelope.
              expect(u.currents![y]!, at).toBeCloseTo(i, 12);
              expect(u.terminals[y]!, at).toBeCloseTo(3.0 - dropAt(i), 9);
              // KVL along Y → 220 Ω → LED → GND.
              expect(o.components[r]!.voltage!, at).toBeCloseTo(220 * i, 9);
              expect(u.terminals[y]! - 220 * i - o.components[led]!.voltage!, at).toBeCloseTo(0, 9);
            } else {
              expect(i, at).toBeLessThan(1e-9);
              expect(u.terminals[y]!, at).toBeCloseTo(0, 9);
            }
          }
          // The SHARED V_CC pin carries both gates' source currents; PSU1 also feeds the pressed
          // button's 10 kΩ pull-down (3 V / 10 kΩ).
          expect(u.currents!.vcc!, at).toBeCloseTo((y1 ? d1 : 0) + (y2 ? d2 : 0), 12);
          expect(o.components.PSU1!.current!, at).toBeCloseTo(
            u.currents!.vcc! + (btn ? 3.0 / 10_000 : 0),
            12,
          );
          expect(ratingWarnings(full, o), at).toEqual([]);
        }
  });

  it('a heavier LED resistor moves the operating point along the same envelope (not a fixed answer)', () => {
    const r = setParam(DOC, 'R1', 'resistance', { value: 470, unit: 'ohm' });
    if (!r.ok) throw new Error(r.error);
    const base = session(DOC);
    const heavy = session(r.doc);
    for (const { s } of [base, heavy]) {
      s.setPinMode(18, 'output-high');
      s.setPinMode(19, 'output-high');
    }
    const i220 = ok(base.s.solve()).components.D1!.current!;
    const o = ok(heavy.s.solve());
    const i470 = o.components.D1!.current!;
    expect(i470).toBeLessThan(i220);
    expect(o.components.U2!.terminals['y1']!).toBeCloseTo(3.0 - dropAt(i470), 9);
  });

  it('every pad-mode combination solves, with the levels the pad model gives (input mode: 0 V, LOW)', () => {
    // An ESP32 pad in input mode is the engine's leakage-to-GND model (esp32Gpio.ts, pre-existing):
    // the gate input sits at 0 V. Output modes give 3.3 V (HIGH: 5.5 V-tolerant input) or 0 V.
    const MODES: RuntimePinMode[] = ['input', 'output-high', 'output-low'];
    for (const m18 of MODES)
      for (const m19 of MODES) {
        const { s } = session(DOC);
        s.setPinMode(18, m18);
        s.setPinMode(19, m19);
        const o = ok(s.solve());
        const lv = (m: RuntimePinMode) => (m === 'output-high' ? 'high' : 'low');
        expect(
          o.components.U2!.logic!.gates[0]!.inputs.map((p) => p.level),
          `${m18} ${m19}`,
        ).toEqual([lv(m18), lv(m19)]);
      }
  });

  it('removing the pull-down leaves 2B floating with the button released: refused, naming 2B', () => {
    const d = structuredClone(DOC);
    // R3 is the 10 kΩ pull-down on 2B.
    d.components = d.components.filter((c) => c.id !== 'R3');
    d.layout.wires = d.layout.wires.filter(
      (w) =>
        !(w.from.kind === 'terminal' && w.from.component === 'R3') &&
        !(w.to.kind === 'terminal' && w.to.component === 'R3'),
    );
    const { s } = session(d);
    s.setPinMode(18, 'output-high');
    s.setPinMode(19, 'output-high');
    s.setMomentary('SW1', false);
    const o = s.solve();
    expect(o.ok ? null : o.error).toMatchObject({
      code: 'logic_input_floating',
      components: ['U2'],
      param: 'b2',
    });
  });
});
