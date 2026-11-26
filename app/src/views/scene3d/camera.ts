/** Camera steps of the 3D view's buttons and keys (pure; no three.js here). */

import { PAN_STEP } from '../../ui/viewPan.js';

/** The tilt closest to straight above (radians from vertical): never exactly on the axis. */
export const MIN_POLAR = 0.001;

/** The angle from vertical after raising the camera by `up` radians, within the limits. */
export function tiltedPolar(polar: number, up: number, maxPolar: number): number {
  return Math.min(maxPolar, Math.max(MIN_POLAR, polar - up));
}

/**
 * Arguments of `Viewer.pan` that move the VIEW one step towards (dx, dy) (x right, y down), as in
 * the 2D views. `Viewer.pan` moves the content (like a drag), so the horizontal sign flips.
 */
export function viewerPan(dx: number, dy: number): [number, number] {
  // `|| 0`: no negative zero.
  return [-dx * PAN_STEP || 0, dy * PAN_STEP || 0];
}
