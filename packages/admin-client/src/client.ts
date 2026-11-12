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
 *
 * Phase C (owner 2026-11-04): a private display name per record (add, rename), and the gate's
 * sign-in data (first, last, how many). Names come only from the owner-only API at run time.
 *
 * Admin app design §3: moved from app/src/ui/admin.ts to this shared package, unchanged in
 * behaviour, for the Lab's in-app administration and the TBI Lab Admin app (admin-lab), which reach
 * the same two servers by the same relative paths. Every request asks for JSON (`Accept:
 * application/json`), so an expired gate session answers 401 instead of starting a login. New:
 * the admin service's read-only usage history and audit view (`/usage`, `/audit`).
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
  /** Phase C: the owner's private display name, or null. */
  displayName: string | null;
  /** Phase C: completed Google sign-ins at the gate. */
  firstSignIn: string | null;
  lastSignIn: string | null;
  signIns: number;
  /** The Session Host's hourly observation (any authorized request), or null. */
  lastSeen: string | null;
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
  | { kind: 'refused'; error: 'invalid_email' | 'invalid_name' | 'invalid' | LoadError | 'csrf' };

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
const ACCOUNT_PATH = /^\/(accounts|requests|sessions|usage|audit)(\/|$|\?)/;

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
      // The gate answers 401 (not a login redirect) to a request that accepts JSON.
      headers: { accept: 'application/json', ...(init.headers as Record<string, string>) },
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
      ? ({
          warnings: [],
          ...b,
          accounts: (b.accounts as Record<string, unknown>[]).map((a) => ({
            displayName: null,
            firstSignIn: null,
            lastSignIn: null,
            signIns: 0,
            lastSeen: null,
            ...a,
          })),
        } as unknown as AccountsView)
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
    return {
      kind: 'refused',
      error: error === 'invalid_email' || error === 'invalid_name' ? error : 'invalid',
    };
  if (status === 403 && error === 'csrf') return { kind: 'refused', error: 'csrf' };
  return { kind: 'refused', error: loadError(status) };
}

export async function addTester(
  fetchFn: Fetch,
  email: string,
  name = '',
): Promise<MutationOutcome> {
  const n = name.trim();
  const r = await request(
    fetchFn,
    '/accounts',
    mutating('POST', { email: email.trim(), ...(n ? { name: n } : {}) }),
  );
  return interpretMutation(r.status, r.body);
}

/** Phase C: give a record a (new) display name. */
export async function renameTester(
  fetchFn: Fetch,
  target: string,
  name: string,
): Promise<MutationOutcome> {
  const r = await request(fetchFn, '/accounts/rename', mutating('POST', { target, name }));
  return interpretMutation(r.status, r.body);
}

/** Longest display name (the server's rule, runtime/admin/accounts.ts). */
export const DISPLAY_NAME_MAX = 60;

/**
 * Category L/M code points that render as nothing: Hangul fillers, the combining grapheme joiner,
 * Mongolian free variation selectors and vowel separator, Khmer inherent vowels, variation
 * selectors. The same set as the helper's.
 */
const INVISIBLE_NAME_POINTS = new Set([
  0x115f, 0x1160, 0x3164, 0xffa0, 0x034f, 0x180b, 0x180c, 0x180d, 0x180e, 0x180f, 0x17b4, 0x17b5,
]);
const invisibleNameChar = (s: string) =>
  [...s].some((ch) => {
    const cp = ch.codePointAt(0)!;
    return (
      INVISIBLE_NAME_POINTS.has(cp) ||
      (cp >= 0xfe00 && cp <= 0xfe0f) ||
      (cp >= 0xe0100 && cp <= 0xe01ef)
    );
  });

/**
 * The server's display-name rule, for immediate feedback only (the admin service and the helper
 * validate again): NFC, trimmed, single spaces, 1-60 letters (with their marks), spaces and . ' -,
 * starting with a letter. Returns the normalized name, or null.
 */
