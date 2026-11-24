import { describe, expect, it } from 'vitest';
import { panIntoView } from '../src/ui/wireKeyboard.js';

const cam = { x: 100, y: 100 };
const view = { w: 400, h: 300 };

describe('panIntoView', () => {
  it('does not move when the point is inside the margin', () => {
    expect(panIntoView(cam, view, { x: 300, y: 200 }, 40)).toEqual({ dx: 0, dy: 0 });
    expect(panIntoView(cam, view, { x: 140, y: 360 }, 40)).toEqual({ dx: 0, dy: 0 });
  });
  it('pans so the point ends exactly one margin inside', () => {
    expect(panIntoView(cam, view, { x: 90, y: 100 }, 40)).toEqual({ dx: -50, dy: -40 });
    expect(panIntoView(cam, view, { x: 520, y: 450 }, 40)).toEqual({ dx: 60, dy: 90 });
  });
  it('centres the point when the view is smaller than twice the margin', () => {
    expect(panIntoView({ x: 0, y: 0 }, { w: 60, h: 60 }, { x: 100, y: 10 }, 40)).toEqual({
      dx: 70,
      dy: -20,
    });
  });
});
