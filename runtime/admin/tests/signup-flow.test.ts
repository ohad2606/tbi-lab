/** TBI-022: intake, notifier, email, approve/reject/resend workflow, HTTP handler. All fakes; no network. */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approvalEmail, ResendSender } from '../signup/email.js';
import { NonceCache, sign } from '../signup/hmac.js';
import { handleSignupRequest, signupConfigFromEnv, spoolAccountAdder } from '../signup/http.js';
import { SlidingWindowLimiter } from '../signup/limits.js';
import { TelegramNotifier, type FetchLike } from '../signup/notify.js';
import {
  SignupApprover,
  SignupIntake,
  type AccountAdder,
  type AddOutcome,
} from '../signup/service.js';
import { PendingStore } from '../signup/store.js';

const SECRET = Buffer.from('test-secret-not-real-0123456789abcdef');
const TG_TOKEN = '1234567:AAAAAAAAAAAAAAAAAAAAAAAAAAAA_test';
const RESEND_KEY = 're_testkey_not_real_123';
const GOOD = {
  name: 'Dana Levi',
  email: 'dana@example.com',
  role: 'Teacher',
  lang: 'he',
  consent: true,
};

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function newStore(now?: () => number) {
  const root = mkdtempSync(join(tmpdir(), 'tbi-signup-flow-'));
  roots.push(root);
  const store = new PendingStore(join(root, 'p'), { now, maxRecords: 100 });
  await store.init();
  return store;
}

interface Sent {
  url: string;
  init: Parameters<FetchLike>[1];
}
function fakeFetch(
  answer: (s: Sent) => { ok: boolean; status: number } | Error = () => ({ ok: true, status: 200 }),
) {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    sent.push({ url, init });
    const a = answer({ url, init });
    if (a instanceof Error) throw a;
    return a;
  };
  return { sent, fetch };
}

function signed(body: unknown, now: number, nonce = 'n'.repeat(20), secret = SECRET) {
  const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const ts = Math.floor(now / 1000);
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'x-tbi-timestamp': String(ts),
      'x-tbi-nonce': nonce,
      'x-tbi-signature': sign(secret, ts, nonce, raw),
    },
  };
}

async function intakeSetup(opts: { notifyFails?: boolean; now?: number } = {}) {
  const t = opts.now ?? Date.UTC(2026, 10, 20, 12);
  const store = await newStore(() => t);
  const tg = fakeFetch(() =>
    opts.notifyFails ? { ok: false, status: 500 } : { ok: true, status: 200 },
  );
  const logs: string[] = [];
  const intake = new SignupIntake({
    secret: SECRET,
    store,
    notifier: new TelegramNotifier({
      readToken: async () => `${TG_TOKEN}\n`,
      chatId: '42',
      adminLink: 'https://admin.example.invalid/signups',
      fetch: tg.fetch,
    }),
    now: () => t,
    sourceRate: new SlidingWindowLimiter({ count: 3, windowMs: 60_000 }, () => t),
    globalRate: new SlidingWindowLimiter({ count: 100, windowMs: 60_000 }, () => t),
    nonces: new NonceCache(),
    log: (l) => logs.push(l),
  });
  return { t, store, tg, intake, logs };
}

