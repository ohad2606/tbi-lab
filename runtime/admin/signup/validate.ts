/** TBI-022: validation and sanitising of one sign-up (the form's fields), strict and allow-listed. */
import { normalizeAddEmail } from '../accounts.js';

export interface SignupInput {
  name: string;
  email: string;
  role: string;
  lang: 'he' | 'en';
  consent: true;
}

const FIELDS = ['name', 'email', 'role', 'lang', 'consent'];
export const NAME_MAX = 80;
export const ROLE_MAX = 80;

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
  | { ok: false; field: 'body' | 'name' | 'email' | 'role' | 'lang' | 'consent' };

export function validateSignup(raw: unknown): ValidateResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, field: 'body' };
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !FIELDS.includes(k))) return { ok: false, field: 'body' };
  const name = cleanText(o.name, NAME_MAX);
  if (!name) return { ok: false, field: 'name' };
  const email = normalizeAddEmail(o.email);
  if (!email) return { ok: false, field: 'email' };
  const role = cleanText(o.role, ROLE_MAX);
  if (!role) return { ok: false, field: 'role' };
  if (o.lang !== 'he' && o.lang !== 'en') return { ok: false, field: 'lang' };
  if (o.consent !== true) return { ok: false, field: 'consent' };
  return { ok: true, value: { name, email, role, lang: o.lang, consent: true } };
}
