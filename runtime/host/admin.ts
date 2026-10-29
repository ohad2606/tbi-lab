/**
 * Sprint 23B: owner-only tester administration in the Session Host (docs/alpha/
 * ADMIN-AND-FEEDBACK.md), and the identity observations the privileged helper reconciles.
 *
 * The host never changes an account itself. It holds no write access to the gate's allowlist or
 * the tester registry: it writes a REQUEST into a spool directory and reads the RESULT the root
 * helper writes back. Its only other inputs are two views the helper generates (`view/access.json`
 * for authorization, `view/accounts.json` for the owner's masked list). None of these files holds
 * an address, except a pending `add` request (the address the owner just typed, 0640 group tbi-admin-spool, deleted by
 * the helper once processed).
 *
 *   <TBI_ADMIN_DIR>/spool/<id>.json          host -> helper (atomic: <id>.tmp O_EXCL 0640, fsync, rename)
 *   <TBI_ADMIN_DIR>/results/<id>.json        helper -> host
 *   <TBI_ADMIN_DIR>/view/accounts.json       helper -> host (masked list)
 *   <TBI_ADMIN_DIR>/observations/<id>.json   host -> helper (gate identity, once per principal per hour)
 *
 * Authorization is decided here on every call, from the gate identity and the access view only:
 * the owner is the view's owner principal (or, while none is recorded yet, the owner's email
 * tag). No identity: 401. Any other identity: 403. Mutations also need a JSON content type and a
 * same-origin request (CSRF), and every call is rate limited per caller.
 *
 * Sprint 23C: `TBI_ADMIN_MODE` (AdminMode below). In `reports` mode (the feedback-only release)
 * only `GET /admin/me` and the report routes exist, the owner comes from a root-provided owner
 * reference (owner.ts), and none of the spool, results, views or observations above is used.
 */
import { randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { isOwner, type AccessView, type EmailTag } from '../identity/access.js';
import { isPrincipal, type Principal } from '../identity/principal.js';
import { MemoryRate } from '../policy/rate.js';
import { Refusal, sendRefusal } from '../policy/refusal.js';
import type { OwnerReference } from './owner.js';
import type { ReportStore } from './reports.js';

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
 * Interface N1: the directories are setgid `tbi-admin-spool` (2730), so the file inherits that
 * group, and the root helper reads it by group (it never chowns it). The mode is set with fchmod
 * as well, so a stricter process umask cannot leave the helper unable to read it.
 * The directory itself is not fsynced: the host may create files in it but not read it (0730).
 * On any failure nothing is left behind.
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

// ---------------------------------------------------------------- identity observations

/**
 * Identity observations: at most one per principal per hour, only when the gate passed both its
 * subject and its address. Best effort: the write runs detached from the request, any failure is
 * dropped silently (it never fails, delays or logs a request), and at most a few run at once.
 */
export class IdentityObserver {
  private readonly seen = new Map<string, number>();
  private pending = 0;

  constructor(
    readonly dir: string,
    private readonly opts: { now?: () => number; io?: SpoolIo; maxPending?: number } = {},
  ) {}

  /** Writes still running (tests). */
  get inFlight(): number {
    return this.pending;
  }

  /** Returns the write in progress (tests await it), or null when nothing was due. */
  observe(principal: Principal, subject: string, email: string): Promise<void> | null {
    // Google subjects are decimal; the helper never derives one from anything else.
    if (!/^\d{1,64}$/.test(subject)) return null;
    const now = (this.opts.now ?? Date.now)();
    const last = this.seen.get(principal);
    if (last !== undefined && now - last < 3600_000) return null;
    if (this.pending >= (this.opts.maxPending ?? 4)) return null;
    this.seen.set(principal, now);
    if (this.seen.size > 10_000) this.seen.clear(); // bounded memory
    const id = newRequestId(now);
    const text = `${JSON.stringify({ v: 1, at: new Date(now).toISOString(), sub: subject, email })}\n`;
    this.pending++;
    return writeSpoolFile(this.dir, id, text, this.opts.io)
      .catch(() => undefined)
      .finally(() => void this.pending--);
  }
}

// ---------------------------------------------------------------- views and results

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const TARGET_RE = /^t_[A-Za-z0-9_-]{16}$/;
const MASKED_RE = /^[^\s@*]{0,3}\*\*\*@[A-Za-z0-9.-]{1,253}$/;
/** A masked address as the helper writes it (`ab***@domain`); anything else is hidden entirely. */
const masked = (v: unknown): string => (typeof v === 'string' && MASKED_RE.test(v) ? v : '***');
const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null;
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 100_000 ? v : null;

export interface AccountRow {
  target: string;
  masked: string;
  class: 'owner' | 'alpha_tester';
  status: 'authorized' | 'revoked' | 'pending';
  dateAdded: string | null;
  googleIdRecorded: boolean;
  lastSignIn: string | null;
  statusUpdated: string | null;
}

export interface AccountsView {
  generated: string | null;
  cap: number;
  authorizedTesters: number;
  owner: number;
  accounts: AccountRow[];
  warnings: {
    kind: string;
    target: string | null;
    first: string | null;
    last: string | null;
    count: number | null;
  }[];
}

/** The helper's masked account list, re-validated field by field; null when unusable. */
export function parseAccountsView(text: string): AccountsView | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.v !== 1 || !Array.isArray(raw.accounts) || raw.accounts.length > 1000)
    return null;
  const cap = count(raw.cap);
  const authorizedTesters = count(raw.authorizedTesters);
  const owner = count(raw.owner);
  if (cap === null || authorizedTesters === null || owner === null) return null;
  const accounts: AccountRow[] = [];
  for (const a of raw.accounts) {
    if (!isObj(a) || typeof a.target !== 'string' || !TARGET_RE.test(a.target)) return null;
    if (a.class !== 'owner' && a.class !== 'alpha_tester') return null;
    if (a.status !== 'authorized' && a.status !== 'revoked' && a.status !== 'pending') return null;
    accounts.push({
      target: a.target,
      masked: masked(a.masked),
      class: a.class,
      status: a.status,
      dateAdded:
        typeof a.dateAdded === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.dateAdded)
          ? a.dateAdded
          : null,
      googleIdRecorded: a.googleIdRecorded === true,
      lastSignIn: isoOrNull(a.lastSignIn),
      statusUpdated: isoOrNull(a.statusUpdated),
    });
  }
  // Optional: what the helper wants the owner to know, e.g. an identity mismatch.
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings
        .filter(isObj)
        .slice(0, 100)
        .flatMap((w) =>
          typeof w.kind === 'string' && /^[a-z_]{1,40}$/.test(w.kind)
            ? [
                {
                  kind: w.kind,
                  target:
                    typeof w.target === 'string' && TARGET_RE.test(w.target) ? w.target : null,
                  first: isoOrNull(w.first),
                  last: isoOrNull(w.last),
                  count: count(w.count),
                },
              ]
            : [],
        )
    : [];
  return { generated: isoOrNull(raw.generated), cap, authorizedTesters, owner, accounts, warnings };
}

