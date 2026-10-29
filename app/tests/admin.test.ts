/** Sprint 23B: the owner's administration, client logic (answers, masking, request shapes). */
import { describe, expect, it } from 'vitest';
import {
  addTester,
  deleteTesterReports,
  interpretMutation,
  isOwner,
  loadAccounts,
  loadReport,
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
    expect(f.calls[0]!.url).toBe('/runtime/admin/accounts');
    expect(f.calls[0]!.init?.method).toBe('POST');
    expect(new Headers(f.calls[0]!.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(f.calls[0]!.init?.body as string)).toEqual({ email: 'New@example.invalid' });
    await setAccess(f.fn, 'disable', 't_AAAAAAAAAAAAAAAA');
    expect(f.calls[1]!.url).toBe('/runtime/admin/accounts/disable');
    expect(JSON.parse(f.calls[1]!.init?.body as string)).toEqual({ target: 't_AAAAAAAAAAAAAAAA' });
    expect(await deleteTesterReports(f.fn, 'not a principal')).toBeNull();
    expect(f.calls).toHaveLength(2);
    expect(await requestResult(f.fn, '../etc')).toEqual({ kind: 'refused', error: 'invalid' });
    expect(await loadReport(f.fn, '../../x')).toEqual({ ok: false, error: 'network' });
    expect(f.calls).toHaveLength(2);
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
});
