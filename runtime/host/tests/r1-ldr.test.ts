/**
 * Sprint 11 (R1), slice 5 — a photoresistor divider read by a running board as a DIGITAL level;
 * the light level is mirrored live (ADR-010). Fake runtime: GPIO18 follows GPIO5 (an LED shows it).
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

describe('slice 5 — photoresistor divider feeding a running board', () => {
  it('bright -> HIGH, dark -> LOW, in between -> the previous level held', async () => {
    const { host, art } = fakeHost();
    hosts.push(host);
    const c = new Circuit().psu(3.3);
    const ldr = c.add('component.photoresistor');
    const r = c.add('component.resistor');
    const rl = c.add('component.resistor');
    const d = c.add('component.led');
    c.set(ldr, 'illuminance', { value: 1, unit: 'lux' }).ohms(r, 10_000).ohms(rl, 220);
    c.wire('PSU1.positive', `${ldr}.a`).wire(`${ldr}.b`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
    c.pad(5, `${ldr}.b`);
    c.wire(`${rl}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref').pad(18, `${rl}.a`);
    const req = c.request(art.sha256);
    const s = open(host, req);
    expect(s.state).toBe('ready');
    s.run();
    await waitEvent(s, (e) => e.type === 'electrical');
    let seq = 0;
    let rev = req.circuit.projectRevision;
    const lux = async (v: number, pred: (o: SolveSuccess) => boolean) => {
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
          pred((x as unknown as { outcome: SolveSuccess }).outcome),
      );
      return (e as unknown as { outcome: SolveSuccess }).outcome;
    };
    const lit = (o: SolveSuccess) => (o.components[d]!.current ?? 0) > 1e-3;
    await lux(200, lit); // bright: HIGH
    const held = await lux(20, (o) => o.appliedRevision === rev); // in the hold band
    expect(lit(held)).toBe(true); // still HIGH
    await lux(1, (o) => !lit(o)); // dark: LOW
    const heldLow = await lux(20, (o) => o.appliedRevision === rev);
    expect(lit(heldLow)).toBe(false); // still LOW
    // Out of range: refused when it arrives.
    expect(
      s.submit({
        category: 'mirror',
        seq: ++seq,
        projectRevision: ++rev,
        component: ldr,
        control: { params: { illuminance: 0 } },
      }),
    ).toMatchObject({ accepted: false, reason: 'invalid_value' });
    s.stop();
    await waitState(s, 'ended');
  });
});