export const RESULT_CODES = [
  'done',
  'forbidden',
  'invalid',
  'cap_reached',
  'exists',
  'unknown_target',
  'last_owner',
  'conflict',
  'error',
] as const;
export type ResultCode = (typeof RESULT_CODES)[number];

export interface AdminResult {
  /**
   * Set by the host (not the helper) on a `forbidden` while the view records no owner principal:
   * the owner's Google id is not recorded yet (the operator's identity sync), so the helper
   * refuses every privileged action.
   */
  ownerIdentityPending?: true;
  id: string;
  ok: boolean;
  code: ResultCode;
  target: string | null;
  masked: string | null;
  backup: string | null;
  at: string | null;
}

export function parseResult(text: string, id: string): AdminResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.v !== 1 || raw.id !== id || typeof raw.ok !== 'boolean') return null;
  if (!(RESULT_CODES as readonly unknown[]).includes(raw.code)) return null;
  return {
    id,
    ok: raw.ok,
    code: raw.code as ResultCode,
    target: typeof raw.target === 'string' && TARGET_RE.test(raw.target) ? raw.target : null,
    masked: raw.masked === undefined || raw.masked === null ? null : masked(raw.masked),
    backup:
      typeof raw.backup === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(raw.backup)
        ? raw.backup
        : null,
    at: isoOrNull(raw.at),
  };
}

// ---------------------------------------------------------------- requests

/**
 * An address the owner may add: lower case, the registry's character set (a strict subset of it),
 * at most 254 characters. Normalized before validation (trim, lower case).
 */
const ADD_EMAIL_RE =
  /^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;
export function normalizeAddEmail(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 320) return null;
  // ASCII only, checked before lower-casing (case folding maps e.g. U+212A KELVIN SIGN to `k`).
  const t = v.trim();
  if (!/^[\x21-\x7e]+$/.test(t)) return null;
  const e = t.toLowerCase();
  if (e.length > 254 || e.split('@')[0]!.length > 64 || !ADD_EMAIL_RE.test(e)) return null;
  return e;
}

