/**
 * Sprint 11 (R1), slice 4, REAL runtime: a closed loop through a relay. A toggle on GPIO34 makes
 * the pinned TbiBanks firmware drive GPIO4 -> 1 kΩ -> 2N3904, which switches a 5 V relay coil;
 * the relay's NO contact (10 kΩ pull-up to 3.3 V) feeds GPIO35, which the firmware copies to
 * GPIO33 (an LED). Relay released: GPIO35 HIGH, LED on; pulled in: GPIO35 LOW, LED off.
 * Each state equals the engine for the same request, switch position and pad modes.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { SolveSuccess } from '@tbi-lab/engine';
import { Circuit, flip } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { close, engineAt, realRequest, started, stopped, switchedInput } from './r1-support.js';

const host = realHost();
afterAll(() => host.shutdown());

describe('slice 4 — NPN and relay on the real runtime', () => {
  it('the firmware pulls the relay in and out; its contact closes the loop back through the firmware', async () => {
    const c = new Circuit().psu(3.3);
    const sw = switchedInput(c, 34);
    const p5 = c.add('instrument.lab_psu');
    c.set(p5, 'setpointVoltage', { value: 5, unit: 'volt' })
      .set(p5, 'currentLimit', { value: 0.5, unit: 'ampere' })
      .set(p5, 'outputEnabled', true)
      .wire(`${p5}.negative`, 'GND1.ref');
    const k = c.add('component.relay');
    const q = c.add('component.bjt_npn');
    const rb = c.add('component.resistor');
    const rp = c.add('component.resistor');
    const rl = c.add('component.resistor');
    const d = c.add('component.led');
    c.ohms(rb, 1000).ohms(rp, 10_000).ohms(rl, 220);
    c.wire(`${rb}.b`, `${q}.base`).wire(`${q}.emitter`, 'GND1.ref').pad(4, `${rb}.a`);
    c.wire(`${p5}.positive`, `${k}.coil1`).wire(`${k}.coil2`, `${q}.collector`);
    c.wire('PSU1.positive', `${rp}.a`).wire(`${rp}.b`, `${k}.no`).wire(`${k}.com`, 'GND1.ref');
    c.pad(35, `${rp}.b`);
    c.wire(`${rl}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref').pad(33, `${rl}.a`);
    const req = realRequest(c);
    const s = await started(host, req);
    const rev = { seq: 0, rev: req.circuit.projectRevision };
    const energized = (o: SolveSuccess) => o.components[k]!.state!.energized === true;
    const ledOn = (o: SolveSuccess) => (o.components[d]!.current ?? 0) > 1e-3;
    // At rest (after the firmware's setup and first echo): released, GPIO35 HIGH, LED on.
    const pulled = await flip(s, sw, true, rev, (o) => energized(o) && !ledOn(o), 60_000);
    const want = engineAt(req, { [sw]: true }, { 4: 'output-high', 33: 'output-low' });
    expect(want.components[k]!.state).toMatchObject({ energized: true });
    close(
      pulled.components[k]!.currents!.coil!,
      want.components[k]!.currents!.coil!,
      'coil current',
    );
    close(
      pulled.components[q]!.currents!.collector!,
      want.components[q]!.currents!.collector!,
      'Ic',
    );
    expect(pulled.components[q]!.state).toMatchObject({ region: 'saturation' });
    const released = await flip(s, sw, false, rev, (o) => !energized(o) && ledOn(o), 60_000);
    expect(released.components[q]!.state).toMatchObject({ region: 'cutoff' });
    await flip(s, sw, true, rev, (o) => energized(o) && !ledOn(o), 60_000); // and again
    await stopped(s);
  });
});
