/**
 * Sprint 12 (D-10) on the REAL runtime: real-time pacing withholds tick replies only, so the
 * R-MCU-1 workload's fingerprints are identical paced and unpaced, while a paced run never gets
 * ahead of real time. (Speed and capacity are measured separately, by the C-5 harness.)
 */
import { describe, expect, it } from 'vitest';
import { runClosedLoop } from '../harness/closedLoop.js';
import { QEMU, artifact, assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';

describe('pacing on the real runtime (D-10)', () => {
  it('paced at 1x and unpaced: identical fingerprints; paced never ahead of real time', async () => {
    assertProvisioned();
    const fw = artifact('TbiGpioProof');
    const run = async (pace?: { rate: number }) => {
      let ahead = 0;
      let t0: number | null = null;
      const r = await runClosedLoop({
        qemu: QEMU,
        artifact: fw.path,
        artifactSha256: fw.sha256,
        endNs: 6_000_000_000n,
        tickUs: 1000,
        commands: false,
        ...(pace ? { pace } : {}),
        onTick: (vns) => {
          const now = performance.now();
          t0 ??= now - Number(vns) / 1e6;
          ahead = Math.max(ahead, Number(vns) / 1e6 - (now - t0));
        },
      });
      expect(r.session.outcome, r.session.diagnostics).toBe('completed');
      return { r, ahead };
    };
    const fast = await run();
    const paced = await run({ rate: 1 });
    const fp = (x: typeof fast) => ({
      timeline: x.r.timelineSha256,
      serialTimed: x.r.serialTimedSha256,
      serial: x.r.serialSha256,
    });
    recordEvidence('s12-pace', {
      runtimeId: runtimeInfo().runtimeId,
      unpaced: { ...fp(fast), wallMs: fast.r.session.wallMs, pacedMs: fast.r.session.pacedMs },
      paced: {
        ...fp(paced),
        wallMs: paced.r.session.wallMs,
        pacedMs: paced.r.session.pacedMs,
        maxAheadOfFirstTickMs: paced.ahead,
      },
    });
    expect(fp(paced)).toEqual(fp(fast));
    expect(fast.r.session.pacedMs).toBe(0);
    // Once it runs faster than real time, the paced run is held back (6 s simulated).
    expect(paced.r.session.wallMs).toBeGreaterThanOrEqual(6000);
  });
});
