/** TBI-022: HMAC, replay, size and rate limits, validation, store (unit; no network, no real secrets). */
import {
  mkdtempSync,
  rmSync,
  statSync,
  readdirSync,
  writeFileSync,
  chmodSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { NonceCache, sign, verifyRequest } from '../signup/hmac.js';
import {
  BodyTooLarge,
  MAX_SIGNUP_BODY_BYTES,
  SlidingWindowLimiter,
  readCappedBody,
} from '../signup/limits.js';
import { PendingStore, StoreError } from '../signup/store.js';
import { validateSignup } from '../signup/validate.js';

const SECRET = Buffer.from('test-secret-not-real-0123456789abcdef');
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const NONCE = 'abcdefghijklmnop0123';
const BODY = Buffer.from('{"name":"A"}');

function hdrs(over: Record<string, string> = {}, ts = NOW / 1000, body = BODY, nonce = NONCE) {
  return {
    'x-tbi-timestamp': String(ts),
    'x-tbi-nonce': nonce,
    'x-tbi-signature': sign(SECRET, ts, nonce, body),
    ...over,
  };
}
const verify = (
  h: Record<string, string>,
  o: { now?: number; nonces?: NonceCache; body?: Buffer; secret?: Buffer } = {},
) =>
  verifyRequest({
    secret: o.secret ?? SECRET,
    headers: h,
    body: o.body ?? BODY,
    now: o.now ?? NOW,
    nonces: o.nonces ?? new NonceCache(),
  });

describe('HMAC verification', () => {
  it('accepts a correct signature', () => expect(verify(hdrs())).toEqual({ ok: true }));
  it('rejects a changed body, wrong secret, tampered timestamp and bad formats', () => {
    expect(verify(hdrs(), { body: Buffer.from('{"name":"B"}') })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verify(hdrs(), { secret: Buffer.from('x'.repeat(40)) })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verify(hdrs({ 'x-tbi-timestamp': String(NOW / 1000 + 1) }))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verify(hdrs({ 'x-tbi-signature': 'zz' }))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verify(hdrs({ 'x-tbi-signature': 'A'.repeat(64) }))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verify(hdrs({ 'x-tbi-timestamp': '12x' }))).toEqual({
      ok: false,
      reason: 'bad_timestamp',
    });
    expect(verify(hdrs({ 'x-tbi-nonce': 'short' }))).toEqual({ ok: false, reason: 'bad_nonce' });
  });
  it('requires all three headers', () => {
    for (const k of ['x-tbi-signature', 'x-tbi-timestamp', 'x-tbi-nonce']) {
      const h: Record<string, string> = hdrs();
      delete h[k];
      expect(verify(h)).toEqual({ ok: false, reason: 'missing_header' });
    }
  });
  it('replay window: 5 min inclusive, either direction', () => {
    expect(verify(hdrs(), { now: NOW + 300_000 })).toEqual({ ok: true });
    expect(verify(hdrs(), { now: NOW + 300_001 })).toEqual({ ok: false, reason: 'expired' });
    expect(verify(hdrs(), { now: NOW - 300_001 })).toEqual({ ok: false, reason: 'expired' });
  });
  it('rejects a replayed nonce, but a bad signature does not burn it', () => {
    const nonces = new NonceCache();
    expect(verify(hdrs({ 'x-tbi-signature': 'a'.repeat(64) }), { nonces }).ok).toBe(false);
    expect(verify(hdrs(), { nonces })).toEqual({ ok: true });
    expect(verify(hdrs(), { nonces })).toEqual({ ok: false, reason: 'replayed' });
  });
  it('nonce cache expires entries and is bounded', () => {
    const c = new NonceCache({ windowMs: 500, max: 2 }); // ttl = 2 x window = 1000
    expect(c.take('a', 0)).toBe(true);
    expect(c.take('a', 500)).toBe(false);
    expect(c.take('b', 600)).toBe(true);
    expect(c.take('c', 700)).toBe(false); // full of live entries: refuse, never evict
    expect(c.take('a', 1500)).toBe(true); // expired, free again
  });
});

describe('size and rate limits', () => {
  const req = (chunks: string[], headers: Record<string, string> = {}) =>
    Object.assign(Readable.from(chunks.map((c) => Buffer.from(c))), { headers }) as never;
  it('caps the body by header and by stream', async () => {
    await expect(
      readCappedBody(req(['x'], { 'content-length': String(MAX_SIGNUP_BODY_BYTES + 1) })),
    ).rejects.toBeInstanceOf(BodyTooLarge);
    await expect(
      readCappedBody(req(['x'.repeat(MAX_SIGNUP_BODY_BYTES), 'y'])),
    ).rejects.toBeInstanceOf(BodyTooLarge);
    expect((await readCappedBody(req(['ab', 'cd']))).toString()).toBe('abcd');
  });
  it('sliding window per key, with retry-after and bounded key table', () => {
    let t = 0;
    const l = new SlidingWindowLimiter({ count: 2, windowMs: 1000 }, () => t, 2);
    expect(l.take('a').ok).toBe(true);
    expect(l.take('a').ok).toBe(true);
    const r = l.take('a');
    expect(r).toEqual({ ok: false, retryAfterMs: 1000 });
    expect(l.take('b').ok).toBe(true); // other keys unaffected
    expect(l.take('c').ok).toBe(false); // table full
    t = 1001;
    expect(l.take('a').ok).toBe(true);
    expect(l.take('c').ok).toBe(true); // swept
  });
});

describe('validation', () => {
  const ok = {
    name: '  Dana   Levi ',
    email: ' Dana@Example.COM ',
    role: 'Teacher',
    lang: 'he',
    consent: true,
  };
  it('normalises a good request', () => {
    expect(validateSignup(ok)).toEqual({
      ok: true,
      value: {
        name: 'Dana Levi',
        email: 'dana@example.com',
        role: 'Teacher',
        lang: 'he',
        consent: true,
      },
    });
  });
  it('strips control and bidi characters', () => {
    const r = validateSignup({ ...ok, name: 'Da‮na\n\u0000X' });
    expect(r).toMatchObject({ ok: true, value: { name: 'Da na X' } });
  });
  it.each([
    [{ ...ok, extra: 1 }, 'body'],
    [{ ...ok, name: '' }, 'name'],
    [{ ...ok, name: 'x'.repeat(81) }, 'name'],
    [{ ...ok, name: 5 }, 'name'],
    [{ ...ok, email: 'not-an-email' }, 'email'],
    [{ ...ok, email: 'a@b.c' }, 'email'],
    [{ ...ok, role: '   ' }, 'role'],
    [{ ...ok, lang: 'fr' }, 'lang'],
    [{ ...ok, consent: 'yes' }, 'consent'],
    [{ ...ok, consent: false }, 'consent'],
    [[], 'body'],
    [null, 'body'],
  ])('refuses %j', (input, field) => {
    expect(validateSignup(input)).toEqual({ ok: false, field });
  });
});

describe('pending store', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const mk = (opts: { now?: () => number; maxRecords?: number } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'tbi-signup-'));
    dirs.push(root);
    return { root, dir: join(root, 'p'), store: new PendingStore(join(root, 'p'), opts) };
  };
  const input = {
    name: 'A',
    email: 'a@example.com',
    role: 'r',
    lang: 'en' as const,
    consent: true as const,
  };

  it('creates 0700 dir and 0600 files, atomically (no temp left)', async () => {
    const { dir, store } = mk();
    await store.init();
    const r = await store.create(input);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, `${r.id}.json`)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([`${r.id}.json`]);
    expect(r).toMatchObject({ status: 'pending', accountAdded: false, emailAttempts: 0, ...input });
    expect(await store.get(r.id)).toEqual(r);
  });
  it('refuses a directory others can read', async () => {
    const { root, dir, store } = mk();
    await store.init();
    chmodSync(dir, 0o750);
    await expect(store.init()).rejects.toMatchObject({ code: 'unsafe_dir' });
    void root;
  });
  it('unique ids, update keeps createdAt, bad ids and corrupt files are errors', async () => {
    const { dir, store } = mk();
    await store.init();
    const a = await store.create(input);
    const b = await store.create(input);
    expect(a.id).not.toBe(b.id);
    const u = await store.update(a.id, { status: 'approved' });
    expect(u.createdAt).toBe(a.createdAt);
    expect(u.status).toBe('approved');
    await expect(store.get('../etc/passwd')).rejects.toBeInstanceOf(StoreError);
    await expect(store.get('0123456789ABCDEFGHJKMNPQRS')).rejects.toMatchObject({
      code: 'not_found',
    });
    writeFileSync(join(dir, `${b.id}.json`), '{nope', { mode: 0o600 });
    await expect(store.get(b.id)).rejects.toMatchObject({ code: 'corrupt' });
    expect((await store.list()).map((r) => r.id)).toEqual([a.id]);
  });
  it('caps the number of records', async () => {
    const { store } = mk({ maxRecords: 1 });
    await store.init();
    await store.create(input);
    await expect(store.create(input)).rejects.toMatchObject({ code: 'full' });
  });
  it('purge: not approved (pending, rejected) 90 d, all others 365 d by creation; stale temp files removed', async () => {
    let t = Date.UTC(2026, 0, 1);
    const { dir, store } = mk({ now: () => t });
    await store.init();
    const mkRec = async (
      status: 'pending' | 'rejected' | 'email_sent' | 'approved' | 'email_failed' | 'email_queued',
    ) => {
      const r = await store.create({ ...input, email: `${status}@example.com` });
      return store.update(r.id, { status });
    };
    const rej = await mkRec('rejected');
    const pen = await mkRec('pending');
    const kept = [
      await mkRec('email_sent'),
      await mkRec('approved'),
      await mkRec('email_failed'),
      await mkRec('email_queued'),
    ].map((r) => r.id);
    const tmp = join(dir, 'x.abc.tmp');
    writeFileSync(tmp, '');
    utimesSync(tmp, new Date(t - 7200_000), new Date(t - 7200_000));
    t += 89 * 86_400_000;
    expect(await store.purge()).toEqual([]);
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
    t += 86_400_000; // 90 d
    expect((await store.purge()).sort()).toEqual([rej.id, pen.id].sort());
    t += 274 * 86_400_000; // 364 d
    expect(await store.purge()).toEqual([]);
    t += 86_400_000; // 365 d
    expect((await store.purge()).sort()).toEqual([...kept].sort());
    expect(await store.list()).toEqual([]);
  });
});
