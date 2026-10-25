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
    // leakage level the ESP32's load-less V_OH guarantee is relied on at (item 5); Y HIGH into the
    // LED is guaranteed only ≥ 2.4 V, below the read-back pad's V_IH 2.475 V (item 3). Those states
    // are refused by name. GPIO18 LOW: every level holds (the gate's LOW is guaranteed ≤ 0.1 V),
    // but Sprint 22 Q1 (strict): input A is GPIO18's LOW, guaranteed only ≤ 0.1 × VDD = 0.33 V,
    // not within 1 mV of GND — the gate's I_CC (bounded only with every input at 5.5 V or GND,
    // §5.5) is unbounded, and the supply's current limit is refused by name.
    const { s } = session(X1);
    for (const b of [false, true]) {
      s.setPinMode(18, 'output-low');
      s.setMomentary('SW1', b);
      const o = s.solve();
      // Button held: B at the 3.0 V rail (not 5.5 V) — I_CC unbounded at the operating point
      // itself (U2 and PSU1 named). Released: B is on its pull-down, and A (GPIO18 LOW) can be
      // ≈ 0.33 V (the pad's V_OL bound through its output resistance into the 10 kΩ, ± I_I).
      expect(o.ok ? null : o.error, `${b}`).toMatchObject(
        b
          ? {
              code: 'logic_supply_current_uncharacterized',
              components: ['U2', 'PSU1'],
              param: 'vcc',
              detail: { part: 'SN74LVC1G08', condition: 'notInputs', check: 'limit', psu: 'PSU1' },
            }
          : {
              code: 'logic_supply_current_uncharacterized',
              components: ['U2'],
              param: 'a',
              detail: {
                part: 'SN74LVC1G08',
                condition: 'notInputs',
                check: 'limit',
                worst: expect.closeTo(0.33, 2),
                pads: [18],
              },
            },
      );
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
    // 50 nA leakage ≈ 50.5 mV off GND: refused the same way. The same inputs, the same answer.
    s.setPinMode(18, 'input');
    s.setMomentary('SW1', false);
    const pre = s.solve();
    expect(pre.ok ? null : pre.error).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      param: 'a',
      detail: { check: 'limit' },
    });
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

  it('the gate at 3.3 V instead: GPIO18 LOW still refused by Q1; with the LED its V_OH ≥ 2.4 V still misses the read-back V_IH', () => {
    const d = structuredClone(X1);
    const psu = d.components.find((c) => c.id === 'PSU1')!;
    psu.params.setpointVoltage = { value: 3.3, unit: 'volt' };
    const { s } = session(d);
    s.setPinMode(18, 'output-low');
    s.setMomentary('SW1', true);
    // Sprint 22 Q1 strict: GPIO18 LOW is not exactly GND → refused by the current limit.
    const o = s.solve();
    expect(o.ok ? null : o.error).toMatchObject({
      code: 'logic_supply_current_uncharacterized',
      detail: { vcc: 3.3, check: 'limit' },
    });
    // Y HIGH would source the LED: guaranteed only V_OH ≥ 2.4 V (the class bound's 16 mA point),
    // below the read-back pad's V_IH 2.475 V — refused as at 3.0 V.
    s.setPinMode(18, 'output-high');
    expect(s.solve().ok).toBe(false);
  });
});
