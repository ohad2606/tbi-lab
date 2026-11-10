/**
 * Rotation scheduling for c5-deployed (pure, so its boundaries are unit-tested without a host:
 * runtime/tests/unit/c5-rotation.test.ts).
 *
 * The deadline: no rotation starts in the run's last `warmupS`. A replacement started there could
 * yield no measured window, and it would outlast the load loop. W1 C4 on Alpha, 2026-11-10: 420 s =
 * 7 x the 60 s stagger put the last rotation exactly on the end; the loop ended before the
 * replacement was polled and its state stayed unset (noFailures false).
 *
 * The decision must use a clock read immediately before it, never the loop's top-of-iteration
 * timestamp: polling N sessions, the isolation probes and fault injection can take seconds.
 */
export interface RotationSlot {
  fault?: string;
  /** performance.now() at which this instance is due for replacement; unset: never. */
  rotateAt?: number;
}

export interface RotationClock {
  /** performance.now() at the start of the load loop. */
  t0: number;
  seconds: number;
  warmupS: number;
}

/** The first instant at which no rotation may start any more. */
export const rotationCutoff = (c: RotationClock): number => c.t0 + 1000 * (c.seconds - c.warmupS);

/** The earliest-due slot at `now` (a fresh clock reading), or none: nothing due, or past the cutoff. */
export function dueRotation<T extends RotationSlot>(
  slots: readonly T[],
  now: number,
  c: RotationClock,
): T | undefined {
  if (now >= rotationCutoff(c)) return undefined;
  return slots
    .filter((x) => !x.fault && x.rotateAt !== undefined && x.rotateAt <= now)
    .sort((a, b) => a.rotateAt! - b.rotateAt!)[0];
}
