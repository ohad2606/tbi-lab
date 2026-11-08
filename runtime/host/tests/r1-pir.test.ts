/**
 * Sprint 11 (R1), slice 3 — the PIR sensor feeding a running board: motion is mirrored live as a
 * part parameter (ADR-010), the firmware sees the level (the fake runtime copies GPIO5 to GPIO18,
 * which lights an LED). Also the host's refusal of bad live parameters, explicitly, at submit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SolveSuccess } from '@tbi-lab/engine';
import type { SessionHost } from '../host.js';
import { fakeHost, waitEvent, waitState } from './support.js';
import { Circuit, open } from './r1-support.js';

const hosts: SessionHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.shutdown();
});

function pirCircuit() {
  const c = new Circuit().psu(5);
  const pir = c.add('sensor.pir_hc_sr501');
  const r = c.add('component.resistor');
  const d = c.add('component.led');
  c.wire('PSU1.positive', `${pir}.vcc`).wire(`${pir}.gnd`, 'GND1.ref').pad(5, `${pir}.out`);
  c.ohms(r, 220).wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref').pad(18, `${r}.a`);
  return { c, pir, d };
}

describe('slice 3 — PIR sensor feeding a running board', () => {
  it('motion mirrored live: GPIO5 follows, the firmware lights the LED; motion cleared: dark again', async () => {
    const { host, art } = fakeHost();
    hosts.push(host);
    const { c, pir, d } = pirCircuit();
    const req = c.request(art.sha256);
    const s = open(host, req);
    expect(s.state).toBe('ready');
    s.run();
    await waitEvent(s, (e) => e.type === 'electrical');
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
      await waitEvent(
        s,
        (e) =>
          e.seq > at &&
          e.type === 'electrical' &&
          pred((e as unknown as { outcome: SolveSuccess }).outcome),
      );
    };
    await motion(true, (o) => (o.components[d]!.current ?? 0) > 1e-3);
    await waitEvent(
      s,
      (e) =>
        e.type === 'serial' &&
        Buffer.from((e as { data: string }).data, 'base64')
          .toString()
          .includes('IN5=1'),
    );
    await motion(false, (o) => Math.abs(o.components[d]!.current ?? 0) < 1e-9);
    // Bad live parameters are refused explicitly when they arrive (409), never applied.
    expect(
      s.submit({
        category: 'mirror',
        seq: ++seq,
        projectRevision: ++rev,
        component: pir,
        control: { params: { motion: 'yes' } },
      }),
    ).toMatchObject({ accepted: false, reason: 'invalid_value' });
    expect(
      s.submit({
        category: 'mirror',
        seq: ++seq,
        projectRevision: ++rev,
        component: pir,
        control: { params: { sensitivity: 1 } },
      }),
    ).toMatchObject({ accepted: false, reason: 'unsupported_control' });
    expect(s.state).toBe('running');
    s.stop();
    await waitState(s, 'ended');
  });
});
