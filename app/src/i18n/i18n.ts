/**
 * Locale infrastructure: a registry of N locales, message lookup, and locale-aware
 * formatting. Nothing here knows about any particular language; adding a locale means adding
 * a bundle and a registry entry, with no change to project data or application logic.
 */

import { toEngineering, type Quantity, type UnitId } from '@tbi-lab/domain';
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

export function formatNumber(locale: LocaleInfo, value: number): string {
  return new Intl.NumberFormat(locale.code, {
    maximumFractionDigits: 3,
    useGrouping: false,
  }).format(value);
}

/** `4.7 kΩ`, formatted for the locale; always a single LTR run. */
export function formatQuantity(locale: LocaleInfo, q: Quantity): string {
  const { mantissa, prefix } = toEngineering(q.value);
  return `${formatNumber(locale, mantissa)} ${prefix}${unitSymbol(locale, q.unit)}`;
}

/** The compact, locale-independent input form of a value (`4.7k`), for editing fields. */
export function inputForm(value: number): string {
  const { mantissa, prefix } = toEngineering(value);
  return `${mantissa}${prefix === 'µ' ? 'u' : prefix}`;
}

export function unitSymbol(locale: LocaleInfo, unit: UnitId): string {
  return translate(locale, `unit.${unit}.symbol`);
}

export function formatDateTime(locale: LocaleInfo, iso: string): string {
  return new Intl.DateTimeFormat(locale.code, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

export type { MessageKey };
