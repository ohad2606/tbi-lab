/**
 * Sprint 11 (R1), slice 3, REAL runtime: a PIR sensor (VCC from a 5 V supply) feeding GPIO34;
 * motion is mirrored LIVE as a part parameter (ADR-010); the pinned TbiBanks firmware copies
 * GPIO34 to GPIO4, which lights an LED. Each state equals the engine for the same request.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { EngineSession, type SolveSuccess } from '@tbi-lab/engine';
import { waitEvent } from '../host/tests/support.js';
import { Circuit } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { close, realRequest, started, stopped } from './r1-support.js';

const host = realHost();
afterAll(() => host.shutdown());

describe('slice 3 — PIR sensor on the real runtime', () => {
  it('motion on: GPIO34 HIGH, the firmware lights the LED on GPIO4; motion off: dark; values equal the engine', async () => {
    const c = new Circuit().psu(5);
    const pir = c.add('sensor.pir_hc_sr501');
    const r = c.add('component.resistor');
    const d = c.add('component.led');
    c.wire('PSU1.positive', `${pir}.vcc`).wire(`${pir}.gnd`, 'GND1.ref').pad(34, `${pir}.out`);
    c.ohms(r, 220).wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref').pad(4, `${r}.a`);
    const req = realRequest(c);
    const s = await started(host, req);
    let seq = 0;
    let rev = req.circuit.projectRevision;
    const motion = async (v: boolean, pred: (o: SolveSuccess) => boolean) => {
      const at = s.log.lastSeq;
      expect(
        s.submit({
          category: 'mirror',
          seq: ++seq,
          projectRevision: ++rev,
          component: pir,
          control: { params: { motion: v } },
        }),
      ).toMatchObject({ accepted: true });
      const e = await waitEvent(
        s,
        (x) =>
          x.seq > at &&
          x.type === 'electrical' &&
          pred((x as unknown as { outcome: SolveSuccess }).outcome),
        60_000,
      );
      return (e as unknown as { outcome: SolveSuccess }).outcome;
    };
    const lit = await motion(true, (o) => (o.components[d]!.current ?? 0) > 1e-3);
    const ref = new EngineSession(req.circuit, { pins: req.attachments });
    ref.applyControl(pir, { params: { motion: true } }, rev);
    ref.setPinMode(4, 'output-high');
    const want = ref.solve();
    if (!want.ok) throw new Error('reference failed');
    close(lit.components[d]!.current!, want.components[d]!.current!, 'LED current');
    close(
      lit.pins!.find((p) => p.gpio === 34)!.voltage,
      want.pins!.find((p) => p.gpio === 34)!.voltage,
      'GPIO34 voltage',
    );
    expect(lit.components[pir]!.state).toEqual({ powered: true, output: 'high' });
    await motion(false, (o) => Math.abs(o.components[d]!.current ?? 0) < 1e-9);
    await stopped(s);
  });
});
