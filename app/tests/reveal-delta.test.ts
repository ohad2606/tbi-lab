/** WCAG 2.4.11: the pan that brings a focused item clear of the view's overlays. */
import { describe, expect, it } from 'vitest';
import { revealDelta } from '../src/ui/revealDelta.js';

const box = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});
const frame = box(0, 0, 600, 400);
const column = box(528, 12, 588, 230);
const row = box(300, 12, 588, 50);
const hint = box(12, 360, 400, 390);

describe('revealDelta', () => {
  it('does not move an item that is inside and uncovered', () => {
    expect(revealDelta(box(100, 100, 180, 180), frame, column, hint, false)).toEqual({
      dx: 0,
      dy: 0,
    });
    // Below the controls column, at the right edge: visible, so it stays.
    expect(revealDelta(box(520, 260, 590, 330), frame, column, hint, false)).toEqual({
      dx: 0,
      dy: 0,
    });
  });
  it('moves an item under the controls column left of it', () => {
    expect(revealDelta(box(500, 40, 560, 100), frame, column, undefined, false)).toEqual({
      dx: 40,
      dy: 0,
    });
  });
  it('moves an item under the short-view row below it', () => {
    expect(revealDelta(box(400, 20, 440, 60), frame, row, undefined, true)).toEqual({
      dx: 0,
      dy: -38,
    });
  });
  it('moves an item under the hint above it, and brings an off-screen item in', () => {
    expect(revealDelta(box(100, 340, 140, 380), frame, column, hint, false)).toEqual({
      dx: 0,
      dy: 28,
    });
    expect(revealDelta(box(-100, -50, -60, -10), frame, column, undefined, false)).toEqual({
      dx: -108,
      dy: -58,
    });
  });
  it('centres an item too large for the clear area', () => {
    expect(revealDelta(box(0, 0, 700, 100), frame, column, undefined, false).dx).toBe(86);
  });
});
