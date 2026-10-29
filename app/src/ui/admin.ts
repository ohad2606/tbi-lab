/**
 * Sprint 23B: the owner's administration, the client side without the DOM (unit-tested). The
 * servers decide who the owner is on every call; this module only talks to them and turns their
 * answers into what the dialog shows. Nothing about testers is compiled in: every list comes from
 * the authenticated API, addresses masked by the server.
 *
 * Sprint 23C: two servers. The owner check and the feedback reports are the Session Host's
 * (`/runtime/admin/me`, `/runtime/admin/reports…`, runtime/host/admin.ts); the account
 * administration (accounts, add, disable, reactivate, request status, capacity) is the dedicated
 * admin service's (`/admin-api/…`, runtime/admin/accounts.ts), called only in the full mode.
 */

/** The Session Host's owner routes: the owner check and the reports. */
export const ADMIN_BASE = '/runtime/admin';
/** The admin service: account administration only. */
export const ACCOUNTS_BASE = '/admin-api';

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

export interface AdminWarning {
  kind: string;
  target: string | null;
  first: string | null;
  last: string | null;
  count: number | null;
}

export interface AccountsView {
  generated: string | null;
  cap: number;
  authorizedTesters: number;
  owner: number;
  accounts: AccountRow[];
  warnings: AdminWarning[];
}

export interface Capacity {
  live: number;
  max: number;
}

export interface ReportMeta {
  id: string;
  receivedAt: string;
  readable: boolean;
  kind: string | null;
  category: string | null;
  blocking: boolean | null;
  component: boolean;
  principal: string | null;
  release: string | null;
  app: string | null;
  session: string | null;
  length: number;
  locale: string | null;
}

/** A stored report as the owner reads it (fields the dialog shows; the rest is ignored). */
export interface ReportDetail {
  id: string;
  receivedAt: string;
  principal: string;
  kind?: string;
  category: string;
  blocking: boolean;
  description: string;
  component?: string | null;
  locale: string;
  view: string;
  release: { version: string } | null;
  app: { version: string } | null;
  browser: { family: string; major: number | null; os: string };
  context?: { runtime?: string; device?: string; projectId?: string } | null;
}

export type LoadError = 'signed_out' | 'forbidden' | 'unavailable' | 'rate_limited' | 'network';

export type Loaded<T> = { ok: true; value: T } | { ok: false; error: LoadError };

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

