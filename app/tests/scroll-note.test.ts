import { describe, expect, it } from 'vitest';
import { overflows, wheelPixels } from '../src/ui/scrollNote.js';
import { routeMiddle } from '../src/ui/wireKeyboard.js';

describe('view message box (WCAG 1.4.10)', () => {
  it('overflows only when more than a rounding pixel is clipped', () => {
    expect(overflows({ scrollHeight: 100, clientHeight: 100 })).toBe(false);
    expect(overflows({ scrollHeight: 101, clientHeight: 100 })).toBe(false);
    expect(overflows({ scrollHeight: 140, clientHeight: 100 })).toBe(true);
  });
  it('turns a wheel step into pixels in every delta mode', () => {
    expect(wheelPixels({ deltaY: 100, deltaMode: 0 }, 80)).toBe(100);
    expect(wheelPixels({ deltaY: -3, deltaMode: 1 }, 80)).toBe(-48);
    expect(wheelPixels({ deltaY: 1, deltaMode: 2 }, 80)).toBe(80);
  });
});

describe('routeMiddle', () => {
  it('is the centre of the middle segment of a wire route', () => {
    expect(
      routeMiddle([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toEqual({ x: 5, y: 0 });
    expect(
      routeMiddle([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 40 },
        { x: 30, y: 40 },
      ]),
    ).toEqual({ x: 10, y: 20 });
  });
});
