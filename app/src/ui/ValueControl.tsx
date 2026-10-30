/**
 * The engineering value control (Sprint 13 OS-01; Sprint POT-UNITS Phase 1): one reusable control
 * for every physical quantity a user edits. A plain number field plus, for a quantity with more
 * than one useful unit, a unit dropdown (Ω/kΩ/MΩ, pF/nF/µF/mF, mA/A); a fixed unit
 * symbol otherwise. The allowed range, an error when a value cannot be used, and, for an
 * environment or live parameter, a slider with live updates while dragging (OS-03/OS-06).
 *
 * Canonical values only: the control reports a value in the quantity's canonical SI unit
 * (number x selected unit, exact in decimal) and never stores text or the selected unit; the
 * shown unit is re-derived from the stored value (largest unit whose number is >= 1). As an
 * explicit convenience, a prefixed form typed or pasted into the number field (`4k7`, `100u`,
 * `4.7 kΩ`) is converted by the domain's exact parser. Locale affects labels and the range text,
 * never the value or the parser (the decimal separator is always `.` in technical fields).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  chooseDisplayUnit,
  displayUnitsFor,
  parseEntry,
  type DisplayUnit,
  type UnitId,
} from '@tbi-lab/domain';
import {
  displayNumber,
  displayUnitSymbol,
  formatDisplayQuantity,
  formatQuantity,
  isolateLtr,
  type MessageKey,
} from '../i18n/i18n.js';
import { useAppState, useT } from './context.js';
import { LtrMessage } from './LtrMessage.js';
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

type FieldError = { key: MessageKey; params?: Record<string, string> };

export function ValueControl(p: ValueControlProps) {
  const { locale } = useAppState();
  const t = useT();
  const units = useMemo(() => displayUnitsFor(p.unit, p.min, p.max), [p.unit, p.min, p.max]);
  const offered = units.map((u) => ({ unit: u, symbol: displayUnitSymbol(locale, p.unit, u) }));
  const storedUnit = chooseDisplayUnit(p.value ?? 0, units);
  const shown = p.value === null ? '' : displayNumber(p.value, storedUnit);
  // The draft (text and unit) starts at the stored value and is reset only when that value
  // changes (a passive effect on mount would wipe text typed in the meantime, CI 35828605417).
  const [draft, setDraft] = useState(shown);
  const [draftUnit, setDraftUnit] = useState<DisplayUnit>(storedUnit);
  const [error, setError] = useState<FieldError | null>(null);
  const synced = useRef(`${shown}|${storedUnit.exponent}`);
  const unitRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const key = `${shown}|${storedUnit.exponent}`;
    if (synced.current === key) return;
    synced.current = key;
    setDraft(shown);
    setDraftUnit(storedUnit);
    setError(null);
  }, [shown, storedUnit.exponent]);

  // A fixed-symbol quantity keeps its pre-sprint range text (`10 mm` to `5 m` for a distance,
  // OS-06); a quantity with a unit list names units the list offers.
  const fmt = (value: number) =>
    isolateLtr(
      units.length > 1
        ? formatDisplayQuantity(locale, { value, unit: p.unit }, units)
        : formatQuantity(locale, { value, unit: p.unit }),
    );
  const range = { min: fmt(p.min), max: fmt(p.max) };

  /**
   * Commit exactly the text in the element (a fast Enter/Blur can precede a render) in the given
   * unit. Returns false when nothing could be committed (the error is shown).
   */
  const commit = (raw: string, unit: DisplayUnit): boolean => {
    if (raw === shown && unit.exponent === storedUnit.exponent) {
      setError(null);
      return true;
    }
    const parsed = parseEntry(raw, p.unit, unit, offered, p.min < 0);
    if (!parsed.ok) {
      setError({ key: `error.parse.${parsed.error}` });
      return false;
    }
    if (parsed.value < p.min || parsed.value > p.max) {
      setError({ key: 'error.range', params: range });
      return false;
    }
    setError(null);
    // The field shows the committed value in its derived unit at once (a value equal to the
    // stored one does not re-render from the store).
    const du = chooseDisplayUnit(parsed.value, units);
    setDraft(displayNumber(parsed.value, du));
    setDraftUnit(du);
    if (p.value === parsed.value) return true;
    p.onCommit(parsed.value, { live: false, slider: false });
    return true;
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
          aria-describedby={error ? `${p.id}-error` : `${p.id}-hint`}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onBlur={(e) => {
            // Typing a number and then choosing its unit is one edit: focus moving to this
            // field's own unit list does not commit the number in the previous unit.
            if (e.relatedTarget && e.relatedTarget === unitRef.current) return;
            commit(e.currentTarget.value, draftUnit);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value, draftUnit);
            if (e.key === 'Escape') {
              setDraft(shown);
              setDraftUnit(storedUnit);
              setError(null);
            }
          }}
        />
        {offered.length > 1 ? (
          <select
            class="unit-select technical"
            dir="ltr"
            data-testid={`${p.id}-unit`}
            aria-label={t('valueControl.unit', { label: p.label })}
            ref={unitRef}
            value={String(draftUnit.exponent)}
            disabled={p.disabled}
            onBlur={(e) => {
              // Leaving the unit list without changing it commits a number typed before it.
              const input = e.currentTarget.parentElement?.querySelector('input');
              if (input && e.relatedTarget !== input) commit(input.value, draftUnit);
            }}
            onChange={(e) => {
              const el = e.currentTarget;
              const unit = units.find((u) => String(u.exponent) === el.value) ?? storedUnit;
              const input = el.parentElement?.querySelector('input');
              // The typed number is kept and read in the new unit (220 Ω -> 220 kΩ); a value that
              // cannot be used commits nothing and the dropdown returns to the previous unit.
              if (!commit(input?.value ?? draft, unit)) el.value = String(draftUnit.exponent);
            }}
          >
            {offered.map((o) => (
              <option key={o.unit.exponent} value={String(o.unit.exponent)}>
                {o.symbol}
              </option>
            ))}
          </select>
        ) : (
          <span class="unit" data-testid={`${p.id}-unit`}>
            {offered[0]!.symbol}
          </span>
        )}
      </div>
      {scale && (
        <input
          type="range"
          class="environment-slider"
          data-testid={`${p.id}-slider`}
          aria-label={t('valueControl.slider', { label: p.label })}
          aria-describedby={error ? `${p.id}-error` : `${p.id}-hint`}
          aria-valuetext={fmt(dragPos !== null ? scale.value(dragPos) : (p.value ?? p.min))}
          min={0}
          max={scale.steps}
          step={1}
          value={dragPos ?? scale.position(p.value ?? p.min)}
          disabled={p.disabled}
          onInput={(e) => {
            const pos = Number((e.target as HTMLInputElement).value);
            const v = scale.value(pos);
            setDragPos(pos);
            setDraft(displayNumber(v, chooseDisplayUnit(v, units)));
            setDraftUnit(chooseDisplayUnit(v, units));
            setError(null);
            live.push(v);
          }}
          onChange={(e) => {
            const v = scale.value(Number((e.target as HTMLInputElement).value));
            setDragPos(null);
            setDraft(displayNumber(v, chooseDisplayUnit(v, units)));
            setDraftUnit(chooseDisplayUnit(v, units));
            // The release: no pending live value may arrive after it; the final value always does.
            live.cancel();
            p.onCommit(v, { live: false, slider: true });
          }}
        />
      )}
      {error ? (
        <p class="field-error" role="alert" id={`${p.id}-error`} data-testid={`${p.id}-error`}>
          <LtrMessage k={error.key} {...(error.params ? { params: error.params } : {})} />
        </p>
      ) : (
        <p class="muted small" id={`${p.id}-hint`} data-testid={`${p.id}-hint`}>
          <LtrMessage k="inspector.range" params={range} />
        </p>
      )}
    </div>
  );
}
