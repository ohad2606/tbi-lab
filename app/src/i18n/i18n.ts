/**
 * Locale infrastructure: a registry of N locales, message lookup, and locale-aware
 * formatting. Nothing here knows about any particular language; adding a locale means adding
 * a bundle and a registry entry, with no change to project data or application logic.
 */

import {
  chooseDisplayUnit,
  shiftDecimal,
  toEngineering,
  type DisplayUnit,
  type Quantity,
  type UnitId,
} from '@tbi-lab/domain';
import { en, type MessageKey } from './messages.en.js';
import { he } from './messages.he.js';
import { GLOSSARY, applyGlossary } from './glossary.js';

export type Direction = 'ltr' | 'rtl';

export interface LocaleInfo {
  code: string;
  dir: Direction;
  /** The language's own name for itself (an autonym), shown identically in every locale. */
  autonym: string;
  messages: Record<MessageKey, string>;
}

export const LOCALES: readonly LocaleInfo[] = [
  { code: 'en', dir: 'ltr', autonym: 'English', messages: applyGlossary(en, GLOSSARY.en!) },
  { code: 'he', dir: 'rtl', autonym: 'עברית', messages: applyGlossary(he, GLOSSARY.he!) },
];

export const DEFAULT_LOCALE = 'en';

export function getLocale(code: string): LocaleInfo {
  return LOCALES.find((l) => l.code === code) ?? LOCALES.find((l) => l.code === DEFAULT_LOCALE)!;
}

/** First supported locale matching the browser's language preferences. */
export function negotiateLocale(preferred: readonly string[]): string {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    const hit = LOCALES.find((l) => l.code === base);
    if (hit) return hit.code;
  }
  return DEFAULT_LOCALE;
}

// Unicode directional isolates: technical values (numbers, units, identifiers) keep their
// LTR order inside RTL sentences without disturbing the surrounding text.
const LRI = '⁦';
const PDI = '⁩';

export function isolateLtr(text: string): string {
  return `${LRI}${text}${PDI}`;
}

const FSI = '\u2068';

/**
 * User-authored text (a project name) inside a translated sentence: a first-strong isolate,
 * so an English name in a Hebrew sentence (or the reverse) keeps its own direction without
 * scrambling the surrounding punctuation. The text itself is never changed.
 */
export function isolateUserText(text: string): string {
  return `${FSI}${text}${PDI}`;
}

export type Params = Record<string, string | number>;

export function translate(locale: LocaleInfo, key: MessageKey, params?: Params): string {
  const template = locale.messages[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  );
}

export function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

/**
 * Text for a translation key held as data (catalog names, parameter labels). Every catalog key
 * is checked against the bundles by tests/i18n.test.ts; an unknown key shows as itself rather
 * than failing silently to an empty label.
 */
export function catalogText(locale: LocaleInfo, key: string): string {
  return isMessageKey(key) ? translate(locale, key) : key;
}

/**
 * Cached `Intl.NumberFormat` per locale and options. Constructing a formatter is expensive
 * (it was the main cost of re-rendering a 30-part canvas: Sprint 4 profile), formatting is not.
 */
const numberFormats = new Map<string, Intl.NumberFormat>();
export function numberFormat(
  localeCode: string,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = `${localeCode}|${JSON.stringify(options)}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(localeCode, options);
    numberFormats.set(key, f);
  }
  return f;
}

export function formatNumber(locale: LocaleInfo, value: number): string {
  return numberFormat(locale.code, { maximumFractionDigits: 3, useGrouping: false }).format(value);
}

/**
 * Units shown without SI prefixes (Sprint 12): a temperature in degrees Celsius and a relative
 * humidity read as plain numbers (21.5 °C, 55 %RH), never as 500 m°C.
 */
const UNPREFIXED: ReadonlySet<UnitId> = new Set<UnitId>(['celsius', 'percent_rh', 'percent']);
export const isUnprefixed = (unit: UnitId): boolean => UNPREFIXED.has(unit);

/** `4.7 kΩ`, formatted for the locale; always a single LTR run. */
export function formatQuantity(locale: LocaleInfo, q: Quantity): string {
  if (UNPREFIXED.has(q.unit))
    return `${formatNumber(locale, q.value)} ${unitSymbol(locale, q.unit)}`;
  const { mantissa, prefix } = toEngineering(q.value);
  return `${formatNumber(locale, mantissa)} ${prefix}${unitSymbol(locale, q.unit)}`;
}

/**
 * Units whose symbol is also an SI prefix letter (Sprint 13 OS-01/OS-06): the metre's `m` is the
 * milli prefix, so the compact form of 0.5 m, `500m`, beside the unit `m` read as "500 m m". Their
 * input form is the plain decimal in the base unit (`0.5`); displays keep the prefixed form with
 * a space (`500 mm`), which is unambiguous.
 */
const PLAIN_INPUT: ReadonlySet<UnitId> = new Set<UnitId>(['metre']);

/** The compact, locale-independent input form of a value (`4.7k`), for editing fields. */
export function inputForm(value: number, unit?: UnitId): string {
  if (unit && (UNPREFIXED.has(unit) || PLAIN_INPUT.has(unit)))
    return String(Number(value.toPrecision(12)));
  const { mantissa, prefix } = toEngineering(value);
  return `${mantissa}${prefix === 'µ' ? 'u' : prefix}`;
}

export function unitSymbol(locale: LocaleInfo, unit: UnitId): string {
  return translate(locale, `unit.${unit}.symbol`);
}

/** A display unit's full symbol (`kΩ`, `µF`, `cm`): an international prefix + the unit symbol. */
export function displayUnitSymbol(locale: LocaleInfo, unit: UnitId, du: DisplayUnit): string {
  return `${du.prefix}${unitSymbol(locale, unit)}`;
}

/**
 * The number a field shows for a stored value in a display unit, exact in decimal and
 * locale-independent (a technical field always uses `.`): 4700 in kΩ -> `4.7`.
 */
export function displayNumber(value: number, du: DisplayUnit): string {
  return String(shiftDecimal(value, -du.exponent));
}

/**
 * A value formatted with the same unit choice as the editor's dropdown (`10 mF`, `0 V`), for the
 * range hint and range errors, so the hint names units the user can select.
 */
export function formatDisplayQuantity(
  locale: LocaleInfo,
  q: Quantity,
  units: readonly DisplayUnit[],
): string {
  const du = chooseDisplayUnit(q.value, units);
  return `${formatNumber(locale, shiftDecimal(q.value, -du.exponent))} ${displayUnitSymbol(locale, q.unit, du)}`;
}

/** A translated template split at its placeholders, for rendering parameters as elements. */
export type MessagePart = { text: string } | { param: string };
export function messageParts(locale: LocaleInfo, key: MessageKey): MessagePart[] {
  const parts: MessagePart[] = [];
  const template = locale.messages[key];
  let last = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    if (m.index > last) parts.push({ text: template.slice(last, m.index) });
    parts.push({ param: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });
  return parts;
}

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * Locale date-time display. The formatter is cached per locale: constructing one per call
 * made a 50-project library re-render measurably slower on the dev host (Sprint 5).
 */
export function formatDateTime(locale: LocaleInfo, iso: string): string {
  let f = dateTimeFormats.get(locale.code);
  if (!f) {
    f = new Intl.DateTimeFormat(locale.code, { dateStyle: 'medium', timeStyle: 'short' });
    dateTimeFormats.set(locale.code, f);
  }
  return f.format(new Date(iso));
}

export type { MessageKey };
