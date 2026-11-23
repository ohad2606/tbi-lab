/**
 * BETA-G1 s8: the browser-safe sign-up route (docs/plans/BETA-G1-WEB-INTAKE.md). OFF by default.
 *
 * A browser cannot hold the HMAC secret of `POST /signup`, so the web page asks the intake for a
 * short-lived, stateless FORM TOKEN (`GET /signup/form-token`) and posts it with the answers
 * (`POST /signup/web`). The token is
 *
 *     w1.<issued-at ms>.<nonce: 22 base64url chars>.<mac: 64 hex>
 *     mac = HMAC-SHA256(webKey, "tbi-signup-web-token-v1\n<issued-at>\n<nonce>")
 *     webKey = HMAC-SHA256(secret, "tbi-signup-web-key-v1")
 *
 * Domain separation, two layers: the token MAC is computed under a key DERIVED from the secret
 * (never the secret itself, which is the `/signup` signing key), and over a fixed prefix that no
 * `/signup` signature input (`v1\n...`) can start with. A token therefore proves only "this intake
 * issued it at that time"; it is never a valid `/signup` signature, and `/signup` signatures are
 * never valid tokens. Nothing is stored at issue time; single use is enforced at submit time by a
 * NonceCache keyed by the token nonce, after the MAC verifies (a forged token cannot burn nonces).
 *
 * Pure and injectable: the clock, the secret and the random source are parameters.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** How long a token may be used after it was issued (a person reading the privacy notice). */
export const WEB_TOKEN_TTL_MS = 30 * 60_000;
/** Submissions sooner than this after issue are refused as automated (`too_fast`). */
export const WEB_MIN_FILL_MS = 3_000;
/** Tolerated issued-at in the future (the token clock is the server's own, so only a tiny slack). */
const FUTURE_SLACK_MS = 5_000;
/** The honeypot field: must be present and empty (the page hides it from people and AT). */
export const HONEYPOT_FIELD = 'website';
/** The token field in the JSON body. */
export const TOKEN_FIELD = 'token';

const TOKEN_RE = /^w1\.(\d{13})\.([A-Za-z0-9_-]{22})\.([0-9a-f]{64})$/;
const KEY_LABEL = 'tbi-signup-web-key-v1';
const MAC_PREFIX = 'tbi-signup-web-token-v1\n';

export function deriveWebKey(secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

function mac(webKey: Buffer, issuedAt: number, nonce: string): string {
  return createHmac('sha256', webKey).update(`${MAC_PREFIX}${issuedAt}\n${nonce}`).digest('hex');
}

export function issueToken(
  webKey: Buffer,
  now: number,
  random: (n: number) => Buffer = randomBytes,
): string {
  const nonce = random(16).toString('base64url'); // 16 bytes -> 22 chars
  const iat = Math.floor(now);
  return `w1.${iat}.${nonce}.${mac(webKey, iat, nonce)}`;
}

export type TokenFailure = 'missing_token' | 'bad_token' | 'expired' | 'too_fast';

export type TokenCheck =
  { ok: true; nonce: string; issuedAt: number } | { ok: false; reason: TokenFailure };

/**
 * MAC, age and minimum fill time. Does NOT consume the nonce (the caller does that last, so a
 * typo or a `too_fast` answer lets the same page retry with the same token).
 */
export function checkToken(
  webKey: Buffer,
  token: unknown,
  now: number,
  opts: { ttlMs?: number; minFillMs?: number } = {},
): TokenCheck {
  if (token === undefined || token === null || token === '')
    return { ok: false, reason: 'missing_token' };
  if (typeof token !== 'string' || token.length > 128) return { ok: false, reason: 'bad_token' };
  const m = TOKEN_RE.exec(token);
  if (!m) return { ok: false, reason: 'bad_token' };
  const iat = Number(m[1]);
  const nonce = m[2]!;
  const expected = Buffer.from(mac(webKey, iat, nonce), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(m[3]!, 'hex')))
    return { ok: false, reason: 'bad_token' };
  const age = now - iat;
  if (age < -FUTURE_SLACK_MS) return { ok: false, reason: 'bad_token' };
  if (age > (opts.ttlMs ?? WEB_TOKEN_TTL_MS)) return { ok: false, reason: 'expired' };
  if (age < (opts.minFillMs ?? WEB_MIN_FILL_MS)) return { ok: false, reason: 'too_fast' };
  return { ok: true, nonce, issuedAt: iat };
}

// ---------------------------------------------------------------- origins

/**
 * `TBI_SIGNUP_WEB_ORIGINS`: a comma-separated list of exact origins, each `https://<host>[:port]`
 * (lower-case host, no path, no trailing slash, no user part, no wildcard). Returns null when any
 * entry is malformed or the list is empty (the caller refuses to start: no default).
 */
export function parseOrigins(v: string | undefined): string[] | null {
  if (!v) return null;
  const out: string[] = [];
  for (const raw of v.split(',')) {
    const s = raw.trim();
    if (!/^https:\/\/[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/.test(s)) return null;
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if (u.origin !== s) return null; // e.g. an explicit default port (:443) is not canonical
    if (!out.includes(s)) out.push(s);
  }
  return out.length ? out : null;
}

type Headers = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | null => (typeof v === 'string' ? v : null);

/**
 * The allow-listed origin of a request, or null. `Origin` decides when present (exactly one value,
 * exact match; `null` never matches); only when it is absent does the `Referer`'s origin count.
 * Neither present = null (a browser always sends Origin on a cross-site POST, so absence means a
 * non-browser client or a privacy setting; both are refused for a POST).
 */
export function allowedOrigin(headers: Headers, allow: readonly string[]): string | null {
  if (headers.origin !== undefined) {
    const o = one(headers.origin);
    return o !== null && allow.includes(o) ? o : null;
  }
  const r = one(headers.referer);
  if (r === null || r.length > 2048) return null;
  try {
    const o = new URL(r).origin;
    return allow.includes(o) ? o : null;
  } catch {
    return null;
  }
}
