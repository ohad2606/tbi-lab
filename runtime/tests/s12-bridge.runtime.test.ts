/**
 * Sprint 12 (ADR-011, patch 0006): bridge v2 scheduled inputs on the real runtime.
 *
 * - T-DET-3: 512 scheduled edges on a pad the firmware never reads leave the R-MCU-1 boot-window
 *   fingerprint bit-identical (the host-sync timer does not reshape vCPU scheduling).
 * - Edge timing: the firmware (TbiEdgeEcho, busy-polling micros()) sees each scheduled edge at
 *   the scheduled spacing, within its own polling granularity; widths from 15 us to 23.5 ms.
 * - T-PROTO-12: `X` cancels pending entries; the firmware never observes them.
 * - T-DET-8: the same schedule under a 1 ms and a 10 ms host quantum gives identical serial output.
 * - T-PROTO-10: every malformed or out-of-limit J/X makes QEMU fail closed (exit 3).
 */
import { describe, expect, it } from 'vitest';
import { createSessionOverlay } from '../harness/artifacts.js';
import { runClosedLoop } from '../harness/closedLoop.js';
import { QEMU, artifact, assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import type { Command } from '../harness/protocol.js';
import { runSession, type SessionResult } from '../harness/session.js';

/** The R1 pins (gate.runtime.test.ts), unchanged by every Sprint 12 patch (architecture §5.2). */
const BOOT_PIN = {
  timeline: '81aa9c4b7f0b1916',
  serialTimed: 'f6de86c978e38653',
  serial: '4cfdcad418d34960',
};

const PAD = 4;
/**
 * QEMU applies each edge at its exact virtual time; what the test sees is the firmware's own
 * sampling. TbiEdgeEcho records an edge on the first poll after it, and micros() truncates to
 * whole microseconds, so each observed spacing is off by at most one polling-loop period plus
 * 1 us. Measured on runtime ad68a556e4be25f7: spacing errors -3..+4 us (evidence s12-edges.json).
 */
const TOLERANCE_US = 5;

interface Pulse {
  /** Offset of the rising edge from the scheduling tick, ns. */
  riseNs: bigint;
  widthNs: bigint;
}

async function edgeSession(
  tickUs: number,
  groups: { atNs: bigint; pulses: Pulse[]; cancelAtNs?: bigint }[],
  endNs: bigint,
): Promise<{ r: SessionResult; edges: { level: number; us: number }[] }> {
  const fw = artifact('TbiEdgeEcho');
  const ov = createSessionOverlay(fw.path, fw.sha256);
  try {
    const r = await runSession(
      { qemu: QEMU, flash: ov.flash, dir: ov.dir, tickUs, wallTimeoutMs: 600_000 },
      {
        tick(vns) {
          if (vns >= endNs) return [{ type: 'Q' }];
          const out: Command[] = [];
          for (const g of groups) {
            if (g.atNs === vns)
              for (const p of g.pulses) {
                out.push({ type: 'J', vns: vns + p.riseNs, pad: PAD, level: 1 });
                out.push({ type: 'J', vns: vns + p.riseNs + p.widthNs, pad: PAD, level: 0 });
              }
            if (g.cancelAtNs === vns) out.push({ type: 'X', pad: PAD });
          }
          return out;
        },
      },
    );
    const edges = [...r.serial.toString().matchAll(/^E ([01]) (\d+)\r?$/gm)].map((m) => ({
      level: Number(m[1]),
      us: Number(m[2]),
    }));
    return { r, edges };
  } finally {
    ov.discard();
  }
}

const GROUP_A: Pulse[] = [
  { riseNs: 100_000n, widthNs: 15_000n },
  { riseNs: 300_000n, widthNs: 150_000n },
];
/**
 * Cancelled before it is due: scheduled at T_A, cancelled at T_A + 10 ms (a tick under both the
 * 1 ms and the 10 ms quantum, so both runs send the same commands at the same times).
 */
const GROUP_B: Pulse[] = [{ riseNs: 50_000_000n, widthNs: 10_000n }];
const GROUP_C: Pulse[] = [
  { riseNs: 100_000n, widthNs: 1_500_000n },
  // HC-SR04 at 4 m, 20 degC: 2 * 4 / 343.42 s = 23 295.091 us (rounded to the ns).
  { riseNs: 3_000_000n, widthNs: 23_295_091n },
];
const T_A = 2_000_000_000n;
const T_C = 2_500_000_000n;
const SCHEDULE = [
  { atNs: T_A, pulses: [...GROUP_A, ...GROUP_B], cancelAtNs: T_A + 10_000_000n },
  { atNs: T_C, pulses: GROUP_C },
];
const scheduledEdgesUs = (base: bigint, pulses: Pulse[]) =>
  pulses.flatMap((p) => [
    Number(base + p.riseNs) / 1000,
    Number(base + p.riseNs + p.widthNs) / 1000,
  ]);

describe('Sprint 12 bridge v2: scheduled inputs (patch 0006)', () => {
  assertProvisioned();
  const info = runtimeInfo();

  it('T-DET-3: 512 edges on an unread pad leave the boot fingerprint unchanged', async () => {
    const caps: string[] = [];
    const fw = artifact('TbiGpioProof');
    const r = await runClosedLoop({
      qemu: QEMU,
      artifact: fw.path,
      artifactSha256: fw.sha256,
      endNs: 3_000_000_000n,
      tickUs: 1000,
      commands: false,
      noise: { pad: PAD, edges: 512, periodNs: 5_000_000n },
      capsOut: caps,
    });
    expect(r.session.outcome, r.session.diagnostics).toBe('completed');
    expect(caps).toContain('sched-input');
    const got = {
      timeline: r.timelineSha256.slice(0, 16),
      serialTimed: r.serialTimedSha256.slice(0, 16),
      serial: r.serialSha256.slice(0, 16),
    };
    recordEvidence('s12-det3', { runtimeId: info.runtimeId, caps, got, pinned: BOOT_PIN });
    expect(got).toEqual(BOOT_PIN);
  });

  it('edges arrive at the scheduled spacing; X cancels; 1 ms and 10 ms quanta agree', async () => {
    const runs = [];
    for (const tickUs of [1000, 10_000]) {
      const { r, edges } = await edgeSession(tickUs, SCHEDULE, 2_700_000_000n);
      expect(r.outcome, r.diagnostics).toBe('completed');
      runs.push({ tickUs, r, edges });
    }
    const [one, ten] = runs;
    // T-PROTO-12: group B (scheduled, then cancelled before due) never reaches the firmware.
    const want = [...scheduledEdgesUs(T_A, GROUP_A), ...scheduledEdgesUs(T_C, GROUP_C)];
    expect(one!.edges.map((e) => e.level)).toEqual(want.map((_, i) => (i % 2 ? 0 : 1)));
    // Spacing of consecutive observed edges vs scheduled (micros() and virtual time differ by a
    // constant boot offset, so only differences are compared).
    const errors = want.slice(1).map((w, i) => {
      const observed = one!.edges[i + 1]!.us - one!.edges[i]!.us;
      return observed - (w - want[i]!);
    });
    recordEvidence('s12-edges', {
      runtimeId: info.runtimeId,
      scheduledUs: want,
      observedUs: one!.edges.map((e) => e.us),
      spacingErrorUs: errors,
    });
    for (const e of errors) expect(Math.abs(e)).toBeLessThanOrEqual(TOLERANCE_US);
    // T-DET-8 analogue: the host quantum is not an execution timestep, also with J.
    expect(ten!.r.serial.equals(one!.r.serial)).toBe(true);
  });

  const faults: [string, string[]][] = [
    ['J not later than the frame', ['J 5 4 1']],
    ['J pad out of range', ['J 99000000000 40 1']],
    ['J level out of range', ['J 99000000000 4 2']],
    ['J malformed', ['J 99000000000 4']],
    ['X pad out of range', ['X 40']],
    ['two entries on one pad < 1 us apart', ['J 99000000000 4 1', 'J 99000000999 4 0']],
    [
      'queue over 512',
      Array.from({ length: 513 }, (_, i) => `J ${99_000_000_000 + i * 1000} 4 ${i & 1}`),
    ],
  ];
  for (const [name, reply] of faults) {
    it(`T-PROTO-10: ${name} -> QEMU exits 3`, async () => {
      const fw = artifact('TbiGpioProof');
      const ov = createSessionOverlay(fw.path, fw.sha256);
      try {
        const r = await runSession(
          {
            qemu: QEMU,
            flash: ov.flash,
            dir: ov.dir,
            wallTimeoutMs: 120_000,
            fault: { afterFrames: 5, kind: 'raw_reply', reply },
          },
          {},
        );
        expect(r.outcome).toBe('protocol_error_runtime');
        expect(r.exitCode).toBe(3);
        expect(r.diagnostics).toMatch(/tbi-bridge: .*terminating \(fail closed\)/);
      } finally {
        ov.discard();
      }
    });
  }

  it('the pair 1 us apart is accepted (the limit is inclusive)', async () => {
    const fw = artifact('TbiGpioProof');
    const ov = createSessionOverlay(fw.path, fw.sha256);
    try {
      let sent = false;
      const r = await runSession(
        { qemu: QEMU, flash: ov.flash, dir: ov.dir, wallTimeoutMs: 120_000 },
        {
          tick(vns) {
            if (vns === 10_000_000n && !sent) {
              sent = true;
              return [
                { type: 'J', vns: 20_000_000n, pad: PAD, level: 1 },
                { type: 'J', vns: 20_001_000n, pad: PAD, level: 0 },
              ];
            }
            return vns >= 50_000_000n ? [{ type: 'Q' }] : [];
          },
        },
      );
      expect(r.outcome, r.diagnostics).toBe('completed');
    } finally {
      ov.discard();
    }
  });
});
