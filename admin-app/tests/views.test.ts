/** TBI Lab Admin: the screens' logic without the DOM (routes, usage sums, the testers list, the log). */
import { describe, expect, it } from 'vitest';
import type {
  AccountRow,
  AccountsView,
  AuditView,
  ReportMeta,
  UsageView,
} from '@tbi-lab/admin-client';
import {
  accountSeries,
  auditRows,
  barHeights,
  chartValue,
  dayTotals,
  daysEnding,
  israelDay,
  lastActivity,
  parseRoute,
  rememberSeen,
  reportsNewestFirst,
  routeHash,
  section,
  seriesTotals,
  simMinutes,
  testerList,
  unread,
  zeroMetrics,
} from '../src/views.js';
import { LOCALES, getLocale, isMessageKey, translate } from '../src/i18n.js';

const T1 = 't_AAAAAAAAAAAAAAAA';
const T2 = 't_BBBBBBBBBBBBBBBB';
const T3 = 't_CCCCCCCCCCCCCCCC';

const row = (p: Partial<AccountRow> & Pick<AccountRow, 'target' | 'masked'>): AccountRow => ({
  class: 'alpha_tester',
  status: 'authorized',
  dateAdded: '2026-10-01',
  googleIdRecorded: true,
  displayName: null,
  firstSignIn: null,
  lastSignIn: null,
  signIns: 0,
  lastSeen: null,
  statusUpdated: null,
  ...p,
});

const accounts: AccountsView = {
  generated: null,
  cap: 30,
  authorizedTesters: 2,
  owner: 1,
  warnings: [],
  accounts: [
    row({
      target: T1,
      masked: 'al***@example.invalid',
      displayName: 'Alex T.',
      lastSignIn: '2026-11-10T08:00:00Z',
    }),
    row({ target: T2, masked: 'be***@example.invalid', lastSeen: '2026-11-11T07:00:00Z' }),
    row({
      target: T3,
      masked: 'fo***@example.invalid',
      displayName: 'בודקת ל.',
      status: 'revoked',
    }),
  ],
};

const m = (p: Partial<Record<string, number>>) => ({ ...zeroMetrics(), ...p });
const usage: UsageView = {
  generated: '2026-11-11T09:55:00Z',
  tz: 'Asia/Jerusalem',
  from: '2026-10-13',
  to: '2026-11-11',
  days: [
    { date: '2026-11-10', accounts: { [T1]: m({ runs: 2, simSeconds: 119 }) } },
    {
      date: '2026-11-11',
      accounts: {
        [T1]: m({ runs: 3, builds: 1, simSeconds: 61 }),
        [T2]: m({}),
        [T3]: m({ refusals: 1 }),
        unmatched: m({ runs: 1 }),
      },
    },
  ],
  lastActivity: { [T1]: '2026-11-11T09:00:00Z' },
};

describe('routes', () => {
  it('parse and print every screen; anything else is Today', () => {
    for (const r of [
      { name: 'today' },
      { name: 'testers' },
      { name: 'tester', target: T1 },
      { name: 'add' },
      { name: 'feedback' },
      { name: 'report', id: 'ABCD-EFGH-JKMN' },
      { name: 'activity' },
      { name: 'settings' },
    ] as const)
      expect(parseRoute(routeHash(r))).toEqual(r);
    for (const h of [
      '',
      '#',
      '#/x',
      '#/testers/../../etc',
      '#/testers/t_x',
      '#/feedback/1/2',
      '#/today/x',
    ])
      expect(parseRoute(h)).toEqual({ name: 'today' });
    expect(section({ name: 'tester', target: T1 })).toBe('testers');
    expect(section({ name: 'report', id: 'ABCD-EFGH-JKMN' })).toBe('feedback');
  });
});

describe('days and usage', () => {
  it('Israel days, and the 30 days ending one', () => {
    expect(israelDay(Date.parse('2026-11-10T22:30:00Z'))).toBe('2026-11-11');
    expect(israelDay(Date.parse('2026-11-10T21:30:00Z'))).toBe('2026-11-10');
    const d = daysEnding('2026-11-11', 30);
    expect(d.length).toBe(30);
    expect(d[0]).toBe('2026-10-13');
    expect(d[29]).toBe('2026-11-11');
    expect(daysEnding('2026-03-01', 2)).toEqual(['2026-02-28', '2026-03-01']);
  });

  it('a day’s totals count every account; active testers exclude unmatched and idle rows', () => {
    const d = dayTotals(usage, '2026-11-11');
    expect(d.totals).toEqual(m({ runs: 4, builds: 1, simSeconds: 61, refusals: 1 }));
    expect(d.activeTesters).toBe(2);
    expect(d.unmatched).toBe(true);
    expect(dayTotals(usage, '2026-01-01')).toEqual({
      totals: zeroMetrics(),
      activeTesters: 0,
      unmatched: false,
    });
  });

  it('one tester’s series fills empty days with 0; totals sum; minutes round down', () => {
    const s = accountSeries(usage, T1, daysEnding('2026-11-11', 3));
    expect(s.map((d) => d.metrics.runs)).toEqual([0, 2, 3]);
    const tot = seriesTotals(s);
    expect(tot.runs).toBe(5);
    expect(tot.simSeconds).toBe(180);
    expect(simMinutes(179)).toBe(2);
    expect(chartValue(tot, 'simSeconds')).toBe(3);
    expect(chartValue(tot, 'runs')).toBe(5);
  });

  it('bar heights scale to the largest; any activity stays visible', () => {
    expect(barHeights([0, 0], 60)).toEqual([0, 0]);
    expect(barHeights([0, 1, 100], 60)).toEqual([0, 2, 60]);
    expect(barHeights([5, 10], 60)).toEqual([30, 60]);
  });
});

