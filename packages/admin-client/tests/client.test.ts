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
  loadAccounts,
  loadAudit,
  loadReports,
  loadUsage,
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