describe('intake', () => {
  it('stores a signed request as pending and notifies with name, role and link only', async () => {
    const s = await intakeSetup();
    const { raw, headers } = signed(GOOD, s.t);
    expect(await s.intake.submit('1.2.3.4', headers, raw)).toEqual({ status: 202 });
    const [rec] = await s.store.list();
    expect(rec).toMatchObject({
      status: 'pending',
      email: 'dana@example.com',
      lang: 'he',
      notified: true,
    });
    expect(s.tg.sent).toHaveLength(1);
    const msg = JSON.parse(s.tg.sent[0]!.init.body) as { text: string; chat_id: string };
    expect(msg.text).toContain('Dana Levi');
    expect(msg.text).toContain('Teacher');
    expect(msg.text).toContain('https://admin.example.invalid/signups');
    expect(msg.text).not.toContain('dana@example.com');
  });
  it('a bad or missing signature stores nothing, notifies nothing, answers one generic 401', async () => {
    const s = await intakeSetup();
    const { raw, headers } = signed(GOOD, s.t, undefined, Buffer.from('y'.repeat(40)));
    expect(await s.intake.submit('x', headers, raw)).toEqual({
      status: 401,
      error: 'unauthorized',
    });
    expect(await s.intake.submit('x', {}, raw)).toEqual({ status: 401, error: 'unauthorized' });
    expect(await s.store.list()).toEqual([]);
    expect(s.tg.sent).toEqual([]);
  });
  it('rejects a replay, a stale timestamp, and invalid fields', async () => {
    const s = await intakeSetup();
    const a = signed(GOOD, s.t);
    expect((await s.intake.submit('x', a.headers, a.raw)).status).toBe(202);
    expect((await s.intake.submit('x', a.headers, a.raw)).status).toBe(401);
    const old = signed({ ...GOOD, email: 'o@example.com' }, s.t - 400_000, 'o'.repeat(20));
    expect((await s.intake.submit('x2', old.headers, old.raw)).status).toBe(401);
    const bad = signed({ ...GOOD, consent: false }, s.t, 'b'.repeat(20));
    expect(await s.intake.submit('x3', bad.headers, bad.raw)).toEqual({
      status: 400,
      error: 'invalid',
    });
    const junk = signed('not json', s.t, 'j'.repeat(20));
    expect((await s.intake.submit('x4', junk.headers, junk.raw)).status).toBe(400);
    expect(await s.store.list()).toHaveLength(1);
  });
  it('per-source rate limit applies before verification; other sources unaffected', async () => {
    const s = await intakeSetup();
    for (let i = 0; i < 3; i++) await s.intake.submit('flood', {}, Buffer.from('x'));
    const r = await s.intake.submit('flood', {}, Buffer.from('x'));
    expect(r).toMatchObject({ status: 429, error: 'rate_limited' });
    expect((await s.intake.submit('other', {}, Buffer.from('x'))).status).toBe(401);
  });
  it('a duplicate address is answered 202 but stored and notified once; after rejection it may re-apply', async () => {
    const s = await intakeSetup();
    const a = signed(GOOD, s.t, 'a'.repeat(20));
    const b = signed(GOOD, s.t, 'b'.repeat(20));
    expect((await s.intake.submit('x', a.headers, a.raw)).status).toBe(202);
    expect((await s.intake.submit('x', b.headers, b.raw)).status).toBe(202);
    expect(await s.store.list()).toHaveLength(1);
    expect(s.tg.sent).toHaveLength(1);
    const [rec] = await s.store.list();
    await s.store.update(rec!.id, { status: 'rejected' });
    const c = signed(GOOD, s.t, 'c'.repeat(20));
    await s.intake.submit('y', c.headers, c.raw);
    expect(await s.store.list()).toHaveLength(2);
  });
  it('a failing notifier does not lose the request; the log has no token or address', async () => {
    const s = await intakeSetup({ notifyFails: true });
    const { raw, headers } = signed(GOOD, s.t);
    expect((await s.intake.submit('x', headers, raw)).status).toBe(202);
    expect((await s.store.list())[0]).toMatchObject({ status: 'pending', notified: false });
    const log = s.logs.join('\n');
    expect(log).toContain('notify failed');
    expect(log).not.toContain(TG_TOKEN);
    expect(log).not.toContain('dana@');
  });
  it('a store that is full answers 503', async () => {
    const t = Date.UTC(2026, 10, 20, 12);
    const root = mkdtempSync(join(tmpdir(), 'tbi-signup-flow-'));
    roots.push(root);
    const store = new PendingStore(join(root, 'p'), { maxRecords: 0 });
    await store.init();
    const intake = new SignupIntake({
      secret: SECRET,
      store,
      notifier: null,
      now: () => t,
      sourceRate: new SlidingWindowLimiter({ count: 9, windowMs: 1000 }, () => t),
      globalRate: new SlidingWindowLimiter({ count: 9, windowMs: 1000 }, () => t),
      nonces: new NonceCache(),
    });
    const { raw, headers } = signed(GOOD, t);
    expect(await intake.submit('x', headers, raw)).toEqual({ status: 503, error: 'unavailable' });
  });
});

