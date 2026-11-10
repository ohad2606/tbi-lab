import { describe, expect, it } from 'vitest';
import { dueRotation, rotationCutoff, type RotationClock } from '../c5-rotation.js';

/**
 * A simulated clock driving the c5-deployed load loop's rotation decisions exactly as the harness
 * makes them (1 s sleep, per-iteration polling cost, a fresh clock reading for the decision, the
 * replacement's clean-up and start-up time). No host: only the schedule and its boundaries.
 */
const STAGGER_S = 60;
const WARMUP_S = 30;
const LIFETIME_S = 1800;

interface Sim {
  n: number;
  seconds: number;
  rotateS: number;
  /** Cost of one iteration's polling, ms (the sessions' status, sampling). */
  pollMs?: number;
  /** Extra delay in the iteration whose top-of-loop elapsed time is in [from, to) s. */
  stall?: { from: number; to: number; ms: number };
  /** End -> unit and directory gone, ms. */
  cleanupMs?: number;
  /** New session's start -> running with simulation time, ms. */
  startupMs?: number;
  /** Decide on the top-of-loop timestamp (the 68e0d73 behaviour) instead of a fresh reading. */
  staleDecision?: boolean;
  /** Between the initial sessions' starts, ms. */
  startGapMs?: number;
  /** No deadline at all (the harness as run on Alpha in W1 C4). */
  noCutoff?: boolean;
}

interface Inst {
  slot: number;
  startedAt: number;
  rotateAt?: number;
  fault?: string;
  runningAt?: number;
}

function simulate(s: Sim) {
  const pollMs = s.pollMs ?? 50;
  const cleanupMs = s.cleanupMs ?? 400;
  const startupMs = s.startupMs ?? 450;
  let clock = 0;
  const slots: Inst[] = [];
  for (let i = 0; i < s.n; i++) {
    clock += s.startGapMs ?? 300; // lease, create, run
    slots.push({
      slot: i,
      startedAt: clock,
      rotateAt: clock + 1000 * (s.rotateS - i * STAGGER_S),
      runningAt: clock + startupMs,
    });
  }
  const t0 = clock;
  const c: RotationClock = { t0, seconds: s.seconds, warmupS: WARMUP_S };
  const retired: Inst[] = [];
  const rotations: { slot: number; decidedS: number; startedS: number; runningS: number }[] = [];
  while (clock - t0 < s.seconds * 1000) {
    clock += 1000;
    const now = clock;
    clock += pollMs * s.n;
    const elapsed = (now - t0) / 1000;
    if (s.stall && elapsed >= s.stall.from && elapsed < s.stall.to) clock += s.stall.ms;
    const decideAt = s.staleDecision ? now : clock;
    const due = s.noCutoff
      ? slots
          .filter((x) => x.rotateAt !== undefined && x.rotateAt <= now)
          .sort((a, b) => a.rotateAt! - b.rotateAt!)[0]
      : s.staleDecision
        ? elapsed < s.seconds - WARMUP_S
          ? slots
              .filter((x) => x.rotateAt !== undefined && x.rotateAt <= now)
              .sort((a, b) => a.rotateAt! - b.rotateAt!)[0]
          : undefined
        : dueRotation(slots, decideAt, c);
    if (due) {
      const decidedS = (clock - t0) / 1000;
      clock += cleanupMs;
      const fresh: Inst = {
        slot: due.slot,
        startedAt: clock,
        rotateAt: clock + 1000 * s.rotateS,
      };
      clock += startupMs;
      fresh.runningAt = clock;
      slots[slots.indexOf(due)] = fresh;
      retired.push(due);
      rotations.push({
        slot: due.slot,
        decidedS,
        startedS: (fresh.startedAt - t0) / 1000,
        runningS: (clock - t0) / 1000,
      });
    }
  }
  const loopEndS = (clock - t0) / 1000;
  const maxAgeS = Math.max(
    ...[...retired, ...slots].map((x) => {
      const next = rotations.find((r) => r.startedS * 1000 + t0 > x.startedAt && r.slot === x.slot);
      return ((next ? next.startedS * 1000 + t0 : clock) - x.startedAt) / 1000;
    }),
  );
  return {
    cutoffS: (rotationCutoff(c) - t0) / 1000,
    rotations,
    loopEndS,
    maxAgeS,
    perSlot: Array.from({ length: s.n }, (_, i) => rotations.filter((r) => r.slot === i).length),
    deferred: slots.filter((x) => x.rotateAt! < clock).map((x) => x.slot),
  };
}

describe('c5-deployed rotation deadline', () => {
  const c: RotationClock = { t0: 10_000, seconds: 420, warmupS: WARMUP_S };
  const cutoff = rotationCutoff(c); // t0 + 390 s
  const slot = (rotateAt: number, fault?: string) => ({ rotateAt, ...(fault ? { fault } : {}) });

  it('the cut-off is the start of the last warm-up period', () => {
    expect(cutoff).toBe(10_000 + 390_000);
  });

  it('exact boundary: nothing starts at the cut-off, even when due earlier', () => {
    expect(dueRotation([slot(cutoff - 5_000)], cutoff, c)).toBeUndefined();
    expect(dueRotation([slot(cutoff)], cutoff, c)).toBeUndefined();
  });

  it('near boundary: due 1 ms before the cut-off and judged 1 ms before it -> starts', () => {
    const x = slot(cutoff - 1);
    expect(dueRotation([x], cutoff - 1, c)).toBe(x);
    expect(dueRotation([x], cutoff + 1, c)).toBeUndefined();
  });

  it('not yet due, faulted and never-rotating slots are not chosen', () => {
    expect(dueRotation([slot(cutoff - 1_000)], cutoff - 2_000, c)).toBeUndefined();
    expect(dueRotation([slot(c.t0, 'crashed')], c.t0 + 1, c)).toBeUndefined();
    expect(dueRotation([{}], cutoff - 1, c)).toBeUndefined();
  });

  it('the earliest due slot first, one at a time', () => {
    const a = slot(c.t0 + 60_000);
    const b = slot(c.t0 + 30_000);
    expect(dueRotation([a, b], c.t0 + 100_000, c)).toBe(b);
  });
});

