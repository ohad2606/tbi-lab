/**
 * TBI-022: HTTP glue. Nothing here is active unless configured: `signupConfigFromEnv` returns null
 * unless every required variable is set, and a null config means no route exists.
 *
 *   TBI_SIGNUP_DIR          the pending store (absolute; created 0700)
 *   TBI_SIGNUP_HMAC_FILE    file with the shared secret (>= 32 bytes); read by the intake process only
 *   TBI_SIGNUP_SOURCE_HEADER  header the trusted proxy sets to the client address (last hop); REQUIRED
 *                           once the feature is on (no default: fail closed, design §3)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { normalizeDisplayName, type AdminSpool } from '../accounts.js';
import type { Principal } from '../../identity/principal.js';
import { send } from '../common.js';
import { errorClass } from './errors.js';
import { MIN_SECRET_BYTES } from './hmac.js';
import { BodyTooLarge, readCappedBody } from './limits.js';
import { readSecretFile } from './secret-file.js';
import type { AccountAdder, AddOutcome, SignupIntake } from './service.js';
import { allowedOrigin } from './web.js';

export interface SignupEnvConfig {
  dir: string;
  hmacFile: string;
  sourceHeader: string;
}

export function signupConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SignupEnvConfig | null {
  const dir = env.TBI_SIGNUP_DIR;
  const hmacFile = env.TBI_SIGNUP_HMAC_FILE;
  if (!dir || !hmacFile) return null; // feature off
  if (!dir.startsWith('/') || !hmacFile.startsWith('/'))
    throw new Error('TBI_SIGNUP_DIR and TBI_SIGNUP_HMAC_FILE must be absolute paths');
  const sourceHeader = parseSourceHeader(env.TBI_SIGNUP_SOURCE_HEADER);
  if (!sourceHeader) throw new Error('TBI_SIGNUP_SOURCE_HEADER is required (a header name)');
  return { dir, hmacFile, sourceHeader };
}

/** A configured header name (token characters, at most 64), lower-cased; null when unset or malformed. */
export function parseSourceHeader(v: string | undefined): string | null {
  return v && /^[A-Za-z0-9-]{1,64}$/.test(v) ? v.toLowerCase() : null;
}

/**
 * Reads the secret; a short or empty secret is a configuration error, and so is a file that
 * other users can read (`secret_unsafe_mode`, see secret-file.ts).
 */
export async function readSecret(file: string): Promise<Buffer> {
  let text: string;
  try {
    text = await readSecretFile(file);
  } catch (e) {
    // A class code only: the raw fs error carries the path.
    const c = errorClass(e);
    // eslint-disable-next-line preserve-caught-error -- the cause would carry the secret file path
    throw new Error(
      c === 'secret_missing' || c === 'secret_unsafe_mode' || c === 'secret_not_file'
        ? c
        : 'secret_unreadable',
    );
  }
  const b = Buffer.from(text.trim(), 'utf8');
  if (b.length < MIN_SECRET_BYTES) throw new Error('secret_short');
  return b;
}

/**
 * The client key: the LAST hop of the proxy header (the one our own proxy appended), else the
 * socket. Only an IP address counts; anything else (absent, empty, a port suffix, junk) is treated
 * as missing and reported through `onFallback`: behind the proxy the socket address is the proxy
 * itself, so every such request shares one rate bucket (a proxy misconfiguration to fix).
 */
export function sourceKey(req: IncomingMessage, header: string, onFallback?: () => void): string {
  const h = req.headers[header];
  const v = Array.isArray(h) ? h[h.length - 1] : h;
  const last = v?.split(',').pop()?.trim();
  if (last && last.length <= 64 && isIP(last) !== 0) return last;
  onFallback?.();
  return req.socket.remoteAddress ?? 'unknown';
}

