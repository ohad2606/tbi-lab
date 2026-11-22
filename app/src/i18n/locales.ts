/**
 * The locale registry (TBI-021): metadata only, no messages, so it is cheap to import anywhere.
 * A locale is offered to users only when it is `enabled` here AND has a message bundle wired in
 * i18n.ts. Disabled entries are stubs that reserve the code, direction and autonym.
 */

export type Direction = 'ltr' | 'rtl';

export interface LocaleDef {
  /** BCP 47 language subtag; also the value of the document's `lang` attribute. */
  code: string;
  dir: Direction;
  /** The language's own name for itself, shown identically in every locale. */
  autonym: string;
  /** Machine/AI-drafted until a native-speaking tester reviewed it; the picker labels it "beta". */
  beta: boolean;
  /** Offered to users. Only HE and EN until a language is live on Alpha (CLAIMS.md). */
  enabled: boolean;
}

export const LOCALE_REGISTRY: readonly LocaleDef[] = [
  { code: 'en', dir: 'ltr', autonym: 'English', beta: false, enabled: true },
  { code: 'he', dir: 'rtl', autonym: 'עברית', beta: false, enabled: true },
  { code: 'es', dir: 'ltr', autonym: 'Español', beta: true, enabled: false },
  { code: 'fr', dir: 'ltr', autonym: 'Français', beta: true, enabled: false },
  { code: 'ar', dir: 'rtl', autonym: 'العربية', beta: true, enabled: false },
  { code: 'ru', dir: 'ltr', autonym: 'Русский', beta: true, enabled: false },
];

export const DEFAULT_LOCALE = 'en';
