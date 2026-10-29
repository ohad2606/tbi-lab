/**
 * Sprint 23C: the owner's ACCOUNT administration, served by the dedicated admin service
 * (runtime/admin/main.ts, user tbi-admin; docs/alpha/ADMIN-AND-FEEDBACK.md). Moved here, not
 * rewritten, from the Sprint 23B Session Host (runtime/host/admin.ts), so that the Session Host,
 * the product's largest attack surface, can no longer write a request the root helper accepts as
 * the owner's (D1). This service is the ONLY writer of the helper's spool.
 *
 * The service never changes an account itself. It holds no write access to the gate's allowlist
 * or the tester registry: it writes a REQUEST into the spool and reads the RESULT the root helper
 * writes back. Its only other inputs are the helper's two views (`view/access.json` for
 * authorization and the owner, `view/accounts.json` for the owner's masked list) and the Session
 * Host's health-only socket (live-session counts). None of these files holds an address, except
 * a pending `add` request (the address the owner just typed, 0640 group tbi-admin-spool, deleted
 * by the helper once processed).
 *
 *   <TBI_ADMIN_DIR>/spool/<id>.json          admin service -> helper (atomic: <id>.tmp O_EXCL 0640, fsync, rename)
 *   <TBI_ADMIN_DIR>/results/<id>.json        helper -> admin service
 *   <TBI_ADMIN_DIR>/view/accounts.json       helper -> admin service (masked list)
 *
 * Authorization is decided here on every call, from the gate identity and the access view only:
 * the request must be authorized by the view (deny wins, as in the backends), and the owner is
 * the view's owner principal (or, while none is recorded yet, the owner's email tag). No
 * identity: 401. Any other identity: 403. Mutations also need a JSON content type and a
 * same-origin request (CSRF), and every call is rate limited per caller.
 */
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { decideAccess, isOwner, type AccessView } from '../identity/access.js';
import type { IdentityConfig, Principal } from '../identity/principal.js';
import { runtimeIdentity } from '../host/identity.js';
import { MemoryRate } from '../policy/rate.js';
import { Refusal } from '../policy/refusal.js';
import {
  ADMIN_RATE,
  ADMIN_WRITE_RATE,
  AdminError,
  REQUEST_ID_RE,
  answerErrors,
  isObj,
  newRequestId,
  readJson,
  sameOriginJson,
  send,
  writeSpoolFile,
  type AdminLimits,
  type Caller,
  type SpoolIo,
} from './common.js';

// ---------------------------------------------------------------- views and results

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
  /** The helper's base directory (spool/, results/, view/). */
  dir: string;
  /** How long a mutation waits for the helper's result before answering 202. */
  resultWaitMs: number;
  /** Result polling interval while waiting. */
  pollMs: number;
}

export const DEFAULT_ADMIN: Omit<AdminConfig, 'dir'> = { resultWaitMs: 15_000, pollMs: 200 };

/** From the environment: `TBI_ADMIN_DIR` (absolute), or null. */
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

// ---------------------------------------------------------------- HTTP (the admin service)

export interface AccountsDeps {
  access: AccessView;
  spool: AdminSpool | null;
  /** Live sessions vs the ceiling, from the Session Host's health-only socket; null: unknown. */
  capacity: () => Promise<{ live: number; max: number } | null>;
  rate?: MemoryRate;
  limits?: AdminLimits;
}

/** A `forbidden` caused by the owner's Google id not being recorded yet says so. */
function withHint(r: AdminResult, access: AccessView): AdminResult {
  return r.code === 'forbidden' && access.current?.owner.principal === null
    ? { ...r, ownerIdentityPending: true }
    : r;
}

const only = (o: Record<string, unknown>, keys: string[]) =>
  Object.keys(o).every((k) => keys.includes(k));

/**
 * The admin service's HTTP server. Behind the gate at `/admin-api/*` (prefix stripped), so it
 * sees `/accounts`, `/accounts/disable`, `/accounts/reactivate`, `/requests/<id>`, `/sessions`,
 * and `GET /health` (no identity: `{"service":"tbi-admin","runtime":{"version","commit"}}`).
 * Every request needs the gate identity and an account the access view authorizes (deny wins;
 * the same rule as the backends), then the owner (the view's owner principal, or its email tag
 * while none is recorded); mutations need the CSRF rule; every caller is rate limited, before the
 * owner check (a non-owner hammering the service is limited too).
 */
export function createAdminServer(identity: IdentityConfig, deps: AccountsDeps): Server {
  const rate = deps.rate ?? new MemoryRate();
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://admin.invalid');
    // Liveness and the build identity (version and commit when stamped); no identity read, no
    // account data. Every other route needs the owner.
    if (req.method === 'GET' && url.pathname === '/health')
      return send(res, 200, {
        service: 'tbi-admin',
        ...(runtimeIdentity() ? { runtime: runtimeIdentity() } : {}),
      });
    void answerErrors(res, 'admin service', () =>
      routeAccounts(req, res, url.pathname.split('/').filter(Boolean), identity, deps, rate),
    );
  });
}

async function routeAccounts(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  identity: IdentityConfig,
  deps: AccountsDeps,
  rate: MemoryRate,
): Promise<void> {
  const method = req.method ?? 'GET';
  const decision = decideAccess(req, identity, deps.access);
  if (!decision.ok)
    throw new AdminError(
      decision.status,
      decision.status === 401 ? 'identity_required' : decision.error,
    );
  const caller: Caller = { principal: decision.principal, emailTag: decision.emailTag };
  const who = (caller.principal ?? caller.emailTag)! as Principal;
  const r = rate.take(who, 'admin', deps.limits?.all ?? ADMIN_RATE);
  if (!r.ok) throw new Refusal('rate_limited', r.retryAfterMs);
  if (!isOwner(decision.view!, caller.principal, caller.emailTag))
    throw new AdminError(403, 'forbidden');
  const mutating = method !== 'GET' && method !== 'HEAD';
  if (mutating) {
    if (!sameOriginJson(req)) throw new AdminError(403, 'csrf');
    const w = rate.take(who, 'admin-write', deps.limits?.write ?? ADMIN_WRITE_RATE);
    if (!w.ok) throw new Refusal('rate_limited', w.retryAfterMs);
  }
  const [a, b] = parts;
  const n = parts.length;

  if (method === 'GET' && a === 'sessions' && n === 1) {
    const c = await deps.capacity();
    if (!c) throw new AdminError(503, 'capacity_unavailable');
    return send(res, 200, c);
  }
  if (a !== 'accounts' && a !== 'requests') throw new AdminError(404, 'not_found');
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
