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

describe('X1: ESP32 + AND gate + read-back (golden)', () => {
  const X1 = doc as unknown as ProjectDocument;

  it('A = GPIO18, B = button: the truth table through the solve; the ESP32 reads the gate back', () => {
    // Sprint 21 review: GPIO18 driven HIGH into the 10 kΩ pull-down carries ≈ 330 µA, beyond the
    // leakage level the ESP32's load-less V_OH guarantee is relied on at (item 5); Y HIGH into the
    // LED is guaranteed only ≥ 2.4 V, below the read-back pad's V_IH 2.475 V (item 3). Those states
    // are refused by name; GPIO18 LOW runs (the gate's LOW is guaranteed ≤ 0.1 V).
    const { s, full } = session(X1);
    for (const b of [false, true]) {
      s.setPinMode(18, 'output-low');
      s.setMomentary('SW1', b);
      const o = ok(s.solve());
      const g = o.components.U2!;
      expect(g.state, `${b}`).toMatchObject({
        input_a: 'low',
        input_b: b ? 'high' : 'low',
        gateOutput: 'low',
        outputModel: 'tabulated',
      });
      const pad4 = o.pins!.find((p) => p.gpio === 4)!;
      expect(interpretDigitalInput(pad4.voltage, 1)).toBe(0);
      expect(o.components.D1!.current!).toBeLessThan(1e-9);
      expect(g.terminals.y!).toBeCloseTo(0, 9);
      expect(ratingWarnings(full, o)).toEqual([]);
    }
    for (const b of [false, true]) {
      s.setPinMode(18, 'output-high');
      s.setMomentary('SW1', b);
      const o = s.solve();
      expect(o.ok ? null : o.error.code, `${b}`).toBe(
        b ? 'logic_mcu_input_not_guaranteed' : 'logic_mcu_output_uncharacterized',
      );
    }
    // The same inputs, the same answer (deterministic).
    s.setPinMode(18, 'output-low');
    s.setMomentary('SW1', true);
    expect(JSON.stringify(ok(s.solve()).components)).toBe(JSON.stringify(ok(s.solve()).components));
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

  it('PM-1: the gate at 3.3 V instead is on the 3.3 V-class bound; with the LED its V_OH ≥ 2.4 V still misses the read-back V_IH', () => {
    const d = structuredClone(X1);
    const psu = d.components.find((c) => c.id === 'PSU1')!;
    psu.params.setpointVoltage = { value: 3.3, unit: 'volt' };
    const { s } = session(d);
    s.setPinMode(18, 'output-low');
    s.setMomentary('SW1', true);
    const o = s.solve();
    if (!o.ok) throw new Error(o.error.code);
    const gate = Object.values(o.components).find((c) => c.type === 'logic.gate_and')!;
    expect(gate.state).toMatchObject({ gateOutput: 'low', outputModel: 'class' });
    // Y HIGH would source the LED: guaranteed only V_OH ≥ 2.4 V (the class bound's 16 mA point),
    // below the read-back pad's V_IH 2.475 V — refused as at 3.0 V.
    s.setPinMode(18, 'output-high');
    expect(s.solve().ok).toBe(false);
  });
});
