/** BETA-G3: the fit keeps the drawing clear of the overlays of a view (WCAG 2.4.11). */
import { describe, expect, it } from 'vitest';
import { fitCamera, type FitOptions } from '../src/ui/fitCamera.js';
import type { Box } from '../src/ui/revealDelta.js';

const options: FitOptions = { marginX: 150, marginY: 90, pad: 24, min: 0.25, max: 1.5 };
const box = (left: number, top: number, right: number, bottom: number): Box => ({
  left,
  top,
  right,
  bottom,
});
/** World boxes in screen pixels under a camera. */
const onScreen = (items: Box[], c: { x: number; y: number; scale: number }) =>
  items.map((b) =>
    box(
      (b.left - c.x) * c.scale,
      (b.top - c.y) * c.scale,
      (b.right - c.x) * c.scale,
      (b.bottom - c.y) * c.scale,
    ),
  );
const hits = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
function expectClear(items: Box[], size: { w: number; h: number }, overlays: Box[]) {
  const camera = fitCamera(items, size, overlays, options);
  for (const item of onScreen(items, camera)) {
    expect(item.left).toBeGreaterThanOrEqual(0);
    expect(item.top).toBeGreaterThanOrEqual(0);
    expect(item.right).toBeLessThanOrEqual(size.w);
    expect(item.bottom).toBeLessThanOrEqual(size.h);
    for (const o of overlays) expect(hits(item, o)).toBe(false);
  }
  return camera;
}

describe('fitCamera', () => {
  const size = { w: 500, h: 400 };
  const column = box(430, 10, 490, 260);
  const hint = box(10, 340, 400, 390);
  const wide = [box(0, 0, 40, 40), box(560, 0, 600, 40), box(0, 260, 40, 300)];

  it('centres the drawing with its margins when no overlay is in the way', () => {
    const camera = fitCamera(wide, { w: 1200, h: 900 }, [box(1130, 10, 1190, 260)], options);
    expect(camera.scale).toBeCloseTo(Math.min(1200 / 900, 900 / 480));
    expect(camera.x + 600 / camera.scale).toBeCloseTo(300);
    expect(camera.y + 450 / camera.scale).toBeCloseTo(150);
  });

  it('keeps every item clear of a control column and a hint', () => {
    expectClear(wide, size, [column, hint]);
  });

  it('keeps every item clear of a row along the top', () => {
    expectClear(wide, size, [box(200, 10, 490, 60), hint]);
  });

  it('does not shrink the drawing when moving it is enough', () => {
    // Narrow drawing: the base scale leaves room to move it left of the column.
    const items = [box(0, 0, 40, 40), box(300, 0, 340, 300)];
    const free = fitCamera(items, size, [], options);
    const camera = expectClear(items, size, [box(340, 0, 500, 400)]);
    expect(camera.scale).toBeGreaterThan(free.scale * 0.95);
  });

  it('ignores an overlay that no item meets, however large', () => {
    const items = [box(0, 200, 40, 240), box(300, 200, 340, 240)];
    expect(fitCamera(items, size, [column, hint], options)).toEqual(
      fitCamera(items, size, [], options),
    );
  });

  it('stays at the smallest scale and finite when the view cannot hold the drawing', () => {
    const camera = fitCamera(wide, { w: 100, h: 80 }, [box(40, 0, 100, 80)], options);
    expect(camera.scale).toBe(0.25);
    expect(Number.isFinite(camera.x) && Number.isFinite(camera.y)).toBe(true);
  });

  it('shows the origin in the middle when there is nothing to fit', () => {
    expect(fitCamera([], size, [column], options)).toEqual({ x: -250, y: -200, scale: 1 });
  });
});