describe('telegram notifier', () => {
  const mk = (token: string, f: ReturnType<typeof fakeFetch>) =>
    new TelegramNotifier({
      readToken: async () => token,
      chatId: '1',
      adminLink: 'https://a.invalid/x',
      fetch: f.fetch,
    });
  it('errors never carry the token or URL', async () => {
    const f = fakeFetch(() => new Error(`connect failed https://api.telegram.org/bot${TG_TOKEN}`));
    const err = await mk(TG_TOKEN, f)
      .notify({ name: 'A', role: 'B' })
      .catch((e: Error) => e);
    expect((err as Error).message).toBe('network');
    const g = fakeFetch(() => ({ ok: false, status: 403 }));
    expect(
      await mk(TG_TOKEN, g)
        .notify({ name: 'A', role: 'B' })
        .catch((e: Error) => e.message),
    ).toBe('http_403');
  });
  it('refuses a malformed token without calling out', async () => {
    const f = fakeFetch();
    await expect(mk('garbage', f).notify({ name: 'A', role: 'B' })).rejects.toThrow('bad_token');
    expect(f.sent).toEqual([]);
  });
});

describe('approval email', () => {
  it('HE and EN content: lab link, same Google account, desktop Chrome/Edge, limited places, reply; no owner name', () => {
    const he = approvalEmail('he', 'דנה', { labUrl: 'https://lab.example.invalid/' });
    const en = approvalEmail('en', 'Dana', { labUrl: 'https://lab.example.invalid/' });
    for (const m of [he, en]) {
      expect(m.text).toContain('https://lab.example.invalid/');
      expect(m.text).toMatch(/Chrome/);
      expect(m.text).toMatch(/Edge/);
    }
    expect(he.text).toContain('שלום דנה');
    expect(he.text).toContain('אותו חשבון Google');
    expect(he.text).toContain('מוגבלת במספר המקומות');
    expect(he.text).toContain('השיבו');
    expect(en.text).toContain('Hello Dana');
    expect(en.text).toContain('same Google account');
    expect(en.text).toContain('limited number of places');
    expect(en.text).toContain('reply to this email');
    expect(en.text).not.toMatch(/Ohad/i);
    expect(he.text).not.toMatch(/אוהד/);
  });
  it('Resend request: key from reader, from address from config, idempotency key, error class only', async () => {
    const f = fakeFetch();
    const s = new ResendSender({
      from: 'TBI Lab <support@example.invalid>',
      labUrl: 'https://lab.example.invalid/',
      readKey: async () => `${RESEND_KEY}\n`,
      fetch: f.fetch,
    });
    await s.sendApproval({ email: 'dana@example.com', name: 'Dana', lang: 'en', id: 'ID1' });
    const req = f.sent[0]!;
    expect(req.url).toBe('https://api.resend.com/emails');
    expect(req.init.headers.authorization).toBe(`Bearer ${RESEND_KEY}`);
    expect(req.init.headers['idempotency-key']).toBe('signup-approval-ID1');
    const body = JSON.parse(req.init.body);
    expect(body).toMatchObject({
      from: 'TBI Lab <support@example.invalid>',
      to: ['dana@example.com'],
    });
    const bad = new ResendSender({
      from: 'x',
      labUrl: 'x',
      readKey: async () => RESEND_KEY,
      fetch: fakeFetch(() => ({ ok: false, status: 422 })).fetch,
    });
    await expect(
      bad.sendApproval({ email: 'a@b.co', name: 'A', lang: 'en', id: 'I' }),
    ).rejects.toThrow('http_422');
    const noKey = new ResendSender({
      from: 'x',
      labUrl: 'x',
      readKey: async () => '',
      fetch: f.fetch,
    });
    await expect(
      noKey.sendApproval({ email: 'a@b.co', name: 'A', lang: 'en', id: 'I' }),
    ).rejects.toThrow('bad_key');
    expect(f.sent).toHaveLength(1);
  });
});

