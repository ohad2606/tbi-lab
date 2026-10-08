/**
 * Sprint 11 (R1), slice 4 — a 2N3904 switching a 5 V relay from a running board (routine CI: the
 * fake runtime copies GPIO5 to GPIO18). The relay's armature state (hysteresis) lives in the host
 * session's engine across pad events.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SolveSuccess } from '@tbi-lab/engine';
import type { SessionHost } from '../host.js';
import { fakeHost, waitEvent, waitState } from './support.js';
import { Circuit, echoInput, flip, open } from './r1-support.js';

const hosts: SessionHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.shutdown();
});

describe('slice 4 — NPN and relay driven by a running board', () => {
  it('GPIO18 -> 1 kΩ -> 2N3904 -> coil from a 5 V supply: pulls in with the pad, releases without it', async () => {
    const { host, art } = fakeHost();
    hosts.push(host);
    const c = new Circuit().psu(3.3);
    const sw = echoInput(c);
    const p5 = c.add('instrument.lab_psu');
    c.set(p5, 'setpointVoltage', { value: 5, unit: 'volt' })
      .set(p5, 'currentLimit', { value: 0.5, unit: 'ampere' })
      .set(p5, 'outputEnabled', true)
      .wire(`${p5}.negative`, 'GND1.ref');
    const k = c.add('component.relay');
    const q = c.add('component.bjt_npn');
    const rb = c.add('component.resistor');
    c.ohms(rb, 1000).wire(`${rb}.b`, `${q}.base`).wire(`${q}.emitter`, 'GND1.ref');
    c.wire(`${p5}.positive`, `${k}.coil1`).wire(`${k}.coil2`, `${q}.collector`);
    c.wire(`${k}.com`, 'GND1.ref').pad(18, `${rb}.a`);
    const req = c.request(art.sha256);
    const s = open(host, req);
    expect(s.state).toBe('ready');
    s.run();
    await waitEvent(s, (e) => e.type === 'electrical');
    const energized = (o: SolveSuccess) => o.components[k]!.state!.energized === true;
    const rev = { seq: 0, rev: req.circuit.projectRevision };
    const on = await flip(s, sw, true, rev, energized);
    expect(on.components[q]!.state).toMatchObject({ region: 'saturation' });
    const off = await flip(s, sw, false, rev, (o) => !energized(o));
    expect(off.components[q]!.state).toMatchObject({ region: 'cutoff' });
    await flip(s, sw, true, rev, energized); // and again: the state follows every event
    s.stop();
    await waitState(s, 'ended');
  });
});
