/**
 * Admin app design §3: the shared administration client. The Lab's behaviour is covered by
 * app/tests/admin.test.ts (through app/src/ui/admin.ts); these are the shared request rules and
 * the new read calls (usage history, audit view).
 */
import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS_BASE,
  ADMIN_BASE,
  addTester,
  inFilter,
  loadAccounts,
  loadAudit,
  loadReports,
  loadUsage,
  matchesQuery,
  visibleAccounts,
  type AccountRow,
  type AccountsView,
} from '../src/index.js';
import { adminMessagesEn, adminMessagesHe } from '../src/messages.js';

type Call = { url: string; init: RequestInit | undefined };
function fake(status: number, body: unknown) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? 'x' : JSON.stringify(body), { status });
  };
  return { fn, calls };
}

describe('shared admin client', () => {
  it('keeps the two bases and relative, same-origin, uncached JSON requests', async () => {
    expect(ADMIN_BASE).toBe('/runtime/admin');
    expect(ACCOUNTS_BASE).toBe('/admin-api');
    const f = fake(200, { reports: [] });
    await loadReports(f.fn);
    await loadAccounts(f.fn);
    await addTester(f.fn, 'n@example.invalid');
    expect(f.calls.map((c) => c.url)).toEqual([
      '/runtime/admin/reports',
      '/admin-api/accounts',
      '/admin-api/accounts',
    ]);
    for (const c of f.calls) {
      expect(c.init?.cache).toBe('no-store');
      expect(c.init?.credentials).toBe('same-origin');
      // The gate answers 401 to a JSON request instead of starting a login.
      expect(new Headers(c.init?.headers).get('accept')).toBe('application/json');
    }
    expect(new Headers(f.calls[2]!.init?.headers).get('content-type')).toBe('application/json');
  });

  it('usage: the admin service, an optional validated range', async () => {
    const view = {
      generated: '2026-11-11T10:00:00Z',
      tz: 'Asia/Jerusalem',
      from: '2026-10-13',
      to: '2026-11-11',
      days: [],
      lastActivity: {},
    };
    const f = fake(200, view);
    expect(await loadUsage(f.fn)).toEqual({ ok: true, value: view });
    await loadUsage(f.fn, { from: '2026-11-01', to: '2026-11-11' });
    await loadUsage(f.fn, { from: '../x', to: '2026-11-11' });
    expect(f.calls.map((c) => c.url)).toEqual([
      '/admin-api/usage',
      '/admin-api/usage?from=2026-11-01&to=2026-11-11',
      '/admin-api/usage?to=2026-11-11',
    ]);
    expect(await loadUsage(fake(503, { error: 'usage_unavailable' }).fn)).toEqual({
      ok: false,
      error: 'unavailable',
    });
    expect(await loadUsage(fake(401, {}).fn)).toEqual({ ok: false, error: 'signed_out' });
    expect(await loadUsage(fake(403, {}).fn)).toEqual({ ok: false, error: 'forbidden' });
    expect(await loadUsage(fake(200, { days: 'x' }).fn)).toEqual({ ok: false, error: 'network' });
  });

  it('audit: the admin service, limit clamped to 1..500', async () => {
    const f = fake(200, { generated: '2026-11-11T10:00:00Z', entries: [] });
    expect((await loadAudit(f.fn)).ok).toBe(true);
    await loadAudit(f.fn, 9999);
    await loadAudit(f.fn, 0);
    await loadAudit(f.fn, 1.5);
    expect(f.calls.map((c) => c.url)).toEqual([
      '/admin-api/audit?limit=100',
      '/admin-api/audit?limit=500',
      '/admin-api/audit?limit=1',
      '/admin-api/audit?limit=100',
    ]);
    expect(await loadAudit(fake(503, { error: 'audit_unavailable' }).fn)).toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('the texts: the same keys in every locale, none empty', () => {
    expect(Object.keys(adminMessagesHe).sort()).toEqual(Object.keys(adminMessagesEn).sort());
    for (const v of [...Object.values(adminMessagesEn), ...Object.values(adminMessagesHe)])
      expect(v.trim()).not.toBe('');
  });
});

describe('testers search (shared by the Lab administration and the Admin app)', () => {
  const row = (target: string, p: Partial<AccountRow>): AccountRow => ({
    target,
    masked: '***',
    class: 'alpha_tester',
    status: 'authorized',
    dateAdded: null,
    googleIdRecorded: false,
    displayName: null,
    firstSignIn: null,
    lastSignIn: null,
    signIns: 0,
    lastSeen: null,
    statusUpdated: null,
    ...p,
  });
  const view: AccountsView = {
    accounts: [
      row('t_owner', { class: 'owner', masked: 'ow***@example.invalid', displayName: 'Owner' }),
      row('t_alex', { masked: 'te***@example.invalid', displayName: 'Alex T.' }),
      row('t_noa', { masked: 'no***@makers.example.invalid', displayName: 'נועה לוי' }),
      row('t_none', { masked: 'ab***@example.invalid', status: 'pending' }),
      row('t_gone', {
        masked: 'fo***@example.invalid',
        displayName: 'בודקת ל.',
        status: 'revoked',
      }),
    ],
    warnings: [],
    generated: null,
    authorizedTesters: 3,
    owner: 1,
    cap: 30,
  };
  const ids = (filter: 'active' | 'disabled' | 'all', q: string) =>
    visibleAccounts(view, filter, q).map((a) => a.target);

  it('matches the private name, case-insensitively', () => {
    expect(matchesQuery(view.accounts[1]!, 'alex')).toBe(true);
    expect(matchesQuery(view.accounts[1]!, '  ALEX t. ')).toBe(true);
    expect(matchesQuery(view.accounts[1]!, 'bob')).toBe(false);
  });

  it('matches the visible masked address only (never a full one)', () => {
    expect(matchesQuery(view.accounts[1]!, 'TE***@EXAMPLE')).toBe(true);
    expect(matchesQuery(view.accounts[2]!, 'makers')).toBe(true);
    // The full address is not known here: its hidden part never matches.
    expect(matchesQuery(view.accounts[1]!, 'tester.one')).toBe(false);
  });

  it('Hebrew names, in the composed or decomposed form', () => {
    expect(matchesQuery(view.accounts[2]!, 'לוי')).toBe(true);
    expect(matchesQuery(view.accounts[2]!, 'נועה'.normalize('NFD'))).toBe(true);
    expect(matchesQuery(view.accounts[4]!, 'בודקת')).toBe(true);
    expect(matchesQuery(view.accounts[2]!, 'בודקת')).toBe(false);
  });

  it('an empty or blank query matches everything', () => {
    for (const a of view.accounts) {
      expect(matchesQuery(a, '')).toBe(true);
      expect(matchesQuery(a, '   ')).toBe(true);
    }
    expect(ids('all', '')).toEqual(['t_owner', 't_none', 't_alex', 't_gone', 't_noa']);
  });

  it('combined with the filter; the owner stays first', () => {
    expect(inFilter(view.accounts[3]!, 'active')).toBe(true); // pending counts as active
    expect(inFilter(view.accounts[4]!, 'active')).toBe(false);
    expect(ids('active', 'example.invalid')).toEqual(['t_owner', 't_none', 't_alex', 't_noa']);
    expect(ids('active', '@example.invalid')).toEqual(['t_owner', 't_none', 't_alex']);
    expect(ids('disabled', 'example.invalid')).toEqual(['t_gone']);
    expect(ids('disabled', 'alex')).toEqual([]);
    expect(ids('all', 'בודקת')).toEqual(['t_gone']);
    expect(ids('active', 'בודקת')).toEqual([]);
    expect(ids('all', 'o')).toEqual(['t_owner', 't_gone', 't_noa']);
  });
});
