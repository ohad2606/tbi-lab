/**
 * Sprint 11 (R1), slice 6 — the 8x8 matrix and a running board. DECISION (measured,
 * r1-matrix-perf.runtime.test.ts): the per-event solve gate (p99 <= 2 ms) is not met, so the matrix
 * stays LOCAL-ONLY: the host refuses it with a board. The static-pattern capability is still
 * verified here (routine CI: the fake runtime copies GPIO5 to GPIO18, which drives column 1; row 1
 * grounded), with the catalog flag lifted for that test only, for when the PM revisits it.
 */
import { CATALOG } from '@tbi-lab/domain';
import { afterEach, describe, expect, it } from 'vitest';
import type { SolveSuccess } from '@tbi-lab/engine';
import type { SessionHost } from '../host.js';
import { fakeHost, waitEvent, waitState } from './support.js';
import { Circuit, echoInput, flip, open } from './r1-support.js';

const hosts: SessionHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.shutdown();
});

function matrixCircuit(sha: string) {
  const c = new Circuit().psu(3.3);
  const sw = echoInput(c);
  const m = c.add('display.led_matrix_8x8');
  const r = c.add('component.resistor');
  c.ohms(r, 220).wire(`${r}.b`, `${m}.c1`).wire(`${m}.r1`, 'GND1.ref').pad(18, `${r}.a`);
  return { req: c.request(sha), sw, m };
}

describe('slice 6 — matrix and a running board (measured: stays local-only)', () => {
  it('a project with the matrix and a board is refused by the host (unsupported_component)', () => {
    const { host, art } = fakeHost();
    hosts.push(host);
    const { req, m } = matrixCircuit(art.sha256);
    const s = open(host, req);
    expect(s.status()).toMatchObject({ state: 'failed', reason: 'electrical_error' });
    expect(s.status().detail).toEqual({ code: 'unsupported_component', components: [m] });
  });

  it('capability (flag lifted for this test only): one dot lit with the pad, dark without', async () => {
    const def = CATALOG['display.led_matrix_8x8'] as { mcuRuntime?: false };
    const saved = def.mcuRuntime;
    delete def.mcuRuntime;
    try {
      await staticPattern();
    } finally {
      def.mcuRuntime = saved;
    }
  });
});

async function staticPattern() {
  {
    const { host, art } = fakeHost();
    hosts.push(host);
    const { req, sw, m } = matrixCircuit(art.sha256);
    const s = open(host, req);
    expect(s.state).toBe('ready');
    s.run();
    await waitEvent(s, (e) => e.type === 'electrical');
    const lit = (o: SolveSuccess) => o.components[m]!.state!.lit as number;
    const rev = { seq: 0, rev: req.circuit.projectRevision };
    const on = await flip(s, sw, true, rev, (o) => lit(o) === 1);
    expect(on.components[m]!.array!.currents[0]!).toBeGreaterThan(3e-3);
    await flip(s, sw, false, rev, (o) => lit(o) === 0);
    s.stop();
    await waitState(s, 'ended');
  }
}
