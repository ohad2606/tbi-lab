/**
 * Presentation of solved values and simulation diagnostics. Formatting only: the numbers
 * themselves come unchanged from the engine.
 */

import { CATALOG, type ProjectDocument, type UnitId } from '@tbi-lab/domain';
import { RATING_UNIT, type EngineError, type RatingWarning } from '@tbi-lab/engine';
import { toEngineering } from '@tbi-lab/domain';
import {
  catalogText,
  isMessageKey,
  isolateLtr,
  numberFormat,
  translate,
  unitSymbol,
  type LocaleInfo,
  type MessageKey,
} from '../i18n/i18n.js';
import type { SimFailure } from './controller.js';

/** Below this magnitude a solved value is displayed as 0 (display resolution, not physics). */
const DISPLAY_FLOOR = 1e-12;

/** A solved value, four significant digits, engineering prefix, always an LTR run. */
export function formatResult(locale: LocaleInfo, value: number, unit: UnitId): string {
  const v = Math.abs(value) < DISPLAY_FLOOR ? 0 : value;
  const { mantissa, prefix } = toEngineering(v);
  const n = numberFormat(locale.code, { maximumSignificantDigits: 4, useGrouping: false }).format(
    mantissa,
  );
  return `${n} ${prefix}${unitSymbol(locale, unit)}`;
}

/**
 * A solved power, same presentation as `formatResult`. Watts are a derived quantity shown by
 * the product only; they are not a stored engineering unit (UnitId stays unchanged).
 */
export function formatPower(locale: LocaleInfo, watts: number): string {
  const v = Math.abs(watts) < DISPLAY_FLOOR ? 0 : watts;
  const { mantissa, prefix } = toEngineering(v);
  const n = numberFormat(locale.code, { maximumSignificantDigits: 4, useGrouping: false }).format(
    mantissa,
  );
  return `${n} ${prefix}${translate(locale, 'unit.watt.symbol')}`;
}

type RatingLike = Pick<RatingWarning, 'component' | 'code' | 'value' | 'limit'> &
  Partial<Pick<RatingWarning, 'gpio' | 'otherGpio' | 'channel'>>;

/**
 * One compact over-stress row: "Current: 62.64 mA (maximum 30 mA)", or for a board pad
 * "IO2 drives HIGH into IO4 driving LOW: 97.4 mA (drive rating 40 mA)". Values and pin names stay
 * LTR technical tokens.
 */
export function ratingRow(locale: LocaleInfo, w: RatingLike): string {
  const unit = RATING_UNIT[w.code];
  const fmt = (v: number) =>
    unit === 'watt' ? formatPower(locale, v) : formatResult(locale, v, unit);
  const row = translate(locale, `rating.row.${w.code}`, {
    value: isolateLtr(fmt(w.value)),
    limit: isolateLtr(fmt(w.limit)),
    pin: isolateLtr(w.gpio === undefined ? '' : `IO${w.gpio}`),
    other: isolateLtr(w.otherGpio === undefined ? '' : `IO${w.otherGpio}`),
  });
  if (!w.channel) return row;
  // A part's element (an RGB channel, a relay coil): named by its result label.
  const key = `sim.part.current.${w.channel}`;
  const channel = isMessageKey(key) ? translate(locale, key) : w.channel;
  return translate(locale, 'rating.channel', { channel, row });
}

/** Warnings grouped by component, in first-seen order: one summary per part, rows below. */
export function groupByComponent<T extends { component: string }>(warnings: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const w of warnings) groups.set(w.component, [...(groups.get(w.component) ?? []), w]);
  return [...groups];
}

const list = (ids: string[] | undefined) => isolateLtr((ids ?? []).join(', '));

/** The localized explanation for a failed run. Error codes are the language-neutral truth. */
export function simFailureMessage(
  locale: LocaleInfo,
  failure: SimFailure,
  doc: ProjectDocument | null,
): string {
  const t = (key: MessageKey, params?: Record<string, string>) => translate(locale, key, params);
  if (failure.kind === 'worker') return t(`sim.error.${failure.code}`);
  if (failure.kind === 'mcu') {
    return t(`sim.error.${failure.code}`, {
      components: list(failure.components),
      pins: list((failure.pins ?? []).map((p) => `GPIO${p}`)),
      features: (failure.features ?? []).map((f) => featureName(locale, f)).join(', '),
    });
  }
  if (failure.kind === 'runtime') return t(`sim.error.runtime.${failure.code}`);
  return engineErrorMessage(locale, failure.error, doc);
}

/**
 * A structured explanation for errors that are a known unsupported configuration rather than a
 * solver failure: a short title, the explanation, and what to do. Others have only a body.
 */
export function engineErrorParts(
  locale: LocaleInfo,
  error: EngineError,
  doc: ProjectDocument | null,
): { title?: string; body: string; hint?: string } {
  if (error.code === 'psu_parallel') {
    const supplies = new Intl.ListFormat(locale.code, { type: 'conjunction' }).format(
      (error.components ?? []).map((id) => isolateLtr(id)),
    );
    return {
      title: translate(locale, 'sim.error.psu_parallel.title'),
      body: translate(locale, 'sim.error.psu_parallel', { supplies }),
      hint: translate(locale, 'sim.error.psu_parallel.hint'),
    };
  }
  return { body: engineErrorMessage(locale, error, doc) };
}

export function engineErrorMessage(
  locale: LocaleInfo,
  error: EngineError,
  doc: ProjectDocument | null,
): string {
  const t = (key: MessageKey, params?: Record<string, string>) => translate(locale, key, params);
  const components = list(error.components);
  switch (error.code) {
    case 'floating_circuit':
      return error.outputOffSupplies?.length
        ? t('sim.error.floating_output_off', {
            components,
            supplies: list(error.outputOffSupplies),
          })
        : t('sim.error.floating_circuit', { components });
    case 'invalid_parameter': {
      const c = doc?.components.find((x) => x.id === error.components?.[0]);
      const def = c ? CATALOG[c.type].params.find((p) => p.key === error.param) : undefined;
      const param = def ? catalogText(locale, def.labelKey) : (error.param ?? '');
      return t('sim.error.invalid_parameter', { components, param });
    }
    case 'psu_parallel': {
      const p = engineErrorParts(locale, error, doc);
      return [p.title, p.body, p.hint].join(' ');
    }
    default:
      return t(`sim.error.${error.code}`, { components });
  }
}

/** Localized name of a firmware feature the simulator does not model (build feature report). */
export function featureName(locale: LocaleInfo, feature: string): string {
  if (feature.startsWith('library:'))
    return translate(locale, 'build.feature.library', { name: isolateLtr(feature.slice(8)) });
  const key = `build.feature.${feature}`;
  return isMessageKey(key) ? translate(locale, key) : isolateLtr(feature);
}