/** The 8 hextets of a valid IPv6 literal (zone id dropped; a dotted IPv4 tail folded), else null. */
function ipv6Hextets(ip: string): number[] | null {
  let a = ip.split('%')[0]!.toLowerCase();
  const dot = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (dot) {
    const b = dot.slice(1).map(Number);
    a = `${a.slice(0, dot.index)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const part = (x: string | undefined) => (x ? x.split(':') : []);
  const head = part(halves[0]);
  const tail = part(halves[1]);
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const h = [...head, ...Array<string>(fill).fill('0'), ...tail].map((x) =>
    /^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN,
  );
  return h.length === 8 && h.every((n) => Number.isInteger(n)) ? h : null;
}

/**
 * BETA-G1 s8, the web route's rate-limit bucket for one client address: IPv4 as is; an
 * IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, also in hex) as its IPv4 address (one person, one
 * bucket, whichever form the proxy writes); any other IPv6 address as its /64 (`p:q:r:s::/64`),
 * because one subscriber or one cloud host usually holds a whole /64 and could otherwise rotate
 * through 2^64 addresses (fresh buckets, and limiter table growth). Not an IP: null.
 */
export function webBucket(ip: string): string | null {
  if (ip.length > 64) return null;
  const kind = isIP(ip);
  if (kind === 4) return ip;
  if (kind !== 6) return null;
  const h = ipv6Hextets(ip);
  if (!h) return null;
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff)
    return `${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`;
  return `${h
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}

/**
 * The web route's source key: the bucket (webBucket) of the proxy header's LAST hop, or null when
 * the header is absent or not an IP. Unlike `/signup` there is NO fallback to the socket peer
 * (behind the proxy that is the proxy itself, so every visitor would share one bucket): the
 * caller refuses with 503 instead.
 */
export function webSourceKey(req: IncomingMessage, header: string): string | null {
  const h = req.headers[header];
  const v = Array.isArray(h) ? h[h.length - 1] : h;
  const last = v?.split(',').pop()?.trim();
  return last ? webBucket(last) : null;
}

/** `POST /signup` only. Every answer is a small JSON body; nothing about the request is echoed. */
export async function handleSignupRequest(
  req: IncomingMessage,
  res: ServerResponse,
  intake: SignupIntake,
  sourceHeader: string,
  onSourceFallback?: () => void,
): Promise<void> {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? ''))
    return send(res, 415, { error: 'unsupported_media_type' });
  let body: Buffer;
  try {
    body = await readCappedBody(req);
  } catch (e) {
    return send(res, e instanceof BodyTooLarge ? 413 : 400, {
      error: e instanceof BodyTooLarge ? 'body_too_large' : 'invalid',
    });
  }
  let out;
  try {
    out = await intake.submit(sourceKey(req, sourceHeader, onSourceFallback), req.headers, body);
  } catch {
    return send(res, 500, { error: 'internal' });
  }
  if (out.status === 202) return send(res, 202, { ok: true });
  if (out.status === 429 && out.retryAfterMs)
    res.setHeader('retry-after', String(Math.ceil(out.retryAfterMs / 1000)));
  return send(res, out.status, { error: out.error });
}

export const WEB_TOKEN_PATH = '/signup/form-token';
export const WEB_SIGNUP_PATH = '/signup/web';

export interface WebHttpOptions {
  sourceHeader: string;
  /** The exact allow-listed origins (TBI_SIGNUP_WEB_ORIGINS). */
  origins: readonly string[];
  onSourceFallback?: () => void;
}

/** `application/json`, optionally with `charset=utf-8`; nothing else (no form posts, no text/plain). */
const STRICT_JSON = /^application\/json\s*(;\s*charset=utf-8\s*)?$/i;

/** CORS for an allow-listed origin only; never credentials; `Vary: Origin` on every answer. */
function cors(res: ServerResponse, origin: string | null): void {
  res.setHeader('vary', 'Origin');
  if (origin) res.setHeader('access-control-allow-origin', origin);
}

function refuse(req: IncomingMessage, res: ServerResponse, status: number, error: string): void {
  req.resume();
  send(res, status, { error });
}

/**
 * BETA-G1 s8: `GET /signup/form-token` and `POST /signup/web` (plus their CORS preflights). Exists
 * only when the web route is enabled (the server answers 404 otherwise). Every answer is a small
 * JSON body with a machine code; nothing from the request is echoed.
 */
export async function handleWebSignupRequest(
  req: IncomingMessage,
  res: ServerResponse,
  intake: SignupIntake,
  path: string,
  o: WebHttpOptions,
): Promise<void> {
  const isToken = path === WEB_TOKEN_PATH;
  const method = isToken ? 'GET' : 'POST';
  if (req.method === 'OPTIONS') {
    // Preflight: only from an allow-listed origin, only for this route's method.
    const origin = allowedOrigin({ origin: req.headers.origin }, o.origins);
    cors(res, origin);
    if (!origin || req.headers['access-control-request-method'] !== method)
      return refuse(req, res, 403, 'forbidden');
    res.setHeader('access-control-allow-methods', method);
    if (!isToken) res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-max-age', '600');
    req.resume();
    res.writeHead(204, { 'cache-control': 'no-store', 'content-length': 0 });
    res.end();
    return;
  }
  if (req.method !== method) {
    res.setHeader('allow', `${method}, OPTIONS`);
    return refuse(req, res, 405, 'method_not_allowed');
  }
  const key = webSourceKey(req, o.sourceHeader);
  // No usable client address: refuse (503, generic) rather than bucket everyone together.
  const noSource = () => {
    o.onSourceFallback?.();
    refuse(req, res, 503, 'unavailable');
  };
  if (isToken) {
    // A same-origin GET carries no Origin header (allowed); a cross-origin one must be listed.
    const origin = req.headers.origin === undefined ? null : allowedOrigin(req.headers, o.origins);
    cors(res, origin);
    if (req.headers.origin !== undefined && !origin) return refuse(req, res, 403, 'forbidden');
    if (key === null) return noSource();
    req.resume();
    const t = intake.issueWebToken(key);
    if (t.status === 200) return send(res, 200, { token: t.token, ttl: t.ttl });
    if (t.status === 429 && t.retryAfterMs)
      res.setHeader('retry-after', String(Math.ceil(t.retryAfterMs / 1000)));
    return send(res, t.status, { error: t.error });
  }
  // POST: the origin (or, without Origin, the Referer) must be listed: a cross-site page cannot
  // post here (CSRF), and a JSON body forces a browser preflight that only listed origins pass.
  const origin = allowedOrigin(req.headers, o.origins);
  cors(res, origin);
  if (!origin) return refuse(req, res, 403, 'forbidden');
  if (!STRICT_JSON.test(req.headers['content-type'] ?? ''))
    return refuse(req, res, 415, 'unsupported_media_type');
  if (key === null) return noSource();
  let body: Buffer;
  try {
    body = await readCappedBody(req);
  } catch (e) {
    return send(res, e instanceof BodyTooLarge ? 413 : 400, {
      error: e instanceof BodyTooLarge ? 'body_too_large' : 'invalid',
    });
  }
  let out;
  try {
    out = await intake.submitWeb(key, body);
  } catch {
    return send(res, 500, { error: 'internal' });
  }
  // Same answer for a new and an already known address (privacy: no account enumeration).
  if (out.status === 200) return send(res, 200, { ok: true, status: 'received' });
  if (out.status === 429 && out.retryAfterMs)
    res.setHeader('retry-after', String(Math.ceil(out.retryAfterMs / 1000)));
  return send(res, out.status, { error: out.error });
}

/** Adapter: the existing admin spool (-> root helper) as the approver's account-add path. */
export function spoolAccountAdder(
  spool: Pick<AdminSpool, 'submit' | 'wait'>,
  actor: Principal,
): AccountAdder {
  return {
    async add(email, name): Promise<AddOutcome> {
      const displayName = name ? normalizeDisplayName(name) : null;
      let id: string;
      try {
        id = await spool.submit(actor, {
          action: 'add',
          email,
          ...(displayName ? { displayName } : {}),
        });
      } catch {
        return 'error';
      }
      const r = await spool.wait(id);
      if (r === 'pending') return 'pending';
      if (r.ok || r.code === 'exists') return r.ok ? 'done' : 'exists';
      return r.code === 'cap_reached' ? 'cap_reached' : 'error';
    },
  };
}
