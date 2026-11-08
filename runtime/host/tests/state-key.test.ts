/**
 * Sprint 18 (F-17C-2, independent review): EngineSession.stateKey, the key of the host's PWM
 * operating-point cache, changes with every transient input a solve depends on and with a
 * stateful part's state that a solve moves; equal inputs give equal keys.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession } from '@tbi-lab/engine';
import { Circuit } from './r1-support.js';

/** 5 V supply -> push button -> relay coil -> GND; GPIO18 -> 1 kΩ -> GND. */
function bench() {
  const c = new Circuit();
  const b = c.add('component.push_button');
  const k = c.add('component.relay');
  const r = c.add('component.resistor');
  c.psu(5)
    .wire('PSU1.positive', `${b}.a`)
    .wire(`${b}.b`, `${k}.coil1`)
    .wire(`${k}.coil2`, 'GND1.ref')
    .wire(`${k}.com`, 'GND1.ref')
    .ohms(r, 1000)
    .wire(`${r}.b`, 'GND1.ref')
    .pad(18, `${r}.a`);
  const req = c.request('0'.repeat(64));
  return { e: new EngineSession(req.circuit, { pins: req.attachments }), b, k, req };
}

describe('EngineSession.stateKey (Sprint 18)', () => {
  it('equal inputs, equal keys; each kind of input changes it', () => {
    const one = bench();
    const two = bench();
    expect(one.e.stateKey).not.toBeNull();
    expect(one.e.stateKey).toBe(two.e.stateKey);
    const keys = new Set<string>([one.e.stateKey!]);
    const step = (f: () => unknown) => {
      expect(f()).toBeNull();
      const k = one.e.stateKey!;
      expect(keys.has(k), k).toBe(false);
      keys.add(k);
    };
    step(() => one.e.setPinMode(18, 'output-high'));
    step(() => one.e.applyControl('PSU1', { setpointVoltage: 4.5 }, 2));
    step(() => one.e.setMomentary(one.b, true));
    // Back to an earlier input gives the earlier key again.
    one.e.setPinMode(18, 'input');
    one.e.setMomentary(one.b, false);
    two.e.applyControl('PSU1', { setpointVoltage: 4.5 }, 2);
    expect(one.e.stateKey).toBe(two.e.stateKey);
  });

  it('a solve that moves a relay armature changes the key; a settled solve does not', () => {
    const { e, b, k } = bench();
    const solved = () => {
      const o = e.solve();
      if (!o.ok) throw new Error(JSON.stringify(o.error));
      return o;
    };
    solved();
    const idle = e.stateKey;
    expect(solved() && e.stateKey).toBe(idle); // settled: solving again changes nothing
    e.setMomentary(b, true);
    const pressed = e.stateKey;
    const o = solved();
    expect(o.components[k]!.state).toMatchObject({ energized: true });
    expect(e.stateKey).not.toBe(pressed); // the armature moved during the solve
    const pulledIn = e.stateKey;
    solved();
    expect(e.stateKey).toBe(pulledIn);
  });
});
