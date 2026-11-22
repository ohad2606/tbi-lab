/**
 * ARC-MAILER: the mail provider transport (Resend HTTP API). `fetch` and the key reader are
 * injected; tests never reach the network or a real key. The key is read at send time, checked
 * against the sending-key shape and used in the Authorization header only. Every failure is
 * a short class code (`bad_key`, `network`, `http_<n>`, a secret-file class): never the key, the
 * URL, the recipient or the response body.
 */
import { RESEND_KEY_RE } from '../admin/signup/email.js';
import { errorClass } from '../admin/signup/errors.js';
import type { FetchLike } from '../admin/signup/notify.js';

export const RESEND_API_URL = 'https://api.resend.com/emails';

export interface OutgoingMail {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  /** The provider de-duplicates on this key (24 h at Resend). */
  idempotencyKey: string;
}

export class MailError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface MailTransport {
  /** Resolves when the provider accepted the mail; throws MailError otherwise. */
  send(m: OutgoingMail): Promise<void>;
}

export interface ResendTransportConfig {
  readKey: () => Promise<string>;
  fetch: FetchLike;
  timeoutMs?: number;
}

export class ResendTransport implements MailTransport {
  constructor(private readonly c: ResendTransportConfig) {}

  async send(m: OutgoingMail): Promise<void> {
    let key: string;
    try {
      key = (await this.c.readKey()).trim();
    } catch (e) {
      throw new MailError(errorClass(e));
    }
    if (!RESEND_KEY_RE.test(key)) throw new MailError('bad_key');
    let res;
    try {
      res = await this.c.fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'idempotency-key': m.idempotencyKey,
        },
        body: JSON.stringify({
          from: m.from,
          to: [m.to],
          reply_to: m.replyTo,
          subject: m.subject,
          text: m.text,
        }),
        signal: AbortSignal.timeout(this.c.timeoutMs ?? 15_000),
      });
    } catch {
      throw new MailError('network');
    }
    if (!res.ok) throw new MailError(`http_${res.status}`);
  }
}

/**
 * Whether a failed attempt may be retried. Retried (same idempotency key, inside the provider's
 * de-duplication window): transport errors and timeouts, 408, 429, 5xx, and the operator-fixable
 * key problems (missing / unreadable / malformed key file, 401, 403). Everything else (400, 404,
 * 409 idempotency conflict, 413, 422, ...) is permanent and goes to the dead letters.
 */
export function isRetryable(code: string): boolean {
  if (code === 'network' || code === 'bad_key' || code.startsWith('secret_')) return true;
  if (code === 'fs_error') return true;
  const m = /^http_(\d{3})$/.exec(code);
  if (!m) return false;
  const s = Number(m[1]);
  return s === 401 || s === 403 || s === 408 || s === 429 || s >= 500;
}