export type AdminAction =
  { action: 'add'; email: string } | { action: 'disable' | 'reactivate'; target: string };

export interface AdminConfig {
  /** The helper's base directory (spool/, results/, view/, observations/). */
  dir: string;
  /** How long a mutation waits for the helper's result before answering 202. */
  resultWaitMs: number;
  /** Result polling interval while waiting. */
  pollMs: number;
}

export const DEFAULT_ADMIN: Omit<AdminConfig, 'dir'> = { resultWaitMs: 15_000, pollMs: 200 };

/**
 * Sprint 23C: what the Session Host serves under `/admin` (`TBI_ADMIN_MODE`).
 *
 * - `off`: no `/admin` route at all (404, as RC4).
 * - `reports`: the feedback-only release. Owner-only `GET /admin/me` and the report routes; every
 *   other `/admin` path (accounts, requests, sessions, anything unknown) is 404 for everyone, the
 *   owner included, so it is not a 403 oracle. The owner comes from `TBI_OWNER_PRINCIPAL_FILE`
 *   (owner.ts); no spool, no observations, no access view.
 * - `full`: the Sprint 23B administration (the owner from the access view).
 *
 * Unset: exactly the Sprint 23B behaviour, `full` when `TBI_ACCESS_VIEW` (or `TBI_ADMIN_DIR`) is
 * set (the condition under which s23b served `/admin`), `off` otherwise. So an s23b unit, which
 * sets both and no mode, keeps its behaviour.
 */
export type AdminMode = 'off' | 'reports' | 'full';

export interface AdminEnv {
  mode: AdminMode;
  /** `full` only: the helper's directory (spool, results, views, observations), or null. */
  config: AdminConfig | null;
  /** `reports` only: the owner reference file. */
  ownerFile: string | null;
}

/** The admin switches, checked together; an inconsistent combination refuses to start. */
export function adminEnvFromEnv(env: NodeJS.ProcessEnv = process.env): AdminEnv {
  const raw = env.TBI_ADMIN_MODE;
  const mode: AdminMode =
    raw === undefined || raw === ''
      ? env.TBI_ACCESS_VIEW || env.TBI_ADMIN_DIR
        ? 'full'
        : 'off'
      : raw === 'off' || raw === 'reports' || raw === 'full'
        ? raw
        : (() => {
            throw new Error(`TBI_ADMIN_MODE must be off, reports or full, not ${raw}`);
          })();
  const ownerFile = env.TBI_OWNER_PRINCIPAL_FILE || null;
  if (mode !== 'reports' && ownerFile)
    throw new Error('TBI_OWNER_PRINCIPAL_FILE is for TBI_ADMIN_MODE=reports only');
  if (mode !== 'full' && env.TBI_ADMIN_DIR)
    throw new Error(`TBI_ADMIN_DIR is for TBI_ADMIN_MODE=full only (mode ${mode})`);
  if (mode === 'reports') {
    if (!ownerFile) throw new Error('TBI_ADMIN_MODE=reports needs TBI_OWNER_PRINCIPAL_FILE');
    if (!ownerFile.startsWith('/'))
      throw new Error('TBI_OWNER_PRINCIPAL_FILE must be an absolute path');
  }
  if (mode === 'full' && !env.TBI_ACCESS_VIEW)
    throw new Error(
      env.TBI_ADMIN_DIR
        ? 'TBI_ADMIN_DIR needs TBI_ACCESS_VIEW'
        : 'TBI_ADMIN_MODE=full needs TBI_ACCESS_VIEW',
    );
  return { mode, config: mode === 'full' ? adminConfigFromEnv(env) : null, ownerFile };
}

/** From the environment: `TBI_ADMIN_DIR` (absolute), or null (no admin API, no observations). */
export function adminConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AdminConfig | null {
  const dir = env.TBI_ADMIN_DIR;
  if (!dir) return null;
  if (!dir.startsWith('/')) throw new Error('TBI_ADMIN_DIR must be an absolute path');
  return { ...DEFAULT_ADMIN, dir };
}

export class AdminSpool {
  /** Requests this process submitted and has not seen a result for (id -> submitted at). */
  private readonly submitted = new Map<string, number>();

