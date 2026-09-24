/**
 * Presentation of solved values and simulation diagnostics. Formatting only: the numbers
 * themselves come unchanged from the engine.
 */

import { CATALOG, type ProjectDocument, type UnitId } from '@tbi-lab/domain';
import type { EngineError } from '@tbi-lab/engine';
import { toEngineering } from '@tbi-lab/domain';
import {
  catalogText,
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

/** One localized over-stress line: "D1: forward current 60.3 mA is above ... 30 mA." */
export function ratingMessage(
  locale: LocaleInfo,
  w: {
    component: string;
    model: string;
    code: 'forward_current' | 'reverse_voltage' | 'power';
    value: number;
    limit: number;
  },
  modelName: string,
): string {
  const fmt = (v: number) =>
    w.code === 'power'
      ? formatPower(locale, v)
      : formatResult(locale, v, w.code === 'forward_current' ? 'ampere' : 'volt');
  return translate(locale, `rating.${w.code}`, {
    component: isolateLtr(w.component),
    value: isolateLtr(fmt(w.value)),
    limit: isolateLtr(fmt(w.limit)),
    model: isolateLtr(modelName),
  });
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
  return engineErrorMessage(locale, failure.error, doc);
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
    default:
      return t(`sim.error.${error.code}`, { components });
  }
}
