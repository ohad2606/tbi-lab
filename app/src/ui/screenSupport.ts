/**
 * Screen support policy. The supported setup is Chrome or Edge on a computer (public beta,
 * 2026-11-27); phones and tablets are not supported. This class only chooses which message, if any,
 * is shown (work is never blocked): a touch screen at least 1024 px wide, in landscape, gets none.
 *
 * Thresholds come from the real layout:
 * - 1024 CSS px is the narrowest width the editor is built and tested for (`.app` min-width, the
 *   Alpha UX-P1 toolbar fit at 1024 px). Every current iPad and Android tablet is at least 1024 px
 *   wide in landscape (iPad mini 1133, iPad 1080-1180, iPad Pro 1194/1366, Galaxy Tab S4 1138), and
 *   narrower in portrait (744-1024).
 * - A phone has a coarse primary pointer (touch), a short side under 600 px AND a long side under
 *   1024 px: phones have a short side of 360-440 px and a long side up to about 950 px in either
 *   orientation, while the smallest tablets have a short side of 600 px or more (7-inch Android
 *   tablets 600, iPad mini 744). The long-side condition keeps a wide, short touch screen (e.g.
 *   1400 x 560) from being called a phone.
 * Sizes are the layout viewport in CSS pixels (document.documentElement.clientWidth/Height).
 * Browser zoom shrinks them (a 1280 x 720 window at 200% is 640 x 360), so a small size alone is
 * not a phone: with a fine primary pointer it is a 'narrow' computer window. Pinch-zoom does not
 * change them.
 */
export type ScreenSupport =
  /** Supported as it is: a computer, or a tablet in landscape. No message. */
  | 'ok'
  /** A phone (small touch screen): not supported. A clear message (work is not blocked). */
  | 'phone'
  /** A touch tablet in portrait: a gentle hint to rotate to landscape. */
  | 'rotate'
  /** Any other window under 1024 px wide (zoomed in included): a hint to widen it or zoom out. */
  | 'narrow';

export const MIN_SUPPORTED_WIDTH = 1024;
export const PHONE_SHORT_SIDE = 600;

export function screenSupport(
  width: number,
  height: number,
  coarsePointer: boolean,
): ScreenSupport {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  if (coarsePointer && short < PHONE_SHORT_SIDE && long < MIN_SUPPORTED_WIDTH) return 'phone';
  // A tablet (touch is its primary pointer) in portrait: landscape is the recommended use, even
  // where the portrait width reaches 1024 px (12.9-inch iPad Pro).
  if (coarsePointer && height > width) return 'rotate';
  if (width < MIN_SUPPORTED_WIDTH) return 'narrow';
  return 'ok';
}
