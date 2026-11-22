/** TBI-022 follow-up (security review): race-free dedupe, limiter order, notified marker, nonce TTL, error classes, audit. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NonceCache, sign, verifyRequest } from '../signup/hmac.js';
import { readSecret } from '../signup/http.js';
import { SlidingWindowLimiter } from '../signup/limits.js';
import { SignupApprover, SignupIntake } from '../signup/service.js';
import { PendingStore } from '../signup/store.js';

const SECRET = Buffer.from('test-secret-not-real-0123456789abcdef');
const GOOD = { name: 'Dana', email: 'dana@example.com', role: 'T', lang: 'en', consent: true };
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
async function mkStore(opts: { maxRecords?: number; now?: () => number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tbi-signup-h-'));
  roots.push(root);
  const store = new PendingStore(join(root, 'p'), opts);
  await store.init();
  return { root, dir: join(root, 'p'), store };
}
const T = Date.UTC(2026, 10, 20, 12);
function signed(body: unknown, nonce: string) {
  const raw = Buffer.from(JSON.stringify(body));
  const ts = Math.floor(T / 1000);
  return {
    raw,
    headers: {
      'x-tbi-timestamp': String(ts),
      'x-tbi-nonce': nonce,
      'x-tbi-signature': sign(SECRET, ts, nonce, raw),
    },
  };
}
const input = { ...GOOD, lang: 'en' as const, consent: true as const };

describe('dedupe is race-free and hash-keyed', () => {
  it('N concurrent creates for one address yield one record; marker holds no plaintext address', async () => {
    const { dir, store } = await mkStore();
    const rs = await Promise.all(Array.from({ length: 8 }, () => store.createIfNew(input)));
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    for (const f of readdirSync(dir)) expect(f).not.toContain('dana');
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), 'utf8')).toBeDefined();
    const marker = readdirSync(dir).find((f) => f.endsWith('.mark'))!;
    expect(readFileSync(join(dir, marker), 'utf8')).not.toContain('dana@');
  });
  it('a second store object over the same dir (another process) also sees the marker', async () => {
    const { dir, store } = await mkStore();
    const other = new PendingStore(dir);
    expect((await store.createIfNew(input)).created).toBe(true);
    expect((await other.createIfNew(input)).created).toBe(false);
  });
  it('rejected or vanished record frees the address', async () => {
    const { store } = await mkStore();
    const a = await store.createIfNew(input);
    await store.update(a.record.id, { status: 'rejected' });
    expect((await store.createIfNew(input)).created).toBe(true);
  });
  it('full store is refused', async () => {
    const { store } = await mkStore({ maxRecords: 1 });
    await store.createIfNew(input);
    await expect(store.createIfNew({ ...input, email: 'b@example.com' })).rejects.toMatchObject({
      code: 'full',
    });
  });
  it('intake: concurrent same-address posts give one record and one notification', async () => {
    const { store } = await mkStore();
    let notes = 0;
    const intake = new SignupIntake({
      secret: SECRET,
      store,
      notifier: { notify: async () => void notes++ } as never,
      now: () => T,
      sourceRate: new SlidingWindowLimiter({ count: 99, windowMs: 1000 }, () => T),
      globalRate: new SlidingWindowLimiter({ count: 99, windowMs: 1000 }, () => T),
      nonces: new NonceCache(),
    });
    const rs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => {
        const s = signed(GOOD, `n${i}`.padEnd(20, 'x'));
        return intake.submit('s', s.headers, s.raw);
      }),
    );
    expect(rs.every((r) => r.status === 202)).toBe(true);
    expect(notes).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });
});

describe('global limiter is only spent by verified requests', () => {
  it('unsigned junk from many sources does not consume the global budget', async () => {
    const { store } = await mkStore();
    const intake = new SignupIntake({
      secret: SECRET,
      store,
      notifier: null,
      now: () => T,
      sourceRate: new SlidingWindowLimiter({ count: 99, windowMs: 1000 }, () => T),
      globalRate: new SlidingWindowLimiter({ count: 1, windowMs: 60_000 }, () => T),
      nonces: new NonceCache(),
    });
    for (let i = 0; i < 20; i++)
      expect((await intake.submit(`src${i}`, {}, Buffer.from('x'))).status).toBe(401);
    const s = signed(GOOD, 'g'.repeat(20));
    expect((await intake.submit('legit', s.headers, s.raw)).status).toBe(202);
    const s2 = signed({ ...GOOD, email: 'z@example.com' }, 'h'.repeat(20));
    expect((await intake.submit('legit2', s2.headers, s2.raw)).status).toBe(429);
  });
});

describe('notified is a separate marker', () => {
  it('markNotified never overwrites an owner update', async () => {
    const { store } = await mkStore();
    const { record } = await store.createIfNew(input);
    await store.update(record.id, { status: 'approved' });
    await store.markNotified(record.id);
    expect(await store.get(record.id)).toMatchObject({ status: 'approved', notified: true });
  });
});

describe('nonce ttl', () => {
  it('ttl is derived as 2x the window and a larger verify window is refused', () => {
    const c = new NonceCache({ windowMs: 1000 });
    expect(c.ttlMs).toBe(2000);
    const hdr = signed(GOOD, 'q'.repeat(20));
    expect(() =>
      verifyRequest({
        secret: SECRET,
        headers: hdr.headers,
        body: hdr.raw,
        now: T,
        nonces: c,
        windowMs: 5000,
      }),
    ).toThrow(/window/);
  });
  it('a nonce is still remembered at the far edge of the window', () => {
    const c = new NonceCache({ windowMs: 1000 });
    expect(c.take('a', 0)).toBe(true);
    expect(c.take('a', 1999)).toBe(false);
    expect(c.take('a', 2001)).toBe(true);
  });
});

describe('error classes carry no paths', () => {
  it('readSecret maps fs errors to a class', async () => {
    await expect(readSecret('/nonexistent/dir/secret-file')).rejects.toThrow(/^secret_missing$/);
    const { root } = await mkStore();
    writeFileSync(join(root, 's'), 'short', { mode: 0o600 }); // 0600: other-readable is refused first
    await expect(readSecret(join(root, 's'))).rejects.toThrow(/^secret_short$/);
  });
  it('approver stores a class, not a path, in lastError', async () => {
    const { store } = await mkStore();
    const { record } = await store.createIfNew(input);
    const approver = new SignupApprover({
      store,
      accounts: { add: async () => 'done' },
      email: {
        sendApproval: async () => {
          throw Object.assign(new Error("ENOENT: open '/etc/secret/key'"), { code: 'ENOENT' });
        },
      },
    });
    const r = await approver.approve(record.id);
    expect(r).toMatchObject({ ok: false, code: 'email_failed' });
    const rec = await store.get(record.id);
    expect(rec.lastError).toBe('secret_missing');
    expect(JSON.stringify(rec)).not.toContain('/etc');
  });
  it('approve on email_failed points to resend (not ok/already_done)', async () => {
    const { store } = await mkStore();
    const { record } = await store.createIfNew(input);
    await store.update(record.id, { status: 'email_failed', accountAdded: true });
    const approver = new SignupApprover({
      store,
      accounts: { add: async () => 'done' },
      email: { sendApproval: async () => undefined },
    });
    expect(await approver.approve(record.id)).toMatchObject({
      ok: false,
      code: 'email_failed_use_resend',
    });
  });
});

describe('audit log', () => {
  it('appends id, action, outcome and time only; 0600', async () => {
    const { dir, store } = await mkStore({ now: () => T });
    const { record } = await store.createIfNew(input);
    const approver = new SignupApprover({
      store,
      accounts: { add: async () => 'done' },
      email: { sendApproval: async () => undefined },
      now: () => T,
    });
    await approver.approve(record.id);
    await approver.reject(record.id);
    const lines = readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n');
    expect(lines).toEqual([
      `${new Date(T).toISOString()} ${record.id} approve ok`,
      `${new Date(T).toISOString()} ${record.id} reject bad_state`,
    ]);
    expect(statSync(join(dir, 'audit.log')).mode & 0o777).toBe(0o600);
    expect(lines.join('')).not.toContain('dana');
  });
});
