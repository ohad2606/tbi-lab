/**
 * R1.6 / R1-A: MCU simulation release gate on the maintained-baseline runtime (ADR-007).
 *
 * Given identical firmware artifact, runtime build, configuration, initial state and ordered
 * simulation-time command sequence, every run must reproduce the same externally observable
 * behaviour: pad events, electrical solves (full precision), injected inputs, command applications,
 * and serial output with simulation timestamps. One divergence fails the gate.
 *
 * Configurations: 1 ms tick (V1), 1 ms tick with QEMU main-loop stress, 10 ms tick (comparison),
 * and the early-boot window (first 3 s, no commands). Results are compared within the batch AND
 * against pinned fingerprints for this runtime build + artifact (a batch that agrees with itself
 * but not with the pin has drifted between processes). TBI_GATE_RUNS sets the runs per
 * configuration (default 3); TBI_GATE_UNPINNED=1 skips the pin (only when establishing a new one).
 */
import { describe, expect, it } from 'vitest';
import { runClosedLoop, STIMULUS, type ClosedLoopRecord } from '../harness/closedLoop.js';
import { QEMU, artifact, assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';

const RUNS = Number(process.env.TBI_GATE_RUNS ?? 3);
const UNPINNED = process.env.TBI_GATE_UNPINNED === '1';

/**
 * Pinned fingerprints (sha256 prefixes) for runtimeId 567e58e704a0e43e (espressif/qemu 40edccac +
 * runtime/qemu/patches 0001-0004) and artifacts.lock.json TbiGpioProof (5f177cbe…). Established on
 * 2026-09-24 from 40 unpinned runs (10 per configuration) that converged to exactly one result each;
 * see docs/runtime/R1-REPORT.md.
 * A change to the runtime (patches, upstream commit, QEMU arguments) or the artifact is a new
 * runtime version and re-establishes these through a documented repeated-run baseline.
 */
const PINNED: Record<string, { timeline: string; serialTimed: string; serial: string }> = {
  full: {
    timeline: '2fadf3ae624080b1',
    serialTimed: '1a8db052c6c4fa4a',
    serial: '45b7ded872c2e393',
  },
  full10ms: {
    timeline: '12efd464dbe6bb3a',
    serialTimed: '39d81de4911e98b9',
    serial: '45b7ded872c2e393',
  },
  boot: {
    timeline: 'b64f0bd3e94c22c4',
    serialTimed: '4dc46111f588e958',
    serial: '9874f2e574af4adb',
  },
};

interface Config {
  name: string;
  pin: keyof typeof PINNED;
  tickUs: number;
  stress: boolean;
  endNs: bigint;
  commands: boolean;
}

const CONFIGS: Config[] = [
  {
    name: '1 ms tick, full workload',
    pin: 'full',
    tickUs: 1000,
    stress: false,
    endNs: 15_500_000_000n,
    commands: true,
  },
  {
    name: '1 ms tick, full workload, main-loop stress',
    pin: 'full',
    tickUs: 1000,
    stress: true,
    endNs: 15_500_000_000n,
    commands: true,
  },
  {
    name: '10 ms tick, full workload',
    pin: 'full10ms',
    tickUs: 10_000,
    stress: false,
    endNs: 15_500_000_000n,
    commands: true,
  },
  {
    name: '1 ms tick, early boot window (3 s)',
    pin: 'boot',
    tickUs: 1000,
    stress: false,
    endNs: 3_000_000_000n,
    commands: false,
  },
];

function firstDivergence(a: string[], b: string[]): number | null {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i;
  return null;
}

const summary: Record<string, unknown>[] = [];

describe('R1 release gate: deterministic closed MCU <-> electrical loop', () => {
  assertProvisioned();
  const fw = artifact('TbiGpioProof');

  for (const cfg of CONFIGS) {
    it(`${cfg.name}: ${RUNS} runs reproduce one result`, async () => {
      const runs: ClosedLoopRecord[] = [];
      for (let i = 0; i < RUNS; i++) {
        const r = await runClosedLoop({
          qemu: QEMU,
          artifact: fw.path,
          artifactSha256: fw.sha256,
          endNs: cfg.endNs,
          tickUs: cfg.tickUs,
          stressMainLoop: cfg.stress,
          commands: cfg.commands,
        });
        expect(r.session.outcome, r.session.error ?? r.session.diagnostics).toBe('completed');
        runs.push(r);
        console.log(
          `[${cfg.name}] run ${i + 1}: timeline ${r.timelineSha256.slice(0, 16)} serialTimed ${r.serialTimedSha256.slice(0, 16)} ` +
            `serial ${r.serialSha256.slice(0, 16)} G=${r.counts.padEvents} V=${r.counts.solves} I=${r.counts.injections} ` +
            `K=${r.counts.commands} T=${r.session.frames.T} wall=${(r.session.wallMs / 1000).toFixed(1)}s`,
        );
      }
      const ref = runs[0]!;
      // The workload must exercise the loop, not trivially agree on nothing.
      if (cfg.commands) {
        expect(ref.counts.commands, 'all scheduled commands applied').toBe(STIMULUS.length);
        expect(ref.counts.injections).toBeGreaterThan(3);
        expect(ref.session.serial.toString()).toMatch(/IN=1/);
      }
      expect(ref.counts.padEvents).toBeGreaterThan(cfg.commands ? 40 : 4);
      expect(ref.session.serial.toString()).toMatch(/TBI-ARDUINO-READY/);
      for (let i = 1; i < runs.length; i++) {
        const d = firstDivergence(ref.timeline, runs[i]!.timeline);
        expect(
          d,
          `run ${i + 1} diverges at ${d}: ${d === null ? '' : `${ref.timeline[d]} vs ${runs[i]!.timeline[d]}`}`,
        ).toBeNull();
        expect(runs[i]!.serialTimedSha256, `run ${i + 1} timed serial`).toBe(ref.serialTimedSha256);
      }
      summary.push({
        config: cfg.name,
        runs: RUNS,
        distinctTimelines: new Set(runs.map((r) => r.timelineSha256)).size,
        distinctSerialTimed: new Set(runs.map((r) => r.serialTimedSha256)).size,
        timelineSha256: ref.timelineSha256,
        serialTimedSha256: ref.serialTimedSha256,
        serialSha256: ref.serialSha256,
        counts: ref.counts,
        ticks: ref.session.frames.T,
        wallMs: runs.map((r) => Math.round(r.session.wallMs)),
      });
      if (!UNPINNED) {
        const pin = PINNED[cfg.pin]!;
        expect(ref.timelineSha256.slice(0, 16), 'timeline matches the pinned fingerprint').toBe(
          pin.timeline,
        );
        expect(
          ref.serialTimedSha256.slice(0, 16),
          'timed serial matches the pinned fingerprint',
        ).toBe(pin.serialTimed);
        expect(ref.serialSha256.slice(0, 16), 'serial matches the pinned fingerprint').toBe(
          pin.serial,
        );
      }
    });
  }

  it('records the gate evidence', () => {
    recordEvidence(`gate${UNPINNED ? '-unpinned' : ''}-${RUNS}x`, {
      runtime: runtimeInfo(),
      artifact: fw,
      summary,
    });
  });
});