describe('approver', () => {
  async function setup(opts: { add?: AddOutcome[]; mail?: ('ok' | 'fail')[] } = {}) {
    const store = await newStore();
    const rec = await store.create({
      name: 'Dana',
      email: 'dana@example.com',
      role: 'T',
      lang: 'en',
      consent: true,
    });
    const adds: (string | null)[][] = [];
    const addQ = [...(opts.add ?? [])];
    const accounts: AccountAdder = {
      add: async (e, n) => (adds.push([e, n]), addQ.shift() ?? 'done'),
    };
    const mails: string[] = [];
    const mailQ = [...(opts.mail ?? [])];
    const email = {
      sendApproval: async (to: { id: string }) => {
        mails.push(to.id);
        if ((mailQ.shift() ?? 'ok') === 'fail') throw new Error('http_500');
      },
    };
    return { store, rec, adds, mails, approver: new SignupApprover({ store, accounts, email }) };
  }

  it('approve: adds the account once, sends once, ends email_sent; repeat and parallel calls are no-ops', async () => {
    const s = await setup();
    const [a, b] = await Promise.all([s.approver.approve(s.rec.id), s.approver.approve(s.rec.id)]);
    expect(a.ok && a.record.status).toBe('email_sent');
    expect(b).toMatchObject({ ok: true, note: 'already_done' });
    await s.approver.approve(s.rec.id);
    expect(s.adds).toEqual([['dana@example.com', 'Dana']]);
    expect(s.mails).toEqual([s.rec.id]);
  });
  it('email failure: status email_failed, account kept, approve does not resend, resend sends once', async () => {
    const s = await setup({ mail: ['fail', 'ok'] });
    const r = await s.approver.approve(s.rec.id);
    expect(r).toMatchObject({
      ok: false,
      code: 'email_failed',
      record: { status: 'email_failed', accountAdded: true, lastError: 'http_500' },
    });
    expect(await s.approver.approve(s.rec.id)).toMatchObject({
      ok: false,
      code: 'email_failed_use_resend',
    });
    expect(s.mails).toHaveLength(1);
    const again = await s.approver.resend(s.rec.id);
    expect(again.ok && again.record).toMatchObject({ status: 'email_sent', emailAttempts: 2 });
    expect(await s.approver.resend(s.rec.id)).toMatchObject({ ok: true, note: 'already_done' });
    expect(s.mails).toHaveLength(2);
    expect(s.adds).toHaveLength(1);
  });
  it('account cap or error: back to pending, nothing emailed; retry succeeds', async () => {
    const s = await setup({ add: ['cap_reached', 'error', 'done'] });
    expect(await s.approver.approve(s.rec.id)).toMatchObject({
      ok: false,
      code: 'cap_reached',
      record: { status: 'pending', lastError: 'cap_reached' },
    });
    expect(await s.approver.approve(s.rec.id)).toMatchObject({ ok: false, code: 'account_error' });
    expect(s.mails).toEqual([]);
    expect(await s.approver.approve(s.rec.id)).toMatchObject({
      ok: true,
      record: { status: 'email_sent' },
    });
  });
  it('helper still pending: stays approved without email; retry adds again (the helper answers exists) and sends once', async () => {
    const s = await setup({ add: ['pending', 'exists'] });
    expect(await s.approver.approve(s.rec.id)).toMatchObject({
      ok: false,
      code: 'account_pending',
      record: { status: 'approved', accountAdded: false },
    });
    expect(s.mails).toEqual([]);
    expect(await s.approver.approve(s.rec.id)).toMatchObject({
      ok: true,
      record: { status: 'email_sent' },
    });
    expect(s.mails).toHaveLength(1);
  });
  it('an interrupted send (attempt recorded, outcome unknown) is never repeated automatically', async () => {
    const s = await setup();
    await s.store.update(s.rec.id, {
      status: 'approved',
      accountAdded: true,
      emailAttemptedAt: '2026-11-20T10:00:00Z',
      emailAttempts: 1,
    });
    expect(await s.approver.approve(s.rec.id)).toMatchObject({
      ok: true,
      note: 'email_not_resent',
    });
    expect(s.mails).toEqual([]);
    expect((await s.approver.resend(s.rec.id)).ok).toBe(true); // explicit owner action only
    expect(s.mails).toHaveLength(1);
  });
  it('reject: sends nothing, is idempotent, cannot be approved or resent; unknown id is not_found', async () => {
    const s = await setup();
    expect(await s.approver.reject(s.rec.id)).toMatchObject({
      ok: true,
      record: { status: 'rejected' },
    });
    expect(await s.approver.reject(s.rec.id)).toMatchObject({ ok: true, note: 'already_done' });
    expect(await s.approver.approve(s.rec.id)).toMatchObject({ ok: false, code: 'bad_state' });
    expect(await s.approver.resend(s.rec.id)).toMatchObject({ ok: false, code: 'bad_state' });
    expect(await s.approver.approve('0123456789ABCDEFGHJKMNPQRS')).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(s.adds).toEqual([]);
    expect(s.mails).toEqual([]);
  });
  it('an approved request cannot be rejected', async () => {
    const s = await setup();
    await s.approver.approve(s.rec.id);
    expect(await s.approver.reject(s.rec.id)).toMatchObject({ ok: false, code: 'bad_state' });
  });
});

