/**
 * TBI Admin's locales: the Lab's pattern (app/src/i18n/i18n.ts), N locales in a registry, each a
 * bundle and a direction. Hebrew (RTL) is the default (admin app design §3); English is
 * available. The bundles are the shared administration texts (@tbi-lab/admin-client, as the
 * Lab shows them) plus this app's own, with the Lab's controlled glossary applied.
 */
import { GLOSSARY, applyGlossary } from '@tbi-lab/admin-client/glossary';
import {
  adminMessagesEn,
  adminMessagesHe,
  type AdminMessageKey,
} from '@tbi-lab/admin-client/messages';
import { consoleEn, type ConsoleMessageKey } from './messages.en.js';
import { consoleHe } from './messages.he.js';

export type MessageKey = AdminMessageKey | ConsoleMessageKey;
export type Direction = 'ltr' | 'rtl';

export interface LocaleInfo {
  code: string;
  dir: Direction;
  /** The language's own name (an autonym), the same in every locale. */
  autonym: string;
  messages: Record<MessageKey, string>;
}

const en: Record<MessageKey, string> = { ...adminMessagesEn, ...consoleEn };
const he: Record<MessageKey, string> = { ...adminMessagesHe, ...consoleHe };

export const LOCALES: readonly LocaleInfo[] = [
  { code: 'he', dir: 'rtl', autonym: 'עברית', messages: applyGlossary(he, GLOSSARY.he!) },
  { code: 'en', dir: 'ltr', autonym: 'English', messages: applyGlossary(en, GLOSSARY.en!) },
];

export const DEFAULT_LOCALE = 'he';

export function getLocale(code: string | null | undefined): LocaleInfo {
  return LOCALES.find((l) => l.code === code) ?? LOCALES.find((l) => l.code === DEFAULT_LOCALE)!;
}

export type Params = Record<string, string | number>;

export function translate(locale: LocaleInfo, key: MessageKey, params?: Params): string {
  const template = locale.messages[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  );
}

export const isMessageKey = (key: string): key is MessageKey =>
  Object.prototype.hasOwnProperty.call(en, key);

/** A count in the UI language's digits and grouping. */
export const formatCount = (locale: LocaleInfo, n: number) =>
  new Intl.NumberFormat(locale.code, { maximumFractionDigits: 0 }).format(n);

const STORAGE_KEY = 'tbi-admin.locale';

/** The remembered language (per browser), else the default. Storage may be unavailable. */
export function storedLocale(): LocaleInfo {
  try {
    return getLocale(localStorage.getItem(STORAGE_KEY));
  } catch {
    return getLocale(DEFAULT_LOCALE);
  }
}

export function storeLocale(code: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // not remembered; the choice still applies now
  }
}
