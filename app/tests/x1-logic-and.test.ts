/**
 * Sprint 19B, Exploration Foundation acceptance project X1 (EF-D7 B): the `esp32-logic-and`
 * example as a GOLDEN numeric test. ESP32 GPIO18 and a push button (10 kΩ pull-down) drive an
 * SN74LVC1G08 AND gate at 3.0 V; the gate drives 220 Ω + LED and is read back on GPIO4.
 * The ESP32 pads are attached exactly as the Session Host attaches them (each board pin to the
 * part terminal on its net); the firmware's pad modes are set directly (the real-QEMU run of
 * the example's own sketch is runtime/tests/s19b-x1.runtime.test.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  createSnapshot,
  deleteSelection,
  emptySelection,
  type ProjectDocument,
} from '@tbi-lab/domain';
import {
  EngineSession,
  interpretDigitalInput,
  ratingWarnings,
  type SolveOutcome,
  type SolveSuccess,
} from '@tbi-lab/engine';
import doc from '../src/examples/data/esp32-logic-and.json';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${JSON.stringify(o.error)}`);
  return o;
};

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
  const s = new EngineSession(projected, { pins });
  s.setPinMode(4, 'input');
  return { s, full };
}

/**
 * SN74LVC1G08 at V_CC = 3.0 V (SCES217AA §5.5), guaranteed HIGH envelope: the drop V_CC − V_OH
 * through (0.1 V, 100 µA), (0.6 V, 16 mA), (0.7 V, 24 mA). A few-mA LED load is on the middle
 * segment: drop = 0.1 + (I − 100 µA)·0.5 V / 15.9 mA.
 */
const dropAt = (i: number) => 0.1 + (i - 100e-6) * (0.5 / 15.9e-3);

describe('X1: ESP32 + AND gate + read-back (golden)', () => {
  const X1 = doc as unknown as ProjectDocument;

  it('A = GPIO18, B = button: the truth table through the solve; the ESP32 reads the gate back', () => {
    const { s, full } = session(X1);
    const states: [boolean, boolean, 'high' | 'low'][] = [
      [false, false, 'low'],
      [true, false, 'low'],
      [false, true, 'low'],
      [true, true, 'high'],
    ];
    for (const [a, b, out] of states) {
      s.setPinMode(18, a ? 'output-high' : 'output-low');
      s.setMomentary('SW1', b);
      const o = ok(s.solve());
      const g = o.components.U2!;
      expect(g.state, `${a} ${b}`).toMatchObject({
        input_a: a ? 'high' : 'low',
        input_b: b ? 'high' : 'low',
        gateOutput: out,
        outputModel: 'tabulated',
      });
      const pad4 = o.pins!.find((p) => p.gpio === 4)!;
      expect(interpretDigitalInput(pad4.voltage, out === 'high' ? 0 : 1)).toBe(
        out === 'high' ? 1 : 0,
      );
      const led = o.components.D1!.current!;
      if (out === 'high') {
        // The gate sources the LED and the ESP32 input pad (its leakage, the pad model's own
        // current), all through its V_CC pin from PSU1; V_Y on the guaranteed envelope.
        expect(led).toBeGreaterThan(3e-3);
        expect(led).toBeLessThan(6e-3);
        const iy = g.currents!.y!;
        expect(iy).toBeCloseTo(led - pad4.current, 12);
        expect(g.currents!.vcc).toBeCloseTo(iy, 12);
        expect(g.terminals.y!).toBeCloseTo(3.0 - dropAt(iy), 9);
        // PSU1 also feeds the pressed button's 10 kΩ pull-down: 3 V / 10 kΩ = 0.3 mA.
        expect(o.components.PSU1!.current!).toBeCloseTo(iy + 3.0 / 10_000, 12);
      } else {
        expect(led).toBeLessThan(1e-9);
        expect(g.terminals.y!).toBeCloseTo(0, 9);
      }
      expect(ratingWarnings(full, o)).toEqual([]);
    }
    // The same inputs, the same numbers (deterministic).
    s.setPinMode(18, 'output-high');
    s.setMomentary('SW1', true);
    const a1 = ok(s.solve());
    const a2 = ok(s.solve());
    expect(JSON.stringify(a1.components)).toBe(JSON.stringify(a2.components));
  });

  it('without the pull-down, the released button leaves input B floating: refused, naming B', () => {
    const r = deleteSelection(X1, { ...emptySelection(), components: ['R2'] });
    if (!r.ok) throw new Error(r.error);
    const d = r.doc;
    const { s } = session(d);
    s.setPinMode(18, 'output-high');
    s.setMomentary('SW1', false);
    const o = s.solve();
    expect(o.ok ? null : o.error).toMatchObject({
      code: 'logic_input_floating',
      components: ['U2'],
      param: 'b',
    });
  });

  it('the gate at 3.3 V instead: the LED load is beyond the guaranteed ±100 µA row -> refused by name', () => {
    const d = structuredClone(X1);
    const psu = d.components.find((c) => c.id === 'PSU1')!;
    psu.params.setpointVoltage = { value: 3.3, unit: 'volt' };
    const { s } = session(d);
    s.setPinMode(18, 'output-high');
    s.setMomentary('SW1', true);
    const o = s.solve();
    expect(o.ok ? null : o.error.code).toBe('logic_output_uncharacterized');
  });
});
