/**
 * Moving a wire segment without dragging (BETA-G3; WCAG 2.1.1, 2.5.7): the pure choices around the
 * domain edit `moveWireSegment`. A route is orthogonal; segment i joins points i and i + 1.
 */
import type { Point } from '@tbi-lab/domain';

/** The chosen segment of one wire (view state, never stored in the project). */
export interface SegmentPick {
  wire: string;
  index: number;
}

export const isHorizontalSegment = (route: readonly Point[], index: number): boolean =>
  route[index]!.y === route[index + 1]!.y;

/** A segment moves only across its own line, in physical (screen) directions. */
export const segmentDirections = (horizontal: boolean) =>
  horizontal ? (['up', 'down'] as const) : (['left', 'right'] as const);

/** The chosen index kept inside a route of `count` segments; the middle one when none is chosen. */
export const clampSegment = (index: number | undefined, count: number): number =>
  Math.max(0, Math.min(count - 1, index ?? Math.floor((count - 1) / 2)));

/**
 * Where the moved segment is in the new route (a move can add a jog before it or merge it with a
 * neighbour): the segment on the shifted line that overlaps it most, else the clamped old index.
 */
export function followSegment(
  before: readonly Point[],
  index: number,
  delta: Point,
  after: readonly Point[],
): number {
  const horizontal = isHorizontalSegment(before, index);
  const along = horizontal ? 'x' : 'y';
  const across = horizontal ? 'y' : 'x';
  const [a, b] = [before[index]!, before[index + 1]!];
  const line = a[across] + delta[across];
  let best = clampSegment(index, after.length - 1);
  let bestOverlap = 0;
  for (let i = 0; i < after.length - 1; i++) {
    const [c, d] = [after[i]!, after[i + 1]!];
    if (c[across] !== line || d[across] !== line) continue;
    const overlap =
      Math.min(Math.max(a[along], b[along]), Math.max(c[along], d[along])) -
      Math.max(Math.min(a[along], b[along]), Math.min(c[along], d[along]));
    if (overlap > bestOverlap) [best, bestOverlap] = [i, overlap];
  }
  return best;
}
