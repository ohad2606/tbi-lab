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
      for (let n = 0; n < MODES.length ** gpios.length; n++) {
        const s = new EngineSession(circuit, { pins: attachments });
        let k = n;
        for (const g of gpios) {
          s.setPinMode(g, MODES[k % MODES.length]!);
          k = Math.floor(k / MODES.length);
        }
        const out = s.solve();
        if (!out.ok) continue; // e.g. a relay chattering is not reachable from these examples
        combos++;
        const codes = ratingWarnings(full, out).map((w) => w.code);
        expect(codes, `${e.id} #${n}`).not.toContain('gpio_input_overvoltage');
        expect(codes, `${e.id} #${n}`).not.toContain('gpio_output_overvoltage');
      }
      expect(combos).toBe(MODES.length ** gpios.length);
    });
});
