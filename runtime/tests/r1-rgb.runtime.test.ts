/**
 * Sprint 11 (R1), slice 1, REAL runtime: the RGB LED driven by the pinned TbiBanks firmware on the
 * Session Host; each lit state equals the engine solving the same request, switch positions and pad
 * modes (one engine, two hosts).
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { SolveSuccess } from '@tbi-lab/engine';
import { Circuit, flip } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { close, engineAt, realRequest, started, stopped, switchedInput } from './r1-support.js';

const host = realHost();
afterAll(() => host.shutdown());

describe('slice 1 — RGB LED on the real runtime', () => {
  it('firmware drives red (GPIO4) and green (GPIO33) on and off; each equals the engine', async () => {
    const c = new Circuit().psu(3.3);
    const swRed = switchedInput(c, 34);
    const swGreen = switchedInput(c, 35);
    const led = c.add('component.rgb_led');
    const rr = c.add('component.resistor');
    const rg = c.add('component.resistor');
    c.ohms(rr, 220).ohms(rg, 100);
    c.wire(`${rr}.b`, `${led}.red`).wire(`${rg}.b`, `${led}.green`);
    c.wire(`${led}.cathode`, 'GND1.ref').pad(4, `${rr}.a`).pad(33, `${rg}.a`);
    const req = realRequest(c);
    const s = await started(host, req);
    const ch = (o: SolveSuccess, k: string) => o.components[led]!.currents![k]!;
    const rev = { seq: 0, rev: req.circuit.projectRevision };

    const red = await flip(s, swRed, true, rev, (o) => ch(o, 'red') > 1e-3, 60_000);
    let want = engineAt(req, { [swRed]: true }, { 4: 'output-high', 33: 'output-low' });
    close(ch(red, 'red'), ch(want, 'red'), 'red on');
    expect(Math.abs(ch(red, 'green'))).toBeLessThan(1e-9);

    const both = await flip(s, swGreen, true, rev, (o) => ch(o, 'green') > 1e-3, 60_000);
    want = engineAt(
      req,
      { [swRed]: true, [swGreen]: true },
      { 4: 'output-high', 33: 'output-high' },
    );
    close(ch(both, 'red'), ch(want, 'red'), 'red with green');
    close(ch(both, 'green'), ch(want, 'green'), 'green on');

    await flip(s, swRed, false, rev, (o) => Math.abs(ch(o, 'red')) < 1e-9, 60_000);
    await flip(s, swGreen, false, rev, (o) => Math.abs(ch(o, 'green')) < 1e-9, 60_000);
    await stopped(s);
  });
});
