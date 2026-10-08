/**
 * Sprint 11 (R1), slice 2, REAL runtime: the active buzzer straight on GPIO4, switched by the
 * pinned TbiBanks firmware (GPIO34 -> GPIO4); the sounding state and operating point equal the
 * engine for the same request, switch position and pad modes.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { SolveSuccess } from '@tbi-lab/engine';
import { Circuit, flip } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { close, engineAt, realRequest, started, stopped, switchedInput } from './r1-support.js';

const host = realHost();
afterAll(() => host.shutdown());

describe('slice 2 — buzzer on the real runtime', () => {
  it('firmware drives the buzzer on and off; sounding and current equal the engine', async () => {
    const c = new Circuit().psu(3.3);
    const sw = switchedInput(c, 34);
    const bz = c.add('component.buzzer');
    c.wire(`${bz}.negative`, 'GND1.ref').pad(4, `${bz}.positive`);
    const req = realRequest(c);
    const s = await started(host, req);
    const rev = { seq: 0, rev: req.circuit.projectRevision };
    const sounding = (o: SolveSuccess) => o.components[bz]!.state!.sounding === true;
    const on = await flip(s, sw, true, rev, sounding, 60_000);
    const want = engineAt(req, { [sw]: true }, { 4: 'output-high' });
    close(on.components[bz]!.current!, want.components[bz]!.current!, 'buzzer current');
    close(on.components[bz]!.voltage!, want.components[bz]!.voltage!, 'buzzer voltage');
    expect(on.components[bz]!.voltage!).toBeGreaterThan(3.0);
    await flip(s, sw, false, rev, (o) => !sounding(o), 60_000);
    await stopped(s);
  });
});
