/**
 * BETA-G3: the pan and tilt arithmetic behind the view buttons and keys. A direction is the way
 * the VIEW moves, in screen terms (x right, y down), the same in all three views.
 */
import { describe, expect, it } from 'vitest';
import { MIN_POLAR, viewerPan, tiltedPolar } from '../src/views/scene3d/camera.js';
import { PAN_BUTTONS, PAN_STEP, panCamera } from '../src/ui/viewPan.js';

describe('2D view pan', () => {
  const cam = { x: 10, y: 20, scale: 2 };
  it('moves the view by a tenth of what is visible, keeping the scale', () => {
    const size = { w: 800, h: 600 };
    expect(panCamera(cam, size, 1, 0)).toEqual({ x: 10 + (PAN_STEP * 800) / 2, y: 20, scale: 2 });
    expect(panCamera(cam, size, 0, -1)).toEqual({ x: 10, y: 20 - (PAN_STEP * 600) / 2, scale: 2 });
  });
  it('has one button per physical direction', () => {
    expect(PAN_BUTTONS.map((b) => [b.id, b.dx, b.dy])).toEqual([
      ['left', -1, 0],
      ['right', 1, 0],
      ['up', 0, -1],
      ['down', 0, 1],
    ]);
  });
});

describe('3D view pan and tilt', () => {
  it('moves the camera the way of the direction (the renderer moves the content)', () => {
    // Viewer.pan(right, up) moves the CONTENT right and up, like a drag.
    expect(viewerPan(1, 0)).toEqual([-PAN_STEP, 0]);
    expect(viewerPan(-1, 0)).toEqual([PAN_STEP, 0]);
    expect(viewerPan(0, -1)).toEqual([0, -PAN_STEP]);
    expect(viewerPan(0, 1)).toEqual([0, PAN_STEP]);
  });
  it('tilts between straight above and the bench limit', () => {
    const max = Math.PI * 0.495;
    expect(tiltedPolar(1, 0.25, max)).toBeCloseTo(0.75);
    expect(tiltedPolar(1, -0.25, max)).toBeCloseTo(1.25);
    expect(tiltedPolar(0.1, 1, max)).toBe(MIN_POLAR);
    expect(tiltedPolar(1.5, -1, max)).toBe(max);
  });
});
