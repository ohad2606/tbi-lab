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
/**
 * A logic pin's datasheet name from its terminal id (L3): a package's `a1` is the datasheet's
 * "1A" (terminal ids start with a letter: the session protocol's identifier rule), `vcc` "VCC".
 */
export function datasheetPinName(terminal: string): string {
  const m = /^([a-z])(\d)$/.exec(terminal);
  return (m ? `${m[2]}${m[1]}` : terminal).toUpperCase();
}

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
  return formatDerived(locale, watts, 'unit.watt.symbol');
}

/** A derived quantity (not a stored UnitId), same presentation as `formatResult`. */
function formatDerived(locale: LocaleInfo, value: number, symbol: MessageKey): string {
  const v = Math.abs(value) < DISPLAY_FLOOR ? 0 : value;
  const { mantissa, prefix } = toEngineering(v);
  const n = numberFormat(locale.code, { maximumSignificantDigits: 4, useGrouping: false }).format(
    mantissa,
  );
  return `${n} ${prefix}${translate(locale, symbol)}`;
}

/** A PWM frequency (Sprint 15, R4), from its period: `1 kHz`, `50 Hz`. */
export function formatFrequency(locale: LocaleInfo, hertz: number): string {
  return formatDerived(locale, hertz, 'unit.hertz.symbol');
}

/**
 * A servo pulse width (Sprint 15), reported in microseconds and shown in them as servo pulses are
 * specified (1000-2000 us): `1500 µs`, one decimal at most.
 */
export function formatPulseWidth(locale: LocaleInfo, microseconds: number): string {
  const n = numberFormat(locale.code, { maximumFractionDigits: 1, useGrouping: false }).format(
    microseconds,
  );
  return `${n} µ${translate(locale, 'unit.second.symbol')}`;
}

/** A PWM duty cycle (0..1) as a percentage, locale-formatted: `25 %`. */
export function formatDuty(locale: LocaleInfo, duty: number): string {
  const n = numberFormat(locale.code, { maximumFractionDigits: 1, useGrouping: false }).format(
    duty * 100,
  );
  return `${n} ${translate(locale, 'unit.percent.symbol')}`;
}

/** A shaft angle in degrees (Sprint 15, the servo): `90°`, one decimal at most. */
export function formatAngle(locale: LocaleInfo, degrees: number): string {
  const d = Math.round(degrees * 10) / 10;
  const n = numberFormat(locale.code, { maximumFractionDigits: 1, useGrouping: false }).format(
    d === 0 ? 0 : d, // never "-0°"
  );
  return `${n}${translate(locale, 'unit.degree.symbol')}`;
}

type RatingLike = Pick<RatingWarning, 'component' | 'code' | 'value' | 'limit'> &
  Partial<Pick<RatingWarning, 'gpio' | 'otherGpio' | 'channel' | 'kind' | 'unreliable'>>;

/**
 * One compact over-stress row: "Current: 62.64 mA (maximum 30 mA)", or for a board pad
 * "IO2 drives HIGH into IO4 driving LOW: 97.4 mA (drive rating 40 mA)". Values and pin names stay
 * LTR technical tokens.
 */
