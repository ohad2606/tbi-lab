/**
 * Sprint 11 (R1), test matrix T-D3: the new pad warnings (gpio_input_overvoltage,
 * gpio_output_overvoltage) never fire on a shipped example. Every ESP32 example is solved as the
 * Session Host solves it (the app's own session request), in EVERY combination of its attached
 * pads' modes, and classified as the browser classifies host outcomes (ratingWarnings with the
 * project's snapshot). Local examples have no pads, so no pad warning can apply to them.
 */
import { describe, expect, it } from 'vitest';
import { createSnapshot } from '@tbi-lab/domain';
import { EngineSession, ratingWarnings, type RuntimePinMode } from '@tbi-lab/engine';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import { buildSessionRequest } from '../src/runtime/snapshot.js';

const MODES: RuntimePinMode[] = ['input', 'output-high', 'output-low'];

describe('no shipped example raises a pad over-voltage warning (T-D3)', () => {
  const boards = EXAMPLES.filter((e) =>
    e.document.components.some((c) => c.type === 'board.esp32_devkitc_wroom32'),
  );
  it('covers every ESP32 example', () => {
    expect(boards.length).toBeGreaterThanOrEqual(5);
  });
  for (const e of boards)
    it(`${e.id}: every pad-mode combination`, () => {
      const plan = buildSessionRequest(e.document, () => ({
        sha256: '0'.repeat(64),
        origin: 'program',
      }));
      if (!plan.ok) throw new Error(JSON.stringify(plan.error));
      const { circuit, attachments } = plan.plan.request;
      const full = createSnapshot(e.document);
      const gpios = attachments.map((a) => a.gpio);
      let combos = 0;
      let refused = 0;
      const refusedAt: number[] = [];
      for (let n = 0; n < MODES.length ** gpios.length; n++) {
        const s = new EngineSession(circuit, { pins: attachments });
        let k = n;
        for (const g of gpios) {
          s.setPinMode(g, MODES[k % MODES.length]!);
          k = Math.floor(k / MODES.length);
        }
        const out = s.solve();
        // Sprint 19B: firmware driving a pad as an OUTPUT against a logic gate's output (X1's
        // read-back pin): the contention current is beyond the gate's guaranteed output current,
        // so that combination is refused by name, never shown as a number.
        // Sprint 21: the SN74LVC08A example at 3.0 V is refused in every combination (its input
        // leakage is specified only at 3.6 V, owner question S21-Q2).
        if (
          !out.ok &&
          (out.error.code === 'logic_output_uncharacterized' ||
            out.error.code === 'logic_input_leakage_uncharacterized' ||
            // Sprint 21 review (items 3, 5): an ESP32 pad reading a gate HIGH that is not
            // guaranteed above its V_IH; a pad relied on for a level while it carries a load.
            out.error.code === 'logic_mcu_input_not_guaranteed' ||
            out.error.code === 'logic_mcu_output_uncharacterized' ||
            // Sprint 22 Q1 (strict): a gate input that is never at 5.5 V or exactly GND (an
            // ESP32 pad's level, a pull-down's leakage drop): I_CC unbounded, the supply's current
            // limit refused by name.
            out.error.code === 'logic_supply_current_uncharacterized' ||
            // Sprint 22 review F2/F7: the read-back pad driven onto the gate output (two drivers
            // on one net).
            out.error.code === 'logic_bound_not_established')
        ) {
          refused++;
          refusedAt.push(n);
          continue;
        }
        if (!out.ok) continue; // e.g. a relay chattering is not reachable from these examples
        combos++;
        const codes = ratingWarnings(full, out).map((w) => w.code);
        expect(codes, `${e.id} #${n}`).not.toContain('gpio_input_overvoltage');
        expect(codes, `${e.id} #${n}`).not.toContain('gpio_output_overvoltage');
      }
      expect(combos + refused).toBe(MODES.length ** gpios.length);
      // Only X1: with the button released the gate's output is LOW, so pad 4 driven HIGH against it
      // contends (× the 3 modes of GPIO18); driven LOW it agrees with the gate and solves.
      // Sprint 20, esp32-logic-override (switch open): read-back pad GPIO19 driven HIGH against
      // the gate's LOW (GPIO18 input → pulled down, or LOW: 2), driven LOW against its HIGH (1),
      // and driven HIGH (3.3 V) against its HIGH at 3.0 V: Y forced above the gate's own V_CC, a
      // wrong-way current no test point covers (1).
      const expected: Record<string, number> = {
        // Sprint 22 Q1 (strict): every combination of the three ESP32 logic examples is refused.
        'esp32-logic-and': 9,
        'esp32-logic-override': 9,
        'esp32-logic-quad-and': 9,
      };
      expect(refused, `${e.id} ${refusedAt}`).toBe(expected[e.id] ?? 0);
    });
});
