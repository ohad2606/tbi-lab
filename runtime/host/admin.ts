/**
 * The owner's routes in the Session Host (docs/alpha/ADMIN-AND-FEEDBACK.md), and the identity
 * observations the privileged helper reconciles.
 *
 * Sprint 23C (D1): the Session Host no longer administers accounts. Account administration (the
 * list, add, disable, reactivate, request status, capacity) moved to the dedicated admin service
 * (runtime/admin/accounts.ts, user tbi-admin), the only writer of the helper's spool; the Session
 * Host has no write access to it and no code that writes it. What stays here, under `/admin`:
 *
 *   GET    /admin/me                       {"owner":true} for the owner (the UI shows the entry)
 *   GET    /admin/reports[/<id>]           the feedback reports (its own data, reports.ts)
 *   DELETE /admin/reports/<id>             one report
 *   DELETE /admin/reports?principal=p_…    every report of one tester
 *
 * Every other `/admin` path or method is 404 for every identity, the owner included, decided
 * first (no 403 or 503 oracle). `TBI_ADMIN_MODE` (AdminMode below) decides who the owner is:
 * `reports` (the feedback-only release) from a root-provided owner reference (owner.ts), `full`
 * from the access view. In `full` mode the host also writes identity observations
 * (`<TBI_ADMIN_DIR>/observations`, group tbi-admin-observe); in `reports` mode nothing outside
 * the report store. No identity: 401. Any other identity: 403. Deletions need a JSON content type
 * and a same-origin request (CSRF), and every call is rate limited per caller.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  ADMIN_RATE,
  ADMIN_WRITE_RATE,
  AdminError,
  answerErrors,
  newRequestId,
  sameOriginJson,
  send,
  writeSpoolFile,
  type AdminLimits,
  type Caller,
  type SpoolIo,
} from '../admin/common.js';
import { isOwner, type AccessView } from '../identity/access.js';
import { isPrincipal, type Principal } from '../identity/principal.js';
import { MemoryRate } from '../policy/rate.js';
import { Refusal } from '../policy/refusal.js';
import type { OwnerReference } from './owner.js';
import type { ReportStore } from './reports.js';

export type { AdminLimits, Caller } from '../admin/common.js';

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

// ---------------------------------------------------------------- mode

/**
 * Sprint 23C: what the Session Host serves under `/admin` (`TBI_ADMIN_MODE`).
 *
 * - `off`: no `/admin` route at all (404, as RC4).
 * - `reports`: the feedback-only release. The owner from `TBI_OWNER_PRINCIPAL_FILE` (owner.ts);
 *   no observations, no access view needed.
 * - `full`: the owner from the access view; identity observations in `TBI_ADMIN_DIR`.
 *
 * Both serve the same routes (`/admin/me` and the reports). Unset: the Sprint 23B rule, `full`
 * when `TBI_ACCESS_VIEW` (or `TBI_ADMIN_DIR`) is set, `off` otherwise.
 */
export type AdminMode = 'off' | 'reports' | 'full';

export interface AdminEnv {
  mode: AdminMode;
  /**
   * `full` only: where the host writes identity observations, or null (none). From
   * `TBI_OBSERVATIONS_DIR` (Sprint 23C), or the s23b `TBI_ADMIN_DIR` + `/observations`.
   */
  observationsDir: string | null;
  /** `reports` only: the owner reference file. */
  ownerFile: string | null;
}

/** The admin switches, checked together; an inconsistent combination refuses to start. */
export function adminEnvFromEnv(env: NodeJS.ProcessEnv = process.env): AdminEnv {
  const raw = env.TBI_ADMIN_MODE;
  const obs = env.TBI_OBSERVATIONS_DIR || null;
  const legacy = env.TBI_ADMIN_DIR || null;
  const mode: AdminMode =
    raw === undefined || raw === ''
      ? env.TBI_ACCESS_VIEW || legacy || obs
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
  // Observations are a full-mode feature: the feedback-only mode writes nothing outside reports.
  for (const [name, v] of [
    ['TBI_ADMIN_DIR', legacy],
    ['TBI_OBSERVATIONS_DIR', obs],
  ] as const) {
    if (v && mode !== 'full')
      throw new Error(`${name} is for TBI_ADMIN_MODE=full only (mode ${mode})`);
    if (v && !v.startsWith('/')) throw new Error(`${name} must be an absolute path`);
  }
  if (legacy && obs) throw new Error('set TBI_OBSERVATIONS_DIR or TBI_ADMIN_DIR, not both');
  if (mode === 'reports') {
    if (!ownerFile) throw new Error('TBI_ADMIN_MODE=reports needs TBI_OWNER_PRINCIPAL_FILE');
    if (!ownerFile.startsWith('/'))
      throw new Error('TBI_OWNER_PRINCIPAL_FILE must be an absolute path');
  }
  if (mode === 'full' && !env.TBI_ACCESS_VIEW)
    throw new Error(
      legacy || obs
        ? `${legacy ? 'TBI_ADMIN_DIR' : 'TBI_OBSERVATIONS_DIR'} needs TBI_ACCESS_VIEW`
        : 'TBI_ADMIN_MODE=full needs TBI_ACCESS_VIEW',
    );
  return {
    mode,
    observationsDir: obs ?? (legacy ? join(legacy, 'observations') : null),
    ownerFile,
  };
}

// ---------------------------------------------------------------- HTTP

export interface AdminDeps {
  /** `full` (default): the owner from the access view. `reports`: from the owner reference. */
  mode?: 'reports' | 'full';
  access: AccessView | null;
  owner?: OwnerReference | null;
  limits?: AdminLimits;
  reports: ReportStore | null;
  rate: MemoryRate;
}

/** `/admin/...` (`parts` without the leading `admin`). Every outcome is answered here. */
export function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  caller: Caller,
  deps: AdminDeps,
): Promise<void> {
  return answerErrors(res, 'admin', () => route(req, res, url, parts, caller, deps));
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
  // Only the owner's own data exists here. Every other path is 404 for every identity, the owner
  // included, decided before anything else (no 403/503 oracle). Sprint 23C: in every mode, the
  // account, request and sessions paths are among them (the admin service serves those).
  const known =
    (method === 'GET' && a === 'me' && n === 1) ||
    ((method === 'GET' || method === 'DELETE') && a === 'reports' && n <= 2);
  if (!known) throw new AdminError(404, 'not_found');
  if (deps.mode === 'reports') {
    const owner = (await deps.owner?.principal()) ?? null;
    if (!owner) throw new AdminError(503, 'owner_unavailable');
    if (caller.principal !== owner) throw new AdminError(403, 'forbidden');
  } else {
    const view = deps.access?.current;
    if (!view) throw new AdminError(503, 'access_view_unavailable');
    if (!isOwner(view, caller.principal, caller.emailTag)) throw new AdminError(403, 'forbidden');
  }
  const who = (caller.principal ?? caller.emailTag)! as Principal;
  const r = deps.rate.take(who, 'admin', deps.limits?.all ?? ADMIN_RATE);
  if (!r.ok) throw new Refusal('rate_limited', r.retryAfterMs);
  if (method === 'DELETE') {
    if (!sameOriginJson(req)) throw new AdminError(403, 'csrf');
    const w = deps.rate.take(who, 'admin-write', deps.limits?.write ?? ADMIN_WRITE_RATE);
    if (!w.ok) throw new Refusal('rate_limited', w.retryAfterMs);
  }

  // GET /admin/me: the UI asks whether to show the administration (the server decides).
  if (a === 'me') return send(res, 200, { owner: true });

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
