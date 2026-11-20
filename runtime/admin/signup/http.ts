/**
 * TBI-022: HTTP glue. Nothing here is active unless configured: `signupConfigFromEnv` returns null
 * unless every required variable is set, and a null config means no route exists.
 *
 *   TBI_SIGNUP_DIR          the pending store (absolute; created 0700)
 *   TBI_SIGNUP_HMAC_FILE    file with the shared secret (>= 32 bytes); read by the intake process only
 *   TBI_SIGNUP_SOURCE_HEADER  header the trusted proxy sets to the client address (default x-forwarded-for, last hop)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { normalizeDisplayName, type AdminSpool } from '../accounts.js';
import type { Principal } from '../../identity/principal.js';
import { send } from '../common.js';
import { MIN_SECRET_BYTES } from './hmac.js';
import { BodyTooLarge, readCappedBody } from './limits.js';
import type { AccountAdder, AddOutcome, SignupIntake } from './service.js';

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
  return {
    dir,
    hmacFile,
    sourceHeader: (env.TBI_SIGNUP_SOURCE_HEADER ?? 'x-forwarded-for').toLowerCase(),
  };
}

/** Reads the secret; a short or empty secret is a configuration error. */
export async function readSecret(file: string): Promise<Buffer> {
  const b = Buffer.from((await readFile(file, 'utf8')).trim(), 'utf8');
  if (b.length < MIN_SECRET_BYTES) throw new Error('signup HMAC secret too short');
  return b;
}

/** The client key: the LAST hop of the proxy header (the one our own proxy appended), else the socket. */
export function sourceKey(req: IncomingMessage, header: string): string {
  const h = req.headers[header];
  const v = Array.isArray(h) ? h[h.length - 1] : h;
  const last = v?.split(',').pop()?.trim();
  return last && last.length <= 64 ? last : (req.socket.remoteAddress ?? 'unknown');
}

/** `POST /signup` only. Every answer is a small JSON body; nothing about the request is echoed. */
export async function handleSignupRequest(
  req: IncomingMessage,
  res: ServerResponse,
  intake: SignupIntake,
  sourceHeader: string,
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
    out = await intake.submit(sourceKey(req, sourceHeader), req.headers, body);
  } catch {
    return send(res, 500, { error: 'internal' });
  }
  if (out.status === 202) return send(res, 202, { ok: true });
  if (out.status === 429 && out.retryAfterMs)
    res.setHeader('retry-after', String(Math.ceil(out.retryAfterMs / 1000)));
  return send(res, out.status, { error: out.error });
}

/** Adapter: the existing admin spool (-> root helper) as the approver's account-add path. */
export function spoolAccountAdder(spool: AdminSpool, actor: Principal): AccountAdder {
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
