/**
 * Sprint 30 (M1/M2/M4): the shipped twins esp32-logic-feedback (Arduino) and mpy-logic-feedback
 * (MicroPython), one circuit:
 * GPIO18 → U2 (SN74LVC1G08) A with R2 = 100 kΩ to GND; B ← SW1 (PERMIT) from the 3.0 V rail, R1 =
 * 10 kΩ to GND; U2.Y → GPIO4 and U3.A (U3.B at V_CC); U3.Y → R3 = 1 kΩ → Q1 (2N3904) → K1 coil on
 * PSU2 = 5 V (D1 1N4148 across it); K1 NO grounds D2's cathode, R4 = 330 Ω from 5 V.
 * Asserted through the same request the browser sends (buildSessionRequest): every GPIO18 mode ×
 * PERMIT state — U2/U3 levels, GPIO4's voltage (the firmware's feedback), the relay and the LED;
 * the edits named in the texts' "Try" (22 kΩ refused by S30-L1; 200 kΩ refused at boot); the
 * MicroPython program passes the Build analysis; texts in both locales.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSnapshot, setParam, type ProjectDocument } from '@tbi-lab/domain';
import { EngineSession, type SolveOutcome, type SolveSuccess } from '@tbi-lab/engine';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import { buildSessionRequest } from '../src/runtime/snapshot.js';
import { analyzeMicroPython } from '../../runtime/builder/pyFeatures.js';
import { getLocale, translate } from '../src/i18n/i18n.js';
import type { MessageKey } from '../src/i18n/messages.en.js';

const doc = (id: string) => EXAMPLES.find((e) => e.id === id)!.document;
const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o;
};
const edit = (d: ProjectDocument, id: string, key: string, v: unknown) => {
  const r = setParam(d, id, key, v as never);
  if (!r.ok) throw new Error(r.error);
  return r.doc;
};
function hosted(d: ProjectDocument) {
  const plan = buildSessionRequest(d, () => ({ sha256: '0'.repeat(64), origin: 'program' }));
  if (!plan.ok) throw new Error(JSON.stringify(plan.error));
  const { circuit, attachments } = plan.plan.request;
  const s = new EngineSession(circuit, { pins: attachments });
  s.setPinMode(4, 'input');
  return s;
}
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
const MODES = ['input', 'output-low', 'output-high'] as const;

for (const id of ['esp32-logic-feedback', 'mpy-logic-feedback']) {
  describe(`${id} (S30 M1/M2/M4)`, () => {
    const D = doc(id);

    it('netlist: GPIO18 → U2.a (+100 kΩ), U2.y → GPIO4 and U3.a only (no load on the read-back), U3.y → 1 kΩ → base', () => {
      expect(netOf(D, 'U2', 'a')).toEqual(['R2.a', 'U1.gpio18', 'U2.a']);
      expect(netOf(D, 'U2', 'y')).toEqual(['U1.gpio4', 'U2.y', 'U3.a']);
      expect(netOf(D, 'U3', 'y')).toEqual(['R3.a', 'U3.y']);
      expect(netOf(D, 'Q1', 'base')).toEqual(['Q1.base', 'R3.b']);
      expect(D.components.find((c) => c.id === 'R2')!.params.resistance).toEqual({
        value: 100_000,
        unit: 'ohm',
      });
    });

    it('every GPIO18 mode × PERMIT: U2.Y = request · permit; GPIO4 reads it (≥ 2.9 V / ≤ 0.1 V); the relay and the LED follow', () => {
      for (const permit of [false, true])
        for (const mode of MODES) {
          const s = hosted(edit(D, 'SW1', 'closed', permit));
          s.setPinMode(18, mode);
          const o = ok(s.solve());
          const at = `GPIO18 ${mode}, PERMIT ${permit ? 'closed' : 'open'}`;
          const y = mode === 'output-high' && permit;
          const level = (u: string) => o.components[u]!.logic!.gates[0]!.output.level;
          expect(level('U2'), at).toBe(y ? 'high' : 'low');
          expect(level('U3'), at).toBe(y ? 'high' : 'low');
          const fb = o.pins!.find((p) => p.gpio === 4)!.voltage;
          if (y) expect(fb, at).toBeGreaterThanOrEqual(2.9 - 1e-9);
          else expect(fb, at).toBeLessThanOrEqual(0.1 + 1e-9);
          expect(o.components.K1!.state, at).toMatchObject({ energized: y });
          if (y) expect(o.components.D2!.current!, at).toBeGreaterThan(5e-3);
          else expect(Math.abs(o.components.D2!.current!), at).toBeLessThan(1e-9);
        }
    });

    it('Try: 22 kΩ instead of 100 kΩ — driven HIGH the pad would source ≈ 150 µA > 100 µA: refused by name (S30-L1); 200 kΩ — the boot state is refused', () => {
      const s = hosted(edit(D, 'R2', 'resistance', { value: 22_000, unit: 'ohm' }));
      s.setPinMode(18, 'output-high');
      const o = s.solve();
      expect(o.ok ? null : o.error).toMatchObject({
        code: 'logic_mcu_output_uncharacterized',
        param: 'gpio18',
        detail: { level: 'high', limit: 100e-6 },
      });
      const boot = hosted(edit(D, 'R2', 'resistance', { value: 200_000, unit: 'ohm' }));
      boot.setPinMode(18, 'input');
      expect(boot.solve().ok).toBe(false);
    });

    if (id === 'mpy-logic-feedback')
      it('the MicroPython program passes the Build analysis (Pin and time only)', () => {
        const src = readFileSync(
          new URL('./exampleSketches/mpy_logic_feedback.py', import.meta.url),
          'utf8',
        );
        expect(D.programs.U1!.files?.[0]?.text ?? D.programs.U1!.text).toBe(src);
        expect(analyzeMicroPython(src, ['gpio-irq', 'input-read', 'pwm']).unsupported).toEqual([]);
      });

    it('texts in EN and HE (title, summary with a "Try")', () => {
      for (const l of ['en', 'he'] as const) {
        const t = translate(getLocale(l), `example.${id}.title` as MessageKey);
        const sm = translate(getLocale(l), `example.${id}.summary` as MessageKey);
        expect(t.length).toBeGreaterThan(10);
        expect(sm).toContain('100 µA');
        expect(sm).toContain('S30-L1');
      }
    });
  });
}
