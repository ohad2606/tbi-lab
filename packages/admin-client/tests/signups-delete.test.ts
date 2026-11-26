/** K12: list every stored sign-up request and delete one. Synthetic data only. */
import { describe, expect, it } from 'vitest';
import { deleteSignup, loadAllSignups } from '../src/index.js';

const ID = '01JD0000000000000000000000';

type Call = { url: string; init: RequestInit | undefined };
function fake(status: number, body: unknown) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? 'x' : JSON.stringify(body), { status });
  };
  return { fn, calls };
}
const rec = (id: string, createdAt: string, status: string) => ({
  id,
  name: 'Dana Example',
  email: 'dana@example.invalid',
  role: 'teacher',
  lang: 'he',
  status,
  accountAdded: false,
  emailAttempts: 0,
  lastError: null,
  createdAt,
});

describe('loadAllSignups', () => {
  it('reads every status from GET /signups, oldest first, never cached', async () => {
    const f = fake(200, {
      signups: [
        rec('b1', '2026-11-02T10:00:00Z', 'email_sent'),
        { id: '../x' },
        rec('a1', '2026-11-01T10:00:00Z', 'rejected'),
      ],
    });
    const r = await loadAllSignups(f.fn);
    expect(f.calls.map((c) => c.url)).toEqual(['/admin-api/signups']);
    expect(f.calls[0]!.init?.cache).toBe('no-store');
    expect(f.calls[0]!.init?.method).toBeUndefined();
    expect(r.ok && r.value.map((x) => [x.id, x.status])).toEqual([
      ['a1', 'rejected'],
      ['b1', 'email_sent'],
    ]);
  });
  it('maps failures; 404 (feature off) is unavailable', async () => {
    const err = async (s: number, body: unknown = { error: 'x' }) => {
      const r = await loadAllSignups(fake(s, body).fn);
      return r.ok ? null : r.error;
    };
    expect(await err(404)).toBe('unavailable');
    expect(await err(401)).toBe('signed_out');
    expect(await err(403)).toBe('forbidden');
    expect(await err(429)).toBe('rate_limited');
    expect(await err(500)).toBe('network');
    expect(await err(200, { nope: 1 })).toBe('network');
  });
});

describe('deleteSignup', () => {
  it('sends one same-origin JSON DELETE for exactly that id', async () => {
    const f = fake(200, { deleted: true });
    expect(await deleteSignup(f.fn, ID)).toEqual({ kind: 'deleted' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(`/admin-api/signups/${ID}`);
    const init = f.calls[0]!.init!;
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(init.body).toBeUndefined();
  });
  it.each<[number, unknown, object]>([
    [200, { deleted: true, note: 'already_deleted' }, { kind: 'already_deleted' }],
    [404, { error: 'not_found' }, { kind: 'not_found' }],
    [403, { error: 'csrf' }, { kind: 'failed', error: 'csrf' }],
    [403, { error: 'forbidden' }, { kind: 'failed', error: 'forbidden' }],
    [401, { error: 'identity_required' }, { kind: 'failed', error: 'signed_out' }],
    [429, { error: 'rate_limited', retryAfterS: 42 }, { kind: 'rate_limited', retryAfterS: 42 }],
    [429, { error: 'rate_limited' }, { kind: 'rate_limited', retryAfterS: null }],
    [429, { retryAfterS: '<b>' }, { kind: 'rate_limited', retryAfterS: null }],
    [500, { error: 'internal' }, { kind: 'failed', error: 'server' }],
    [503, { error: 'x' }, { kind: 'failed', error: 'unavailable' }],
    [502, undefined, { kind: 'failed', error: 'network' }],
    [200, {}, { kind: 'failed', error: 'network' }],
    [200, undefined, { kind: 'failed', error: 'network' }],
  ])('status %i %j', async (status, body, want) => {
    expect(await deleteSignup(fake(status, body).fn, ID)).toEqual(want);
  });
  it('a failed fetch is "network"', async () => {
    const out = await deleteSignup(() => Promise.reject(new TypeError('offline')), ID);
    expect(out).toEqual({ kind: 'failed', error: 'network' });
  });
  it.each([
    '',
    'a1',
    ID.slice(1),
    `${ID}0`,
    ID.toLowerCase(),
    ID.replace('0', 'I'),
    '../accounts/xxxxxxxxxxxxxx',
    `${ID}/approve`,
  ])('never calls fetch for the bad id %j', async (bad) => {
    const f = fake(200, { deleted: true });
    expect(await deleteSignup(f.fn, bad)).toEqual({ kind: 'failed', error: 'invalid_id' });
    expect(f.calls).toHaveLength(0);
  });
});
