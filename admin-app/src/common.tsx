import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { LoadError } from '@tbi-lab/admin-client';
import { formatCount, type MessageKey } from './i18n.js';
import { useConsole, useT } from './context.js';
import { barHeights } from './views.js';

/** Where the gate starts a sign-in, and where it ends one (admin app design §1). */
export const SIGN_IN_URL = '/oauth2/start?rd=/';
export const SIGN_OUT_URL = '/oauth2/sign_out';

/** The breakpoint of the desktop layout (side navigation, tables). */
const WIDE = '(min-width: 900px)';

export function useWide(): boolean {
  const query = () => typeof matchMedia === 'function' && matchMedia(WIDE).matches;
  const [wide, setWide] = useState(query);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(WIDE);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

/** A number: the UI language's digits, always a left-to-right run. */
export function Num({ n, testid }: { n: number; testid?: string }) {
  const { locale } = useConsole();
  return (
    <bdi dir="ltr" data-testid={testid}>
      {formatCount(locale, n)}
    </bdi>
  );
}

/** Why a panel has no data: signed out (with the way back in), no access, or unavailable. */
export function Problem({
  error,
  unavailable,
  testid,
}: {
  error: LoadError;
  unavailable: MessageKey;
  testid?: string;
}) {
  const t = useT();
  return (
    <p role="alert" class="problem" data-testid={testid ?? 'problem'} data-error={error}>
      {error === 'unavailable' ? t(unavailable) : t(`admin.error.${error}`)}
      {error === 'signed_out' && (
        <>
          {' '}
          <a href={SIGN_IN_URL} data-testid="sign-in-link">
            {t('console.access.signIn')}
          </a>
        </>
      )}
    </p>
  );
}

export const Loading = () => {
  const t = useT();
  return <p class="muted">{t('admin.loading')}</p>;
};

/** An inline confirmation of a consequential action; it takes focus on its safe choice. */
export function Confirm({
  title,
  children,
  action,
  danger,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ComponentChildren;
  action: string;
  danger: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <section
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
      class="confirm"
      data-testid="confirm"
    >
      <h3 id="confirm-title">{title}</h3>
      <div id="confirm-body">{children}</div>
      <div class="actions">
        <button
          ref={cancel}
          type="button"
          class="button"
          data-testid="confirm-cancel"
          aria-disabled={busy ? 'true' : undefined}
          onClick={() => !busy && onCancel()}
        >
          {t('admin.cancel')}
        </button>
        <button
          type="button"
          class={`button ${danger ? 'button-danger' : 'button-primary'}`}
          data-testid="confirm-ok"
          aria-disabled={busy ? 'true' : undefined}
          onClick={() => !busy && onConfirm()}
        >
          {busy ? t('admin.working') : action}
        </button>
      </div>
    </section>
  );
}

/**
 * A small bar chart (plain SVG, no library): one bar per day, oldest at the inline start. The
 * chart is a picture of the numbers beside it; its accessible name states the total.
 */
export function BarChart({
  values,
  dates,
  label,
}: {
  values: number[];
  dates: string[];
  label: string;
}) {
  const { locale } = useConsole();
  const H = 60;
  const W = 300;
  const step = values.length ? W / values.length : W;
  const heights = barHeights(values, H);
  const rtl = locale.dir === 'rtl';
  return (
    <svg
      class="chart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      data-testid="tester-chart"
    >
      <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} class="chart-axis" />
      {heights.map((h, i) => {
        const x = (rtl ? values.length - 1 - i : i) * step;
        return (
          <rect
            key={dates[i]}
            x={x + step * 0.15}
            y={H - h}
            width={step * 0.7}
            height={h}
            class="chart-bar"
            data-value={values[i]}
          >
            <title>{`${dates[i]}: ${formatCount(locale, values[i]!)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** Inline icons (24 x 24, stroked with the text colour; decorative: the label says it all). */
const ICONS = {
  today: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  testers:
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 3.5a4 4 0 0 1 0 7M18 14a6 6 0 0 1 4 6v1',
  feedback: 'M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4v-4H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
  more: 'M4 6h16M4 12h16M4 18h16',
  activity: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.7-1L15 3.5h-4L10.6 6a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.4z',
  signOut: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11',
  add: 'M12 5v14M5 12h14',
  /** Points to the inline start (left in English); mirrored right to left. */
  back: 'M19 12H5M11 6l-6 6 6 6',
  /** Points to the inline end; mirrored right to left. */
  forward: 'M9 6l6 6-6 6',
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, class: cls }: { name: IconName; class?: string }) {
  return (
    <svg
      class={`icon${name === 'back' || name === 'forward' ? ' icon-directional' : ''}${cls ? ` ${cls}` : ''}`}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

/** "Back": an arrow toward the inline start (right in Hebrew, left in English) and the word. */
export function BackButton({ onClick, testid }: { onClick: () => void; testid: string }) {
  const t = useT();
  return (
    <button type="button" class="back" data-testid={testid} onClick={onClick}>
      <Icon name="back" />
      <span>{t('console.back')}</span>
    </button>
  );
}