export function normalizeDisplayName(v: string): string | null {
  if (v.length > 4 * DISPLAY_NAME_MAX) return null;
  const s = v.normalize('NFC').replace(/ +/g, ' ').replace(/^ | $/g, '');
  const n = [...s].length;
  if (n < 1 || n > DISPLAY_NAME_MAX) return null;
  // Letters and marks that render as nothing (blank or look-alike names; review R6), as the helper's rule.
  if (invisibleNameChar(s)) return null;
  return /^\p{L}[\p{L}\p{M} .'-]*$/u.test(s) ? s : null;
}

/** The time zone every administration date is shown in. */
export const ADMIN_TIME_ZONE = 'Asia/Jerusalem';

/** A date (and time) in Israel time, in the UI language; null when absent or unparseable. */
export function israelTime(iso: string | null, locale: string, withTime = true): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat(locale, {
    timeZone: ADMIN_TIME_ZONE,
    ...(withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }),
  }).format(ms);
}

export type AccountFilter = 'active' | 'disabled' | 'all';

/** The list the owner sees: the owner first, then by name (or masked address), per filter. */
export function visibleAccounts(v: AccountsView, filter: AccountFilter): AccountRow[] {
  const keep = (a: AccountRow) =>
    filter === 'all' || (filter === 'active' ? a.status !== 'revoked' : a.status === 'revoked');
  const label = (a: AccountRow) => (a.displayName ?? a.masked).toLocaleLowerCase();
  return v.accounts
    .filter(keep)
    .sort((a, b) =>
      a.class !== b.class ? (a.class === 'owner' ? -1 : 1) : label(a).localeCompare(label(b)),
    );
}

export const accountCounts = (v: AccountsView) => ({
  active: v.accounts.filter((a) => a.status !== 'revoked').length,
  disabled: v.accounts.filter((a) => a.status === 'revoked').length,
  all: v.accounts.length,
});

/** No tester place left (authorized testers only; the owner is not counted). */
export const capFull = (v: AccountsView) => v.authorizedTesters >= v.cap;

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

// ---------------------------------------------------------------- usage history and audit (admin app)

/** Per tester and day (Israel days), as the usage exporter counts them (tester-usage.py's rules). */
export const USAGE_METRICS = [
  'signIns',
  'builds',
  'prebuilt',
  'runs',
  'simSeconds',
  'refusals',
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];
export type UsageMetrics = Record<UsageMetric, number>;

/** The usage key of activity that maps to no account (shown as "unknown"). */
export const UNMATCHED = 'unmatched';

export interface UsageDay {
  date: string;
  /** Keyed by the account's target (`t_…`, as in the accounts list) or UNMATCHED. */
  accounts: Record<string, UsageMetrics>;
}

export interface UsageView {
  generated: string;
  tz: string;
  from: string;
  to: string;
  /** Only days with activity, ascending. */
  days: UsageDay[];
  lastActivity: Record<string, string>;
}

export const AUDIT_ACTIONS = [
  'add',
  'disable',
  'reactivate',
  'rename',
  'refused',
  'record_identity',
  'identity_mismatch',
  'unknown_identity',
  'sign_ins',
  'prune_backups',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  at: string;
  action: AuditAction;
  target: string | null;
  result: string;
  corr: string | null;
  count?: number;
}

export interface AuditView {
  generated: string;
  /** Newest first. */
  entries: AuditEntry[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The usage history between two Israel days (inclusive; the server's default: the last 30). */
export function loadUsage(
  fetchFn: Fetch,
  range: { from?: string; to?: string } = {},
): Promise<Loaded<UsageView>> {
  const q = new URLSearchParams();
  if (range.from && DAY.test(range.from)) q.set('from', range.from);
  if (range.to && DAY.test(range.to)) q.set('to', range.to);
  const query = q.toString();
  return load<UsageView>(fetchFn, `/usage${query ? `?${query}` : ''}`, (b) =>
    isObj(b) &&
    Array.isArray(b.days) &&
    typeof b.from === 'string' &&
    typeof b.to === 'string' &&
    isObj(b.lastActivity)
      ? (b as unknown as UsageView)
      : null,
  );
}

/** The latest administration changes, newest first (at most 500). */
export function loadAudit(fetchFn: Fetch, limit = 100): Promise<Loaded<AuditView>> {
  const n = Number.isSafeInteger(limit) ? Math.min(500, Math.max(1, limit)) : 100;
  return load<AuditView>(fetchFn, `/audit?limit=${n}`, (b) =>
    isObj(b) && Array.isArray(b.entries) ? (b as unknown as AuditView) : null,
  );
}
