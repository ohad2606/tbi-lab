/**
 * Sprint 11 (R1), slice 5, REAL runtime: a photoresistor divider (3.3 V -> LDR -> GPIO35 -> 10 kΩ
 * -> GND) read by the pinned TbiBanks firmware as a DIGITAL level and copied to GPIO33 (an LED);
 * the light level is mirrored live (ADR-010). Bright -> HIGH, dark -> LOW, in between -> the pad
 * holds its previous level (datasheet V_IL/V_IH band). No ADC (analogRead stays refused).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { EngineSession, type SolveSuccess } from '@tbi-lab/engine';
import { waitEvent } from '../host/tests/support.js';
import { Circuit } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { close, realRequest, started, stopped } from './r1-support.js';

const host = realHost();
afterAll(() => host.shutdown());

describe('slice 5 — photoresistor (digital threshold) on the real runtime', () => {
  it('light mirrored live: bright lights the LED, dark turns it off, in between holds; values equal the engine', async () => {
    const c = new Circuit().psu(3.3);
    const ldr = c.add('component.photoresistor');
    const r = c.add('component.resistor');
    const rl = c.add('component.resistor');
    const d = c.add('component.led');
    c.set(ldr, 'illuminance', { value: 1, unit: 'lux' }).ohms(r, 10_000).ohms(rl, 220);
    c.wire('PSU1.positive', `${ldr}.a`).wire(`${ldr}.b`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
    c.pad(35, `${ldr}.b`);
    c.wire(`${rl}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref').pad(33, `${rl}.a`);
    const req = realRequest(c);
    const s = await started(host, req);
    let seq = 0;
    let rev = req.circuit.projectRevision;
    const lit = (o: SolveSuccess) => (o.components[d]!.current ?? 0) > 1e-3;
    const lux = async (v: number, pred: (o: SolveSuccess) => boolean, settleMs = 0) => {
      const at = s.log.lastSeq;
      expect(
        s.submit({
          category: 'mirror',
          seq: ++seq,
          projectRevision: ++rev,
          component: ldr,
          control: { params: { illuminance: v } },
        }),
      ).toMatchObject({ accepted: true });
      const e = await waitEvent(
        s,
        (x) =>
          x.seq > at &&
          x.type === 'electrical' &&
          (x as unknown as { outcome: SolveSuccess }).outcome.appliedRevision === rev &&
          pred((x as unknown as { outcome: SolveSuccess }).outcome),
        60_000,
      );
      if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
      return (e as unknown as { outcome: SolveSuccess }).outcome;
    };
    // Bright: the LED lights (GPIO35 HIGH -> firmware -> GPIO33 HIGH).
    const bright = await lux(200, lit);
    const ref = new EngineSession(req.circuit, { pins: req.attachments });
    ref.applyControl(ldr, { params: { illuminance: 200 } }, rev);
    ref.setPinMode(33, 'output-high');
    const want = ref.solve();
    if (!want.ok) throw new Error('reference failed');
    close(
      bright.pins!.find((p) => p.gpio === 35)!.voltage,
      want.pins!.find((p) => p.gpio === 35)!.voltage,
      'GPIO35 voltage',
    );
    close(bright.components[d]!.current!, want.components[d]!.current!, 'LED current');
    // In the hold band (20 lx): still lit, for a while.
    await lux(20, () => true, 1500);
    expect(
      lit(
        s.log
          .since(0)
          .filter((e) => e.type === 'electrical')
          .map((e) => (e as unknown as { outcome: SolveSuccess }).outcome)
          .at(-1)!,
      ),
    ).toBe(true);
    // Dark: off.
    await lux(1, (o) => !lit(o));
    // Back into the band: stays off.
    await lux(20, () => true, 1500);
    expect(
      lit(
        s.log
          .since(0)
          .filter((e) => e.type === 'electrical')
          .map((e) => (e as unknown as { outcome: SolveSuccess }).outcome)
          .at(-1)!,
      ),
    ).toBe(false);
    await stopped(s);
  });
});
