/**
 * MCU simulation release gate (ADR-007, V1-ARCHITECTURE §7): deterministic closed loop.
 *
 * Given identical snapshot, firmware, runtime configuration, initial state and ordered
 * simulation-time command sequence, repeated runs must reproduce the same externally observable
 * GPIO output events, electrical results, digital input transitions, firmware-observable behaviour
 * (serial output), and their simulation timestamps.
 *
 * TBI_CLOSED_LOOP_RUNS controls the repeat count (default 5). Results are also compared with a pinned
 * reference fingerprint for the tick (set TBI_CLOSED_LOOP_UNPINNED=1 to skip, e.g. on a new runtime).
 */

import { describe, expect, it } from 'vitest';
import { runClosedLoop, STIMULUS, type RunRecord } from '../closed-loop/closedLoop.js';

const RUNS = Number(process.env.TBI_CLOSED_LOOP_RUNS ?? 5);
/** Keep QEMU's main loop busy (QMP query every ~1 ms) to provoke host-timing races. */
const STRESS = process.env.TBI_CLOSED_LOOP_STRESS === '1';
/** Virtual-time tick (and scheduling quantum) in microseconds. */
const TICK_US = Number(process.env.TBI_CLOSED_LOOP_TICK_US ?? 1_000);
const END_NS = 15_500_000_000n;
/**
 * Reference fingerprints (sha256 prefixes) for the pristine firmware artifact on the recorded runtime
 * build (a159x36@03be9af0 + TBI patches incl. APP-CPU reset and icount warp fixes). Comparing only
 * within one batch would miss drift between processes (e.g. a changed initial state), so the
 * reference is pinned. A runtime or firmware change is a new runtimeVersion and updates these.
 */
const REFERENCE: Record<number, { timeline: string; serial: string }> = {
  1_000: { timeline: '1382cd99602e52e4', serial: 'c4d82896054ce928' },
  10_000: { timeline: 'b779e313e61e4d72', serial: 'c4d82896054ce928' },
};

function firstDivergence(a: string[], b: string[]): number | null {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return null;
}

describe('deterministic closed MCU <-> electrical loop (release gate)', () => {
  it(`reproduces the observable timeline exactly across ${RUNS} runs (icount + syncsock, tick ${TICK_US} us${STRESS ? ', main-loop stress' : ''})`, async () => {
    const runs: RunRecord[] = [];
    for (let i = 0; i < RUNS; i++) {
      const r = await runClosedLoop({ icount: true, endNs: END_NS, pollUs: TICK_US, stressMainLoop: STRESS });
      runs.push(r);
      console.log(
        `run ${i + 1}: timeline ${r.timelineSha256.slice(0, 16)} serial ${r.serialSha256.slice(0, 16)} ` +
          `events=${r.counts.gpioEvents} solves=${r.counts.solves} injections=${r.counts.injections} ` +
          `commands=${r.counts.commands} ticks=${r.counts.ticks} flashWritten=${r.flashWritten} wall=${(r.wallMs / 1000).toFixed(1)}s`,
      );
    }
    const ref = runs[0]!;
    // The run must actually exercise the loop, not trivially match on nothing.
    expect(ref.counts.commands, 'all scheduled commands applied').toBe(STIMULUS.length);
    expect(ref.counts.injections, 'inputs were injected').toBeGreaterThan(3);
    expect(ref.counts.solves).toBeGreaterThan(10);
    expect(ref.serial, 'firmware reported digitalRead results').toMatch(/IN=\d/);

    for (let i = 1; i < runs.length; i++) {
      const d = firstDivergence(ref.timeline, runs[i]!.timeline);
      expect(d, `run ${i + 1} timeline diverges at entry ${d}: ${d === null ? '' : ref.timeline[d] + ' vs ' + runs[i]!.timeline[d]}`).toBeNull();
      expect(runs[i]!.serialSha256, `run ${i + 1} serial output`).toBe(ref.serialSha256);
    }
    const pinned = REFERENCE[TICK_US];
    if (pinned && !process.env.TBI_CLOSED_LOOP_UNPINNED) {
      expect(ref.timelineSha256.slice(0, 16), 'timeline matches the pinned reference').toBe(pinned.timeline);
      expect(ref.serialSha256.slice(0, 16), 'serial matches the pinned reference').toBe(pinned.serial);
    }
  }, RUNS * 90_000 + 60_000);
});
