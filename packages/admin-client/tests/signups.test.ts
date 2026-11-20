/** TBI-022 slice D: the sign-up requests calls (design §6.1). Synthetic data only. */
import { describe, expect, it } from 'vitest';
import { interpretSignup, loadPendingSignups, signupAction } from '../src/index.js';

type Call = { url: string; init: RequestInit | undefined };
function fake(status: number, body: unknown) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? 'x' : JSON.stringify(body), { status });
  };
  return { fn, calls };
}
const rec = (id: string, createdAt: string, extra: object = {}) => ({
  id,
  name: 'Dana Example',
  email: 'dana@example.invalid',
  role: 'teacher',
  lang: 'he',
  status: 'pending',
  accountAdded: false,
  emailAttempts: 0,
  lastError: null,
  createdAt,
  ...extra,
});

describe('loadPendingSignups', () => {
  it('reads the admin service, oldest first, dropping malformed rows', async () => {
    const f = fake(200, {
      signups: [
        rec('b1', '2026-11-02T10:00:00Z'),
        { id: '../x' },
        rec('a1', '2026-11-01T10:00:00Z'),
      ],
    });
    const r = await loadPendingSignups(f.fn);
    expect(f.calls[0]!.url).toBe('/admin-api/signups/pending');
    expect(r.ok && r.value.map((x) => x.id)).toEqual(['a1', 'b1']);
  });
  it('maps statuses to load errors; 404 (feature off) is unavailable', async () => {
    const err = async (s: number) => {
      const r = await loadPendingSignups(fake(s, { error: 'x' }).fn);
      return r.ok ? null : r.error;
    };
    expect(await err(401)).toBe('signed_out');
    expect(await err(403)).toBe('forbidden');
    expect(await err(404)).toBe('unavailable');
    expect(await err(429)).toBe('rate_limited');
    expect(await err(500)).toBe('network');
    const bad = await loadPendingSignups(fake(200, { nope: 1 }).fn);
    expect(bad).toEqual({ ok: false, error: 'network' });
  });
});

describe('signupAction', () => {
  it('POSTs an empty JSON body to the id and action, same origin', async () => {
    const f = fake(200, { record: rec('a1', '2026-11-01T10:00:00Z') });
    await signupAction(f.fn, 'a1', 'approve');
    const c = f.calls[0]!;
    expect(c.url).toBe('/admin-api/signups/a1/approve');
    expect(c.init?.method).toBe('POST');
    expect(c.init?.body).toBe('{}');
    expect(c.init?.credentials).toBe('same-origin');
    expect(new Headers(c.init?.headers).get('content-type')).toBe('application/json');
  });
  it('never builds a path from a malformed id or action', async () => {
    const f = fake(200, {});
    expect(await signupAction(f.fn, '../accounts', 'approve')).toMatchObject({ kind: 'refused' });
    expect(await signupAction(f.fn, 'a1', 'delete' as never)).toMatchObject({ kind: 'refused' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('interpretSignup', () => {
  it('200 with and without a note', () => {
    expect(interpretSignup(200, { record: rec('a1', 'x') })).toMatchObject({
      kind: 'done',
      note: null,
    });
    expect(interpretSignup(200, { record: rec('a1', 'x'), note: 'already_done' })).toMatchObject({
      note: 'already_done',
    });
    expect(interpretSignup(200, { note: 'weird' })).toMatchObject({ note: null, record: null });
  });
  it('202 account_pending', () => {
    expect(interpretSignup(202, { error: 'account_pending' })).toEqual({ kind: 'account_pending' });
  });
  it.each([
    [409, 'bad_state'],
    [409, 'email_failed_use_resend'],
    [502, 'cap_reached'],
    [502, 'account_error'],
    [502, 'email_failed'],
  ])('%i %s', (status, error) => {
    const o = interpretSignup(status, {
      error,
      record: rec('a1', 'x', { status: 'email_failed' }),
    });
    expect(o).toMatchObject({ kind: 'error', error });
  });
  it('404 is not_found; unknown codes and statuses are refusals', () => {
    expect(interpretSignup(404, { error: 'not_found' })).toMatchObject({ error: 'not_found' });
    expect(interpretSignup(409, { error: 'surprise' })).toEqual({
      kind: 'refused',
      error: 'network',
    });
    expect(interpretSignup(401, null)).toEqual({ kind: 'refused', error: 'signed_out' });
    expect(interpretSignup(403, { error: 'csrf' })).toEqual({ kind: 'refused', error: 'csrf' });
    expect(interpretSignup(429, {})).toEqual({ kind: 'refused', error: 'rate_limited' });
    expect(interpretSignup(null, null)).toEqual({ kind: 'refused', error: 'network' });
  });
});
