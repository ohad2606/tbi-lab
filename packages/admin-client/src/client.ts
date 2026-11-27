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
const ACCOUNT_PATH = /^\/(accounts|requests|sessions|usage|audit|signups)(\/|$|\?)/;

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

// ---------------------------------------------------------------- sign-up requests (TBI-022)

/** One sign-up request as the admin service answers it (design §6.1). */
export interface SignupRecord {
  id: string;
  name: string;
  email: string;
  role: string;
  lang: string;
  status: string;
  accountAdded: boolean;
  emailAttempts: number;
  lastError: string | null;
  /** While `email_queued`: when the email may go out (quiet hours end); else null. */
  emailSendAfter: string | null;
  /** When the automatic approver approved this request (BETA-G1); null when a person did or it is undecided. */
  autoApprovedAt: string | null;
  /** BETA-G1: how the person heard about us (free text, <= 80 chars, shown as plain text only); null when absent. */
  heardFrom: string | null;
  /** BETA-G1: 'web' when the request came from the public web form; null otherwise. */
  origin: 'web' | null;
  createdAt: string;
}

export const SIGNUP_ACTIONS = ['approve', 'reject', 'resend'] as const;
export type SignupAction = (typeof SIGNUP_ACTIONS)[number];

export const SIGNUP_ERRORS = [
  'bad_state',
  'email_failed_use_resend',
  'cap_reached',
  'account_error',
  'email_failed',
  'not_found',
  'mail_cap',
] as const;
export type SignupError = (typeof SIGNUP_ERRORS)[number];

/** What one approve / reject / resend ended with. */
export type SignupOutcome =
  | {
      kind: 'done';
      record: SignupRecord | null;
      note: 'already_done' | 'email_not_resent' | 'email_queued' | null;
    }
  | { kind: 'account_pending' }
  | { kind: 'error'; error: SignupError; record: SignupRecord | null }
  | { kind: 'refused'; error: LoadError | 'csrf' };

const SIGNUP_ID = /^[A-Za-z0-9_-]{1,64}$/;

function signupRecord(v: unknown): SignupRecord | null {
  if (!isObj(v) || typeof v.id !== 'string' || !SIGNUP_ID.test(v.id)) return null;
  const str = (x: unknown) => (typeof x === 'string' ? x : '');
  return {
    id: v.id,
    name: str(v.name),
    email: str(v.email),
    role: str(v.role),
    lang: str(v.lang),
    status: str(v.status),
    accountAdded: v.accountAdded === true,
    emailAttempts: typeof v.emailAttempts === 'number' ? v.emailAttempts : 0,
    lastError: typeof v.lastError === 'string' ? v.lastError : null,
    emailSendAfter: typeof v.emailSendAfter === 'string' ? v.emailSendAfter : null,
    autoApprovedAt:
      typeof v.autoApprovedAt === 'string' && v.autoApprovedAt !== '' ? v.autoApprovedAt : null,
    heardFrom:
      typeof v.heardFrom === 'string' &&
      v.heardFrom.trim() !== '' &&
      [...v.heardFrom.trim()].length <= 80
        ? v.heardFrom.trim()
        : null,
    origin: v.origin === 'web' ? 'web' : null,
    createdAt: str(v.createdAt),
  };
}

/**
 * The open requests (pending, approved, email queued or failed: everything that still needs the
 * owner), oldest first. 404 (the feature is off on the server) is "unavailable".
 */
export const loadOpenSignups = (fetchFn: Fetch) => loadSignups(fetchFn, '/signups/open');

/**
 * K12: every request the store still holds, any status, oldest first (the same parsing). Personal
 * data: the caller keeps it in memory only (the request itself is `cache: 'no-store'`).
 */
export const loadAllSignups = (fetchFn: Fetch) => loadSignups(fetchFn, '/signups');

