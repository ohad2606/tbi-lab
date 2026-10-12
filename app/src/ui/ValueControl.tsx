/**
 * The engineering value control (Sprint 13 OS-01): one reusable control for every physical
 * quantity a user edits. A numeric field in the quantity's SI unit (typed values take SI prefixes,
 * `4k7`-style forms and unit suffixes, parsed by the domain's exact parser), the unit symbol, the
 * allowed range, an error when a value cannot be used, and, for an environment parameter, a
 * slider with live updates while dragging (OS-03/OS-06).
 *
 * Canonical values only: the control reports a value in the quantity's canonical SI unit and
 * never stores text. Locale affects labels and the range text, never the value or the parser
 * (the decimal separator is always `.` in technical fields, which are LTR).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseQuantity, type UnitId } from '@tbi-lab/domain';
import { formatQuantity, inputForm, isolateLtr, unitSymbol } from '../i18n/i18n.js';
import { useAppState, useT } from './context.js';
import { liveThrottle, sliderScale } from './sliderScale.js';

/** Live updates while dragging: at most one per this interval (10 per second). */
export const LIVE_INTERVAL_MS = 100;

export interface ValueControlProps {
  /** Element id and test id base. */
  id: string;
  label: string;
  unit: UnitId;
  min: number;
  max: number;
  /** The stored canonical value (null: none). */
  value: number | null;
  disabled: boolean;
  /** An environment parameter: show a slider on this scale. */
  slider?: 'linear' | 'log';
  /**
   * A new canonical value. `live`: an intermediate value while the slider is dragged (bounded
   * frequency); the final value of a drag and every typed value come with `live: false`.
   * `slider`: the value comes from the slider (a drag is one edit for undo).
   */
  onCommit(value: number, opts: { live: boolean; slider: boolean }): void;
}

/** A typed quantity; a range below zero also takes a leading minus (ASCII or U+2212). */
function parseSigned(raw: string, unit: UnitId, min: number) {
  const text = raw.trim();
  if (min < 0 && /^[-−]/.test(text)) {
    const r = parseQuantity(text.slice(1), unit);
    return r.ok ? { ...r, value: -r.value } : r;
  }
  return parseQuantity(raw, unit);
}

export function ValueControl(p: ValueControlProps) {
  const { locale } = useAppState();
  const t = useT();
  const shown = p.value === null ? '' : inputForm(p.value, p.unit);
  // The draft starts at the stored value and is reset only when that value changes (a passive
  // effect on mount would wipe text typed in the meantime, CI run 35828605417).
  const [draft, setDraft] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  const synced = useRef(shown);
  useEffect(() => {
    if (synced.current === shown) return;
    synced.current = shown;
    setDraft(shown);
    setError(null);
  }, [shown]);

  const range = {
    min: isolateLtr(formatQuantity(locale, { value: p.min, unit: p.unit })),
    max: isolateLtr(formatQuantity(locale, { value: p.max, unit: p.unit })),
  };

  /** Commit exactly the text in the element (a fast Enter/Blur can precede a render). */
  const commit = (raw: string) => {
    if (raw === shown) return setError(null);
    const parsed = parseSigned(raw, p.unit, p.min);
    if (!parsed.ok) return setError(t(`error.parse.${parsed.error}`));
    if (parsed.value < p.min || parsed.value > p.max) return setError(t('error.range', range));
    setError(null);
    if (p.value === parsed.value) return;
    p.onCommit(parsed.value, { live: false, slider: false });
  };

  // Slider: the thumb follows the pointer while dragging (never re-derived from a rounded value
  // mid-drag), the field shows the value under the thumb, and the value is sent at a bounded
  // rate; the release always commits the final value.
  const scale = useMemo(
    () => (p.slider ? sliderScale(p.min, p.max, p.slider) : null),
    [p.slider, p.min, p.max],
  );
  const [dragPos, setDragPos] = useState<number | null>(null);
  const onCommit = useRef(p.onCommit);
  onCommit.current = p.onCommit;
  const live = useMemo(
    () =>
      liveThrottle<number>(
        (v) => onCommit.current(v, { live: true, slider: true }),
        LIVE_INTERVAL_MS,
      ),
    [],
  );

  return (
    <div class="field value-control">
      <label for={p.id}>{p.label}</label>
      <div class="field-row" dir="ltr">
        <input
          id={p.id}
          data-testid={p.id}
          class="technical"
          dir="ltr"
          inputMode="decimal"
          autocomplete="off"
          spellcheck={false}
          value={draft}
          disabled={p.disabled}
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={`${p.id}-hint`}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value);
            if (e.key === 'Escape') {
              setDraft(shown);
              setError(null);
            }
          }}
        />
        <span class="unit">{unitSymbol(locale, p.unit)}</span>
      </div>
      {scale && (
        <input
          type="range"
          class="environment-slider"
          data-testid={`${p.id}-slider`}
          aria-label={p.label}
          aria-valuetext={isolateLtr(
            formatQuantity(locale, {
              value: dragPos !== null ? scale.value(dragPos) : (p.value ?? p.min),
              unit: p.unit,
            }),
          )}
          min={0}
          max={scale.steps}
          step={1}
          value={dragPos ?? scale.position(p.value ?? p.min)}
          disabled={p.disabled}
          onInput={(e) => {
            const pos = Number((e.target as HTMLInputElement).value);
            const v = scale.value(pos);
            setDragPos(pos);
            setDraft(inputForm(v, p.unit));
            setError(null);
            live.push(v);
          }}
          onChange={(e) => {
            const v = scale.value(Number((e.target as HTMLInputElement).value));
            setDragPos(null);
            setDraft(inputForm(v, p.unit));
            // The release: no pending live value may arrive after it; the final value always does.
            live.cancel();
            p.onCommit(v, { live: false, slider: true });
          }}
        />
      )}
      {error ? (
        <p class="field-error" role="alert" data-testid={`${p.id}-error`}>
          {error}
        </p>
      ) : (
        <p class="muted small" id={`${p.id}-hint`}>
          {t('inspector.range', range)}
        </p>
      )}
    </div>
  );
}
