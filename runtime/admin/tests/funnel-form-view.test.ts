/**
 * K12 slice 3: `signup_form_view` = "form tokens issued" (200 answers of GET /signup/form-token).
 * Real intake, real http, real counters and files; the last test runs the bundled process entry.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { FUNNEL_FILE, FunnelCounters, parseFunnelFile } from '../funnel/counters.js';
import type { FunnelSink } from '../funnel/counters.js';
import { intakeConfigFromEnv, startIntake, type RunningIntake } from '../signup/intake-server.js';

const SITE = 'https://signup.example.com';
const T0 = Date.UTC(2026, 10, 26, 12, 0, 0);

const roots: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function env(web = true) {
  const root = mkdtempSync(join(tmpdir(), 'tbi-form-view-'));
  roots.push(root);
  chmodSync(root, 0o700);
  const hmac = join(root, 'hmac');
  const token = join(root, 'tg');
  writeFileSync(hmac, 'test-secret-not-real-0123456789abcdef\n', { mode: 0o600 });
  writeFileSync(token, '1234567:AAAAAAAAAAAAAAAAAAAAAAAAAAAA_test\n', { mode: 0o600 });
  const vars: Record<string, string> = {
    TBI_SIGNUP_INTAKE: '1',
    TBI_SIGNUP_DIR: join(root, 'p'),
    TBI_SIGNUP_HMAC_FILE: hmac,
    TBI_SIGNUP_TELEGRAM_TOKEN_FILE: token,
    TBI_SIGNUP_TELEGRAM_CHAT_ID: '42',
    TBI_SIGNUP_ADMIN_LINK: 'https://admin.example.invalid/signups',
    TBI_SIGNUP_LISTEN: '127.0.0.1:0',
    TBI_SIGNUP_SOURCE_HEADER: 'x-forwarded-for',
    TBI_SIGNUP_QUIET: 'off',
    ...(web ? { TBI_SIGNUP_WEB: '1', TBI_SIGNUP_WEB_ORIGINS: SITE } : {}),
  };
  return { root, vars };
}

const getToken = (port: number, over: Record<string, string> = {}, method = 'GET') =>
  fetch(`http://127.0.0.1:${port}/signup/form-token`, {
    method,
    headers: { 'x-forwarded-for': '198.51.100.1', ...over },
  });

async function up(counters: FunnelSink | null, web = true): Promise<RunningIntake> {
  const cfg = intakeConfigFromEnv(env(web).vars);
  if (!cfg.enabled) throw new Error(`config: ${cfg.reason}`);
  const r = await startIntake(cfg.config, {
    fetch: async () => ({ ok: true, status: 200 }),
    log: () => undefined,
    now: () => T0,
    counters,
  });
  closers.push(() => r.close());
  return r;
}

const recording = () => {
  const calls: unknown[][] = [];
  const sink: FunnelSink = { increment: (...a) => (calls.push(a), true) };
  return { calls, sink };
};

describe('signup_form_view (form tokens issued)', () => {
  it('a 200 counts once per token, passing only the event name', async () => {
    const s = recording();
    const r = await up(s.sink);
    expect((await getToken(r.port)).status).toBe(200);
    expect(s.calls).toEqual([['signup_form_view']]);
    expect((await getToken(r.port, { origin: SITE })).status).toBe(200);
    expect(s.calls).toEqual([['signup_form_view'], ['signup_form_view']]);
  });

  it('refusals count nothing: 429, 403, 405, 503 (no source), preflight', async () => {
    const s = recording();
    const r = await up(s.sink);
    expect((await getToken(r.port, { origin: 'https://evil.example.net' })).status).toBe(403);
    expect((await getToken(r.port, {}, 'POST')).status).toBe(405);
    expect((await getToken(r.port, { 'x-forwarded-for': 'junk' })).status).toBe(503);
    const pre = { origin: SITE, 'access-control-request-method': 'GET' };
    expect((await getToken(r.port, pre, 'OPTIONS')).status).toBe(204);
    expect(s.calls).toEqual([]);
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await getToken(r.port)).status);
    expect(statuses).toEqual([...Array<number>(20).fill(200), 429, 429]);
    expect(s.calls).toHaveLength(20);
  });

  it('404 (web route off, server and service) counts nothing', async () => {
    const s = recording();
    const r = await up(s.sink, false);
    expect((await getToken(r.port)).status).toBe(404);
    expect(r.intake.issueWebToken('src')).toEqual({ status: 404, error: 'not_found' });
    expect(s.calls).toEqual([]);
  });

  it('a throwing sink never changes the answer', async () => {
    let calls = 0;
    const r = await up({
      increment: () => {
        calls++;
        throw new Error('boom');
      },
    });
    const res = await getToken(r.port);
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object).sort()).toEqual(['minFill', 'token', 'ttl']);
    expect(calls).toBe(1);
  });

  it('counters off: the token is answered as before', async () => {
    const r = await up(null);
    expect((await getToken(r.port)).status).toBe(200);
  });

  it('the written file parses with the current parser', async () => {
    const dir = join(env().root, 'funnel');
    const c = new FunnelCounters(dir, { now: () => T0 });
    await c.init();
    closers.push(() => c.stop());
    const r = await up(c);
    await (await getToken(r.port)).text();
    await c.flush();
    expect(parseFunnelFile(readFileSync(join(dir, FUNNEL_FILE), 'utf8'))).toEqual({
      '2026-11-26': { signup_form_view: 1 },
    });
  });

  it('process wiring: the bundled intake entry counts the token only with TBI_FUNNEL_COUNTERS=1', async () => {
    const { root, vars } = env();
    const bundle = join(root, 'signup-intake.mjs');
    await build({
      entryPoints: [new URL('../signup/intake-main.ts', import.meta.url).pathname],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: bundle,
      logLevel: 'silent',
    });
    async function run(extra: Record<string, string>) {
      const child = spawn(process.execPath, [bundle], {
        env: { ...vars, ...extra },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      closers.push(() => void child.kill('SIGKILL'));
      const exited = new Promise((resolve) => child.once('exit', resolve));
      const port = await new Promise<number>((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
          const m = /listening on 127\.0\.0\.1:(\d+)/.exec(out);
          if (m) resolve(Number(m[1]));
        });
        void exited.then(() => reject(new Error(`intake exited: ${out}`)));
      });
      expect((await getToken(port)).status).toBe(200);
      child.kill('SIGTERM'); // flushes pending counts
      expect(await exited).toBe(0);
    }
    const dir = join(root, 'funnel');
    await run({ TBI_FUNNEL_DIR: dir });
    expect(existsSync(dir)).toBe(false);
    await run({ TBI_FUNNEL_DIR: dir, TBI_FUNNEL_COUNTERS: '1' });
    const days = parseFunnelFile(readFileSync(join(dir, FUNNEL_FILE), 'utf8'))!;
    expect(Object.values(days)).toEqual([{ signup_form_view: 1 }]);
  });
});