/** What one add / disable / reactivate ended with, for the message the owner reads. */
export type MutationOutcome =
  | { kind: 'result'; ok: boolean; code: ResultCode; masked: string | null; ownerPending: boolean }
  | { kind: 'pending'; id: string }
  | { kind: 'refused'; error: 'invalid_email' | 'invalid' | LoadError | 'csrf' };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function loadError(status: number | null): LoadError {
  if (status === 401) return 'signed_out';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'unavailable';
  return 'network';
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Paths of the account administration (the admin service); every other one is the host's. */
const ACCOUNT_PATH = /^\/(accounts|requests|sessions)(\/|$)/;

async function request(
  fetchFn: Fetch,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number | null; body: unknown }> {
  try {
    const base = ACCOUNT_PATH.test(path) ? ACCOUNTS_BASE : ADMIN_BASE;
    const res = await fetchFn(`${base}${path}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...init,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // not JSON (e.g. a proxy page)
    }
    return { status: res.status, body };
  } catch {
    return { status: null, body: null };
  }
}

/** A mutation: JSON, same origin (the server refuses anything else as CSRF). */
const mutating = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function load<T>(
  fetchFn: Fetch,
  path: string,
  accept: (b: unknown) => T | null,
): Promise<Loaded<T>> {
  const r = await request(fetchFn, path);
  if (r.status !== 200) return { ok: false, error: loadError(r.status) };
  const v = accept(r.body);
  return v === null ? { ok: false, error: 'network' } : { ok: true, value: v };
}

/** Whether the server recognises this account as the owner (the only way the entry appears). */
export async function isOwner(fetchFn: Fetch): Promise<boolean> {
  const r = await request(fetchFn, '/me');
  return r.status === 200 && isObj(r.body) && r.body.owner === true;
}

export const loadAccounts = (fetchFn: Fetch) =>
  load<AccountsView>(fetchFn, '/accounts', (b) =>
    isObj(b) && Array.isArray(b.accounts) && typeof b.cap === 'number'
      ? ({ warnings: [], ...b } as unknown as AccountsView)
      : null,
  );

export const loadCapacity = (fetchFn: Fetch) =>
  load<Capacity>(fetchFn, '/sessions', (b) =>
    isObj(b) && typeof b.live === 'number' && typeof b.max === 'number'
      ? { live: b.live, max: b.max }
      : null,
  );

export const loadReports = (fetchFn: Fetch) =>
  load<ReportMeta[]>(fetchFn, '/reports', (b) =>
    isObj(b) && Array.isArray(b.reports) ? (b.reports as ReportMeta[]) : null,
  );

const REPORT_ID = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
export const loadReport = (fetchFn: Fetch, id: string): Promise<Loaded<ReportDetail>> =>
  REPORT_ID.test(id)
    ? load<ReportDetail>(fetchFn, `/reports/${id}`, (b) =>
        isObj(b) && b.id === id && typeof b.description === 'string'
          ? (b as unknown as ReportDetail)
          : null,
      )
    : Promise.resolve({ ok: false, error: 'network' });

/** The answer of a mutation (200 / 409 with a result, 202 pending, or a refusal). */
export function interpretMutation(status: number | null, body: unknown): MutationOutcome {
  if (status === 202 && isObj(body) && typeof body.id === 'string')
    return { kind: 'pending', id: body.id };
  if (
    (status === 200 || status === 409) &&
    isObj(body) &&
    typeof body.ok === 'boolean' &&
    (RESULT_CODES as readonly unknown[]).includes(body.code)
  )
    return {
      kind: 'result',
      ok: body.ok,
      code: body.code as ResultCode,
      masked: typeof body.masked === 'string' ? body.masked : null,
      ownerPending: body.ownerIdentityPending === true,
    };
  const error = isObj(body) ? body.error : null;
  if (status === 400)
    return { kind: 'refused', error: error === 'invalid_email' ? 'invalid_email' : 'invalid' };
  if (status === 403 && error === 'csrf') return { kind: 'refused', error: 'csrf' };
  return { kind: 'refused', error: loadError(status) };
}

export async function addTester(fetchFn: Fetch, email: string): Promise<MutationOutcome> {
  const r = await request(fetchFn, '/accounts', mutating('POST', { email: email.trim() }));
  return interpretMutation(r.status, r.body);
}

export async function setAccess(
  fetchFn: Fetch,
  action: 'disable' | 'reactivate',
  target: string,
): Promise<MutationOutcome> {
  const r = await request(fetchFn, `/accounts/${action}`, mutating('POST', { target }));
  return interpretMutation(r.status, r.body);
}

/** A request the server took but the helper has not answered yet: ask again. */
export async function requestResult(fetchFn: Fetch, id: string): Promise<MutationOutcome> {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return { kind: 'refused', error: 'invalid' };
  const r = await request(fetchFn, `/requests/${id}`);
  return interpretMutation(r.status, r.body);
}

export async function deleteReport(fetchFn: Fetch, id: string): Promise<boolean> {
  if (!REPORT_ID.test(id)) return false;
  return (await request(fetchFn, `/reports/${id}`, mutating('DELETE'))).status === 200;
}

export async function deleteTesterReports(
  fetchFn: Fetch,
  principal: string,
): Promise<number | null> {
  if (!/^p_[A-Za-z0-9_-]{26}$/.test(principal)) return null;
  const r = await request(
    fetchFn,
    `/reports?principal=${encodeURIComponent(principal)}`,
    mutating('DELETE'),
  );
  return r.status === 200 && isObj(r.body) && typeof r.body.deleted === 'number'
    ? r.body.deleted
    : null;
}

/** The address the owner just typed, masked like the server's list (`ab***@domain`). */
export function maskAddress(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${e.slice(0, Math.min(2, at))}***${e.slice(at)}`;
}

/** A short, stable, non-identifying tester label from a report's opaque principal. */
export const testerLabel = (principal: string | null): string =>
  principal ? `${principal.slice(0, 8)}…` : '—';

/** Testers that count against the cap: authorized testers (the owner is excluded). */
export const capText = (v: AccountsView) => ({ n: v.authorizedTesters, cap: v.cap });

/** A client-side check before sending (the server validates again, strictly). */
export const plausibleAddress = (v: string): boolean =>
  /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) && v.trim().length <= 254;