describe('spool adapter and config', () => {
  it('maps helper results; passes the display name only when the account rule accepts it', async () => {
    const submitted: unknown[] = [];
    const results: unknown[] = [
      { ok: true, code: 'done' },
      { ok: false, code: 'exists' },
      { ok: false, code: 'cap_reached' },
      { ok: false, code: 'conflict' },
      'pending',
    ];
    const spool = {
      submit: async (_a: unknown, act: unknown) => (submitted.push(act), 'ID'),
      wait: async () => results.shift(),
    };
    const add = spoolAccountAdder(spool as never, 'p_x' as never);
    expect(await add.add('a@example.com', 'Dana')).toBe('done');
    expect(await add.add('a@example.com', 'R2-D2 99')).toBe('exists');
    expect(await add.add('a@example.com', null)).toBe('cap_reached');
    expect(await add.add('a@example.com', 'x')).toBe('error');
    expect(await add.add('a@example.com', 'x')).toBe('pending');
    expect(submitted[0]).toEqual({ action: 'add', email: 'a@example.com', displayName: 'Dana' });
    expect(submitted[1]).toEqual({ action: 'add', email: 'a@example.com' });
  });
  it('the feature is off unless both variables are set', () => {
    expect(signupConfigFromEnv({})).toBeNull();
    expect(signupConfigFromEnv({ TBI_SIGNUP_DIR: '/x' })).toBeNull();
    expect(signupConfigFromEnv({ TBI_SIGNUP_HMAC_FILE: '/x' })).toBeNull();
    expect(() =>
      signupConfigFromEnv({ TBI_SIGNUP_DIR: 'rel', TBI_SIGNUP_HMAC_FILE: '/x' }),
    ).toThrow();
    expect(signupConfigFromEnv({ TBI_SIGNUP_DIR: '/a', TBI_SIGNUP_HMAC_FILE: '/b' })).toEqual({
      dir: '/a',
      hmacFile: '/b',
      sourceHeader: 'x-forwarded-for',
    });
  });
});

describe('HTTP handler', () => {
  async function serve() {
    const s = await intakeSetup({ now: Date.now() });
    const server: Server = createServer(
      (req, res) => void handleSignupRequest(req, res, s.intake, 'x-forwarded-for'),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { ...s, base };
  }
  const post = (base: string, raw: Buffer | string, headers: Record<string, string>) =>
    fetch(`${base}/signup`, { method: 'POST', headers, body: raw });

  it('202 for a signed request, nothing echoed; 401 generic; 413; 415; 405', async () => {
    const s = await serve();
    const a = signed(GOOD, Date.now());
    const ok = await post(s.base, a.raw, a.headers);
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ ok: true });
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const forged = signed(GOOD, Date.now(), 'f'.repeat(20), Buffer.from('z'.repeat(40)));
    const bad = await post(s.base, forged.raw, forged.headers);
    expect([bad.status, await bad.json()]).toEqual([401, { error: 'unauthorized' }]);
    expect(
      (await post(s.base, 'x'.repeat(5000), { 'content-type': 'application/json' })).status,
    ).toBe(413);
    expect((await post(s.base, 'x', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await fetch(`${s.base}/signup`)).status).toBe(405);
    expect(await s.store.list()).toHaveLength(1);
  });
  it('rate limits by the proxy-asserted last hop, not by a spoofed first entry', async () => {
    const s = await serve();
    const hit = (xff: string) =>
      post(s.base, 'x', { 'content-type': 'application/json', 'x-forwarded-for': xff });
    for (let i = 0; i < 3; i++) await hit(`10.0.0.${i}, 9.9.9.9`);
    expect((await hit('10.0.0.99, 9.9.9.9')).status).toBe(429);
    expect((await hit('10.0.0.1, 8.8.8.8')).status).toBe(401);
  });
});