describe('c5-deployed rotation schedule (simulated clock)', () => {
  const noneAfterCutoff = (r: ReturnType<typeof simulate>) =>
    r.rotations.every((x) => x.decidedS < r.cutoffS);
  const allRunningBeforeLoopEnd = (r: ReturnType<typeof simulate>) =>
    r.rotations.every((x) => x.runningS <= r.loopEndS);

  it('W1 C4 (N=5, 420 s, rotate 300): the end-of-run rotation is deferred, not started', () => {
    // Calibrated on the Alpha C4 log: rotations at 60, 120, 181, 240, 301, 362, 421 s.
    const alpha = { n: 5, seconds: 420, rotateS: 300, pollMs: 10, cleanupMs: 200, startGapMs: 50 };
    const r = simulate(alpha);
    expect(noneAfterCutoff(r)).toBe(true);
    expect(allRunningBeforeLoopEnd(r)).toBe(true);
    // Five first rotations (60..300 s) and slot 4's second (~360 s); slot 3's second (~420 s,
    // the one that failed on Alpha) falls past the 390 s cut-off.
    expect(r.rotations.map((x) => x.slot)).toEqual([4, 3, 2, 1, 0, 4]);
    expect(r.maxAgeS).toBeLessThan(LIFETIME_S);
    // Without the deadline (W1 C4 on Alpha): a seventh rotation, started past the 420 s end.
    const w1 = simulate({ ...alpha, noCutoff: true });
    expect(w1.rotations.map((x) => Math.round(x.decidedS))).toEqual([
      61, 120, 181, 240, 301, 361, 421,
    ]);
    expect(w1.rotations[6]!.decidedS).toBeGreaterThanOrEqual(420);
  });

  it('the same run deciding on the stale top-of-loop clock starts a rotation past the cut-off', () => {
    // 68e0d73 judged `elapsed` before polling. A slot first due at 389.5 s (top of loop, before the
    // 390 s cut-off) in an iteration whose polling stalls 8 s: the stale decision starts it at
    // ~397.6 s; the fresh one defers it.
    const slow = { n: 1, seconds: 420, rotateS: 389, stall: { from: 389, to: 390, ms: 8_000 } };
    const stale = simulate({ ...slow, staleDecision: true });
    const fresh = simulate(slow);
    expect(stale.rotations).toHaveLength(1);
    expect(stale.rotations[0]!.decidedS).toBeGreaterThanOrEqual(stale.cutoffS);
    expect(fresh.rotations).toHaveLength(0);
    expect(fresh.deferred).toEqual([0]);
  });

  for (const offsetS of [-2, -1, 0, 1, 2]) {
    it(`a slot due ${offsetS} s from the cut-off: started only before it, and observed`, () => {
      // N=1: slot 0 is due at rotateS after its start; seconds puts that offsetS from the cut-off.
      const rotateS = 300;
      const r = simulate({ n: 1, seconds: rotateS + WARMUP_S - offsetS, rotateS });
      expect(noneAfterCutoff(r)).toBe(true);
      expect(allRunningBeforeLoopEnd(r)).toBe(true);
      if (r.rotations.length === 0) expect(r.deferred).toEqual([0]);
    });
  }

  it('a rotation started just before the cut-off still completes before the loop ends', () => {
    // Worst-case harness bounds: 15 s clean-up wait, 20 s start-up wait (35 s > the 30 s warm-up).
    const r = simulate({ n: 1, seconds: 330, rotateS: 299, cleanupMs: 15_000, startupMs: 20_000 });
    expect(r.rotations).toHaveLength(1);
    expect(r.rotations[0]!.decidedS).toBeLessThan(r.cutoffS);
    // The loop's own condition is checked only between iterations: it runs on past the end.
    expect(r.loopEndS).toBeGreaterThanOrEqual(r.rotations[0]!.runningS);
  });

  it('full soak (N=5, 7200 s, rotate 1500): four rotations per slot, none near the end', () => {
    const r = simulate({ n: 5, seconds: 7200, rotateS: 1500 });
    expect(r.perSlot).toEqual([4, 4, 4, 4, 4]);
    expect(r.rotations).toHaveLength(20);
    expect(noneAfterCutoff(r)).toBe(true);
    expect(Math.max(...r.rotations.map((x) => x.decidedS))).toBeLessThan(7200 - 1000);
    expect(r.maxAgeS).toBeLessThan(LIFETIME_S - 60);
  });

  it('full soak with slow replacements (35 s each) keeps the same rotations', () => {
    const r = simulate({
      n: 5,
      seconds: 7200,
      rotateS: 1500,
      cleanupMs: 15_000,
      startupMs: 20_000,
    });
    expect(r.perSlot).toEqual([4, 4, 4, 4, 4]);
    expect(r.maxAgeS).toBeLessThan(LIFETIME_S - 60);
  });

  it('DEV smoke soak (N=1, 330 s, rotate 270): one rotation', () => {
    const r = simulate({ n: 1, seconds: 330, rotateS: 270 });
    expect(r.rotations).toHaveLength(1);
    expect(noneAfterCutoff(r)).toBe(true);
  });
});
