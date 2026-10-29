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
 * Keep an element over the visible part of the page: its physical left offset (relative to where
 * the layout puts it, its parent's left edge) and width follow the visual viewport. A layout wider
 * than the screen pans sideways (and Chromium on Android widens the layout viewport to it, so
 * `100vw` and `position: sticky` are the full 1024 px); in Hebrew the page starts at its right end.
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
      const parent = el?.parentElement;
      if (!el || !parent) return;
      const pageLeft = vv ? vv.pageLeft : scrollX;
      // The width is the screen's (the initial containing block), not the zoomed visual viewport:
      // pinch-zooming must not re-wrap the notes and move the page under the user's finger.
      const width = document.documentElement.clientWidth;
      const parentLeft = parent.getBoundingClientRect().left + scrollX;
      const parentWidth = parent.getBoundingClientRect().width;
      const w = Math.min(width, parentWidth);
      const left = Math.min(Math.max(0, pageLeft - parentLeft), parentWidth - w);
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
    if (ref.current?.parentElement) ro?.observe(ref.current.parentElement);
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
 * is covered) and stay over the visible area when a narrow screen pans the page sideways.
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
          <strong class="dev-strip-label" dir="ltr">
            {t('deployment.devBadge')}
          </strong>
          <span>{t('deployment.devStrip')}</span>
        </div>
      )}
      {support !== 'ok' && (
        <div
          class={`screen-note screen-note-${support}`}
          role={support === 'phone' ? 'alert' : 'note'}
          data-testid="screen-note"
          data-support={support}
        >
          {t(SCREEN_MESSAGES[support])}
        </div>
      )}
    </div>
  );
}