export function ratingRow(locale: LocaleInfo, w: RatingLike): string {
  const unit = RATING_UNIT[w.code];
  const fmt = (v: number) =>
    unit === 'watt' ? formatPower(locale, v) : formatResult(locale, v, unit);
  // Sprint 13 H2: an operating-range row names the limit as the specified operating maximum.
  const operatingKey = `rating.operating.row.${w.code}`;
  const rowKey =
    w.kind !== undefined && w.kind !== 'absolute' && isMessageKey(operatingKey)
      ? operatingKey
      : `rating.row.${w.code}`;
  const row = translate(locale, rowKey as MessageKey, {
    // Sprint 13 P2: an extrapolated pad current is never shown as a value.
    value: w.unreliable
      ? translate(locale, 'rating.value.uncharacterized')
      : isolateLtr(fmt(w.value)),
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
  if (failure.kind === 'unmodelled')
    return t('sim.error.unmodelled', { feature: featureName(locale, failure.facility) });
  if (failure.kind === 'pwm') {
    const pins = (g: number[] | undefined) => list((g ?? []).map((p) => `GPIO${p}`));
    return t(`sim.error.pwm.${failure.code}`, {
      pins: pins(failure.gpios),
      components: list(failure.components),
      inputs: pins(failure.inputs),
      why: failure.why ? t(`sim.pwm.why.${failure.why}` as MessageKey) : '',
    });
  }
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
    // Sprint 19B (logic L1): the pin, supply and load the refusal is about, in the message.
    // Sprint 21 adds the four guarantee-bound refusals (the last four labels).
    case 'logic_input_floating':
    case 'logic_supply_missing':
    case 'logic_supply_uncharacterized':
    case 'logic_output_uncharacterized':
    case 'logic_feedback_unsupported':
    case 'logic_unknown_state':
    case 'logic_unpowered_uncharacterized':
    case 'logic_input_undefined':
    case 'logic_input_out_of_range':
    case 'logic_supply_undriven':
    case 'logic_supply_current_uncharacterized':
    case 'logic_input_leakage_uncharacterized':
    case 'logic_input_not_guaranteed':
    case 'logic_supply_not_guaranteed': {
      const d = (error.detail ?? {}) as {
        vcc?: number;
        value?: number;
        limit?: number;
        part?: string;
        vih?: number;
        vil?: number;
        pads?: number[];
        worst?: number;
        causes?: string[];
        condition?: string;
        range?: [number, number];
        iiVcc?: [number, number];
        level?: string;
      };
      const V = (v: number | undefined) =>
        typeof v === 'number' ? formatResult(locale, v, 'volt') : '';
      const pin = error.param?.startsWith('gpio')
        ? isolateLtr(`GPIO${error.param.slice(4)}`)
        : isolateLtr(datasheetPinName(error.param ?? ''));
      // L3: a device whose datasheet rows differ from the single gates' words them itself
      // (`sim.error.<code>.<part>`), never with another device's figures.
      // Sprint 20: an input held only by ESP32 pads in input mode names them first.
      // Sprint 21: an ESP32 output whose guaranteed V_OH does not reach the gate's V_IH, and a
      // supply's current limit, have their own wording.
      const own =
        error.code === 'logic_input_floating' && d.pads?.length
          ? d.pads.length > 1
            ? 'sim.error.logic_input_floating.mcu_inputs'
            : 'sim.error.logic_input_floating.mcu_input'
          : (error.code === 'logic_input_undefined' && d.pads?.length) ||
              (error.code === 'logic_input_not_guaranteed' && d.causes?.includes('esp32_voh'))
            ? `sim.error.${error.code}.mcu_high`
            : error.code === 'logic_supply_not_guaranteed' && error.param === 'limit'
              ? 'sim.error.logic_supply_not_guaranteed.limit'
              : `sim.error.${error.code}.${(d.part ?? '').toLowerCase()}`;
      const causes = (d.causes ?? [])
        .map((c) => `sim.bound.cause.${c}`)
        .filter(isMessageKey)
        .map((k) => t(k));
      const reason = `sim.bound.reason.${d.condition ?? ''}`;
      const range = (r: [number, number] | undefined) =>
        r ? isolateLtr(r[0] === r[1] ? `V_CC = ${V(r[0])}` : `${V(r[0])} – ${V(r[1])}`) : '';
      return t(isMessageKey(own) ? own : `sim.error.${error.code}`, {
        components,
        pin,
        pads: list((d.pads ?? []).map((g) => `GPIO${g}`)),
        // Each label with its value as ONE LTR run (never reordered or mirrored in RTL).
        vih: typeof d.vih === 'number' ? isolateLtr(`V_IH ${V(d.vih)}`) : '',
        vil: typeof d.vil === 'number' ? isolateLtr(`V_IL ${V(d.vil)}`) : '',
        vccEq: typeof d.vcc === 'number' ? isolateLtr(`V_CC = ${V(d.vcc)}`) : '',
        supply: V(d.vcc),
        current: typeof d.value === 'number' ? formatResult(locale, d.value, 'ampere') : '',
        limit: typeof d.limit === 'number' ? formatResult(locale, d.limit, 'ampere') : '',
        // L3: an input voltage the refusal is about.
        voltage:
          typeof d.value === 'number' &&
          (error.code === 'logic_input_undefined' ||
            error.code === 'logic_input_out_of_range' ||
            error.code === 'logic_input_not_guaranteed')
            ? formatResult(locale, d.value, 'volt')
            : '',
        // Sprint 21: the bounds' worst value, causes, the row and the comparison.
        worst: V(d.worst),
        causes: new Intl.ListFormat(locale.code, { type: 'conjunction' }).format(causes),
        reason: isMessageKey(reason) ? t(reason) : '',
        range: range(d.range),
        iiVcc: range(d.iiVcc),
        level: d.level === 'high' ? 'HIGH' : d.level === 'low' ? 'LOW' : '',
        cmp:
          d.level === 'high' && typeof d.vih === 'number'
            ? t('sim.bound.cmp.high', { th: isolateLtr(`V_IH ${V(d.vih)}`) })
            : d.level === 'low' && typeof d.vil === 'number'
              ? t('sim.bound.cmp.low', { th: isolateLtr(`V_IL ${V(d.vil)}`) })
              : '',
      });
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
