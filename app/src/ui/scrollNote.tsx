/**
 * A message box laid over a view (Circuit hint, 3D note). It is click-through (CSS), so the
 * drawing under it stays usable; when its text is clipped (WCAG 1.4.10) the mouse wheel over it
 * scrolls it, and it becomes a named Tab stop that the keyboard can scroll (2.1.1).
 */
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useT } from './context.js';

export const overflows = (box: { scrollHeight: number; clientHeight: number }): boolean =>
  box.scrollHeight - box.clientHeight > 1;

/** A wheel step in pixels: `deltaMode` 0 is pixels, 1 lines, 2 pages. */
export const wheelPixels = (e: { deltaY: number; deltaMode: number }, page: number): number =>
  e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? page : 1);

export function ScrollNote({
  children,
  onResize,
  ...props
}: {
  class: string;
  dir: 'ltr' | 'rtl';
  'data-testid'?: string;
  children: ComponentChildren;
  /** The box changed size: it may now cover something it did not. */
  onResize?(box: HTMLDivElement): void;
}) {
  const t = useT();
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [clipped, setClipped] = useState(false);
  const [focused, setFocused] = useState(false);
  const resized = useRef(onResize);
  resized.current = onResize;
  useLayoutEffect(() => {
    if (!box) return;
    const measure = () => setClipped(overflows(box));
    measure();
    const size = new ResizeObserver(() => {
      measure();
      resized.current?.(box);
    });
    size.observe(box);
    // A capped box keeps its size when its text grows.
    const content = new MutationObserver(measure);
    content.observe(box, { childList: true, subtree: true, characterData: true });
    // Capture on the view: before the drawing's own wheel zoom.
    const view = box.parentElement!;
    const onWheel = (e: WheelEvent) => {
      // Ctrl + wheel stays with the browser (zoom).
      if (e.ctrlKey || !overflows(box)) return;
      const target = e.target as Element;
      // Only over the drawing: a panel above the box keeps its own wheel.
      if (!box.contains(target) && !target.closest('svg, .view3d-host')) return;
      const r = box.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        return;
      e.preventDefault();
      e.stopPropagation();
      box.scrollTop += wheelPixels(e, box.clientHeight);
    };
    view.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => {
      size.disconnect();
      content.disconnect();
      view.removeEventListener('wheel', onWheel, { capture: true });
    };
  }, [box]);
  // Focus is never dropped because the text became short while the box had it.
  const stop = clipped || focused;
  return (
    <div
      {...props}
      ref={setBox}
      tabindex={stop ? 0 : undefined}
      role={stop ? 'group' : undefined}
      aria-label={stop ? t('view.messages') : undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      {children}
    </div>
  );
}
