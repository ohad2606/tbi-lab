/**
 * Sprint 23B: server-side access enforcement from the authorization view (docs/alpha/
 * ADMIN-AND-FEEDBACK.md). Shared by the Session Host and the build service.
 *
 * OFF unless `TBI_ACCESS_VIEW` names the view file: then every request (health aside) needs a
 * gate identity that the view authorizes, by principal (from `X-Forwarded-User`) or by email tag
 * (an HMAC of `X-Forwarded-Email`). Anything else is 403 `account_disabled`; a missing,
 * unreadable or invalid view is 503 `access_view_unavailable` (fail closed).
 *
 * The view never holds an address: only principals and email tags, both HMACs with the identity
 * key the backends already hold. An address read from the gate's header is used to compute its
 * tag and is never logged, stored or returned.
 *
 * Trust: both headers come from the gate only. oauth2-proxy deletes any client-sent
 * `X-Forwarded-User` / `X-Forwarded-Email` before it injects the session's own values, and the
 * internal reverse proxy strips every `X-Tbi-*` header (the verification is recorded in the
 * document above).
 */
import { createHmac } from 'node:crypto';
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { basename, dirname } from 'node:path';
import { isPrincipal, principalOf, type IdentityConfig, type Principal } from './principal.js';

export type EmailTag = `e_${string}`;
const EMAIL_TAG_RE = /^e_[A-Za-z0-9_-]{26}$/;
export const isEmailTag = (v: unknown): v is EmailTag =>
  typeof v === 'string' && EMAIL_TAG_RE.test(v);

/** The header the gate sets to the session's verified address. */
export const EMAIL_HEADER = 'x-forwarded-email';

/**
 * An address as the gate may assert it: printable ASCII, one `@`, no spaces, separators or
 * quotes, at most 254 characters. Anything else (a repeated header joined with `, `, a control
 * character) is treated as no address at all.
 */
const GATE_EMAIL_RE = /^[^\s@",;<>()[\]\\]{1,64}@[^\s@",;<>()[\]\\]{1,253}$/;
export function gateEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  // ASCII is checked BEFORE lower-casing: Unicode case folding maps some non-ASCII characters to
  // ASCII ones (U+212A KELVIN SIGN to `k`, U+0130 to `i` + a combining dot), which would turn a
  // different address into an authorized one.
  if (t.length > 254 || !/^[\x21-\x7e]+$/.test(t)) return null;
  const e = t.toLowerCase();
  if (!GATE_EMAIL_RE.test(e)) return null;
  return e;
}

/** The email tag: `e_` + base64url(HMAC-SHA256(key, "email|" + lower(trim(email))))[0..26). */
export function deriveEmailTag(cfg: IdentityConfig, email: string): EmailTag {
  const mac = createHmac('sha256', cfg.key)
    .update(`email|${email.trim().toLowerCase()}`)
    .digest('base64url');
  return `e_${mac.slice(0, 26)}`;
}

/** The verified address the gate passed, or null. Never log or store the result. */
export function emailOf(req: IncomingMessage): string | null {
  return gateEmail(req.headers[EMAIL_HEADER]);
}

export function emailTagOf(req: IncomingMessage, cfg: IdentityConfig): EmailTag | null {
  const e = emailOf(req);
  return e === null ? null : deriveEmailTag(cfg, e);
}

export interface AccessViewData {
  v: 1;
  generated: string;
  seq: number;
  owner: { principal: Principal | null; emailTag: EmailTag };
  authorized: { principals: ReadonlySet<Principal>; emailTags: ReadonlySet<EmailTag> };
  revoked: { principals: ReadonlySet<Principal>; emailTags: ReadonlySet<EmailTag> };
}

/** Largest view file accepted (a cohort of a few dozen accounts is a few KiB). */
const MAX_VIEW_BYTES = 1024 * 1024;
const MAX_ENTRIES = 10_000;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function idSet<T extends string>(v: unknown, test: (x: unknown) => x is T): Set<T> | null {
  if (!Array.isArray(v) || v.length > MAX_ENTRIES || !v.every(test)) return null;
  return new Set(v);
}

function lists(v: unknown): AccessViewData['authorized'] | null {
  if (!isObj(v)) return null;
  const principals = idSet(v.principals, isPrincipal);
  const emailTags = idSet(v.emailTags, isEmailTag);
  return principals && emailTags ? { principals, emailTags } : null;
}

/** The view, strictly validated; null when anything is wrong (the caller fails closed). */
export function parseAccessView(text: string): AccessViewData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.v !== 1) return null;
  if (typeof raw.generated !== 'string' || raw.generated.length > 64) return null;
  if (typeof raw.seq !== 'number' || !Number.isSafeInteger(raw.seq) || raw.seq < 0) return null;
  const o = raw.owner;
  if (!isObj(o) || !isEmailTag(o.emailTag)) return null;
  if (o.principal !== null && !isPrincipal(o.principal)) return null;
  const authorized = lists(raw.authorized);
  const revoked = lists(raw.revoked);
  if (!authorized || !revoked) return null;
  return {
    v: 1,
    generated: raw.generated,
    seq: raw.seq,
    owner: { principal: o.principal, emailTag: o.emailTag },
    authorized,
    revoked,
  };
}

