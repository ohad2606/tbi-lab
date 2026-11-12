/**
 * Admin app design §2: the admin service's read-only history views, for the owner (the TBI Admin
 * app's Today, Testers and Activity screens). Two files the ops side writes as root (group
 * tbi-admin-view, 0640); this service only reads them, defensively:
 *
 *   <TBI_ADMIN_DIR>/usage/usage.json   (TBI_ADMIN_USAGE)       the usage exporter's per-tester,
 *                                                              per-day aggregates (Israel days)
 *   <TBI_ADMIN_DIR>/view/audit.json    (TBI_ADMIN_AUDIT_VIEW)  the helper's last audit lines
 *
 * Neither holds an address, a name or a token: accounts are the same opaque targets (`t_…`) as
 * the accounts view, and `unmatched` is activity that maps to no account. A file that is missing,
 * too large, of an unknown version or malformed is "unavailable" (503), never a partial answer.
 */
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { TARGET_RE } from './accounts.js';
import { AdminError, isObj } from './common.js';

/** Largest view file read (usage for 400 days x 31 accounts is well under 2 MiB). */
export const MAX_VIEW_BYTES = 8 * 1024 * 1024;
/** Longest usage range one request may ask for (the exporter keeps 400 days). */
export const MAX_RANGE_DAYS = 400;
export const DEFAULT_RANGE_DAYS = 30;
export const AUDIT_DEFAULT_LIMIT = 100;
export const AUDIT_MAX = 500;

export const USAGE_METRICS = [
  'signIns',
  'builds',
  'prebuilt',
  'runs',
  'simSeconds',
  'refusals',
] as const;
export type UsageMetrics = Record<(typeof USAGE_METRICS)[number], number>;
export const UNMATCHED = 'unmatched';

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

export interface UsageFile {
  generated: string;
  tz: string;
  from: string | null;
  /** Day -> account key -> metrics. */
  days: Map<string, Record<string, UsageMetrics>>;
  lastActivity: Record<string, string>;
}

export interface AuditEntry {
  at: string;
  action: (typeof AUDIT_ACTIONS)[number];
  target: string | null;
  result: string;
  corr: string;
  count?: number;
}

export interface AuditFile {
  generated: string;
  entries: AuditEntry[];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;
const RESULT_RE = /^[a-z][a-z0-9_]{0,39}$/;
const CORR_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** A time zone the runtime knows (an unknown one would fail later, as a 500), else false. */
function knownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** An ISO UTC timestamp (as the ops side writes it), else null. */
const isoUtc = (v: unknown): string | null =>
  typeof v === 'string' &&
  v.length <= 40 &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(v) &&
  Number.isFinite(Date.parse(v))
    ? v
    : null;

/** A real calendar day `YYYY-MM-DD` as a UTC day number, else null. */
export function dayNumber(v: unknown): number | null {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d)
    return null;
  return ms / 86_400_000;
}
export const dayString = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);

const accountKey = (k: string) => k === UNMATCHED || TARGET_RE.test(k);
const metric = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1e9 ? v : null;
/**
 * Simulated seconds are a duration, not a count: the exporter rounds them to 0.1 s (71.3). Any
 * finite non-negative number up to 1e9 is accepted and passed on rounded to 0.1 s.
 */
const seconds = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e9
    ? Math.round(v * 10) / 10
    : null;

/** usage.json, re-validated in full; null when unusable (unknown version or any bad field). */
export function parseUsage(text: string): UsageFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.v !== 1) return null;
  const generated = isoUtc(raw.generated);
  if (!generated || typeof raw.tz !== 'string' || !TZ_RE.test(raw.tz) || !knownTimeZone(raw.tz))
    return null;
  if (raw.from !== undefined && raw.from !== null && dayNumber(raw.from) === null) return null;
  const from = typeof raw.from === 'string' ? raw.from : null;
  if (!isObj(raw.days)) return null;
  const dayKeys = Object.keys(raw.days);
  if (dayKeys.length > 1000) return null;
  const days = new Map<string, Record<string, UsageMetrics>>();
  for (const day of dayKeys) {
    const accounts = raw.days[day];
    if (dayNumber(day) === null || !isObj(accounts)) return null;
    const keys = Object.keys(accounts);
    if (keys.length > 2000) return null;
    const out: Record<string, UsageMetrics> = {};
    for (const k of keys) {
      const m = accounts[k];
      if (!accountKey(k) || !isObj(m)) return null;
      const row = {} as UsageMetrics;
      // Every known metric: absent is 0; a present one must be a count (simulated seconds: a
      // duration, see `seconds`). Unknown metrics (a newer exporter's) are not passed on.
      for (const name of USAGE_METRICS) {
        const v =
          m[name] === undefined ? 0 : name === 'simSeconds' ? seconds(m[name]) : metric(m[name]);
        if (v === null) return null;
        row[name] = v;
      }
      out[k] = row;
    }
    days.set(day, out);
  }
  const lastActivity: Record<string, string> = {};
  if (raw.lastActivity !== undefined) {
    if (!isObj(raw.lastActivity)) return null;
    for (const [k, v] of Object.entries(raw.lastActivity)) {
      const at = isoUtc(v);
      if (!accountKey(k) || !at) return null;
      lastActivity[k] = at;
    }
  }
  return { generated, tz: raw.tz, from, days, lastActivity };
}

