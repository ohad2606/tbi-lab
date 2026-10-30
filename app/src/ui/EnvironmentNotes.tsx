import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { IS_DEV_ENV } from '../deployment.js';
import type { MessageKey } from '../i18n/messages.en.js';
import { useT } from './context.js';
import { screenSupport, type ScreenSupport } from './screenSupport.js';

function currentSupport(): ScreenSupport {
  const root = document.documentElement;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return screenSupport(root.clientWidth, root.clientHeight, coarse);
}

/** The screen support class, kept current across resizing and rotation. */
export function useScreenSupport(): ScreenSupport {
  const [support, setSupport] = useState(currentSupport);
  useEffect(() => {
    const update = () => setSupport(currentSupport());
    addEventListener('resize', update);
    addEventListener('orientationchange', update);
    return () => {
      removeEventListener('resize', update);
      removeEventListener('orientationchange', update);
    };
  }, []);
  return support;
}

/**
 * The notes' bands span the page layout (like the top bar), but their TEXT follows the visible part
 * of the page: a layout wider than the screen pans sideways (Chromium on Android widens the layout
 * viewport to it, so `100vw` and `position: sticky` are the full 1024 px), and in Hebrew the page
 * may start at either end. This sets, on the notes element, the physical offset and width of the
 * visible part within it (--notes-left, --notes-width); each band's `.note-body` uses them.
 */
function useVisibleBox<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    // Nothing rendered (production branding on a supported screen): nothing to follow.
    if (!ref.current) return;
    const vv = typeof visualViewport === 'object' ? visualViewport : null;
    let frame = 0;
    const update = () => {
      frame = 0;
      const el = ref.current;
      if (!el) return;
      const pageLeft = vv ? vv.pageLeft : scrollX;
      // The width is the screen's (the initial containing block), not the zoomed visual viewport:
      // pinch-zooming must not re-wrap the notes and move the page under the user's finger.
      const width = document.documentElement.clientWidth;
      const box = el.getBoundingClientRect();
      const w = Math.min(width, box.width);
      const left = Math.min(Math.max(0, pageLeft - (box.left + scrollX)), box.width - w);
      el.style.setProperty('--notes-left', `${Math.round(left)}px`);
      el.style.setProperty('--notes-width', `${Math.floor(w)}px`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    const targets: EventTarget[] = [window, ...(vv ? [vv] : [])];
    for (const t of targets) {
      t.addEventListener('scroll', schedule, { passive: true });
      t.addEventListener('resize', schedule);
    }
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    ro?.observe(ref.current);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      for (const t of targets) {
        t.removeEventListener('scroll', schedule);
        t.removeEventListener('resize', schedule);
      }
      ro?.disconnect();
    };
  });
  return ref;
}

const SCREEN_MESSAGES: Record<Exclude<ScreenSupport, 'ok'>, MessageKey> = {
  phone: 'app.screen.phone',
  rotate: 'app.screen.rotate',
  narrow: 'app.screen.narrow',
};

/**
 * The notes above the top bar: the DEV strip on DEV-Lab builds, and the screen support message
 * when the screen needs one. They take their own row of the layout (the page moves down; nothing
 * is covered); the bands span the layout like the top bar, and their text stays in the visible area
 * when a narrow screen pans the page sideways.
 */
export function EnvironmentNotes() {
  const t = useT();
  const support = useScreenSupport();
  const ref = useVisibleBox<HTMLDivElement>();
  if (!IS_DEV_ENV && support === 'ok') return null;
  return (
    <div class="app-notes" ref={ref}>
      {IS_DEV_ENV && (
        <div class="dev-strip" role="note" data-testid="dev-strip">
          <div class="note-body">
            <strong class="dev-strip-label" dir="ltr">
              {t('deployment.devBadge')}
            </strong>
            <span>{t('deployment.devStrip')}</span>
          </div>
        </div>
      )}
      {support !== 'ok' && (
        <div
          class={`screen-note screen-note-${support}`}
          role={support === 'phone' ? 'alert' : 'note'}
          data-testid="screen-note"
          data-support={support}
        >
          <div class="note-body">{t(SCREEN_MESSAGES[support])}</div>
        </div>
      )}
    </div>
  );
}