  constructor(
    readonly config: AdminConfig,
    private readonly opts: { now?: () => number; io?: SpoolIo } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Write one request to the spool. Returns its id. */
  async submit(actor: Principal, a: AdminAction): Promise<string> {
    const id = newRequestId(this.now());
    const body = {
      v: 1,
      id,
      at: new Date(this.now()).toISOString(),
      actor,
      action: a.action,
      ...(a.action === 'add' ? { email: a.email } : { target: a.target }),
    };
    const text = `${JSON.stringify(body)}\n`;
    if (Buffer.byteLength(text) > 4096) throw new Error('request too large');
    await writeSpoolFile(join(this.config.dir, 'spool'), id, text, this.opts.io);
    this.submitted.set(id, this.now());
    for (const [k, at] of this.submitted) if (this.now() - at > 3600_000) this.submitted.delete(k);
    return id;
  }

  /** The helper's result, 'pending' while a known request has none yet, or null (unknown). */
  async result(id: string): Promise<AdminResult | 'pending' | null> {
    if (!REQUEST_ID_RE.test(id)) return null;
    let text: string | null;
    try {
      text = await readFile(join(this.config.dir, 'results', `${id}.json`), 'utf8');
    } catch {
      text = null;
    }
    if (text !== null) {
      const r = parseResult(text, id);
      if (r) {
        this.submitted.delete(id);
        return r;
      }
    }
    return this.submitted.has(id) ? 'pending' : null;
  }

  /** Wait (bounded) for the result of a request just submitted. */
  async wait(id: string): Promise<AdminResult | 'pending'> {
    const until = this.now() + this.config.resultWaitMs;
    for (;;) {
      const r = await this.result(id);
      if (r !== null && r !== 'pending') return r;
      if (this.now() >= until) return 'pending';
      await new Promise((ok) => setTimeout(ok, this.config.pollMs));
    }
  }

  async accounts(): Promise<AccountsView | null> {
    try {
      const text = await readFile(join(this.config.dir, 'view', 'accounts.json'), 'utf8');
      return text.length > 1024 * 1024 ? null : parseAccountsView(text);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------- HTTP

/** Largest admin request body (an address or a target). */
export const MAX_ADMIN_BODY_BYTES = 1024;
/** Per-caller limits: every admin call, and the mutations among them. */
export const ADMIN_RATE = { count: 120, windowMs: 60_000 };
export const ADMIN_WRITE_RATE = { count: 20, windowMs: 60_000 };

export interface AdminLimits {
  all: { count: number; windowMs: number };
  write: { count: number; windowMs: number };
}

export interface AdminDeps {
  /** `full` (default): the owner from the access view. `reports`: from the owner reference. */
  mode?: 'reports' | 'full';
  access: AccessView | null;
  owner?: OwnerReference | null;
  limits?: AdminLimits;
  spool: AdminSpool | null;
  reports: ReportStore | null;
  capacity: () => { live: number; max: number };
  rate: MemoryRate;
}

export interface Caller {
  principal: Principal | null;
  emailTag: EmailTag | null;
}

class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
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

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
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

/** A `forbidden` caused by the owner's Google id not being recorded yet says so. */
function withHint(r: AdminResult, access: AccessView | null): AdminResult {
  return r.code === 'forbidden' && access?.current?.owner.principal === null
    ? { ...r, ownerIdentityPending: true }
    : r;
}

const only = (o: Record<string, unknown>, keys: string[]) =>
  Object.keys(o).every((k) => keys.includes(k));

/** `/admin/...` (`parts` without the leading `admin`). Every outcome is answered here. */
export async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  caller: Caller,
  deps: AdminDeps,
): Promise<void> {
  try {
    await route(req, res, url, parts, caller, deps);
  } catch (e) {
    if (e instanceof AdminError) return send(res, e.status, { error: e.code });
    if (e instanceof Refusal) return sendRefusal(res, e);
    // Never the request's data (an address may be in it): the error class only.
    process.stderr.write(`admin: internal error (${(e as Error)?.name ?? 'error'})\n`);
    send(res, 500, { error: 'internal' });
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  caller: Caller,
  deps: AdminDeps,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (!caller.principal && !caller.emailTag) throw new AdminError(401, 'identity_required');
  const [a, b] = parts;
  const n = parts.length;
  if (deps.mode === 'reports') {
    // Sprint 23C: only the owner's own data exists here. Every other path is 404 for every
    // identity, the owner included, decided before anything else (no 403/503 oracle), and no
    // file outside the report store is touched.
    const known =
      (method === 'GET' && a === 'me' && n === 1) ||
      ((method === 'GET' || method === 'DELETE') && a === 'reports' && n <= 2);
    if (!known) throw new AdminError(404, 'not_found');
    const owner = (await deps.owner?.principal()) ?? null;
    if (!owner) throw new AdminError(503, 'owner_unavailable');
    if (caller.principal !== owner) throw new AdminError(403, 'forbidden');
  } else {
    const view = deps.access?.current;
    if (!view) throw new AdminError(503, 'access_view_unavailable');
    if (!isOwner(view, caller.principal, caller.emailTag)) throw new AdminError(403, 'forbidden');
  }
  const who = (caller.principal ?? caller.emailTag)!;
  const r = deps.rate.take(who as Principal, 'admin', deps.limits?.all ?? ADMIN_RATE);
  if (!r.ok) throw new Refusal('rate_limited', r.retryAfterMs);
  const mutating = method !== 'GET' && method !== 'HEAD';
  if (mutating) {
    if (!sameOriginJson(req)) throw new AdminError(403, 'csrf');
    const w = deps.rate.take(
      who as Principal,
      'admin-write',
      deps.limits?.write ?? ADMIN_WRITE_RATE,
    );
    if (!w.ok) throw new Refusal('rate_limited', w.retryAfterMs);
  }

  // GET /admin/me: the UI asks whether to show the administration (the server decides).
  if (method === 'GET' && a === 'me' && n === 1) return send(res, 200, { owner: true });

  if (method === 'GET' && a === 'sessions' && n === 1) return send(res, 200, deps.capacity());

  if (a === 'accounts' || a === 'requests') {
    const spool = deps.spool;
    if (!spool) throw new AdminError(503, 'admin_unavailable');
    if (method === 'GET' && a === 'accounts' && n === 1) {
      const v = await spool.accounts();
      if (!v) throw new AdminError(503, 'accounts_view_unavailable');
      return send(res, 200, v);
    }
    if (method === 'GET' && a === 'requests' && n === 2) {
      if (!REQUEST_ID_RE.test(b!)) throw new AdminError(404, 'not_found');
      const out = await spool.result(b!);
      if (out === null) throw new AdminError(404, 'not_found');
      return out === 'pending'
        ? send(res, 202, { id: b, pending: true })
        : send(res, 200, withHint(out, deps.access));
    }
    if (method === 'POST' && a === 'accounts' && n <= 2) {
      // Mutations name the actor: the gate's principal (the helper checks it against the owner).
      if (!caller.principal) throw new AdminError(401, 'identity_required');
      const body = await readJson(req);
      let action: AdminAction;
      if (n === 1) {
        if (!only(body, ['email'])) throw new AdminError(400, 'invalid');
        const email = normalizeAddEmail(body.email);
        if (!email) throw new AdminError(400, 'invalid_email');
        action = { action: 'add', email };
      } else if (b === 'disable' || b === 'reactivate') {
        if (!only(body, ['target'])) throw new AdminError(400, 'invalid');
        if (typeof body.target !== 'string' || !TARGET_RE.test(body.target))
          throw new AdminError(400, 'invalid_target');
        action = { action: b, target: body.target };
      } else throw new AdminError(404, 'not_found');
      let id: string;
      try {
        id = await spool.submit(caller.principal, action);
      } catch {
        throw new AdminError(503, 'spool_unavailable');
      }
      const out = await spool.wait(id);
      return out === 'pending'
        ? send(res, 202, { id, pending: true, result: `requests/${id}` })
        : send(res, out.ok ? 200 : 409, withHint(out, deps.access));
    }
    throw new AdminError(404, 'not_found');
  }

  if (a === 'reports') {
    const store = deps.reports;
    if (!store) throw new AdminError(503, 'reports_disabled');
    if (method === 'GET' && n === 1) return send(res, 200, { reports: await store.list() });
    if (method === 'GET' && n === 2) {
      const r = await store.get(b!);
      if (!r) throw new AdminError(404, 'not_found');
      return send(res, 200, r);
    }
    if (method === 'DELETE' && n === 2) {
      if (!(await store.delete(b!))) throw new AdminError(404, 'not_found');
      return send(res, 200, { deleted: 1 });
    }
    // DELETE /admin/reports?principal=p_… : every report of one tester.
    if (method === 'DELETE' && n === 1) {
      const p = url.searchParams.get('principal');
      if (!isPrincipal(p) || [...url.searchParams.keys()].length !== 1)
        throw new AdminError(400, 'invalid_principal');
      return send(res, 200, { deleted: await store.deleteByPrincipal(p) });
    }
    throw new AdminError(404, 'not_found');
  }
  throw new AdminError(404, 'not_found');
}