/**
 * view/audit.json. The file as a whole must be version 1; an entry the service does not
 * understand (a newer helper's action, a malformed line) is left out rather than failing the view.
 */
export function parseAudit(text: string): AuditFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.v !== 1 || !Array.isArray(raw.entries)) return null;
  const generated = isoUtc(raw.generated);
  if (!generated) return null;
  const entries: AuditEntry[] = [];
  // Every entry is read (the file is size-bounded) and sorted before the cap, so the newest are
  // kept whatever the file's order.
  for (const e of raw.entries) {
    if (!isObj(e)) continue;
    const at = isoUtc(e.at);
    if (!at || !(AUDIT_ACTIONS as readonly unknown[]).includes(e.action)) continue;
    const target =
      e.target === null || e.target === undefined
        ? null
        : typeof e.target === 'string' && TARGET_RE.test(e.target)
          ? e.target
          : undefined;
    if (target === undefined) continue;
    if (typeof e.result !== 'string' || !RESULT_RE.test(e.result)) continue;
    if (typeof e.corr !== 'string' || !CORR_RE.test(e.corr)) continue;
    const count = e.count === undefined ? undefined : metric(e.count);
    if (count === null) continue;
    entries.push({
      at,
      action: e.action as AuditEntry['action'],
      target,
      result: e.result,
      corr: e.corr,
      ...(count === undefined ? {} : { count }),
    });
  }
  // Newest first, whatever the file's order (stable for equal times).
  entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { generated, entries: entries.slice(0, AUDIT_MAX) };
}

/** Read a small file; null when missing, unreadable, not a regular file or too large. */
async function readSmall(path: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > MAX_VIEW_BYTES) return null;
    const buf = Buffer.alloc(Math.min(st.size, MAX_VIEW_BYTES) + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_VIEW_BYTES) return null; // grew while reading
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

export interface ViewPaths {
  usage: string;
  audit: string;
}

/** `TBI_ADMIN_USAGE` / `TBI_ADMIN_AUDIT_VIEW` (absolute), defaulting under the admin directory. */
export function viewPathsFromEnv(dir: string, env: NodeJS.ProcessEnv = process.env): ViewPaths {
  const pick = (name: string, fallback: string) => {
    const v = env[name];
    if (v === undefined || v === '') return fallback;
    if (!v.startsWith('/')) throw new Error(`${name} must be an absolute path`);
    return v;
  };
  return {
    usage: pick('TBI_ADMIN_USAGE', join(dir, 'usage', 'usage.json')),
    audit: pick('TBI_ADMIN_AUDIT_VIEW', join(dir, 'view', 'audit.json')),
  };
}

export class AdminViews {
  constructor(readonly paths: ViewPaths) {}

  async usage(): Promise<UsageFile | null> {
    const text = await readSmall(this.paths.usage);
    return text === null ? null : parseUsage(text);
  }

  async audit(): Promise<AuditFile | null> {
    const text = await readSmall(this.paths.audit);
    return text === null ? null : parseAudit(text);
  }
}

/** Today's date in a time zone, `YYYY-MM-DD`. */
export function todayIn(tz: string, now: number): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * The requested range: `from` and `to` (inclusive Israel days), each optional; the default is
 * the last 30 days ending today. At most 400 days; `from` after `to` is refused.
 */
export function usageRange(
  q: URLSearchParams,
  tz: string,
  now: number,
): { from: string; to: string } {
  for (const k of q.keys())
    if (k !== 'from' && k !== 'to') throw new AdminError(400, 'invalid_query');
  if (q.getAll('from').length > 1 || q.getAll('to').length > 1)
    throw new AdminError(400, 'invalid_query');
  const parse = (name: 'from' | 'to') => {
    const v = q.get(name);
    if (v === null) return null;
    const n = dayNumber(v);
    if (n === null) throw new AdminError(400, `invalid_${name}`);
    return n;
  };
  let to = parse('to');
  let from = parse('from');
  to ??= dayNumber(todayIn(tz, now))!;
  from ??= to - (DEFAULT_RANGE_DAYS - 1);
  if (from > to) throw new AdminError(400, 'invalid_range');
  if (to - from + 1 > MAX_RANGE_DAYS) throw new AdminError(400, 'range_too_long');
  return { from: dayString(from), to: dayString(to) };
}

/** The `GET /usage` answer: the days in range that have activity, ascending. */
export function usageAnswer(u: UsageFile, range: { from: string; to: string }) {
  const days = [...u.days.keys()]
    .filter((d) => d >= range.from && d <= range.to)
    .sort()
    .map((date) => ({ date, accounts: u.days.get(date)! }));
  return {
    generated: u.generated,
    tz: u.tz,
    from: range.from,
    to: range.to,
    days,
    lastActivity: u.lastActivity,
  };
}

/** `?limit=N`: 1..500, default 100. */
export function auditLimit(q: URLSearchParams): number {
  for (const k of q.keys()) if (k !== 'limit') throw new AdminError(400, 'invalid_query');
  const all = q.getAll('limit');
  if (all.length === 0) return AUDIT_DEFAULT_LIMIT;
  if (all.length > 1 || !/^[1-9]\d{0,3}$/.test(all[0]!)) throw new AdminError(400, 'invalid_limit');
  const n = Number(all[0]);
  if (n > AUDIT_MAX) throw new AdminError(400, 'invalid_limit');
  return n;
}
