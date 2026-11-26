/**
 * TBI-022: request authentication of the public sign-up endpoint (docs/alpha/SIGNUP-AUTOMATION-DESIGN.md).
 *
 * The sender (a form-response script) signs `v1\n<timestamp>\n<nonce>\n<raw body>` with
 * HMAC-SHA256 and sends hex in `x-tbi-signature`, the unix timestamp in seconds in
 * `x-tbi-timestamp` and a random nonce (16-64 chars of [A-Za-z0-9_-]) in `x-tbi-nonce`.
 * Pure and injectable: the clock and the secret are parameters; nothing here reads a file or the
 * network. Every failure is a coded refusal, never a partial accept.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-tbi-signature';
export const TIMESTAMP_HEADER = 'x-tbi-timestamp';
export const NONCE_HEADER = 'x-tbi-nonce';
/** Accepted clock skew / replay window either side of now. */
export const DEFAULT_REPLAY_WINDOW_MS = 5 * 60_000;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SIG_RE = /^[0-9a-f]{64}$/;
/** A secret shorter than this is a configuration error, not a weak-but-working secret. */
export const MIN_SECRET_BYTES = 32;

export type VerifyFailure =
  'missing_header' | 'bad_timestamp' | 'expired' | 'bad_nonce' | 'bad_signature' | 'replayed';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

export function sign(secret: Buffer, timestampSec: number, nonce: string, body: Buffer): string {
  return createHmac('sha256', secret)
    .update(`v1\n${timestampSec}\n${nonce}\n`)
    .update(body)
    .digest('hex');
}

/** Remembers nonces for the replay window; bounded so a flood of valid-looking nonces cannot grow it. */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  readonly windowMs: number;
  /** Derived, never configured: a nonce must outlive the whole accept interval (2 x window). */
  readonly ttlMs: number;
  private readonly max: number;
  /** In memory only: a restart empties it and reopens replay of captured requests for up to the window. */
  constructor(opts: { windowMs?: number; max?: number } = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    this.ttlMs = 2 * this.windowMs;
    this.max = opts.max ?? 10_000;
  }

  /** Records the nonce; false when it was already seen (or the cache is full of live entries). */
  take(nonce: string, now: number): boolean {
    for (const [k, exp] of this.seen) {
      if (exp > now) break; // insertion order = expiry order
      this.seen.delete(k);
    }
    if (this.seen.has(nonce)) return false;
    if (this.seen.size >= this.max) return false; // refuse rather than evict a live nonce
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }

  /** Number of recorded entries (expired ones are dropped lazily by `take`). */
  get size(): number {
    return this.seen.size;
  }

  /** Whether the nonce is recorded and not yet expired (does not record it). */
  has(nonce: string, now: number): boolean {
    const exp = this.seen.get(nonce);
    return exp !== undefined && exp > now;
  }

  /**
   * Forgets a nonce taken by `take` (BETA-G1 s8: the web route gives a token back when nothing
   * was stored). Only for a nonce this caller just took; never used by the signed route.
   */
  release(nonce: string): void {
    this.seen.delete(nonce);
  }
}

export interface VerifyInput {
  secret: Buffer;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  now: number;
  nonces: NonceCache;
  windowMs?: number;
}

const one = (v: string | string[] | undefined): string | null => (typeof v === 'string' ? v : null);

export function verifyRequest(i: VerifyInput): VerifyResult {
  const window = i.windowMs ?? DEFAULT_REPLAY_WINDOW_MS;
  if (window > i.nonces.windowMs)
    throw new Error('nonce cache window is shorter than the replay window');
  const sig = one(i.headers[SIGNATURE_HEADER]);
  const ts = one(i.headers[TIMESTAMP_HEADER]);
  const nonce = one(i.headers[NONCE_HEADER]);
  if (sig === null || ts === null || nonce === null) return { ok: false, reason: 'missing_header' };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: 'bad_timestamp' };
  const tsSec = Number(ts);
  if (Math.abs(i.now - tsSec * 1000) > window) return { ok: false, reason: 'expired' };
  if (!NONCE_RE.test(nonce)) return { ok: false, reason: 'bad_nonce' };
  if (!SIG_RE.test(sig)) return { ok: false, reason: 'bad_signature' };
  const expected = Buffer.from(sign(i.secret, tsSec, nonce, i.body), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(sig, 'hex')))
    return { ok: false, reason: 'bad_signature' };
  // Only a correctly signed request consumes a nonce (an attacker cannot burn nonces).
  if (!i.nonces.take(nonce, i.now)) return { ok: false, reason: 'replayed' };
  return { ok: true };
}
