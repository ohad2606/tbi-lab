/**
 * Screen support policy (owner decision 2026-10-29, after the first real tablet check):
 * computers and tablets are supported, tablets preferably in landscape; phones are not.
 *
 * Thresholds come from the real layout:
 * - 1024 CSS px is the narrowest width the editor is built and tested for (`.app` min-width, the
 *   Alpha UX-P1 toolbar fit at 1024 px). Every current iPad and Android tablet is at least 1024 px
 *   wide in landscape (iPad mini 1133, iPad 1080-1180, iPad Pro 1194/1366, Galaxy Tab S4 1138), and
 *   narrower in portrait (744-1024).
 * - A phone is a screen whose short side is under 600 px AND whose long side is under 1024 px:
 *   phones have a short side of 360-440 px and a long side up to about 950 px in either
 *   orientation, while the smallest tablets have a short side of 600 px or more (7-inch Android
 *   tablets 600, iPad mini 744). The long-side condition keeps a short desktop window (e.g.
 *   1400 x 560 with developer tools open) from being called a phone.
 * Sizes are the layout viewport in CSS pixels (document.documentElement.clientWidth/Height), which
 * zooming does not change.
 */
export type ScreenSupport =
  /** Supported as it is: a computer, or a tablet in landscape. No message. */
  | 'ok'
  /** Phone-size: not supported. A clear message (work is not blocked). */
  | 'phone'
  /** A touch tablet in portrait: a gentle hint to rotate to landscape. */
  | 'rotate'
  /** Any other window under 1024 px wide: a gentle hint to widen it. */
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
  if (short < PHONE_SHORT_SIDE && long < MIN_SUPPORTED_WIDTH) return 'phone';
  // A tablet (touch is its primary pointer) in portrait: landscape is the recommended use, even
  // where the portrait width reaches 1024 px (12.9-inch iPad Pro).
  if (coarsePointer && height > width) return 'rotate';
  if (width < MIN_SUPPORTED_WIDTH) return 'narrow';
  return 'ok';
}
