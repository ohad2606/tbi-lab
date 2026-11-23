/** TBI-022: validation and sanitising of one sign-up (the form's fields), strict and allow-listed. */
import { normalizeAddEmail } from '../accounts.js';

export interface SignupInput {
  name: string;
  email: string;
  role: string;
  lang: 'he' | 'en';
  consent: true;
  /**
   * BETA-G1 s8: the optional answer to "how did you hear about us" (a short cleaned text, see
   * `HEARD_FROM_MAX`). Accepted only where the caller allows it (the web route); absent on every
   * record from the signed form route, whose stored records are therefore unchanged. Additive:
   * the record schema stays `v: 1` (older readers ignore the extra key).
   */
  heardFrom?: string;
}

const FIELDS = ['name', 'email', 'role', 'lang', 'consent'];
export const NAME_MAX = 80;
export const ROLE_MAX = 80;
export const HEARD_FROM_MAX = 80;

/** NFC, control/format/bidi-override characters removed, runs of whitespace collapsed, trimmed. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length > max * 4) return null;
  const s = v
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const n = [...s].length;
  return n >= 1 && n <= max ? s : null;
}

export type ValidateResult =
  | { ok: true; value: SignupInput }
  | { ok: false; field: 'body' | 'name' | 'email' | 'role' | 'lang' | 'consent' | 'heardFrom' };

export interface ValidateOptions {
  /** Allow the optional `heardFrom` key (web route only). Default false: the key is refused. */
  heardFrom?: boolean;
}

export function validateSignup(raw: unknown, opts: ValidateOptions = {}): ValidateResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, field: 'body' };
  const o = raw as Record<string, unknown>;
  const allowed = opts.heardFrom ? [...FIELDS, 'heardFrom'] : FIELDS;
  if (Object.keys(o).some((k) => !allowed.includes(k))) return { ok: false, field: 'body' };
  const name = cleanText(o.name, NAME_MAX);
  if (!name) return { ok: false, field: 'name' };
  const email = normalizeAddEmail(o.email);
  if (!email) return { ok: false, field: 'email' };
  const role = cleanText(o.role, ROLE_MAX);
  if (!role) return { ok: false, field: 'role' };
  if (o.lang !== 'he' && o.lang !== 'en') return { ok: false, field: 'lang' };
  if (o.consent !== true) return { ok: false, field: 'consent' };
  const value: SignupInput = { name, email, role, lang: o.lang, consent: true };
  // Optional: absent, or an empty / whitespace-only answer, means "not answered" (no key stored).
  if (opts.heardFrom && o.heardFrom !== undefined) {
    if (typeof o.heardFrom !== 'string') return { ok: false, field: 'heardFrom' };
    const blank =
      o.heardFrom.length <= HEARD_FROM_MAX * 4 &&
      o.heardFrom.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]/gu, '') === '';
    if (!blank) {
      const h = cleanText(o.heardFrom, HEARD_FROM_MAX);
      if (!h) return { ok: false, field: 'heardFrom' };
      value.heardFrom = h;
    }
  }
  return { ok: true, value };
}
