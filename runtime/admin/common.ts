/**
 * Sprint 23B/23C: what the owner's two HTTP surfaces share (docs/alpha/ADMIN-AND-FEEDBACK.md):
 * the Session Host's report routes (runtime/host/admin.ts) and the dedicated admin service's
 * account routes (runtime/admin/accounts.ts). Moved here from the s23b runtime/host/admin.ts,
 * unchanged: the atomic file write of requests and observations, the CSRF rule, the body reader,
 * the error answers and the per-caller limits.
 */
import { randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { EmailTag } from '../identity/access.js';
import type { Principal } from '../identity/principal.js';
import { Refusal, sendRefusal } from '../policy/refusal.js';

// ---------------------------------------------------------------- ids and atomic files

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Request and observation ids: 26 Crockford base32 characters (48-bit time, 80 random bits). */
export const REQUEST_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export function newRequestId(now = Date.now()): string {
  let t = '';
  let ms = now;
  for (let i = 0; i < 10; i++) {
    t = CROCKFORD[ms % 32]! + t;
    ms = Math.floor(ms / 32);
  }
  let r = '';
  for (const b of randomBytes(16)) r += CROCKFORD[b & 31];
  return t + r;
}

/** File-system steps tests replace. */
export interface SpoolIo {
  syncFile(fh: Awaited<ReturnType<typeof open>>): Promise<void>;
}
const defaultIo: SpoolIo = { syncFile: (fh) => fh.sync() };

/**
 * `<dir>/<id>.tmp` created exclusively (0640) -> written -> fsynced -> renamed to `<id>.json`.
 * Interface N1: the directories are setgid (2730) with the group the root helper reads by
 * (`tbi-admin-spool` for requests, `tbi-admin-observe` for observations, Sprint 23C), so the file
 * inherits that group, and the helper never chowns it. The mode is set with fchmod as well, so a
 * stricter process umask cannot leave the helper unable to read it. The directory itself is not
 * fsynced: the writer may create files in it but not read it (0730). On any failure nothing is
 * left behind.
 */
export async function writeSpoolFile(
  dir: string,
  id: string,
  text: string,
  io: SpoolIo = defaultIo,
): Promise<void> {
  if (!REQUEST_ID_RE.test(id)) throw new Error('bad id');
  const tmp = join(dir, `${id}.tmp`);
  // Exclusive: an existing file of that name is never written to or removed by us.
  const fh = await open(tmp, 'wx', 0o640);
  try {
    try {
      await fh.chmod(0o640);
      await fh.writeFile(text, 'utf8');
      await io.syncFile(fh);
    } finally {
      await fh.close();
    }
    await rename(tmp, join(dir, `${id}.json`));
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------- HTTP

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Largest admin request body (an address or a target). */
export const MAX_ADMIN_BODY_BYTES = 1024;
/** Per-caller limits: every admin call, and the mutations among them. */
export const ADMIN_RATE = { count: 120, windowMs: 60_000 };
export const ADMIN_WRITE_RATE = { count: 20, windowMs: 60_000 };

export interface AdminLimits {
  all: { count: number; windowMs: number };
  write: { count: number; windowMs: number };
}

export interface Caller {
  principal: Principal | null;
  emailTag: EmailTag | null;
}

export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Every outcome of an admin handler is answered: its own errors, refusals, and a bare 500. */
export async function answerErrors(
  res: ServerResponse,
  what: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (e) {
    if (e instanceof AdminError) return send(res, e.status, { error: e.code });
    if (e instanceof Refusal) return sendRefusal(res, e);
    // Never the request's data (an address may be in it): the error class only.
    process.stderr.write(`${what}: internal error (${(e as Error)?.name ?? 'error'})\n`);
    send(res, 500, { error: 'internal' });
  }
}

/**
 * CSRF for a mutation: a JSON content type (a cross-site form cannot send one without a
 * preflight) and a same-origin request: an `Origin` whose host is the request's own `Host`, or,
 * without an `Origin`, `Sec-Fetch-Site: same-origin`. A cross-site `Sec-Fetch-Site` is refused
 * whatever the Origin says.
 */
export function sameOriginJson(req: IncomingMessage): boolean {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return site === 'same-origin';
  if (typeof origin !== 'string' || origin === 'null') return false;
  let host: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    host = u.host;
  } catch {
    return false;
  }
  return typeof req.headers.host === 'string' && host === req.headers.host.toLowerCase();
}

export function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_ADMIN_BODY_BYTES) {
      req.resume();
      return reject(new AdminError(413, 'body_too_large'));
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_ADMIN_BODY_BYTES) {
        req.destroy();
        reject(new AdminError(413, 'body_too_large'));
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (!isObj(v)) return reject(new AdminError(400, 'invalid'));
        resolve(v);
      } catch {
        reject(new AdminError(400, 'invalid'));
      }
    });
    req.on('error', () => reject(new AdminError(400, 'invalid')));
  });
}
