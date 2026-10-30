/**
 * Sprint POT-UNITS: a potentiometer divider next to a running board. The wiper position is a live
 * control mirrored to the Session Host (as the photoresistor's light level, ADR-010): each
 * accepted position re-solves the circuit with the new divider. The wiper feeds an input pad only
 * through the digital threshold model (no ADC). Fake runtime (GPIO18 follows GPIO5).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { G_INPUT_LEAKAGE_S, type SolveSuccess } from '@tbi-lab/engine';
import type { SessionHost } from '../host.js';
import { fakeHost, waitEvent, waitState } from './support.js';
import { Circuit, open } from './r1-support.js';

const hosts: SessionHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.shutdown();
});

describe('potentiometer position mirrored to a running board', () => {
  it('each accepted position re-solves the wiper voltage; out of range is refused', async () => {
    const { host, art } = fakeHost();
    hosts.push(host);
    const c = new Circuit().psu(3.3);
    const rv = c.add('component.potentiometer');
    const rl = c.add('component.resistor');
    const d = c.add('component.led');
    c.set(rv, 'resistance', { value: 10_000, unit: 'ohm' });
    c.set(rv, 'position', { value: 50, unit: 'percent' });
    c.wire('PSU1.positive', `${rv}.a`).wire(`${rv}.b`, 'GND1.ref');
    c.pad(5, `${rv}.wiper`);
    c.ohms(rl, 220)
      .wire(`${rl}.b`, `${d}.anode`)
      .wire(`${d}.cathode`, 'GND1.ref')
      .pad(18, `${rl}.a`);
    const req = c.request(art.sha256);
    const s = open(host, req);
    expect(s.state).toBe('ready');
    s.run();
    await waitEvent(s, (e) => e.type === 'electrical');
    let seq = 0;
    let rev = req.circuit.projectRevision;
    const move = async (position: number) => {
      const at = s.log.lastSeq;
      expect(
        s.submit({
          category: 'mirror',
          seq: ++seq,
          projectRevision: ++rev,
          component: rv,
          control: { params: { position } },
        }),
      ).toMatchObject({ accepted: true });
      const e = await waitEvent(
        s,
        (x) =>
          x.seq > at &&
          x.type === 'electrical' &&
          (x as unknown as { outcome: SolveSuccess }).outcome.appliedRevision === rev,
      );
      return (e as unknown as { outcome: SolveSuccess }).outcome;
    };
    for (const p of [10, 90, 0, 100]) {
      const o = await move(p);
      // Closed form: R_AW over (R_WB parallel to the input pad's leakage, 66 MΩ).
      const aw = 10_000 * (p / 100);
      const wb = 10_000 * (1 - p / 100);
      const leak = 1 / G_INPUT_LEAKAGE_S;
      const low = wb === 0 ? 0 : (wb * leak) / (wb + leak);
      const expected = (3.3 * low) / (aw + low);
      const w = o.components[rv]!.terminals.wiper!;
      expect(Math.abs(w - expected)).toBeLessThanOrEqual(3.3 * 1e-9);
    }
    expect(
      s.submit({
        category: 'mirror',
        seq: ++seq,
        projectRevision: ++rev,
        component: rv,
        control: { params: { position: 101 } },
      }),
    ).toMatchObject({ accepted: false, reason: 'invalid_value' });
    s.stop();
    await waitState(s, 'ended');
  });
});