/**
 * The host rule. Deny wins: a principal in `revoked.principals` or an email tag in
 * `revoked.emailTags` is refused even if the other identifier is authorized. Otherwise the
 * principal, or the email tag, must be in the authorized lists.
 */
export function isAuthorized(
  view: AccessViewData,
  principal: Principal | null,
  emailTag: EmailTag | null,
): boolean {
  if (
    (principal !== null && view.revoked.principals.has(principal)) ||
    (emailTag !== null && view.revoked.emailTags.has(emailTag))
  )
    return false;
  return (
    (principal !== null && view.authorized.principals.has(principal)) ||
    (emailTag !== null && view.authorized.emailTags.has(emailTag))
  );
}

/**
 * The owner: the recorded owner principal; only while none is recorded yet, the owner's email
 * tag. Decided from the view alone, never from anything a client sends.
 */
export function isOwner(
  view: AccessViewData,
  principal: Principal | null,
  emailTag: EmailTag | null,
): boolean {
  if (view.owner.principal !== null)
    return principal !== null && principal === view.owner.principal;
  return emailTag !== null && emailTag === view.owner.emailTag;
}

export interface AccessViewOptions {
  /** Unconditional re-read interval (at most 10 s; the view also reloads on change). */
  pollMs?: number;
  /** Reader (tests substitute a failing one). */
  read?: (path: string) => string;
}

/**
 * The authorization view file, kept current: read at start, on every change of the file (a
 * directory watch, rename included) and at least every `pollMs`. A missing, unreadable or invalid
 * file makes `current` null (fail closed) until a valid one is read again. Every successful read
 * notifies the listeners (the Session Host stops the sessions of accounts no longer authorized).
 */
export class AccessView {
  private data: AccessViewData | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(v: AccessViewData) => void>();
  readonly pollMs: number;

  constructor(
    readonly path: string,
    private readonly opts: AccessViewOptions = {},
  ) {
    this.pollMs = Math.min(opts.pollMs ?? 5_000, 10_000);
  }

  get current(): AccessViewData | null {
    return this.data;
  }

  /** Read the file now. Returns whether a valid view is in force. */
  reload(): boolean {
    let next: AccessViewData | null = null;
    try {
      const text = (this.opts.read ?? ((p) => readFileSync(p, 'utf8')))(this.path);
      if (Buffer.byteLength(text) <= MAX_VIEW_BYTES) next = parseAccessView(text);
    } catch {
      next = null;
    }
    this.data = next;
    if (next)
      for (const l of [...this.listeners]) {
        try {
          l(next);
        } catch {
          // a listener's failure never changes the view in force
        }
      }
    return next !== null;
  }

  onReload(fn: (v: AccessViewData) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  start(): this {
    this.reload();
    this.timer = setInterval(() => this.reload(), this.pollMs);
    this.timer.unref();
    try {
      // The helper replaces the file by rename: watch the directory, not the inode.
      const name = basename(this.path);
      this.watcher = watch(dirname(this.path), { persistent: false }, (_event, file) => {
        if (file !== null && file !== name) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.reload(), 50);
        this.debounce.unref();
      });
      this.watcher.on('error', () => undefined);
    } catch {
      // A directory that cannot be watched: the periodic read still applies.
      this.watcher = null;
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.timer = this.watcher = this.debounce = null;
  }
}

export type AccessDecision =
  | {
      ok: true;
      principal: Principal | null;
      emailTag: EmailTag | null;
      view: AccessViewData | null;
    }
  | { ok: false; status: 401 | 403 | 503; error: string };

/**
 * The gate identity of a request and, when a view is configured, the access decision. Without a
 * view this is exactly RC4: only the principal counts (401 without one).
 */
export function decideAccess(
  req: IncomingMessage,
  identity: IdentityConfig,
  access: AccessView | null,
): AccessDecision {
  const principal = principalOf(req, identity);
  if (!access) {
    return principal
      ? { ok: true, principal, emailTag: null, view: null }
      : { ok: false, status: 401, error: 'identity required' };
  }
  const emailTag = emailTagOf(req, identity);
  if (!principal && !emailTag) return { ok: false, status: 401, error: 'identity required' };
  const view = access.current;
  if (!view) return { ok: false, status: 503, error: 'access_view_unavailable' };
  if (!isAuthorized(view, principal, emailTag))
    return { ok: false, status: 403, error: 'account_disabled' };
  return { ok: true, principal, emailTag, view };
}

/** From the environment: `TBI_ACCESS_VIEW` (absolute path), or null (enforcement off, RC4). */
export function accessViewFromEnv(env: NodeJS.ProcessEnv = process.env): AccessView | null {
  const path = env.TBI_ACCESS_VIEW;
  if (!path) return null;
  if (!path.startsWith('/')) throw new Error('TBI_ACCESS_VIEW must be an absolute path');
  return new AccessView(path);
}
