/**
 * Sprint 12 (R2) bridge-edge accuracy, measured with the firmware's polling taken out (Gate B G-2,
 * PM-approved 2026-10-11). A separate test: s12-bridge's TbiEdgeEcho test stays the end-to-end
 * check of what an Arduino sketch sees.
 *
 * TbiEdgeTime polls the GPIO input register with interrupts masked and timestamps each change of
 * GPIO4 with the CPU cycle counter (4.17 ns), so it reports when the CPU could see the edge, not
 * when an Arduino loop sampled it (TbiEdgeEcho's digitalRead + micros() loop takes ~12 us under
 * QEMU).
 *
 *   - The s12-bridge schedule (pulses of 15 us .. 23.3 ms): every observed spacing within 0.1 us of
 *     the scheduled spacing, at the 1 ms and the 10 ms quantum, identically.
 *   - A phase sweep (120 pulses at 1.137 ms steps): every edge seen within 0.1 us. This fails
 *     today for edges that fall while the other core runs (F-R2-1: QEMU executes the two cores in
 *     turn, so the capturing core is frozen for ~6.2 us of every simulated millisecond). The
 *     lateness is recorded; no tolerance is granted for it without a PM decision.
 */
import { describe, expect, it } from 'vitest';
import { createSessionOverlay } from '../harness/artifacts.js';
import { QEMU, artifact, assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import type { Command } from '../harness/protocol.js';
import { runSession } from '../harness/session.js';

const STRICT_NS = 100;

type Pulse = { rise: bigint; fall: bigint };
const BRIDGE: Pulse[] = [
  [2_000_100_000n, 15_000n],
  [2_000_300_000n, 150_000n],
  [2_500_100_000n, 1_500_000n],
  [2_503_000_000n, 23_295_091n],
].map(([r, w]) => ({ rise: r!, fall: r! + w! }));
const SWEEP: Pulse[] = [];
for (let b = 0; b < 4; b++)
  for (let k = 0; k < 30; k++) {
    const rise =
      3_000_000_000n + BigInt(b) * 250_000_000n + BigInt(k) * 1_137_000n + BigInt(b) * 31_000n;
    SWEEP.push({ rise, fall: rise + 200_000n });
  }

async function observe(
  tickUs: number,
): Promise<{ scheduled: bigint[]; captures: [number, number][][] }> {
  const fw = artifact('TbiEdgeTime');
  const ov = createSessionOverlay(fw.path, fw.sha256);
  const all = [...BRIDGE, ...SWEEP];
  const sent = new Set<number>();
  try {
    const r = await runSession(
      { qemu: QEMU, flash: ov.flash, dir: ov.dir, tickUs, wallTimeoutMs: 900_000 },
      {
        tick(vns) {
          if (vns >= 4_100_000_000n) return [{ type: 'Q' }];
          const out: Command[] = [];
          all.forEach((p, i) => {
            if (!sent.has(i) && p.rise - vns <= 20_000_000n && p.rise > vns) {
              sent.add(i);
              out.push({ type: 'J', vns: p.rise, pad: 4, level: 1 });
              out.push({ type: 'J', vns: p.fall, pad: 4, level: 0 });
            }
          });
          return out;
        },
      },
    );
    expect(r.outcome, r.diagnostics).toBe('completed');
    const captures: [number, number][][] = [];
    for (const line of r.serial.toString().split(/\r?\n/)) {
      if (line.startsWith('C ')) captures.push([]);
      const m = /^e ([01]) (\d+)$/.exec(line);
      if (m && captures.length) captures.at(-1)!.push([Number(m[1]), Number(m[2])]);
    }
    return { scheduled: all.flatMap((p) => [p.rise, p.fall]), captures };
  } finally {
    ov.discard();
  }
}

type Row = { capture: number; edge: number; schedNs: bigint; errNs: number };
let observed: Promise<{ rows: Row[]; captures: number }> | undefined;

/** Both quanta once, shared by the two checks. */
function observeBoth(): Promise<{ rows: Row[]; captures: number }> {
  observed ??= (async () => {
    assertProvisioned();
    const one = await observe(1000);
    const ten = await observe(10_000);
    expect(ten.captures).toEqual(one.captures); // T-DET-8: the quantum is not an execution step
    const rows: Row[] = [];
    let i = 0;
    one.captures.forEach((c, ci) => {
      const base = one.scheduled[i]!;
      c.forEach(([level, cycles], k) => {
        expect(level, `capture ${ci} edge ${k}`).toBe((i + k) % 2 === 0 ? 1 : 0);
        const want = Number(one.scheduled[i + k]! - base);
        rows.push({
          capture: ci,
          edge: k,
          schedNs: one.scheduled[i + k]!,
          errNs: (cycles * 1000) / 240 - want,
        });
      });
      i += c.length;
    });
    expect(i).toBe(one.scheduled.length); // every scheduled edge was seen, none invented
    return { rows, captures: one.captures.length };
  })();
  return observed;
}

describe('R2: scheduled inputs are seen at their scheduled time (TbiEdgeTime)', () => {
  it('the s12-bridge schedule: every edge within 0.1 us, at both quanta', async () => {
    const { rows } = await observeBoth();
    const bridge = rows.filter((r) => r.capture < 2);
    recordEvidence('s12-bridge-timing-schedule', {
      runtimeId: runtimeInfo().runtimeId,
      firmware: artifact('TbiEdgeTime').sha256,
      errorsNs: bridge.map((r) => Math.round(r.errNs)),
    });
    for (const r of bridge)
      expect(Math.abs(r.errNs), `${r.schedNs}`).toBeLessThanOrEqual(STRICT_NS);
  }, 1_800_000);

  it("a phase sweep: every edge within 0.1 us (F-R2-1 open: fails in the other core's interval)", async () => {
    const { rows, captures } = await observeBoth();
    // Per capture, relative to its median (a late first edge would shift a whole capture).
    const off: { phaseUs: number; lateNs: number }[] = [];
    for (let ci = 2; ci < captures; ci++) {
      const rs = rows.filter((r) => r.capture === ci);
      const med = [...rs.map((r) => r.errNs)].sort((a, b) => a - b)[rs.length >> 1]!;
      for (const r of rs) {
        const d = r.errNs - med;
        if (Math.abs(d) > STRICT_NS)
          off.push({ phaseUs: Number(r.schedNs % 1_000_000n) / 1000, lateNs: Math.round(d) });
      }
    }
    recordEvidence('s12-bridge-timing-sweep', {
      runtimeId: runtimeInfo().runtimeId,
      firmware: artifact('TbiEdgeTime').sha256,
      sweepEdges: rows.filter((r) => r.capture >= 2).length,
      outsideStrict: off,
    });
    expect(off, JSON.stringify(off)).toEqual([]);
  }, 1_800_000);
});
