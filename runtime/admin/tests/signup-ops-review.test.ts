/**
 * TBI-022 ops review (slice C) follow-up: the admin service survives a broken sign-up wiring,
 * purge never unlinks a record an approver operation holds, the proxy source header is an IP or
 * treated as missing (and reported), the Telegram token format is checked at intake start, secret
 * files readable by other users are refused, a missing mail key is reported at start, and the
 * Telegram text is truncated with links removed.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signupWiringFromEnv, wireSignupAdmin } from '../signup/admin-wiring.js';
import { sign } from '../signup/hmac.js';
import { readSecret, sourceKey } from '../signup/http.js';
import { intakeConfigFromEnv, startIntake, type RunningIntake } from '../signup/intake-server.js';
import { TelegramNotifier, telegramText, type FetchLike } from '../signup/notify.js';
import { readSecretFile } from '../signup/secret-file.js';
import { SignupApprover } from '../signup/service.js';
import { DEFAULT_RETENTION, PendingStore } from '../signup/store.js';

const SECRET = 'test-secret-not-real-0123456789abcdef';
const TG_TOKEN = '1234567:AAAAAAAAAAAAAAAAAAAAAAAAAAAA_test';
const RESEND_KEY = 're_testkey_not_real_123';
const GOOD = { name: 'Dana Levi', email: 'dana@example.com', role: 'T', lang: 'he', consent: true };

const roots: string[] = [];
const running: RunningIntake[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
  roots.splice(0).forEach((d) => {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* gone */
    }
    rmSync(d, { recursive: true, force: true });
  });
});
function tmp(): string {
  const root = mkdtempSync(join(tmpdir(), 'tbi-signup-ops-'));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}
const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const ticks = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// ------------------------------------------------------------------ MEDIUM-1

describe('admin service survives a broken sign-up wiring (MEDIUM-1)', () => {
  const env = (root: string, over: Record<string, string> = {}) => ({
    TBI_SIGNUP_ADMIN: '1',
    TBI_SIGNUP_DIR: join(root, 'p'),
    TBI_SIGNUP_RESEND_KEY_FILE: join(root, 'k'),
    TBI_SIGNUP_FROM: 'TBI Lab <noreply@example.invalid>',
    TBI_SIGNUP_LAB_URL: 'https://lab.example.invalid/',
    ...over,
  });
  const io = (logs: string[]) => ({
    fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
    log: (l: string) => logs.push(l),
  });

  it('feature off: no wiring, no log', async () => {
    const logs: string[] = [];
    expect(await signupWiringFromEnv({}, {} as never, io(logs))).toBeNull();
    expect(logs).toEqual([]);
  });

  it('an unsafe store dir (0750) gives no wiring and one class-code log line, no path', async () => {
    const root = tmp();
    const dir = join(root, 'p');
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o750);
    const logs: string[] = [];
    expect(await signupWiringFromEnv(env(root), {} as never, io(logs))).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('unsafe_dir');
    expect(logs[0]).not.toContain(root);
  });

  it('a store dir that cannot be created gives no wiring (class code only)', async () => {
    const root = tmp();
    writeFileSync(join(root, 'file'), 'x', { mode: 0o600 });
    const logs: string[] = [];
    const w = await signupWiringFromEnv(
      env(root, { TBI_SIGNUP_DIR: join(root, 'file', 'p') }),
      {} as never,
      io(logs),
    );
    expect(w).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/store_[a-z_]+/);
    expect(logs[0]).not.toContain(root);
  });

  it('a config error with the flag set gives no wiring and logs the reason, no value', async () => {
    const root = tmp();
    const logs: string[] = [];
    const w = await signupWiringFromEnv(
      env(root, { TBI_SIGNUP_LAB_URL: 'http://lab.example.invalid/' }),
      {} as never,
      io(logs),
    );
    expect(w).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('disabled');
    expect(logs[0]).not.toContain('lab.example.invalid');
  });

  it('a good config gives the wiring', async () => {
    const root = tmp();
    writeFileSync(join(root, 'k'), `${RESEND_KEY}\n`, { mode: 0o600 });
    const logs: string[] = [];
    const w = await signupWiringFromEnv(env(root), {} as never, io(logs));
    expect(w).not.toBeNull();
    expect(logs).toEqual([]);
  });
});

