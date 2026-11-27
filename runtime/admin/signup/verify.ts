/**
 * BETA-G1 G1-AUTO-VERIFY slice 1: the address-proof token (mint / check / hash) and the verify key.
 * Runs in the ADMIN SERVICE only: the intake never holds the key, so a compromised intake cannot
 * mint a verification (it can only drop marker files the admin re-checks, verifyState.ts).
 *
 *   Token   `v1.<id>.<gen>.<exp s>.<nonce 22>.<mac 43>`; mac = base64url(HMAC-SHA256(key,
 *           "tbi-signup-verify-v1\n" + purpose + "\n" + id + "\n" + gen + "\n" + exp + "\n" + nonce)).
 *           The purpose label (`verify`, later `reset`) is in the MAC only, so a token minted for
 *           one purpose never checks for another. The address is never in the token; `id` is the
 *           random store id. `gen` is in the token (so the admin can find the generation) and in
 *           the MAC. The admin trusts nothing in a token beyond the MAC: expiry and single use are
 *           decided from its own state (verifyState.ts).
 *   Key     a file (TBI_SIGNUP_VERIFY_KEY_FILE, read with readSecretFile: not other-readable, no
 *           FIFO), hex or base64url, at least 32 bytes after decoding. `<file>.prev` (optional) is
 *           accepted for checking only, never for minting (rotation). Never in env, never logged:
 *           every failure is a fixed class (`verify_key_missing` / `verify_key_bad`).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { errorClass } from './errors.js';
import { readSecretFile } from './secret-file.js';

export type VerifyPurpose = 'verify' | 'reset';
export const VERIFY_TOKEN_TTL_MS = 24 * 3_600_000;
const LABEL = 'tbi-signup-verify-v1';
const TOKEN_RE =
  /^v1\.([0-9A-HJKMNP-TV-Z]{26})\.([1-9][0-9]{0,3})\.([1-9][0-9]{9,10})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
export const VERIFY_TOKEN_MAX = 160;

export interface ParsedToken {
  id: string;
  gen: number;
  /** Seconds since the epoch, as minted (informational: the admin uses its stored expiry). */
  exp: number;
  nonce: string;
  mac: string;
}

export class VerifyKeyError extends Error {
  constructor(readonly code: 'verify_key_missing' | 'verify_key_bad') {
    super(code);
  }
}

/** Strict key text: hex (even length, >= 64 digits) or base64url (>= 43 chars); >= 32 bytes. */
export function parseVerifyKey(text: string): Buffer {
  const t = text.trim();
  let k: Buffer | null = null;
  if (/^[0-9a-fA-F]+$/.test(t)) {
    // Hex-looking text is hex only (never re-read as base64url).
    if (t.length <= 1024 && t.length >= 64 && t.length % 2 === 0) k = Buffer.from(t, 'hex');
  } else if (t.length <= 1024 && /^[A-Za-z0-9_-]{43,}$/.test(t)) k = Buffer.from(t, 'base64url');
  if (!k || k.length < 32) throw new VerifyKeyError('verify_key_bad');
  return k;
}

/** The current key (mint + check) and the optional previous one (check only). */
export interface VerifyKeys {
  current: Buffer;
  prev: Buffer | null;
}

export async function loadVerifyKeys(
  file: string,
  read: (p: string) => Promise<string> = readSecretFile,
): Promise<VerifyKeys> {
  const one = async (p: string, optional: boolean): Promise<Buffer | null> => {
    let text: string;
    try {
      text = await read(p);
    } catch (e) {
      const cls = errorClass(e);
      if (optional && cls === 'secret_missing') return null;
      throw new VerifyKeyError(cls === 'secret_missing' ? 'verify_key_missing' : 'verify_key_bad');
    }
    return parseVerifyKey(text);
  };
  const current = (await one(file, false))!;
  const prev = await one(`${file}.prev`, true);
  return { current, prev };
}

const macOf = (key: Buffer, purpose: VerifyPurpose, p: Omit<ParsedToken, 'mac'>): string =>
  createHmac('sha256', key)
    .update(`${LABEL}\n${purpose}\n${p.id}\n${p.gen}\n${p.exp}\n${p.nonce}`)
    .digest('base64url');

/**
 * S4a: a public 16-hex id of a verify key (sha256 under its own label), stored with each minted
 * generation so rotating or removing a key revokes its outstanding links. Never the key itself.
 */
export const verifyKeyId = (key: Buffer): string =>
  createHash('sha256').update('tbi-signup-verify-kid-v1\n').update(key).digest('hex').slice(0, 16);

/** sha256 hex of the whole token: the only form the admin state stores. */
export const tokenHash = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export function mintVerifyToken(
  key: Buffer,
  o: { id: string; gen: number; now: number; purpose: VerifyPurpose; ttlMs?: number },
): { token: string; hash: string; exp: number } {
  const exp = Math.floor((o.now + (o.ttlMs ?? VERIFY_TOKEN_TTL_MS)) / 1000);
  const p = { id: o.id, gen: o.gen, exp, nonce: randomBytes(16).toString('base64url') };
  const token = `v1.${p.id}.${p.gen}.${p.exp}.${p.nonce}.${macOf(key, o.purpose, p)}`;
  if (!TOKEN_RE.test(token)) throw new Error('bad_token_input');
  return { token, hash: tokenHash(token), exp: exp * 1000 };
}

/** Strict syntax only (no MAC): null for anything that is not exactly one token. */
export function parseVerifyToken(token: string): ParsedToken | null {
  if (token.length > VERIFY_TOKEN_MAX) return null;
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  return { id: m[1]!, gen: Number(m[2]), exp: Number(m[3]), nonce: m[4]!, mac: m[5]! };
}

/**
 * The token when its MAC is valid for `purpose` under one of `keys` (timing-safe) and, with
 * `now`, its own expiry is not past; else null. Expiry and single use are the caller's (state).
 */
export function checkVerifyToken(
  keys: readonly Buffer[],
  token: string,
  purpose: VerifyPurpose,
  now?: number,
): ParsedToken | null {
  const p = parseVerifyToken(token);
  if (!p) return null;
  const got = Buffer.from(p.mac, 'base64url');
  let ok = false;
  for (const k of keys) {
    const want = Buffer.from(macOf(k, purpose, p), 'base64url');
    if (want.length === got.length && timingSafeEqual(want, got)) ok = true;
  }
  if (!ok) return null;
  if (now !== undefined && p.exp * 1000 <= now) return null;
  return p;
}

/** Timing-safe comparison of two hex digests. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

/**
 * `TBI_SIGNUP_SITE_URL`: an https origin only (no user, path, query or fragment); the link base
 * of the verify mail. Never taken from a record or a request header. Null when invalid.
 */
export function parseSiteUrl(v: string | undefined): string | null {
  if (!v || /[\s\0]/.test(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/') return null;
  return u.origin;
}

/** The link in the verify mail: the token is in the fragment (never sent to a server on GET). */
export const verifyLink = (siteOrigin: string, lang: 'he' | 'en', token: string): string =>
  `${siteOrigin}/${lang}/signup/#verify=${token}`;