describe('testers list', () => {
  it('sorted by last activity (usage, sign-in, sighting), never-active last', () => {
    const list = testerList(accounts, usage, { filter: 'all', query: '' });
    expect(list.map((r) => r.account.target)).toEqual([T1, T2, T3]);
    expect(list[0]!.last).toBe('2026-11-11T09:00:00Z');
    expect(list[1]!.last).toBe('2026-11-11T07:00:00Z');
    expect(list[2]!.last).toBeNull();
    // Without usage the gate's sign-in decides.
    expect(lastActivity(accounts.accounts[0]!, null)).toBe('2026-11-10T08:00:00Z');
  });

  it('filters and searches by name or masked address, case and form insensitive', () => {
    const q = (query: string, filter: 'active' | 'disabled' | 'all' = 'all') =>
      testerList(accounts, usage, { filter, query }).map((r) => r.account.target);
    expect(q('', 'active')).toEqual([T1, T2]);
    expect(q('', 'disabled')).toEqual([T3]);
    expect(q('ALEX')).toEqual([T1]);
    expect(q('be***')).toEqual([T2]);
    expect(q('בודקת')).toEqual([T3]);
    expect(q('al***@example')).toEqual([T1]);
    expect(q('nobody')).toEqual([]);
  });
});

describe('activity log and feedback', () => {
  it('audit entries joined to names, masks, or unknown', () => {
    const a: AuditView = {
      generated: '2026-11-11T09:56:00Z',
      entries: [
        { at: '2026-11-11T09:00:00Z', action: 'rename', target: T1, result: 'done', corr: 'c3' },
        { at: '2026-11-10T09:00:00Z', action: 'disable', target: T2, result: 'done', corr: 'c2' },
        {
          at: '2026-11-09T09:00:00Z',
          action: 'add',
          target: 't_ZZZZZZZZZZZZZZZZ',
          result: 'done',
          corr: 'c1',
        },
        {
          at: '2026-11-08T09:00:00Z',
          action: 'sign_ins',
          target: null,
          result: 'ok',
          corr: 'c0',
          count: 3,
        },
      ],
    };
    const rows = auditRows(a, accounts);
    expect(rows.map((r) => [r.label, r.known])).toEqual([
      ['Alex T.', true],
      ['be***@example.invalid', true],
      [null, false],
      [null, true],
    ]);
    expect(auditRows(a, null)[0]!.known).toBe(false);
  });

  it('feedback newest first; unread is what this device has not opened', () => {
    const r = (id: string, receivedAt: string) => ({ id, receivedAt }) as ReportMeta;
    const list = [
      r('AAAA-AAAA-AAAA', '2026-11-01T00:00:00Z'),
      r('BBBB-BBBB-BBBB', '2026-11-02T00:00:00Z'),
    ];
    expect(reportsNewestFirst(list).map((x) => x.id)).toEqual(['BBBB-BBBB-BBBB', 'AAAA-AAAA-AAAA']);
    const seen = rememberSeen(new Set(['GONE-GONE-GONE']), 'AAAA-AAAA-AAAA', list);
    expect([...seen]).toEqual(['AAAA-AAAA-AAAA']);
    expect(unread(list, seen).map((x) => x.id)).toEqual(['BBBB-BBBB-BBBB']);
  });
});

describe('locales', () => {
  it('Hebrew (RTL) is the default; every key in every locale, none empty, glossary applied', () => {
    expect(getLocale(null).code).toBe('he');
    expect(getLocale('he').dir).toBe('rtl');
    expect(getLocale('en').dir).toBe('ltr');
    expect(getLocale('xx').code).toBe('he');
    const keys = Object.keys(LOCALES[0]!.messages).sort();
    for (const l of LOCALES) {
      expect(Object.keys(l.messages).sort()).toEqual(keys);
      for (const v of Object.values(l.messages)) {
        expect(v.trim()).not.toBe('');
        expect(v).not.toMatch(/\[\[/);
      }
    }
    expect(isMessageKey('console.nav.today')).toBe(true);
    expect(translate(getLocale('en'), 'console.today.unread', { unread: 2, total: 5 })).toBe(
      '2 new of 5',
    );
    // The shared texts are the Lab's, unchanged.
    expect(translate(getLocale('en'), 'admin.result.done.disable', { account: 'X' })).toBe(
      'Access for X has ended.',
    );
  });
});
