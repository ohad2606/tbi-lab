/**
 * Sprint 25 (Runtime v5, gpio-irq): GPIO edge interrupts on real QEMU with real Arduino firmware.
 *
 * TbiIrq attaches CHANGE (GPIO4), RISING (GPIO5) and FALLING (GPIO13) interrupts; each ISR answers
 * on an output with one register write (GPIO2 mirrors GPIO4; GPIO18 / GPIO19 toggle). Edges are
 * scheduled at exact virtual times (`J`, sched-input), off the 1 ms command grid, and the ISR's
 * answer arrives as a G frame stamped with the virtual time of the write. So:
 *   - every scheduled edge of the selected type produces exactly one ISR answer, in order, and no
 *     edge of another type does (delivery and type selectivity);
 *   - latency = answer time - edge time, measured, never assumed (reported as evidence);
 *   - two runs give identical answer times (determinism).
 * TbiIrqLevel asks for a level interrupt (ONHIGH), which Runtime v5 does not deliver: the session
 * ends at the register write, naming the facility (`U gpio-interrupt`).
 */
import { describe, expect, it } from 'vitest';
import { createSessionOverlay } from '../harness/artifacts.js';
import { QEMU, artifact, assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import type { Command, Level } from '../harness/protocol.js';
import { runSession } from '../harness/session.js';
import { join } from 'node:path';
import { MpyStack } from './s24-support.js';

type Edge = { pad: number; vns: bigint; level: Level };

/** The schedule: per input, alternating levels, starting high, off the command grid. */
function schedule(): Edge[] {
  const edges: Edge[] = [];
  const t0 = 2_000_000_000n; // after setup() has attached the interrupts (boot ~1.3 s)
  const add = (pad: number, n: number, first: bigint, step: bigint) => {
    for (let k = 0; k < n; k++)
      edges.push({ pad, vns: first + BigInt(k) * step, level: (k % 2 === 0 ? 1 : 0) as Level });
  };
  add(4, 20, t0 + 100_317n, 3_137_000n);
  add(5, 20, t0 + 1_400_731n, 4_219_000n);
  add(13, 20, t0 + 2_700_113n, 5_311_000n);
  return edges.sort((a, b) => (a.vns < b.vns ? -1 : a.vns > b.vns ? 1 : a.pad - b.pad));
}

const ANSWER: Record<number, number> = { 4: 2, 5: 18, 13: 19 };

async function run(): Promise<{
  answers: { pad: number; vns: bigint; level: number }[];
  serial: string;
  outcome: string;
}> {
  const fw = artifact('TbiIrq');
  const ov = createSessionOverlay(fw.path, fw.sha256);
  const edges = schedule();
  const sent = new Set<number>();
  const answers: { pad: number; vns: bigint; level: number }[] = [];
  try {
    const r = await runSession(
      { qemu: QEMU, flash: ov.flash, dir: ov.dir, tickUs: 1000, wallTimeoutMs: 600_000 },
      {
        pad(e) {
          if (e.drive && [2, 18, 19].includes(e.pad))
            answers.push({ pad: e.pad, vns: e.vns, level: e.level });
          return [];
        },
        tick(vns) {
          if (vns >= 2_200_000_000n) return [{ type: 'Q' }];
          const out: Command[] = [];
          edges.forEach((e, i) => {
            if (!sent.has(i) && e.vns > vns && e.vns - vns <= 20_000_000n) {
              sent.add(i);
              out.push({ type: 'J', vns: e.vns, pad: e.pad, level: e.level });
            }
          });
          return out;
        },
      },
    );
    return { answers, serial: r.serial.toString(), outcome: r.outcome };
  } finally {
    ov.discard();
  }
}

describe('Runtime v5: GPIO edge interrupts (TbiIrq, real QEMU)', () => {
  it('every edge of the selected type runs its ISR once, in order; latency measured; deterministic', async () => {
    assertProvisioned();
    const a = await run();
    expect(a.outcome).toBe('completed');
    expect(a.serial).toContain('TBI-IRQ-READY');
    const edges = schedule();
    // Setup drives the three outputs LOW once (answers before the first edge are not ISR answers).
    const isr = a.answers.filter((x) => x.vns >= edges[0]!.vns);
    // What each ISR must answer: GPIO4 every edge (mirrored level); GPIO5 rising; GPIO13 falling.
    const expected = edges.filter(
      (e) => e.pad === 4 || (e.pad === 5 && e.level === 1) || (e.pad === 13 && e.level === 0),
    );
    const toggles: Record<number, number> = { 18: 0, 19: 0 };
    const rows = expected.map((e) => {
      const out = ANSWER[e.pad]!;
      const level = e.pad === 4 ? e.level : (toggles[out] = (toggles[out]! + 1) % 2);
      return { pad: e.pad, edgeNs: e.vns, out, level };
    });
    // Same count per output, same order per output, each answer at or after its edge.
    const latency: { pad: number; edgeNs: string; ns: number }[] = [];
    for (const out of [2, 18, 19]) {
      const want = rows.filter((r) => r.out === out);
      const got = isr.filter((x) => x.pad === out);
      expect(
        got.map((g) => g.level),
        `GPIO${out} answers`,
      ).toEqual(want.map((w) => w.level));
      want.forEach((w, i) => {
        const ns = Number(got[i]!.vns - w.edgeNs);
        expect(ns, `GPIO${out} answer ${i}`).toBeGreaterThanOrEqual(0);
        latency.push({ pad: w.pad, edgeNs: w.edgeNs.toString(), ns });
      });
    }
    expect(a.serial).toMatch(/IRQ change=20 rise=10 fall=10/);
    const ns = latency.map((l) => l.ns).sort((x, y) => x - y);
    // Every answer before the next scheduled edge of any input (the closest pair is ~0.4 ms apart).
    expect(ns.at(-1)!).toBeLessThan(400_000);
    const b = await run();
    expect(b.answers, 'determinism: identical ISR answer times').toEqual(a.answers);
    recordEvidence('s25-irq', {
      runtime: runtimeInfo(),
      firmware: artifact('TbiIrq'),
      edges: edges.length,
      answers: latency.length,
      latencyNs: {
        min: ns[0],
        median: ns[Math.floor(ns.length / 2)],
        max: ns.at(-1),
        all: latency,
      },
      deterministic: true,
    });
  }, 900_000);

  it('review H1: an edge interrupt armed on an undefined pad is reported like a read (N), at the arming', async () => {
    assertProvisioned();
    const fw = artifact('TbiIrq');
    const ov = createSessionOverlay(fw.path, fw.sha256);
    let reported: { vns: bigint; pads: readonly number[] } | null = null;
    try {
      const r = await runSession(
        { qemu: QEMU, flash: ov.flash, dir: ov.dir, tickUs: 1000, wallTimeoutMs: 300_000 },
        {
          // GPIO13 has no defined level from the start (nothing drives it in this test).
          hello: () => [{ type: 'Z', pad: 13, undefined: true }],
          tick: (vns) => (vns >= 2_500_000_000n ? [{ type: 'Q' }] : []),
          inputRead: (vns, pads) => {
            reported ??= { vns, pads };
            return [{ type: 'Q' }];
          },
        },
      );
      expect(r.outcome).not.toBe('failed');
      expect(reported).not.toBeNull();
      expect(reported!.pads).toEqual([13]);
      // Before the firmware printed it was ready: at attachInterrupt(13, FALLING) itself.
      expect(r.serial.toString()).not.toContain('TBI-IRQ-READY');
    } finally {
      ov.discard();
    }
  }, 600_000);

  it('a level interrupt (ONHIGH) is not delivered: the session ends at the write, naming it', async () => {
    assertProvisioned();
    const fw = artifact('TbiIrqLevel');
    const ov = createSessionOverlay(fw.path, fw.sha256);
    let facility: string | null = null;
    try {
      const r = await runSession(
        { qemu: QEMU, flash: ov.flash, dir: ov.dir, tickUs: 1000, wallTimeoutMs: 300_000 },
        {
          tick: (vns) => (vns >= 3_000_000_000n ? [{ type: 'Q' }] : []),
          unmodelled: (_vns, f) => {
            facility = f;
            return [{ type: 'Q' }];
          },
        },
      );
      expect(r.serial.toString()).toContain('TBI-IRQ-LEVEL-READY');
      expect(facility).toBe('gpio-interrupt');
    } finally {
      ov.discard();
    }
  }, 600_000);

  it('MicroPython Pin.irq (rising | falling): the handler runs for every edge, in order', async () => {
    assertProvisioned();
    const stack = new MpyStack();
    try {
      const build = await stack.build(MPY_IRQ);
      expect(build.features?.requires).toEqual(expect.arrayContaining(['gpio-irq']));
      const sha = build.artifact!.sha256;
      const ov = createSessionOverlay(join(stack.store, `${sha}.bin`), sha);
      const edges = schedule().filter((e) => e.pad === 4);
      const sent = new Set<number>();
      const answers: { vns: bigint; level: number }[] = [];
      try {
        const r = await runSession(
          { qemu: QEMU, flash: ov.flash, dir: ov.dir, tickUs: 1000, wallTimeoutMs: 600_000 },
          {
            pad(e) {
              if (e.drive && e.pad === 2 && e.vns >= edges[0]!.vns)
                answers.push({ vns: e.vns, level: e.level });
              return [];
            },
            tick(vns) {
              if (vns >= 2_300_000_000n) return [{ type: 'Q' }];
              const out: Command[] = [];
              edges.forEach((e, i) => {
                if (!sent.has(i) && e.vns > vns && e.vns - vns <= 20_000_000n) {
                  sent.add(i);
                  out.push({ type: 'J', vns: e.vns, pad: 4, level: e.level });
                }
              });
              return out;
            },
            unmodelled: (_v, f) => {
              throw new Error(`unexpected unmodelled ${f}`);
            },
          },
        );
        expect(r.outcome).toBe('completed');
        expect(r.serial.toString()).toContain('MPY-IRQ-READY');
        // The handler mirrors the level it reads, once per edge, in order, after its edge.
        expect(answers.map((a) => a.level)).toEqual(edges.map((e) => e.level));
        const lat = answers.map((a, i) => Number(a.vns - edges[i]!.vns));
        for (const ns of lat) expect(ns).toBeGreaterThanOrEqual(0);
        expect(r.serial.toString()).toMatch(/edges=20/);
        recordEvidence('s25-irq-mpy', {
          runtime: runtimeInfo(),
          artifact: sha,
          latencyNs: { min: Math.min(...lat), max: Math.max(...lat), all: lat },
        });
      } finally {
        ov.discard();
      }
    } finally {
      stack.cleanup();
    }
  }, 900_000);
});

/** Sprint 25: a MicroPython program with an edge interrupt (scheduled handler, the default). */
const MPY_IRQ = `from machine import Pin
import time

out = Pin(2, Pin.OUT)
out.value(0)
n = 0

def edge(p):
    global n
    out.value(p.value())
    n += 1

Pin(4, Pin.IN).irq(trigger=Pin.IRQ_RISING | Pin.IRQ_FALLING, handler=edge)
print("MPY-IRQ-READY")
last = 0
while True:
    if n != last:
        last = n
        print("edges=%d" % n)
    time.sleep_ms(20)
`;