async function loadSignups(fetchFn: Fetch, path: string): Promise<Loaded<SignupRecord[]>> {
  const r = await request(fetchFn, path);
  if (r.status === 404) return { ok: false, error: 'unavailable' };
  if (r.status !== 200) return { ok: false, error: loadError(r.status) };
  if (!isObj(r.body) || !Array.isArray(r.body.signups)) return { ok: false, error: 'network' };
  const rows = (r.body.signups as unknown[])
    .map(signupRecord)
    .filter((x): x is SignupRecord => x !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { ok: true, value: rows };
}

/** A read-only status value: the real value, or the explicit "unknown" (never a guessed number). */
export type Known<T> = T | 'unknown';

/** The auto-approve status route (BETA-G1 slice 5, design section 9), every field validated. */
export interface AutoApproveStatus {
  enabled: Known<boolean>;
  running: Known<boolean>;
  paused: Known<boolean>;
  capReached: Known<boolean>;
  count: Known<number>;
  dailyCap: Known<number>;
  waitingBacklog: Known<number>;
  stateDir: 'ok' | 'unsafe' | 'unknown';
  /** A fixed code such as `ancestor_mode`; null when absent or not shaped like a code. */
  stateDirReason: string | null;
}

const bool = (v: unknown): Known<boolean> => (typeof v === 'boolean' ? v : 'unknown');
const count = (v: unknown): Known<number> =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 'unknown';

/** Parse the route's answer. Anything missing or malformed becomes "unknown", never 0 or false. */
export function parseAutoApproveStatus(body: unknown): AutoApproveStatus | null {
  if (!isObj(body)) return null;
  const reason = body.stateDirReason;
  return {
    enabled: bool(body.enabled),
    running: bool(body.running),
    paused: bool(body.paused),
    capReached: bool(body.capReached),
    count: count(body.count),
    dailyCap: count(body.dailyCap),
    waitingBacklog: count(body.waitingBacklog),
    stateDir: body.stateDir === 'ok' || body.stateDir === 'unsafe' ? body.stateDir : 'unknown',
    stateDirReason:
      typeof reason === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(reason) ? reason : null,
  };
}

/** Read-only status of the automatic approver. 404 (feature off on the server) is "unavailable". */
export async function loadAutoApproveStatus(fetchFn: Fetch): Promise<Loaded<AutoApproveStatus>> {
  const r = await request(fetchFn, '/signups/auto-approve');
  if (r.status === 404) return { ok: false, error: 'unavailable' };
  if (r.status !== 200) return { ok: false, error: loadError(r.status) };
  const v = parseAutoApproveStatus(r.body);
  return v ? { ok: true, value: v } : { ok: false, error: 'network' };
}

/** The answer of a sign-up mutation, by the status codes of design §6.1. */
export function interpretSignup(status: number | null, body: unknown): SignupOutcome {
  const b = isObj(body) ? body : {};
  if (status === 200)
    return {
      kind: 'done',
      record: signupRecord(b.record),
      note:
        b.note === 'already_done' || b.note === 'email_not_resent' || b.note === 'email_queued'
          ? b.note
          : null,
    };
  if (status === 202 && b.error === 'account_pending') return { kind: 'account_pending' };
  if (status === 403 && b.error === 'csrf') return { kind: 'refused', error: 'csrf' };
  if (status === 404 || status === 409 || status === 502) {
    const code = status === 404 ? 'not_found' : b.error;
    if ((SIGNUP_ERRORS as readonly unknown[]).includes(code))
      return { kind: 'error', error: code as SignupError, record: signupRecord(b.record) };
  }
  return { kind: 'refused', error: loadError(status) };
}

export async function signupAction(
  fetchFn: Fetch,
  id: string,
  action: SignupAction,
): Promise<SignupOutcome> {
  if (!SIGNUP_ID.test(id) || !SIGNUP_ACTIONS.includes(action))
    return { kind: 'refused', error: 'network' };
  const r = await request(fetchFn, `/signups/${id}/${action}`, mutating('POST', {}));
  return interpretSignup(r.status, r.body);
}

// ---------------------------------------------------------------- delete one request (K12)

/** The server's request id (runtime/admin/common.ts REQUEST_ID_RE). */
const DELETE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** What one delete ended with. `network`: no readable answer, so it may or may not have happened. */
export type DeleteSignupOutcome =
  | { kind: 'deleted' | 'already_deleted' | 'not_found' }
  | { kind: 'rate_limited'; retryAfterS: number | null }
  | {
      kind: 'failed';
      error:
        'csrf' | 'forbidden' | 'signed_out' | 'unavailable' | 'server' | 'network' | 'invalid_id';
    };

/** Delete one stored request now. The account, if one was added, is not touched. */
export async function deleteSignup(fetchFn: Fetch, id: string): Promise<DeleteSignupOutcome> {
  if (!DELETE_ID.test(id)) return { kind: 'failed', error: 'invalid_id' };
  const r = await request(fetchFn, `/signups/${id}`, mutating('DELETE'));
  const b = isObj(r.body) ? r.body : {};
  if (r.status === 200 && b.deleted === true)
    return { kind: b.note === 'already_deleted' ? 'already_deleted' : 'deleted' };
  // Only the service's own `not_found` means "no such request"; any other 404 (a proxy page, a
  // missing route) deleted nothing and proves nothing.
  if (r.status === 404)
    return b.error === 'not_found'
      ? { kind: 'not_found' }
      : { kind: 'failed', error: 'unavailable' };
  if (r.status === 429) {
    const s = b.retryAfterS;
    return {
      kind: 'rate_limited',
      retryAfterS: typeof s === 'number' && Number.isFinite(s) && s > 0 ? Math.ceil(s) : null,
    };
  }
  if (r.status === 403 && b.error === 'csrf') return { kind: 'failed', error: 'csrf' };
  if (r.status === 500) return { kind: 'failed', error: 'server' };
  const error = loadError(r.status);
  return { kind: 'failed', error: error === 'rate_limited' ? 'network' : error };
}