// ------------------------------------------------------------------ LOW-9

describe('mail key checked at admin start (LOW-9)', () => {
  const cfg = (root: string, keyFile: string) => ({
    dir: join(root, 'p'),
    keyFile,
    from: 'x',
    labUrl: 'https://l.example.invalid/',
  });
  const io = (logs: string[]) => ({
    fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
    log: (l: string) => logs.push(l),
  });
  it('missing key: wiring still starts, one warning with the class code, no path', async () => {
    const root = tmp();
    const logs: string[] = [];
    const w = await wireSignupAdmin(cfg(root, join(root, 'nope')), {} as never, io(logs));
    expect(w.store).toBeDefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('secret_missing');
    expect(logs[0]).not.toContain(root);
  });
  it('malformed or world-readable key: warning with the class code', async () => {
    const root = tmp();
    const bad = join(root, 'bad');
    writeFileSync(bad, 'nonsense\n', { mode: 0o600 });
    const open = join(root, 'open');
    writeFileSync(open, `${RESEND_KEY}\n`);
    chmodSync(open, 0o644);
    const a: string[] = [];
    await wireSignupAdmin(cfg(root, bad), {} as never, io(a));
    expect(a.join('\n')).toContain('bad_key');
    expect(a.join('\n')).not.toContain('nonsense');
    const b: string[] = [];
    await wireSignupAdmin(cfg(root, open), {} as never, io(b));
    expect(b.join('\n')).toContain('secret_unsafe_mode');
  });
  it('a good key: no warning', async () => {
    const root = tmp();
    const k = join(root, 'k');
    writeFileSync(k, `${RESEND_KEY}\n`, { mode: 0o600 });
    const logs: string[] = [];
    await wireSignupAdmin(cfg(root, k), {} as never, io(logs));
    expect(logs).toEqual([]);
  });
});

// ------------------------------------------------------------------ MEDIUM-3

describe('purge never unlinks a record an approver operation holds (MEDIUM-3)', () => {
  it('purge that listed a stale pending record waits for the approval and keeps it', async () => {
    const root = tmp();
    let t = Date.UTC(2026, 0, 1);
    const store = new PendingStore(join(root, 'p'), { now: () => t });
    await store.init();
    const rec = await store.create({ ...GOOD, lang: 'he', consent: true });
    t += DEFAULT_RETENTION.pendingMs + 86_400_000; // past the pending retention

    // Purge lists first (sees the old pending record), then stalls before deciding.
    const listed = deferred();
    const resume = deferred();
    const realList = store.list.bind(store);
    vi.spyOn(store, 'list').mockImplementationOnce(async () => {
      const l = await realList();
      listed.resolve();
      await resume.promise;
      return l;
    });
    const purging = store.purge();
    await listed.promise;

    // The owner approves at the same instant; the account add is in flight.
    const addStarted = deferred();
    const addDone = deferred<'done'>();
    const approver = new SignupApprover({
      store,
      accounts: {
        add: async () => {
          addStarted.resolve();
          return addDone.promise;
        },
      },
      email: { sendApproval: async () => undefined },
      now: () => t,
    });
    const approving = approver.approve(rec.id);
    await addStarted.promise;

    resume.resolve(); // purge goes on with its stale list while the approval holds the id
    await ticks();
    expect(existsSync(join(root, 'p', `${rec.id}.json`))).toBe(true);
    addDone.resolve('done');

    const out = await approving;
    expect(out.ok).toBe(true);
    expect(await purging).toEqual([]);
    expect((await store.get(rec.id)).status).toBe('email_sent');
  });

  it('a record nobody holds is still purged after its retention', async () => {
    const root = tmp();
    let t = Date.UTC(2026, 0, 1);
    const store = new PendingStore(join(root, 'p'), { now: () => t });
    await store.init();
    const rec = await store.create({ ...GOOD, lang: 'he', consent: true });
    t += DEFAULT_RETENTION.pendingMs + 1;
    expect(await store.purge()).toEqual([rec.id]);
  });
});

