/**
 * Panning a view without dragging (BETA-G3; WCAG 2.1.1, 2.5.7): the arithmetic shared by the
 * Circuit, Schematic and 3D views. A direction is the way the VIEW moves, in screen terms
 * (x right, y down); it is physical, never mirrored in RTL.
 */

/** One button press (or a Schematic / 3D arrow key) moves the view by this share of itself. */
export const PAN_STEP = 0.1;

export const PAN_BUTTONS = [
  { id: 'left', key: 'view.panLeft', dx: -1, dy: 0, path: 'M12 4 6 10l6 6' },
  { id: 'right', key: 'view.panRight', dx: 1, dy: 0, path: 'M8 4l6 6-6 6' },
  { id: 'up', key: 'view.panUp', dx: 0, dy: -1, path: 'M4 12l6-6 6 6' },
  { id: 'down', key: 'view.panDown', dx: 0, dy: 1, path: 'M4 8l6 6 6-6' },
] as const;

/** A 2D camera (top-left world point, screen pixels per world unit) after one pan step. */
export function panCamera<C extends { x: number; y: number; scale: number }>(
  camera: C,
  size: { w: number; h: number },
  dx: number,
  dy: number,
): C {
  return {
    ...camera,
    x: camera.x + (dx * PAN_STEP * size.w) / camera.scale,
    y: camera.y + (dy * PAN_STEP * size.h) / camera.scale,
  };
}
