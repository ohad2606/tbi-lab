/**
 * Language picker model (TBI-021 slice 2): one option per offered locale, derived from the
 * registry-built `LOCALES`. Adding a locale needs only a registry entry plus its messages.
 */
import type { LocaleInfo } from './i18n.js';

export interface LanguageOption {
  code: string;
  /** Option text: the autonym (its own language), plus the localized "beta" marker if beta. */
  label: string;
  /** Applied as the option's `lang` attribute (the autonym is in the option's own language). */
  lang: string;
  dir: 'ltr' | 'rtl';
  beta: boolean;
}

/** `betaLabel` is the already-translated marker in the UI locale, e.g. "beta" / "בטא". */
export function languageOptions(
  locales: readonly LocaleInfo[],
  betaLabel: string,
): LanguageOption[] {
  return locales.map((l) => ({
    code: l.code,
    label: l.beta ? `${l.autonym} (${betaLabel})` : l.autonym,
    lang: l.code,
    dir: l.dir,
    beta: l.beta,
  }));
}
