/**
 * R1 closure blocker (PM decision, docs/runtime/R1-REPORT.md §20): the host command quantum is a
 * scheduling quantum for host commands only, never an MCU execution timestep.
 *
 * With identical firmware and host commands whose simulation times do not differ, changing the
 * quantum must not change what the guest does or when it does it. Every command in these
 * workloads is scheduled on a multiple of 10 ms, so it applies at the same simulation time under
 * a 1 ms and a 10 ms quantum. The comparison therefore covers the guest's complete observable
 * timeline: pad events, electrical solves and injections, command applications, and serial output,
 * each with its simulation timestamp. Only the tick frames themselves may differ.
 */
import { Circuit, GpioPin } from '@tbi-lab/engine';
import { describe, expect, it } from 'vitest';
import { runCircuitSession } from '../harness/circuitSession.js';
import { runClosedLoop } from '../harness/closedLoop.js';
import { QEMU, artifact, assertProvisioned, recordEvidence } from '../harness/env.js';

const QUANTA_US = [1000, 10_000];
const evidence: Record<string, unknown> = {};

/** Largest |Δt| between corresponding pad events, and the first differing entry, if any. */
function compare(a: string[], b: string[]) {
  let maxShiftNs = 0n;
  let first: string | null = null;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    first ??= `#${i}: ${a[i]} | ${b[i]}`;
    const ta = a[i] ? BigInt(a[i]!.split(' ')[1]!) : 0n;
    const tb = b[i] ? BigInt(b[i]!.split(' ')[1]!) : 0n;
    const d = ta > tb ? ta - tb : tb - ta;
    if (d > maxShiftNs) maxShiftNs = d;
  }
  return { identical: first === null, maxShiftNs, first };
}

describe('host command quantum does not alter guest execution', () => {
  assertProvisioned();

  it('release-gate workload (TbiGpioProof, commands at 10 ms multiples): identical at 1 ms and 10 ms', async () => {
    const fw = artifact('TbiGpioProof');
    const runs = [];
    for (const tickUs of QUANTA_US) {
      runs.push(
        await runClosedLoop({
          qemu: QEMU,
          artifact: fw.path,
          artifactSha256: fw.sha256,
          endNs: 15_500_000_000n,
          tickUs,
        }),
      );
    }
    const [a, b] = runs as [(typeof runs)[0], (typeof runs)[0]];
    const g = compare(
      a.timeline.filter((l) => l.startsWith('G ')),
      b.timeline.filter((l) => l.startsWith('G ')),
    );
    const firstPad = (r: typeof a) => r.timeline.find((l) => l.startsWith('G '))!;
    evidence.gate = {
      timeline: [a.timelineSha256, b.timelineSha256],
      serialTimed: [a.serialTimedSha256, b.serialTimedSha256],
      firstPadEvent: [firstPad(a), firstPad(b)],
      padEvents: g,
    };
    console.log('gate workload 1 ms vs 10 ms', evidence.gate);
    expect(a.session.outcome).toBe('completed');
    expect(b.session.outcome).toBe('completed');
    expect(g.first, 'pad events').toBeNull();
    expect(b.timelineSha256, 'full timeline incl. solves, injections, commands').toBe(
      a.timelineSha256,
    );
    expect(b.serialTimedSha256, 'serial with simulation timestamps').toBe(a.serialTimedSha256);
  });

  it('timing probe (TbiTiming, no commands): identical markers and serial at 1, 10, 7 and 0.25 ms', async () => {
    const fw = artifact('TbiTiming');
    const runs = [];
    for (const tickUs of [...QUANTA_US, 7000, 250]) {
      const c = new Circuit();
      const pin = c.add(new GpioPin('IO2', 'io2', 'input'));
      runs.push(
        await runCircuitSession({
          qemu: QEMU,
          artifact: fw.path,
          artifactSha256: fw.sha256,
          circuit: c,
          pads: [{ pad: 2, pin, node: 'io2', input: false }],
          endNs: 4_000_000_000n,
          tickUs,
        }),
      );
    }
    const a = runs[0]!;
    evidence.timing = runs.map((b, i) => ({
      tickUs: [...QUANTA_US, 7000, 250][i],
      timeline: b.timelineSha256,
      serialTimed: b.serialTimedSha256,
      padEventsVs1ms: compare(
        a.timeline.filter((l) => l.startsWith('G ')),
        b.timeline.filter((l) => l.startsWith('G ')),
      ),
    }));
    console.log('timing probe across quanta', evidence.timing);
    for (const b of runs.slice(1)) {
      expect(b.session.outcome).toBe('completed');
      expect(b.timelineSha256, 'pad events and solves').toBe(a.timelineSha256);
      expect(b.serialTimedSha256, 'serial with simulation timestamps').toBe(a.serialTimedSha256);
    }
  });

  it('records the comparison', () => {
    recordEvidence('quantum', evidence);
  });
});
