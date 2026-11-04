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
import { EngineSession } from '@tbi-lab/engine';
import doc from '../src/examples/data/esp32-logic-and.json';

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
  return { s };
}

describe('X1: ESP32 + AND gate + read-back (golden)', () => {
  const X1 = doc as unknown as ProjectDocument;

  it('A = GPIO18, B = button: the truth table through the solve; the ESP32 reads the gate back', () => {
    // Sprint 21 review: GPIO18 driven HIGH into the 10 kΩ pull-down carries ≈ 330 µA, beyond the
    // 100 µA the ESP32's load-less V_OH guarantee is relied on up to (item 5; S30-L1); Y HIGH into the
    // LED is guaranteed only ≥ 2.4 V, below the read-back pad's V_IH 2.475 V (item 3). Those states
    // are refused by name. GPIO18 LOW: every level holds (the gate's LOW is guaranteed ≤ 0.1 V),
    // but GPIO18's LOW carries more than leakage into the 10 kΩ pull-down (review F2, below).
    // Before S29-D1 (Q1 strict) a gate input off 5.5 V / GND by more than 1 mV also refused the
    // supply's current limit; S29-D1 bounds an input within 0.6 V of GND or V_CC by ΔI_CC.
    const { s } = session(X1);
    for (const b of [false, true]) {
      s.setPinMode(18, 'output-low');
      s.setMomentary('SW1', b);
      const o = s.solve();
      // Sprint 22 review F2: GPIO18's LOW is an ideal-source interval [0, 0.33 V]; at 0.33 V it
      // feeds R3 (10 kΩ) and A's leakage: 0.33 V / 10 kΩ + 5 µA = 38 µA. Refused under Q7 until
      // Sprint 29; within the 100 µA envelope since S30-L1 → runs: Y LOW whatever B, GPIO4 LOW.
      if (!o.ok) throw new Error(`${b}: ${JSON.stringify(o.error)}`);
      expect(o.components.U2!.state, `${b}`).toMatchObject({ gateOutput: 'low', input_a: 'low' });
      expect(o.pins!.find((p) => p.gpio === 4)!.voltage).toBeLessThan(0.825);
    }
    for (const b of [false, true]) {
      s.setPinMode(18, 'output-high');
      s.setMomentary('SW1', b);
      const o = s.solve();
      expect(o.ok ? null : o.error.code, `${b}`).toBe(
        b ? 'logic_mcu_input_not_guaranteed' : 'logic_mcu_output_uncharacterized',
      );
    }
    // Before setup() (GPIO18 an input): A sits on its 10 kΩ pull-down, 5 µA × 10 kΩ + the pad's
    // 50 nA leakage ≈ 50.5 mV off GND, B on its pull-down (button released). Before S29-D1 (Q1
    // strict) refused by the current limit; S29-D1: both within 0.6 V of GND → I_CC ≤ 10 µA +
    // 2 × 500 µA: Y LOW, the LED off, GPIO4 reads LOW. The same inputs, the same answer.
    s.setPinMode(18, 'input');
    s.setMomentary('SW1', false);
    const pre = s.solve();
    if (!pre.ok) throw new Error(JSON.stringify(pre.error));
    expect(pre.components.U2!.state).toMatchObject({
      gateOutput: 'low',
      input_a: 'low',
      input_b: 'low',
      iccBasis: 'deltaIcc',
      deltaIccA: 500e-6,
      deltaIccInputs: 2,
      iccMaxA: expect.closeTo(1.01e-3, 12),
    });
    expect(pre.pins!.find((p) => p.gpio === 4)!.voltage).toBeCloseTo(0, 9);
    expect(JSON.stringify(s.solve())).toBe(JSON.stringify(pre));
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

  it('the gate at 3.3 V instead: GPIO18 LOW runs (38 µA, S30-L1); with the LED its V_OH ≥ 2.4 V still misses the read-back V_IH', () => {
    const d = structuredClone(X1);
    const psu = d.components.find((c) => c.id === 'PSU1')!;
    psu.params.setpointVoltage = { value: 3.3, unit: 'volt' };
    const { s } = session(d);
    s.setPinMode(18, 'output-low');
    s.setMomentary('SW1', true);
    // GPIO18 LOW into its 10 kΩ pull-down: 38 µA, within the S30-L1 envelope → runs, Y LOW.
    const o = s.solve();
    if (!o.ok) throw new Error(JSON.stringify(o.error));
    expect(o.components.U2!.state).toMatchObject({ gateOutput: 'low' });
    // Y HIGH would source the LED: guaranteed only V_OH ≥ 2.4 V (the class bound's 16 mA point),
    // below the read-back pad's V_IH 2.475 V — refused as at 3.0 V.
    s.setPinMode(18, 'output-high');
    expect(s.solve().ok).toBe(false);
  });
});
