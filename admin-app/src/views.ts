/**
 * TBI Lab Admin: what the screens show, without the DOM (unit-tested, tests/views.test.ts). Every
 * value comes from the owner-only APIs through @tbi-lab/admin-client; nothing here holds or
 * derives an address (the server masks them) and nothing is computed that the servers did not
 * count: usage is summed, never estimated.
 */
import {
  ADMIN_TIME_ZONE,
  inFilter,
  matchesQuery,
  UNMATCHED,
  USAGE_METRICS,
  type AccountFilter,
  type AccountRow,
  type AccountsView,
  type AuditEntry,
  type AuditView,
  type ReportMeta,
  type UsageMetric,
  type UsageMetrics,
  type UsageView,
} from '@tbi-lab/admin-client';

// ---------------------------------------------------------------- routes (hash based: static files)

export type Route =
  | { name: 'today' }
  | { name: 'testers' }
  | { name: 'tester'; target: string }
  | { name: 'add' }
  | { name: 'feedback' }
  | { name: 'report'; id: string }
  | { name: 'activity' }
  | { name: 'settings' }
  | { name: 'more' };

const TARGET = /^t_[A-Za-z0-9_-]{16}$/;
const REPORT = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export function parseRoute(hash: string): Route {
  const [a, b, ...rest] = hash.replace(/^#\/?/, '').split('/');
  if (rest.length) return { name: 'today' };
  if (a === 'testers' && b && TARGET.test(b)) return { name: 'tester', target: b };
  if (a === 'feedback' && b && REPORT.test(b)) return { name: 'report', id: b };
  if (b) return { name: 'today' };
  if (
    a === 'testers' ||
    a === 'add' ||
    a === 'feedback' ||
    a === 'activity' ||
    a === 'settings' ||
    a === 'more' ||
    a === 'today'
  )
    return { name: a };
  return { name: 'today' };
}

export function routeHash(r: Route): string {
  if (r.name === 'tester') return `#/testers/${r.target}`;
  if (r.name === 'report') return `#/feedback/${r.id}`;
  return `#/${r.name}`;
}

/** The navigation section a route belongs to (adding a tester is part of Testers). */
export const section = (r: Route): Exclude<Route['name'], 'tester' | 'report' | 'add'> =>
  r.name === 'tester' || r.name === 'add' ? 'testers' : r.name === 'report' ? 'feedback' : r.name;

/** The phone's bottom tabs; "More" holds the activity log, settings and signing out. */
export const TABS = ['today', 'testers', 'feedback', 'more'] as const;
export type Tab = (typeof TABS)[number];
export function tab(r: Route): Tab {
  const s = section(r);
  return s === 'activity' || s === 'settings' ? 'more' : s;
}

// ---------------------------------------------------------------- testers list memory

/**
 * What the testers list looked like (search, filter, scroll) when a tester was opened from it, so
 * Back returns to the same place. In memory only: a fresh load starts from the default list.
 */
export interface ListMemory {
  query: string;
  filter: AccountFilter;
  /** The page's scroll offset to restore on the next return to the list, if any. */
  scrollY: number | null;
  /** The tester opened from the list (Back then means "the list as it was"). */
  openedFrom: string | null;
}
export const listMemory: ListMemory = {
  query: '',
  filter: 'active',
  scrollY: null,
  openedFrom: null,
};
export function resetListMemory(m: ListMemory = listMemory): void {
  m.query = '';
  m.filter = 'active';
  m.scrollY = null;
  m.openedFrom = null;
}
/**
 * After every route change: a pending scroll is kept only on the way list -> tester -> list, and
 * "opened from the list" only while that tester is shown. Returns the scroll to restore now.
 */
export function afterRoute(r: Route, m: ListMemory = listMemory): number | null {
  if (!(r.name === 'tester' && r.target === m.openedFrom)) m.openedFrom = null;
  if (r.name === 'testers') {
    const y = m.scrollY;
    m.scrollY = null;
    return y;
  }
  if (r.name !== 'tester') m.scrollY = null;
  return null;
}

// ---------------------------------------------------------------- days

/** Today in Israel, `YYYY-MM-DD` (the usage history's days are Israel days). */
export function israelDay(now: number, tz = ADMIN_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The `n` days ending with `last` (inclusive), ascending. */
export function daysEnding(last: string, n: number): string[] {
  const end = Date.parse(`${last}T00:00:00Z`);
  if (!Number.isFinite(end)) return [];
  return Array.from({ length: n }, (_, i) =>
    new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

// ---------------------------------------------------------------- usage

export const zeroMetrics = (): UsageMetrics =>
  Object.fromEntries(USAGE_METRICS.map((m) => [m, 0])) as UsageMetrics;

export function addMetrics(a: UsageMetrics, b: Partial<UsageMetrics>): UsageMetrics {
  const out = { ...a };
  for (const m of USAGE_METRICS) out[m] += b[m] ?? 0;
  return out;
}

const anyActivity = (m: UsageMetrics) => USAGE_METRICS.some((k) => m[k] > 0);

/** One day's totals over every account (unmatched included), and who was active. */
export function dayTotals(u: UsageView, date: string) {
  const day = u.days.find((d) => d.date === date);
  let totals = zeroMetrics();
  let activeTesters = 0;
  let unmatched = false;
  for (const [key, m] of Object.entries(day?.accounts ?? {})) {
    totals = addMetrics(totals, m);
    if (key === UNMATCHED) unmatched ||= anyActivity(m);
    else if (anyActivity(m)) activeTesters++;
  }
  return { totals, activeTesters, unmatched };
}

/** One account's metrics per day over `days` (0 where nothing was counted). */
export function accountSeries(u: UsageView, target: string, days: string[]) {
  const byDate = new Map(u.days.map((d) => [d.date, d.accounts[target]]));
  return days.map((date) => ({ date, metrics: { ...zeroMetrics(), ...(byDate.get(date) ?? {}) } }));
}

export function seriesTotals(series: { metrics: UsageMetrics }[]): UsageMetrics {
  return series.reduce((t, d) => addMetrics(t, d.metrics), zeroMetrics());
}

/**
 * Whole simulated minutes (rounded down: never more than was counted). The exporter counts
 * seconds to 0.1 s (71.3), so a sum is first taken back to 0.1 s: floating-point sums such as
 * 71.3 + 48.7 = 119.99999999999999 still make 2 minutes.
 */
export const simMinutes = (seconds: number) =>
  Number.isFinite(seconds) && seconds > 0 ? Math.floor(Math.round(seconds * 10) / 600) : 0;

/** What a chart shows for a metric (simulation time in minutes). */
export const chartValue = (m: UsageMetrics, metric: UsageMetric) =>
  metric === 'simSeconds' ? simMinutes(m.simSeconds) : m[metric];

/** Bar heights for values, scaled to `height` (a value above 0 is at least 2 units tall). */
export function barHeights(values: number[], height: number): number[] {
  const max = Math.max(0, ...values);
  if (max === 0) return values.map(() => 0);
  return values.map((v) => (v <= 0 ? 0 : Math.max(2, Math.round((v / max) * height))));
}

// ---------------------------------------------------------------- testers

const latest = (...isos: (string | null | undefined)[]): string | null => {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const v of isos) {
    const ms = v ? Date.parse(v) : NaN;
    if (Number.isFinite(ms) && ms > bestMs) {
      best = v!;
      bestMs = ms;
    }
  }
  return best;
};

/** The latest sign of a tester: usage, gate sign-in, or the host's last sighting. */
export const lastActivity = (a: AccountRow, u: UsageView | null): string | null =>
  latest(u?.lastActivity[a.target], a.lastSignIn, a.lastSeen);

const fold = (s: string) => s.normalize('NFC').toLocaleLowerCase().trim();

/**
 * The testers list: filtered (active / disabled / all), searched by name or masked address (the
 * shared matcher, @tbi-lab/admin-client), sorted by last activity (most recent first; never
 * active last, then by label).
 */
export function testerList(
  v: AccountsView,
  u: UsageView | null,
  opts: { filter: AccountFilter; query: string },
): { account: AccountRow; last: string | null }[] {
  const label = (a: AccountRow) => fold(a.displayName ?? a.masked);
  return v.accounts
    .filter((a) => inFilter(a, opts.filter) && matchesQuery(a, opts.query))
    .map((account) => ({ account, last: lastActivity(account, u) }))
    .sort((x, y) => {
      const dx = x.last ? Date.parse(x.last) : -Infinity;
      const dy = y.last ? Date.parse(y.last) : -Infinity;
      if (dx !== dy) return dy - dx;
      return label(x.account).localeCompare(label(y.account));
    });
}

/** The owner's own label for a record (its name), else the server's mask. */
export const accountLabel = (a: AccountRow) => a.displayName ?? a.masked;

// ---------------------------------------------------------------- activity log

export interface AuditRow extends AuditEntry {
  /** The account's label (name or mask), null for an entry without a target, or 'unknown'. */
  label: string | null;
  known: boolean;
}

/** The audit entries joined to the accounts list for names (masked addresses otherwise). */
export function auditRows(a: AuditView, accounts: AccountsView | null): AuditRow[] {
  const byTarget = new Map((accounts?.accounts ?? []).map((r) => [r.target, r]));
  return a.entries.map((e) => {
    if (e.target === null) return { ...e, label: null, known: true };
    const r = byTarget.get(e.target);
    return r ? { ...e, label: accountLabel(r), known: true } : { ...e, label: null, known: false };
  });
}

// ---------------------------------------------------------------- feedback

/** Newest first. */
export const reportsNewestFirst = (r: ReportMeta[]) =>
  [...r].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));

/** "Unread" is per device: the reports not yet opened here (the server keeps no read state). */
export function unread(reports: ReportMeta[], seen: ReadonlySet<string>) {
  return reports.filter((r) => !seen.has(r.id));
}
