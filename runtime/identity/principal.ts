/**
 * Backend identity contract (Sprint 8, D-S8-1).
 *
 * The only trusted source of identity is the authenticating gate in front of the backends
 * (oauth2-proxy in the private preview). The gate verifies the provider login and sets ONE
 * request header carrying the provider's stable account identifier (for Google: the numeric
 * subject, never the email); it overwrites any value a client sent. The internal reverse proxy
 * strips every `X-TBI-*` header, and the backends listen on unix sockets that only the proxy can
 * reach, so nothing else can assert identity.
 *
 * From that subject each backend derives an opaque PRINCIPAL:
 *   `p_` + base64url(HMAC-SHA256(key, `${issuer}|${subject}`))[0..26)
 * - stable for the same account; different between accounts and between issuers;
 * - not reversible without the key, and it contains no email or provider identifier, so
 *   ownership data, logs and metrics never hold personal data;
 * - provider-neutral: `issuer` is a configured label. A later account layer can add or replace
 *   providers (map several identities to one principal) without touching ownership data.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';

export type Principal = `p_${string}`;

export interface IdentityConfig {
  /** Provider-neutral issuer label that namespaces subjects (e.g. `google`). */
  issuer: string;
  /** Request header, lower case, that the trusted gate sets to the provider subject. */
  subjectHeader: string;
  /** HMAC key (at least 32 bytes). Never logged, never sent anywhere. */
  key: Buffer;
}

const PRINCIPAL_RE = /^p_[A-Za-z0-9_-]{26}$/;
export const isPrincipal = (v: unknown): v is Principal =>
  typeof v === 'string' && PRINCIPAL_RE.test(v);

/** A subject the gate may assert: 1–256 visible ASCII characters, no spaces or controls. */
const SUBJECT_RE = /^[\x21-\x7e]{1,256}$/;

export function derivePrincipal(cfg: IdentityConfig, subject: string): Principal {
  if (!SUBJECT_RE.test(subject)) throw new Error('bad subject');
  const mac = createHmac('sha256', cfg.key).update(`${cfg.issuer}|${subject}`).digest('base64url');
  return `p_${mac.slice(0, 26)}`;
}

/**
 * The caller's principal, or null when the gate asserted no (valid) identity. A repeated header
 * is refused: a well-behaved gate sets exactly one value.
 */
export function principalOf(req: IncomingMessage, cfg: IdentityConfig): Principal | null {
  const raw = req.headers[cfg.subjectHeader];
  if (typeof raw !== 'string' || !SUBJECT_RE.test(raw)) return null;
  return derivePrincipal(cfg, raw);
}

export function identityConfig(opts: {
  issuer: string;
  subjectHeader?: string;
  key: Buffer;
}): IdentityConfig {
  if (!/^[a-z][a-z0-9.-]{0,31}$/.test(opts.issuer)) throw new Error('bad identity issuer label');
  if (opts.key.length < 32) throw new Error('identity key must be at least 32 bytes');
  const subjectHeader = (opts.subjectHeader ?? 'x-forwarded-user').toLowerCase();
  if (!/^x-[a-z0-9-]{1,64}$/.test(subjectHeader)) throw new Error('bad identity header name');
  return { issuer: opts.issuer, subjectHeader, key: opts.key };
}

/**
 * From the process environment (services):
 *   TBI_IDENTITY_KEY_FILE  file holding the HMAC key (required; read once at start)
 *   TBI_IDENTITY_ISSUER    issuer label (default `google`)
 *   TBI_IDENTITY_HEADER    subject header set by the gate (default `x-forwarded-user`)
 */
export function identityFromEnv(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const file = env.TBI_IDENTITY_KEY_FILE;
  if (!file) throw new Error('TBI_IDENTITY_KEY_FILE is required');
  return identityConfig({
    issuer: env.TBI_IDENTITY_ISSUER ?? 'google',
    ...(env.TBI_IDENTITY_HEADER ? { subjectHeader: env.TBI_IDENTITY_HEADER } : {}),
    key: readFileSync(file),
  });
}
