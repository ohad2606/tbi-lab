/**
 * Sprint 11 (R1), slice 2 — the active buzzer switched by a running board (routine CI: the fake
 * runtime copies GPIO5 to GPIO18; a mirrored toggle switch drives GPIO5).
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

describe('slice 2 — buzzer driven by a running board', () => {
  it('GPIO18 straight to the buzzer: sounds when the pad is HIGH (≈3.07 V), silent when LOW', async () => {
    const { host, art } = fakeHost();
    hosts.push(host);
    const c = new Circuit().psu(3.3);
    const sw = echoInput(c);
    const bz = c.add('component.buzzer');
    c.wire(`${bz}.negative`, 'GND1.ref').pad(18, `${bz}.positive`);
    const req = c.request(art.sha256);
    const s = open(host, req);
    expect(s.state).toBe('ready');
    s.run();
    await waitEvent(s, (e) => e.type === 'electrical');
    const sounding = (o: SolveSuccess) => o.components[bz]!.state!.sounding === true;
    const rev = { seq: 0, rev: req.circuit.projectRevision };
    const on = await flip(s, sw, true, rev, sounding);
    expect(on.components[bz]!.voltage!).toBeGreaterThan(3.0);
    expect(on.components[bz]!.voltage!).toBeLessThan(3.1);
    await flip(s, sw, false, rev, (o) => !sounding(o));
    s.stop();
    await waitState(s, 'ended');
  });
});
