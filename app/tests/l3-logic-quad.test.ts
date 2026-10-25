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
import { EngineSession, LVC08A_CARD, ratingWarnings, type RuntimePinMode } from '@tbi-lab/engine';
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

  it('even with Q2(b): a pad driven HIGH into its 10 kΩ pull-down is refused (ESP32 V_OH has no load current, review item 5); pads as inputs or LOW run, every output LOW', () => {
    const modes: RuntimePinMode[] = ['input', 'output-low', 'output-high'];
    for (const m18 of modes)
      for (const m19 of modes) {
        const { s, full } = session(DOC);
        s.setPinMode(18, m18);
        s.setPinMode(19, m19);
        const o = s.solve();
        const at = `${m18}/${m19}`;
        if (m18 === 'output-high' || m19 === 'output-high') {
          expect(o.ok ? null : o.error.code, at).toBe('logic_mcu_output_uncharacterized');
          continue;
        }
        if (!o.ok) throw new Error(`${at}: ${JSON.stringify(o.error)}`);
        expect(
          o.components.U2!.logic!.gates.map((g) => g.output.level),
          at,
        ).toEqual(['low', 'low', 'low', 'low']);
        expect(o.components.D1!.current!, at).toBeLessThan(1e-9);
        expect(ratingWarnings(full, o), at).toEqual([]);
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
