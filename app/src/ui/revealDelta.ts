/**
 * WCAG 2.4.11 Focus Not Obscured: how far a 2D view must move so that a focused item is inside it
 * and clear of its overlays. All rectangles are screen pixels.
 */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Screen pixels kept between an item brought into view and the edges or overlays. */
export const FOCUS_MARGIN = 8;

/** How far to move [a, b] so it lies inside [lo, hi]; a span too long to fit is centred. */
function intoRange(a: number, b: number, lo: number, hi: number): number {
  if (b - a > hi - lo) return (a + b - lo - hi) / 2;
  return a < lo ? a - lo : b > hi ? b - hi : 0;
}

const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Zero when `item` is already inside `frame` and under no overlay. The view controls are a column
 * at the right edge or, in a short view, a row along the top; `foot` runs along the bottom.
 */
export function revealDelta(
  item: Box,
  frame: Box,
  controls: Box,
  foot: Box | undefined,
  short: boolean,
): { dx: number; dy: number } {
  const inside =
    item.left >= frame.left &&
    item.right <= frame.right &&
    item.top >= frame.top &&
    item.bottom <= frame.bottom;
  if (inside && !overlaps(item, controls) && !(foot && overlaps(item, foot)))
    return { dx: 0, dy: 0 };
  const right = short ? frame.right : controls.left;
  const top = short ? controls.bottom : frame.top;
  const bottom = foot ? foot.top : frame.bottom;
  return {
    dx: intoRange(item.left, item.right, frame.left + FOCUS_MARGIN, right - FOCUS_MARGIN),
    dy: intoRange(item.top, item.bottom, top + FOCUS_MARGIN, bottom - FOCUS_MARGIN),
  };
}
