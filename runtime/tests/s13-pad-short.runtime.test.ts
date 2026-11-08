/**
 * Sprint 13 P2/P3 on the real runtime, through the Session Host: TbiGpioProof drives GPIO2 HIGH and
 * LOW in its 800 ms pattern while GPIO2 is wired straight to GND (attached at the ground symbol, as
 * the browser projects a pad whose only other terminal on its net is GND).
 *
 * - OUTPUT HIGH on GND: the pad model's current at 0 V (3.3 V / R_high), never 0 A (P3), and
 *   marked `outsideModelRange` (P2): it is an extrapolation, not a physical short-circuit current.
 * - OUTPUT LOW (and INPUT) on GND: 0 A, inside the model range.
 * Every published value is the engine's own solve of the same circuit (the reference).
 */
import { R_DRIVE_HIGH_OHM, VDD_V, type PinResult } from '@tbi-lab/engine';
import { afterAll, describe, expect, it } from 'vitest';
import { artifact, assertProvisioned } from '../harness/env.js';
import { ticketFor } from '../identity/test-gate.js';
import { waitEvent } from '../host/tests/support.js';
import { Circuit, open, outcomes } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { tieFreeInputs } from './r1-support.js';

const host = realHost();
afterAll(() => host.shutdown());

describe('Sprint 13 P2/P3: a pad wired to GND under real firmware', () => {
  it('HIGH reports the flagged model current; LOW reports 0 A unflagged', async () => {
    assertProvisioned();
    const fw = artifact('TbiGpioProof');
    // GPIO5 is the firmware's input: held LOW (Runtime v5 refuses a read of an unwired input).
    const c = tieFreeInputs(new Circuit().psu(3.3).pad(2, 'GND1.ref'), [5]);
    const s = open(host, { ...c.request(fw.sha256), ticket: ticketFor(fw.sha256) });
    expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
    s.run();
    // Past the 0.89 s boot window plus two pattern periods: both levels are driven.
    await waitEvent(s, () => BigInt(s.status().simNs) > 3_000_000_000n, 180_000);
    const pads = outcomes(s)
      .flatMap((o) => o.pins ?? [])
      .filter((p: PinResult) => p.gpio === 2);
    s.stop();
    await s.done();

    const high = pads.filter((p) => p.mode === 'output-high');
    const low = pads.filter((p) => p.mode === 'output-low');
    expect(high.length).toBeGreaterThan(0);
    expect(low.length).toBeGreaterThan(0);
    for (const p of high) {
      expect(p.voltage).toBe(0);
      expect(p.current).toBeCloseTo(VDD_V / R_DRIVE_HIGH_OHM, 9);
      expect(p.outsideModelRange).toBe(true);
    }
    for (const p of low) {
      expect(p.current).toBe(0);
      expect(p.outsideModelRange).toBeUndefined();
    }
    for (const p of pads.filter((q) => q.mode === 'input')) {
      expect(p.current).toBe(0);
      expect(p.outsideModelRange).toBeUndefined();
    }
  }, 240_000);
});
