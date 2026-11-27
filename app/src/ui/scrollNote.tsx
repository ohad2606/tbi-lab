/**
 * A message box laid over a view (Circuit hint, 3D note). It is click-through (CSS), so the
 * drawing under it stays usable; when its text is clipped (WCAG 1.4.10) the mouse wheel over it
 * scrolls it, and it becomes a named Tab stop that the keyboard can scroll (2.1.1). Two small
 * buttons inside the box scroll it for a pointer without a wheel; they are the only part of the
 * box that takes clicks.
 */
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useT } from './context.js';

export const overflows = (box: { scrollHeight: number; clientHeight: number }): boolean =>
  box.scrollHeight - box.clientHeight > 1;

/** A wheel step in pixels: `deltaMode` 0 is pixels, 1 lines, 2 pages. */
export const wheelPixels = (e: { deltaY: number; deltaMode: number }, page: number): number =>
  e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? page : 1);

/** At which ends the text is, with the same rounding tolerance. */
export const scrollEnds = (box: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}) => ({
  top: box.scrollTop <= 1,
  bottom: box.scrollHeight - box.clientHeight - box.scrollTop <= 1,
});

/** One button press: less than the box, so no line is skipped; never less than a line. */
export const scrollStep = (page: number): number => Math.max(16, page - 40);

const ARROWS = [
  { id: 'up', end: 'top', sign: -1, key: 'view.messages.scrollUp', path: 'M5 12.5l5-5 5 5' },
  { id: 'down', end: 'bottom', sign: 1, key: 'view.messages.scrollDown', path: 'M5 7.5l5 5 5-5' },
] as const;

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
  const [buttonFocused, setButtonFocused] = useState(false);
  const [ends, setEnds] = useState({ top: true, bottom: false });
  const resized = useRef(onResize);
  resized.current = onResize;
  useLayoutEffect(() => {
    if (!box) return;
    const measureEnds = () => {
      const next = scrollEnds(box);
      setEnds((was) => (was.top === next.top && was.bottom === next.bottom ? was : next));
    };
    const measure = () => {
      setClipped(overflows(box));
      measureEnds();
    };
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
    box.addEventListener('scroll', measureEnds, { passive: true });
    return () => {
      size.disconnect();
      content.disconnect();
      view.removeEventListener('wheel', onWheel, { capture: true });
      box.removeEventListener('scroll', measureEnds);
    };
  }, [box]);
  // Focus is never dropped because the text became short while the box had it.
  const stop = clipped || focused || buttonFocused;
  // Likewise a button that has focus stays (disabled at both ends) when the text becomes short.
  const buttons = clipped || buttonFocused;
  return (
    <div
      {...props}
      class={buttons ? `${props.class} has-scroll-buttons` : props.class}
      ref={setBox}
      tabindex={stop ? 0 : undefined}
      role={stop ? 'group' : undefined}
      aria-label={stop ? t('view.messages') : undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      {buttons && (
        <span
          class="view-note-scroll"
          onFocusIn={() => setButtonFocused(true)}
          onFocusOut={(e) => {
            // The render can run before the next element has focus: a move between the buttons
            // keeps them, and a move back to the box keeps it a Tab stop. Otherwise the target
            // would go while receiving focus, and focus would drop to the page.
            const to = e.relatedTarget as Node | null;
            if (e.currentTarget.contains(to)) return;
            if (to && to === box) setFocused(true);
            setButtonFocused(false);
          }}
        >
          {ARROWS.map((a) => {
            const off = !clipped || ends[a.end];
            return (
              <button
                key={a.id}
                type="button"
                data-scroll={a.id}
                aria-label={t(a.key)}
                title={t(a.key)}
                // Not `disabled`: that would drop the focus at the end of the text.
                aria-disabled={off ? 'true' : 'false'}
                onClick={() => {
                  if (!off && box) box.scrollTop += a.sign * scrollStep(box.clientHeight);
                }}
              >
                <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                  <path d={a.path} />
                </svg>
              </button>
            );
          })}
        </span>
      )}
      {children}
    </div>
  );
}
