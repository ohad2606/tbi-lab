/** BETA-G3: the pure logic of the Inspector's segment move (orientation, choice, following). */
import { describe, expect, it } from 'vitest';
import {
  clampSegment,
  followSegment,
  isHorizontalSegment,
  segmentDirections,
} from '../src/ui/segments.js';

const p = (x: number, y: number) => ({ x, y });
const route = [p(0, 0), p(40, 0), p(40, 60), p(100, 60)];

describe('segment orientation and directions', () => {
  it('reads orientation from the route', () => {
    expect([0, 1, 2].map((i) => isHorizontalSegment(route, i))).toEqual([true, false, true]);
  });
  it('offers only the two perpendicular directions', () => {
    expect(segmentDirections(true)).toEqual(['up', 'down']);
    expect(segmentDirections(false)).toEqual(['left', 'right']);
  });
});

describe('clampSegment', () => {
  it('starts on the middle segment', () => {
    expect(clampSegment(undefined, 1)).toBe(0);
    expect(clampSegment(undefined, 3)).toBe(1);
    expect(clampSegment(undefined, 4)).toBe(1);
  });
  it('keeps a chosen index and clamps it when the route got shorter', () => {
    expect(clampSegment(2, 5)).toBe(2);
    expect(clampSegment(4, 3)).toBe(2);
    expect(clampSegment(-1, 3)).toBe(0);
  });
});

describe('followSegment', () => {
  it('follows the first segment past the jog added at the fixed end', () => {
    const after = [p(0, 0), p(0, -20), p(40, -20), p(40, 60), p(100, 60)];
    expect(followSegment(route, 0, p(0, -20), after)).toBe(1);
  });
  it('keeps the index of an inner segment', () => {
    const after = [p(0, 0), p(60, 0), p(60, 60), p(100, 60)];
    expect(followSegment(route, 1, p(20, 0), after)).toBe(1);
  });
  it('finds the segment it merged into', () => {
    // The middle segment of a U lands on the line of its neighbour: they become one.
    const before = [p(0, 0), p(0, 20), p(40, 20), p(40, 0), p(80, 0)];
    const after = [p(0, 0), p(80, 0)];
    expect(followSegment(before, 1, p(0, -20), after)).toBe(0);
  });
  it('falls back to a clamped index when nothing lies on the moved line', () => {
    expect(followSegment(route, 2, p(0, 20), [p(0, 0), p(10, 0)])).toBe(0);
  });
});
