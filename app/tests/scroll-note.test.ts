import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import { overflows, scrollEnds, scrollStep, wheelPixels } from '../src/ui/scrollNote.js';
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

describe('view message scroll buttons (WCAG 1.4.10)', () => {
  const box = (scrollTop: number) => ({ scrollTop, scrollHeight: 200, clientHeight: 60 });
  it('knows each end, with a rounding pixel of tolerance', () => {
    expect(scrollEnds(box(0))).toEqual({ top: true, bottom: false });
    expect(scrollEnds(box(70))).toEqual({ top: false, bottom: false });
    expect(scrollEnds(box(139.4))).toEqual({ top: false, bottom: true });
    expect(scrollEnds(box(140))).toEqual({ top: false, bottom: true });
  });
  it('steps less than a box, so a line is never skipped, and always moves', () => {
    expect(scrollStep(100)).toBe(60);
    expect(scrollStep(300)).toBe(260);
    expect(scrollStep(40)).toBe(16);
  });
  it('names both buttons in English and Hebrew', () => {
    for (const messages of [en, he] as Record<string, string>[])
      for (const key of ['view.messages.scrollUp', 'view.messages.scrollDown'])
        expect(messages[key]).toBeTruthy();
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