// ------------------------------------------------------------------ LOW-4

describe('source key from the proxy header (LOW-4)', () => {
  const req = (h: Record<string, string | string[]>, remote = '127.0.0.1') =>
    ({ headers: h, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;
  it('accepts IPv4 / IPv6 last hops; non-IP values are treated as missing', () => {
    const fb: string[] = [];
    const on = () => fb.push('x');
    expect(sourceKey(req({ 'x-forwarded-for': 'evil, 198.51.100.7' }), 'x-forwarded-for', on)).toBe(
      '198.51.100.7',
    );
    expect(sourceKey(req({ 'x-forwarded-for': '2001:db8::1' }), 'x-forwarded-for', on)).toBe(
      '2001:db8::1',
    );
    expect(fb).toEqual([]);
    for (const v of ['not-an-ip', '198.51.100.7:4433', '', 'a'.repeat(70), '198.51.100.7, junk'])
      expect(sourceKey(req({ 'x-forwarded-for': v }), 'x-forwarded-for', on)).toBe('127.0.0.1');
    expect(sourceKey(req({}), 'x-forwarded-for', on)).toBe('127.0.0.1');
    expect(fb).toHaveLength(6);
  });
});

// ------------------------------------------------------------------ intake start

function intakeFiles() {
  const root = tmp();
  const hmac = join(root, 'hmac');
  const token = join(root, 'tg');
  writeFileSync(hmac, `${SECRET}\n`, { mode: 0o600 });
  writeFileSync(token, `${TG_TOKEN}\n`, { mode: 0o600 });
  return {
    root,
    hmac,
    token,
    env: {
      TBI_SIGNUP_INTAKE: '1',
      TBI_SIGNUP_DIR: join(root, 'p'),
      TBI_SIGNUP_HMAC_FILE: hmac,
      TBI_SIGNUP_TELEGRAM_TOKEN_FILE: token,
      TBI_SIGNUP_TELEGRAM_CHAT_ID: '42',
      TBI_SIGNUP_ADMIN_LINK: 'https://admin.example.invalid/signups',
      TBI_SIGNUP_LISTEN: '127.0.0.1:0',
      TBI_SIGNUP_QUIET: 'off', // real clock here; quiet hours are tested with an injected clock
    } as Record<string, string>,
  };
}
const io = (logs: string[] = []) => ({
  fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
  log: (l: string) => logs.push(l),
});
const cfgOf = (e: Record<string, string>) => {
  const c = intakeConfigFromEnv(e);
  if (!c.enabled) throw new Error('config');
  return c.config;
};
function post(port: number, body: unknown, over: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const nonce = Math.random().toString(36).slice(2).padEnd(20, 'x');
  return fetch(`http://127.0.0.1:${port}/signup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tbi-timestamp': String(ts),
      'x-tbi-nonce': nonce,
      'x-tbi-signature': sign(Buffer.from(SECRET), ts, nonce, Buffer.from(raw)),
      ...over,
    },
    body: raw,
  });
}

describe('intake start: header report, token format, secret modes (LOW-4, LOW-7, LOW-8)', () => {
  it('warns at start when the source header is not configured explicitly; silent when it is', async () => {
    const f = intakeFiles();
    const a: string[] = [];
    running.push(await startIntake(cfgOf(f.env), io(a)));
    expect(a.join('\n')).toContain('source_header_default');
    const b: string[] = [];
    running.push(
      await startIntake(cfgOf({ ...f.env, TBI_SIGNUP_SOURCE_HEADER: 'X-Real-IP' }), io(b)),
    );
    expect(b.join('\n')).not.toContain('source_header_default');
  });

  it('reports (throttled) when requests arrive without a valid source header', async () => {
    const f = intakeFiles();
    const logs: string[] = [];
    const r = await startIntake(
      cfgOf({ ...f.env, TBI_SIGNUP_SOURCE_HEADER: 'x-real-ip' }),
      io(logs),
    );
    running.push(r);
    expect((await post(r.port, GOOD, { 'x-real-ip': '198.51.100.7' })).status).toBe(202);
    expect(logs.join('\n')).not.toContain('source_header_missing');
    await post(r.port, { ...GOOD, email: 'b@example.com' });
    await post(r.port, { ...GOOD, email: 'c@example.com' }, { 'x-real-ip': 'junk' });
    expect(logs.filter((l) => l.includes('source_header_missing'))).toHaveLength(1);
  });

  it('refuses a malformed Telegram token at start (nothing listens)', async () => {
    const f = intakeFiles();
    writeFileSync(f.token, 'not-a-token\n');
    await expect(startIntake(cfgOf(f.env), io())).rejects.toThrow(/^token_malformed$/);
  });

  it('refuses secret or token files readable by other users; group-readable is allowed', async () => {
    const f = intakeFiles();
    chmodSync(f.hmac, 0o604);
    await expect(startIntake(cfgOf(f.env), io())).rejects.toThrow(/^secret_unsafe_mode$/);
    chmodSync(f.hmac, 0o640);
    chmodSync(f.token, 0o644);
    await expect(startIntake(cfgOf(f.env), io())).rejects.toThrow(/^token_unsafe_mode$/);
    chmodSync(f.token, 0o640);
    running.push(await startIntake(cfgOf(f.env), io()));
  });

  it('readSecret / readSecretFile: mode check on the opened file, class codes only', async () => {
    const root = tmp();
    const p = join(root, 's');
    writeFileSync(p, `${SECRET}\n`);
    chmodSync(p, 0o666);
    await expect(readSecret(p)).rejects.toThrow(/^secret_unsafe_mode$/);
    await expect(readSecretFile(p)).rejects.toThrow(/^secret_unsafe_mode$/);
    chmodSync(p, 0o600);
    expect((await readSecret(p)).toString()).toBe(SECRET);
    expect(await readSecretFile(p)).toBe(`${SECRET}\n`);
    await expect(readSecretFile(root)).rejects.toThrow(/^secret_not_file$/);
  });
});

// ------------------------------------------------------------------ LOW-6

describe('Telegram text: truncated, links removed (LOW-6)', () => {
  it('truncates name and role and strips URLs and domain-like tokens', () => {
    const text = telegramText(
      {
        name: `Dana ${'x'.repeat(100)}`,
        role: 'Teacher, see https://evil.example/login and www.evil.example or evil.example/x',
      },
      'https://admin.example.invalid/signups',
    );
    expect(text).not.toMatch(/evil\.example/);
    expect(text).not.toContain('https://evil');
    expect(text).toContain('Review: https://admin.example.invalid/signups');
    const name = /request: (.*) \(/.exec(text)![1]!;
    expect([...name].length).toBeLessThanOrEqual(40);
    expect(name.endsWith('…')).toBe(true);
  });

  it('a plain name and role pass unchanged; truncation never splits a code point', () => {
    expect(telegramText({ name: 'Dana Levi', role: 'Teacher' }, 'https://a.invalid/x')).toBe(
      'New TBI Lab sign-up request: Dana Levi (Teacher). Review: https://a.invalid/x',
    );
    const t = telegramText({ name: '😀'.repeat(60), role: 'T' }, 'https://a.invalid/x');
    expect(t).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('the notifier sends the cleaned text', async () => {
    const bodies: string[] = [];
    const n = new TelegramNotifier({
      readToken: async () => TG_TOKEN,
      chatId: '1',
      adminLink: 'https://a.invalid/x',
      fetch: async (_u, init) => (bodies.push(init.body), { ok: true, status: 200 }),
    });
    await n.notify({ name: 'A', role: 'visit http://phish.example now' });
    expect(bodies[0]).not.toContain('phish.example');
  });
});
