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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSnapshot, type ProjectDocument } from '@tbi-lab/domain';
import { EngineSession, LVC08A_CARD, type RuntimePinMode } from '@tbi-lab/engine';
import doc from '../src/examples/data/esp32-logic-quad-and.json';

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
 * Sprint 21 (guarantee bounds): as shipped (3.0 V) every 08A input of this example is held through
 * a resistance (a 10 kΩ pull-down, an ESP32 pad's 16.5 Ω, gate 1's output stage) and SCAS283W §5.7
 * specifies the input leakage only at V_CC = 3.6 V: the example is refused by name in every pad
 * state. The golden numbers below are kept as the PREVIEW of owner option S21-Q2(b) (accept the
 * 3.6 V I_I row over 1.65–3.6 V): the card's I_I supply range is widened for that block only.
 */
describe('as shipped (Sprint 21): refused, input leakage not characterized at 3.0 V', () => {
  it('every pad-mode combination is refused by name (no level is shown)', () => {
    const modes: RuntimePinMode[] = ['input', 'output-high', 'output-low'];
    for (const m18 of modes)
      for (const m19 of modes) {
        const { s } = session(DOC);
        s.setPinMode(18, m18);
        s.setPinMode(19, m19);
        const o = s.solve();
        if (o.ok) throw new Error(`expected a refusal ${m18}/${m19}`);
        expect(o.error).toMatchObject({
          code: 'logic_input_leakage_uncharacterized',
          components: ['U2'],
          detail: { part: 'SN74LVC08A', iiVcc: [3.6, 3.6] },
        });
      }
  });
});

describe('ESP32 → SN74LVC08A → LEDs (golden; preview of owner option S21-Q2(b))', () => {
  const shipped = LVC08A_CARD.iiVcc;
  beforeAll(() => {
    (LVC08A_CARD as { iiVcc: readonly [number, number] }).iiVcc = [1.65, 3.6];
  });
  afterAll(() => {
    (LVC08A_CARD as { iiVcc: readonly [number, number] }).iiVcc = shipped;
  });

  it('the attachments are the two gate-1 inputs', () => {
    const { pins } = session(DOC);
    expect(pins.map((p) => [p.gpio, p.component, p.terminal]).sort()).toEqual([
      [18, 'U2', 'a1'],
      [19, 'U2', 'b1'],
    ]);
  });

  it('even with Q2(b): a pad driven HIGH into its 10 kΩ pull-down is refused (ESP32 V_OH has no load current, review item 5); pads as inputs or LOW: levels hold, then refused by the current limit (Q1, I_CC only at 3.6 V)', () => {
    const modes: RuntimePinMode[] = ['input', 'output-low', 'output-high'];
    for (const m18 of modes)
      for (const m19 of modes) {
        const { s } = session(DOC);
        s.setPinMode(18, m18);
        s.setPinMode(19, m19);
        const o = s.solve();
        const at = `${m18}/${m19}`;
        if (m18 === 'output-high' || m19 === 'output-high') {
          expect(o.ok ? null : o.error.code, at).toBe('logic_mcu_output_uncharacterized');
          continue;
        }
        // Sprint 22 review F2: a pad driven LOW into its 10 kΩ pull-down: at its V_OL band end
        // (0.33 V) it carries 0.33 V / 10 kΩ + 1A/1B's I_I 5 µA = 38 µA, more than the leakage on its
        // node (5 µA + its own 50 nA): the load-less V_OL guarantee is not relied on (Q7).
        if (m18 === 'output-low' || m19 === 'output-low') {
          expect(o.ok ? null : o.error, at).toMatchObject({
            code: 'logic_mcu_output_uncharacterized',
            detail: { level: 'low', value: expect.closeTo(38e-6, 9) },
          });
          continue;
        }
        // Sprint 22 Q1 (strict): every level holds even here, but the SN74LVC08A's I_CC is
        // bounded only at V_CC = 3.6 V (SCAS283W §5.7): the supply's current limit is refused.
        expect(o.ok ? null : o.error, at).toMatchObject({
          code: 'logic_supply_current_uncharacterized',
          components: ['U2', 'PSU1'],
          detail: { part: 'SN74LVC08A', condition: 'notSupply', check: 'limit' },
        });
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
