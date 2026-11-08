/** Sprint 23B: the owner's administration, client logic (answers, masking, request shapes). */
import { describe, expect, it } from 'vitest';
import {
  accountCounts,
  addTester,
  capFull,
  israelTime,
  normalizeDisplayName,
  renameTester,
  visibleAccounts,
  type AccountRow,
  type AccountsView,
  deleteReport,
  deleteTesterReports,
  interpretMutation,
  isOwner,
  loadAccounts,
  loadCapacity,
  loadReport,
  loadReports,
  maskAddress,
  plausibleAddress,
  requestResult,
  setAccess,
  testerLabel,
} from '../src/ui/admin.js';

type Call = { url: string; init: RequestInit | undefined };
function fake(status: number, body: unknown) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? 'x' : JSON.stringify(body), { status });
  };
  return { fn, calls };
}

describe('admin client', () => {
  it('the entry appears only when the server says owner', async () => {
    expect(await isOwner(fake(200, { owner: true }).fn)).toBe(true);
    expect(await isOwner(fake(403, { error: 'forbidden' }).fn)).toBe(false);
    expect(await isOwner(fake(200, { owner: 'yes' }).fn)).toBe(false);
    expect(await isOwner(fake(404, {}).fn)).toBe(false);
    expect(
      await isOwner(async () => {
        throw new Error('offline');
      }),
    ).toBe(false);
  });

  it('mutations are JSON POSTs to the same origin, with only the needed field', async () => {
    const f = fake(200, { id: 'x', ok: true, code: 'done', masked: 'ne***@example.invalid' });
    await addTester(f.fn, ' New@example.invalid ');
    expect(f.calls[0]!.url).toBe('/admin-api/accounts');
    expect(f.calls[0]!.init?.method).toBe('POST');
    expect(new Headers(f.calls[0]!.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(f.calls[0]!.init?.body as string)).toEqual({ email: 'New@example.invalid' });
    await setAccess(f.fn, 'disable', 't_AAAAAAAAAAAAAAAA');
    expect(f.calls[1]!.url).toBe('/admin-api/accounts/disable');
    expect(JSON.parse(f.calls[1]!.init?.body as string)).toEqual({ target: 't_AAAAAAAAAAAAAAAA' });
    expect(await deleteTesterReports(f.fn, 'not a principal')).toBeNull();
    expect(f.calls).toHaveLength(2);
    expect(await requestResult(f.fn, '../etc')).toEqual({ kind: 'refused', error: 'invalid' });
    expect(await loadReport(f.fn, '../../x')).toEqual({ ok: false, error: 'network' });
    expect(f.calls).toHaveLength(2);
  });

  it('Sprint 23C: accounts go to the admin service, the owner check and reports to the Session Host', async () => {
    const f = fake(200, {});
    await isOwner(f.fn);
    await loadAccounts(f.fn);
    await loadCapacity(f.fn);
    await requestResult(f.fn, 'Z'.repeat(26));
    await loadReports(f.fn);
    await loadReport(f.fn, 'AAAA-BBBB-CCCC');
    await deleteReport(f.fn, 'AAAA-BBBB-CCCC');
    await deleteTesterReports(f.fn, `p_${'A'.repeat(26)}`);
    expect(f.calls.map((c) => c.url)).toEqual([
      '/runtime/admin/me',
      '/admin-api/accounts',
      '/admin-api/sessions',
      `/admin-api/requests/${'Z'.repeat(26)}`,
      '/runtime/admin/reports',
      '/runtime/admin/reports/AAAA-BBBB-CCCC',
      '/runtime/admin/reports/AAAA-BBBB-CCCC',
      `/runtime/admin/reports?principal=p_${'A'.repeat(26)}`,
    ]);
  });

  it('interprets results, pending requests and refusals', () => {
    expect(
      interpretMutation(200, { ok: true, code: 'done', masked: 'a***@example.invalid' }),
    ).toEqual({
      kind: 'result',
      ok: true,
      code: 'done',
      masked: 'a***@example.invalid',
      ownerPending: false,
    });
    expect(
      interpretMutation(409, { ok: false, code: 'forbidden', ownerIdentityPending: true }),
    ).toMatchObject({
      code: 'forbidden',
      ownerPending: true,
    });
    expect(interpretMutation(202, { id: 'ABC', pending: true })).toEqual({
      kind: 'pending',
      id: 'ABC',
    });
    expect(interpretMutation(400, { error: 'invalid_email' })).toEqual({
      kind: 'refused',
      error: 'invalid_email',
    });
    expect(interpretMutation(403, { error: 'csrf' })).toEqual({ kind: 'refused', error: 'csrf' });
    expect(interpretMutation(403, { error: 'forbidden' })).toEqual({
      kind: 'refused',
      error: 'forbidden',
    });
    expect(interpretMutation(401, {})).toEqual({ kind: 'refused', error: 'signed_out' });
    expect(interpretMutation(429, {})).toEqual({ kind: 'refused', error: 'rate_limited' });
    expect(interpretMutation(503, {})).toEqual({ kind: 'refused', error: 'unavailable' });
    expect(interpretMutation(200, { ok: true, code: 'weird' })).toEqual({
      kind: 'refused',
      error: 'network',
    });
    expect(interpretMutation(null, null)).toEqual({ kind: 'refused', error: 'network' });
  });

  it('loads lists defensively; warnings default to none', async () => {
    const v = await loadAccounts(
      fake(200, { cap: 20, authorizedTesters: 0, owner: 1, accounts: [] }).fn,
    );
    expect(v).toEqual({
      ok: true,
      value: { cap: 20, authorizedTesters: 0, owner: 1, accounts: [], warnings: [] },
    });
    expect(await loadAccounts(fake(503, { error: 'accounts_view_unavailable' }).fn)).toEqual({
      ok: false,
      error: 'unavailable',
    });
    expect(await loadAccounts(fake(200, undefined).fn)).toEqual({ ok: false, error: 'network' });
  });

  it('masking and labels', () => {
    expect(maskAddress(' New.Tester@example.invalid')).toBe('ne***@example.invalid');
    expect(maskAddress('a@example.invalid')).toBe('a***@example.invalid');
    expect(maskAddress('nonsense')).toBe('***');
    expect(testerLabel('p_abcdefghijk')).toBe('p_abcdef…');
    expect(testerLabel(null)).toBe('—');
    expect(plausibleAddress('x@example.invalid')).toBe(true);
    expect(plausibleAddress('x@y')).toBe(false);
    expect(plausibleAddress('two words@example.invalid')).toBe(false);
  });

  it("Phase C: add with a name, rename; names travel only in the owner's own requests", async () => {
    const f = fake(200, { id: 'x', ok: true, code: 'done', masked: 'ne***@example.invalid' });
    await addTester(f.fn, 'n@example.invalid', '  Alex T. ');
    expect(JSON.parse(f.calls[0]!.init?.body as string)).toEqual({
      email: 'n@example.invalid',
      name: 'Alex T.',
    });
    await addTester(f.fn, 'n@example.invalid', '   ');
    expect(JSON.parse(f.calls[1]!.init?.body as string)).toEqual({ email: 'n@example.invalid' });
    await renameTester(f.fn, 't_AAAAAAAAAAAAAAAA', 'אלכס ט.');
    expect(f.calls[2]!.url).toBe('/admin-api/accounts/rename');
    expect(JSON.parse(f.calls[2]!.init?.body as string)).toEqual({
      target: 't_AAAAAAAAAAAAAAAA',
      name: 'אלכס ט.',
    });
    expect(interpretMutation(400, { error: 'invalid_name' })).toEqual({
      kind: 'refused',
      error: 'invalid_name',
    });
  });

  it("Phase C: the display-name rule is the server's", () => {
    expect(normalizeDisplayName('  Alex   T. ')).toBe('Alex T.');
    expect(normalizeDisplayName('e\u0301')).toBe('\u00e9');
    for (const ok of ["O'Neil", 'Jean-Luc', 'שָׁלוֹם', 'x'.repeat(60)])
      expect(normalizeDisplayName(ok)).toBe(ok);
    for (const bad of [
      '',
      ' ',
      '-x',
      'x1',
      'x_y',
      'x\u00a0y',
      'x\u202ey',
      '\u0301x',
      'x'.repeat(61),
    ])
      expect(normalizeDisplayName(bad), JSON.stringify(bad)).toBeNull();
  });

  it('Phase C: times are Israel time, in the UI language', () => {
    // 2026-11-02 15:07 UTC = 17:07 in Israel (IST, UTC+2 after the October change)
    expect(israelTime('2026-11-02T15:07:20.000001Z', 'en')).toMatch(/5:07\s?PM/);
    expect(israelTime('2026-07-01T14:33:00Z', 'en')).toMatch(/5:33\s?PM/); // IDT, UTC+3
    expect(israelTime('2026-11-02T15:07:20Z', 'he')).toContain('17:07');
    expect(israelTime(null, 'en')).toBeNull();
    expect(israelTime('soon', 'en')).toBeNull();
  });

  it('Phase C: filters, order, counts and the cap (authorized testers only)', async () => {
    const row = (p: Partial<AccountRow>): AccountRow => ({
      target: 't_AAAAAAAAAAAAAAAA',
      masked: 'aa***@example.invalid',
      class: 'alpha_tester',
      status: 'authorized',
      dateAdded: '2026-11-01',
      googleIdRecorded: false,
      displayName: null,
      firstSignIn: null,
      lastSignIn: null,
      signIns: 0,
      lastSeen: null,
      statusUpdated: null,
      ...p,
    });
    const v: AccountsView = {
      generated: null,
      cap: 30,
      authorizedTesters: 2,
      owner: 1,
      warnings: [],
      accounts: [
        row({ target: 't_B', displayName: 'Zeev' }),
        row({ target: 't_C', status: 'revoked', displayName: 'Dana' }),
        row({ target: 't_O', class: 'owner', displayName: 'Owner' }),
        row({ target: 't_A', displayName: 'Avi' }),
      ],
    };
    expect(visibleAccounts(v, 'active').map((a) => a.target)).toEqual(['t_O', 't_A', 't_B']);
    expect(visibleAccounts(v, 'disabled').map((a) => a.target)).toEqual(['t_C']);
    expect(visibleAccounts(v, 'all')).toHaveLength(4);
    expect(accountCounts(v)).toEqual({ active: 3, disabled: 1, all: 4 });
    expect(capFull(v)).toBe(false);
    expect(capFull({ ...v, authorizedTesters: 30 })).toBe(true);
    // an older view without the Phase C fields still loads, with safe defaults
    const f = fake(200, {
      cap: 30,
      authorizedTesters: 0,
      owner: 1,
      accounts: [{ target: 't_X', masked: 'x***@e.invalid', class: 'owner', status: 'authorized' }],
    });
    const l = await loadAccounts(f.fn);
    expect(l.ok && l.value.accounts[0]).toMatchObject({
      displayName: null,
      signIns: 0,
      lastSeen: null,
    });
  });
});
