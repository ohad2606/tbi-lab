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
