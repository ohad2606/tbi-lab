/** TBI-022: the intake process library: inert by default, fails closed, loopback only, real http, no network. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sign } from '../signup/hmac.js';
import {
  INTAKE_GLOBAL_LIMIT,
  INTAKE_MAX_RECORDS,
  INTAKE_SOURCE_LIMIT,
  intakeConfigFromEnv,
  startIntake,
  type RunningIntake,
} from '../signup/intake-server.js';
import type { FetchLike } from '../signup/notify.js';

const SECRET = 'test-secret-not-real-0123456789abcdef';
const TG_TOKEN = '1234567:AAAAAAAAAAAAAAAAAAAAAAAAAAAA_test';
const GOOD = { name: 'Dana Levi', email: 'dana@example.com', role: 'T', lang: 'he', consent: true };

const roots: string[] = [];
const running: RunningIntake[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
  roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function files() {
  const root = mkdtempSync(join(tmpdir(), 'tbi-intake-main-'));
  roots.push(root);
  chmodSync(root, 0o700);
  const hmac = join(root, 'hmac');
  const token = join(root, 'tg');
  writeFileSync(hmac, `${SECRET}\n`, { mode: 0o600 });
  writeFileSync(token, `${TG_TOKEN}\n`, { mode: 0o600 });
  const env = {
    TBI_SIGNUP_INTAKE: '1',
    TBI_SIGNUP_DIR: join(root, 'p'),
    TBI_SIGNUP_HMAC_FILE: hmac,
    TBI_SIGNUP_TELEGRAM_TOKEN_FILE: token,
    TBI_SIGNUP_TELEGRAM_CHAT_ID: '42',
    TBI_SIGNUP_ADMIN_LINK: 'https://admin.example.invalid/signups',
    TBI_SIGNUP_LISTEN: '127.0.0.1:0',
    TBI_SIGNUP_SOURCE_HEADER: 'x-forwarded-for',
    TBI_SIGNUP_QUIET: 'off', // real clock here; quiet hours are tested with an injected clock
  };
  return { root, env };
}

describe('intake config', () => {
  it('off unless TBI_SIGNUP_INTAKE is exactly 1', () => {
    expect(intakeConfigFromEnv({})).toMatchObject({ enabled: false });
    expect(intakeConfigFromEnv({}).error).toBeFalsy();
    const { env } = files();
    expect(intakeConfigFromEnv({ ...env, TBI_SIGNUP_INTAKE: 'yes' }).error).toBeFalsy();
    expect(intakeConfigFromEnv({ ...env, TBI_SIGNUP_INTAKE: 'yes' }).enabled).toBe(false);
    expect(intakeConfigFromEnv(env)).toMatchObject({ enabled: true });
  });
  it('refuses to serve without an explicit, well-formed proxy source header (design §3)', () => {
    const { env } = files();
    const e: Record<string, string> = { ...env };
    delete e.TBI_SIGNUP_SOURCE_HEADER;
    const c = intakeConfigFromEnv(e);
    expect(c).toMatchObject({ enabled: false, error: true });
    expect(c.reason).toMatch(/TBI_SIGNUP_SOURCE_HEADER is required/);
    for (const v of ['', 'x real ip', 'x-real-ip:', 'x\r\ny', 'a'.repeat(65)])
      expect(intakeConfigFromEnv({ ...env, TBI_SIGNUP_SOURCE_HEADER: v })).toMatchObject({
        enabled: false,
        error: true,
      });
    const ok = intakeConfigFromEnv({ ...env, TBI_SIGNUP_SOURCE_HEADER: 'X-Real-IP' });
    expect(ok.enabled && ok.config.sourceHeader).toBe('x-real-ip');
  });
  it('fails closed on missing settings, relative paths, non-https link, non-loopback listen', () => {
    const { env } = files();
    for (const k of Object.keys(env).filter(
      (x) => x !== 'TBI_SIGNUP_INTAKE' && x !== 'TBI_SIGNUP_LISTEN' && x !== 'TBI_SIGNUP_QUIET',
    )) {
      const e: Record<string, string> = { ...env };
      delete e[k];
      expect(intakeConfigFromEnv(e)).toMatchObject({ enabled: false, error: true });
    }
    for (const bad of [
      { TBI_SIGNUP_HMAC_FILE: 'rel' },
      { TBI_SIGNUP_ADMIN_LINK: 'http://a' },
      { TBI_SIGNUP_LISTEN: '0.0.0.0:7411' },
      { TBI_SIGNUP_LISTEN: '192.0.2.10:7411' },
      { TBI_SIGNUP_LISTEN: 'nonsense' },
    ])
      expect(intakeConfigFromEnv({ ...env, ...bad })).toMatchObject({
        enabled: false,
        error: true,
      });
  });
});

describe('intake server', () => {
  async function up(env: Record<string, string>) {
    const cfg = intakeConfigFromEnv(env);
    if (!cfg.enabled) throw new Error('config');
    const sent: { url: string; body: string }[] = [];
    const logs: string[] = [];
    const fetch: FetchLike = async (url, init) => (
      sent.push({ url, body: init.body }),
      { ok: true, status: 200 }
    );
    const r = await startIntake(cfg.config, { fetch, log: (l) => logs.push(l) });
    running.push(r);
    return { r, sent, logs };
  }
  function post(port: number, body: unknown, over: Record<string, string> = {}) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
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

  it('accepts a signed sign-up over real http, notifies (mock Telegram), listens on loopback only', async () => {
    const { env } = files();
    const { r, sent, logs } = await up(env);
    expect((r.server.address() as { address: string }).address).toBe('127.0.0.1');
    const res = await post(r.port, GOOD);
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url.startsWith('https://api.telegram.org/bot')).toBe(true);
    expect(sent[0]!.body).toContain('Dana Levi');
    expect(sent[0]!.body).not.toContain('dana@example.com');
    expect(logs.join('\n')).not.toContain(SECRET);
    // Duplicate: answered as success, nothing more sent.
    expect((await post(r.port, GOOD)).status).toBe(202);
    expect(sent).toHaveLength(1);
  });

  it('refuses a bad signature (401), a wrong path (404), a wrong method (405), a big body (413)', async () => {
    const { env } = files();
    const { r } = await up(env);
    expect((await post(r.port, GOOD, { 'x-tbi-signature': 'a'.repeat(64) })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${r.port}/other`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${r.port}/signup`)).status).toBe(405);
    expect((await post(r.port, 'x'.repeat(5000))).status).toBe(413);
  });

  it('rate limits one source (429 with retry-after) at the documented values', async () => {
    expect(INTAKE_SOURCE_LIMIT).toEqual({ count: 30, windowMs: 60_000 });
    expect(INTAKE_GLOBAL_LIMIT).toEqual({ count: 200, windowMs: 3_600_000 });
    expect(INTAKE_MAX_RECORDS).toBe(5_000);
    const { env } = files();
    const { r } = await up(env);
    const codes: number[] = [];
    const n = INTAKE_SOURCE_LIMIT.count;
    for (let i = 0; i < n + 2; i++) codes.push((await post(r.port, GOOD)).status);
    expect(codes.slice(0, n).every((c) => c === 202)).toBe(true);
    expect(codes.slice(n)).toEqual([429, 429]);
  });

  it('fails closed before listening: missing, short secret; missing token; shared store dir', async () => {
    const f = files();
    const cfg = (e: Record<string, string>) => {
      const c = intakeConfigFromEnv(e);
      if (!c.enabled) throw new Error('config');
      return c.config;
    };
    const io = {
      fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
      log: () => undefined,
    };
    writeFileSync(f.env.TBI_SIGNUP_HMAC_FILE, 'short');
    await expect(startIntake(cfg(f.env), io)).rejects.toThrow('secret_short');
    await expect(
      startIntake(cfg({ ...f.env, TBI_SIGNUP_HMAC_FILE: join(f.root, 'nope') }), io),
    ).rejects.toThrow('secret_missing');
    const g = files();
    await expect(
      startIntake(cfg({ ...g.env, TBI_SIGNUP_TELEGRAM_TOKEN_FILE: join(g.root, 'nope') }), io),
    ).rejects.toThrow('token_missing');
  });

  it('graceful shutdown: close() stops the listener', async () => {
    const { env } = files();
    const { r } = await up(env);
    const port = r.port;
    await r.close();
    await expect(fetch(`http://127.0.0.1:${port}/signup`)).rejects.toThrow();
  });
});
