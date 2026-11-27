/**
 * BETA-G1 G1-AUTO-VERIFY slice 3: the confirm view and resend form of the sign-up page, built only with
 * `signupVerify` (never in a published build before the flip). Server contract: design/G1-AUTO-VERIFY.md sections 4
 * and 7 (POST /signup/verify {token}: 202 received, 410 expired, 400 invalid, 429; POST /signup/resend
 * {email, website, token}: 200 for any address).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSite, cliOptions } from '../build.mjs';
import { content, SIGNUP_VERIFY_ENABLED } from '../content.mjs';

/**
 * sha256 over (relative path, bytes) of every built file, recorded from a build of origin/co/main 6173968 (before this
 * slice). With `signupVerify` off all three build variants must stay exactly that. If you change the site on purpose
 * while the option is off, update these values in the same commit.
 * `preview` and `enabled` were updated for the request timeouts and the deferred token fetch in signup.mjs. All three
 * were updated for the footer sign-in spacing (assets/site.css, the only `default` change since co/main); `preview` and
 * `enabled` also for the neutral no-answer text on the sign-up pages, and again for the neutral no-answer heading
 * of the sign-up form.
 */
const CO_MAIN_TREES = {
  default: '81d2008c0bf9198c744f75afdaaa10e52254e16a9b6f030e017e015a2185e567',
  preview: 'c3de63e33f422d596293dac802e3a9f2d48493a17e6e7ecd87e070319a89fae1',
  enabled: '6fb3b07ad3e801ec17ce0ba5fe46b451067a6c0de9b7772ee1235c623d415ce1',
};
const VARIANTS = {
  default: {},
  preview: { signupPreview: true },
  enabled: { signupEnabled: true },
};

const walk = (d) =>
  readdirSync(d)
    .sort()
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
const treeHash = (root) => {
  const h = createHash('sha256');
  for (const f of walk(root))
    h.update(relative(root, f) + '\0')
      .update(readFileSync(f))
      .update('\0');
  return h.digest('hex');
};
const build = (o) => buildSite(mkdtempSync(join(tmpdir(), 'tbi-vf-')), o);
const text = (o) =>
  walk(o)
    .filter((f) => /\.(html|mjs|css|txt)$/.test(f))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
const page = (o, l) => readFileSync(join(o, l, 'signup', 'index.html'), 'utf8');
const strings = (v) =>
  typeof v === 'string' ? [v] : Object.values(v ?? {}).flatMap((x) => strings(x));

const off = {};
let on;
let mod;
beforeAll(async () => {
  for (const [k, o] of Object.entries(VARIANTS)) off[k] = build(o);
  on = build({ signupPreview: true, signupVerify: true });
  // The tests import the exact file the build ships.
  mod = await import(/* @vite-ignore */ pathToFileURL(join(on, 'assets', 'signup.mjs')).href);
});

describe('signupVerify off (the default): nothing changes', () => {
  it.each(Object.keys(VARIANTS))('%s build is byte-identical to co/main', (k) => {
    expect(treeHash(off[k])).toBe(CO_MAIN_TREES[k]);
  });
  it.each(Object.keys(VARIANTS))('%s build has no verify code path or new string', (k) => {
    const t = text(off[k]);
    for (const s of ['verify', 'vf-', '/resend', 'initVerify', 'su-flow'])
      expect(t, s).not.toContain(s);
    // every new or changed sentence (sentences the current copy already has are skipped)
    for (const l of ['he', 'en']) {
      const old = JSON.stringify([content[l].signup, content[l].pages]);
      for (const x of strings(content[l].signupVerify))
        for (const part of x.split(/(?<=[.?!])\s|\[\[|\]\]/))
          if (part.length > 20 && !old.includes(part)) expect(t, part).not.toContain(part);
    }
  });
});

describe('flip switch (SIGNUP_VERIFY_ENABLED)', () => {
  it('ships off', () => {
    expect(SIGNUP_VERIFY_ENABLED).toBe(false);
  });
  it('verify without the sign-up page is refused outside the preview, before the output is touched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tbi-vf-refuse-'));
    writeFileSync(join(dir, 'keep'), 'x');
    expect(() => buildSite(dir, { signupVerify: true })).toThrow(/SIGNUP_PAGE_ENABLED/);
    expect(readdirSync(dir)).toEqual(['keep']);
  });
  it('page enabled + verify builds the confirm view without the preview option', () => {
    const out = build({ signupEnabled: true, signupVerify: true });
    for (const l of ['he', 'en']) expect(page(out, l)).toContain('<div id="vf" hidden>');
    expect(readFileSync(join(out, 'assets', 'signup.mjs'), 'utf8')).toContain('initVerify');
  });
  it('the command line overrides the constant only with --signup-verify; no environment variable', () => {
    expect(cliOptions([], {})).toEqual({ signupPreview: false });
    expect(cliOptions(['--signup-preview'], {})).toEqual({ signupPreview: true });
    expect(cliOptions(['--signup-verify'], {})).toEqual({
      signupPreview: true,
      signupVerify: true,
    });
    expect(cliOptions([], { SITE_SIGNUP_VERIFY: '1', SITE_SIGNUP_VERIFY_ENABLED: '1' })).toEqual({
      signupPreview: false,
    });
    expect(cliOptions([], { SITE_SIGNUP_ENABLED: '1' })).toEqual({
      signupPreview: false,
      signupEnabled: true,
    });
  });
});

describe('signupVerify on', () => {
  it('builds the same files as without the option (which pages change: signup-verify-copy.test.mjs)', () => {
    const files = walk(on).map((f) => relative(on, f));
    expect(files).toEqual(walk(off.preview).map((f) => relative(off.preview, f)));
  });
  it('HE and EN have the same keys, all non-empty', () => {
    const keys = (v, p = '') =>
      typeof v === 'object' && !Array.isArray(v)
        ? Object.entries(v).flatMap(([k, x]) => keys(x, `${p}.${k}`))
        : [p];
    expect(keys(content.he.signupVerify)).toEqual(keys(content.en.signupVerify));
    for (const l of ['he', 'en'])
      for (const s of strings(content[l].signupVerify)) expect(s.trim()).not.toBe('');
  });
  it.each(['he', 'en'])('%s: Google account wording, new success copy, old claims gone', (l) => {
    const h = page(on, l);
    const v = content[l].signupVerify;
    expect(h).toContain(
      l === 'he' ? 'כתובת המייל של חשבון' : 'The email address of your Google account',
    );
    expect(h).toContain(l === 'he' ? 'בדקו את המייל כדי לאשר' : 'Check your email to confirm');
    expect(h).not.toContain(content[l].signup.emailHint);
    expect(h).not.toContain(content[l].signup.successP[0]);
    expect(h).not.toContain(l === 'he' ? 'בהדרגה' : 'gradually');
    expect(h).toContain(v.successH);
    if (l === 'he') expect(h).toContain('<span dir="ltr" lang="en">Google</span>');
  });
  it('the Hebrew success copy and all new copy avoid numbers about capacity', () => {
    for (const l of ['he', 'en']) {
      const v = content[l].signupVerify;
      for (const s of [v.successH, ...v.successP, v.resultReceivedP, v.resultSentP])
        expect(s).not.toMatch(/\d/);
    }
  });
  it('no 202 wording claims approval', () => {
    expect(
      content.en.signupVerify.resultReceivedH + content.en.signupVerify.resultReceivedP,
    ).not.toMatch(/approved|account is|you are in/i);
    expect(
      content.he.signupVerify.resultReceivedH + content.he.signupVerify.resultReceivedP,
    ).not.toMatch(/אושר|נפתח החשבון/);
  });
  it.each(['he', 'en'])('%s: confirm view and resend form markup', (l) => {
    const h = page(on, l);
    expect(h).toContain('<div id="vf" hidden>');
    expect(h).toMatch(/<button type="button" class="btn btn-primary" id="vf-button"/);
    // The focused container is the announcement: a named, described group, not a live region.
    expect(h).toContain(
      '<div id="vf-result" role="group" aria-labelledby="vf-result-h" aria-describedby="vf-result-p" tabindex="-1" hidden>',
    );
    expect(h).toContain('<h2 id="vf-result-h"></h2>');
    expect(h).toMatch(
      /id="vf-resend-button"[^\n]*\n<p id="vf-resend-sending"[^>]*aria-hidden="true"/,
    );
    expect(h).toMatch(/id="su-nojs">[^\n]*JavaScript[^\n]*<\/p>/);
    expect(h).toContain(
      l === 'he' ? 'וטענו את הדף מחדש' : 'turn on JavaScript and reload the page',
    );
    const form = h.match(/<form id="vf-resend"[\s\S]*?<\/form>/)[0];
    expect(form).not.toMatch(/\saction=|data-api=/); // the publish gate allows only /signup/web
    expect(form).toContain('<label for="vf-email">');
    expect(form).toMatch(
      /id="vf-email"[^>]*type="email"[^>]*dir="ltr"|type="email" id="vf-email"[^>]*dir="ltr"/,
    );
    expect(form).toContain('aria-describedby="vf-hint-email"');
    expect(form).toContain('id="vf-err-email" hidden');
    expect(form).toMatch(/<div class="hp" aria-hidden="true" inert>[\s\S]*name="website"/);
    expect(h.match(/<script/g)).toHaveLength(1);
    expect(h).toContain('<script type="module" src="/assets/signup.mjs"></script>');
    expect(h).not.toMatch(/\son[a-z]+=|\sstyle=/i);
    const ids = [...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('the shipped module stays inside the publish tripwire (no sinks, storage, logging, imports)', () => {
    const src = readFileSync(join(on, 'assets', 'signup.mjs'), 'utf8');
    expect(Buffer.byteLength(src)).toBeLessThan(64 * 1024);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    for (const re of [
      /\b(innerHTML|outerHTML|insertAdjacentHTML)\b/,
      /\b(localStorage|sessionStorage|indexedDB|cookie|console)\b/,
      /(^|[;{}\s])import\s*[\w{*'"`(]/m,
      /\b(https?|wss?|data|blob|javascript)\s*:/i,
      /['"`]\s*\/\s*\//,
      /\beval\b|\bsendBeacon\b/,
    ])
      expect(code).not.toMatch(re);
  });
});

const res = (status, body = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});
function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = answer(url, calls);
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}
const TOKEN = 'v1.01ARZ3NDEKTSV4RRFFQ69G5FAV.1.1900000000.abcdefghijklmnopqrstuv.' + 'm'.repeat(43);

describe('confirm client logic', () => {
  it('reads the token from the fragment only', () => {
    expect(mod.readVerifyToken(`#verify=${TOKEN}`)).toBe(TOKEN);
    expect(mod.readVerifyToken('#verify=')).toBe('');
    for (const h of ['', '#main', '#su-email', `?verify=${TOKEN}`, '#xverify=a'])
      expect(mod.readVerifyToken(h)).toBe(null);
  });
  it('posts exactly {token} as same-origin JSON', async () => {
    const f = fakeFetch(() => res(202, { ok: true, status: 'received' }));
    expect(await mod.postVerify(f, '/signup', TOKEN)).toBe('received');
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe('/signup/verify');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN });
  });
  it.each([
    [202, { ok: true, status: 'received' }, 'received'],
    [410, { error: 'expired' }, 'expired'],
    [400, { error: 'invalid' }, 'invalid'],
    [413, { error: 'body_too_large' }, 'invalid'],
    [429, { error: 'rate_limited' }, 'rate'],
    [200, { ok: true }, 'unavailable'],
    [202, {}, 'unavailable'],
    [403, { error: 'forbidden' }, 'unavailable'],
    [404, {}, 'unavailable'],
    [500, { error: 'internal' }, 'unavailable'],
    [503, { error: 'unavailable' }, 'unavailable'],
  ])('%s %j -> %s', async (status, body, want) => {
    expect(
      await mod.postVerify(
        fakeFetch(() => res(status, body)),
        '/signup',
        TOKEN,
      ),
    ).toBe(want);
  });
  it('a timeout while reading the body is the timeout state, not "unavailable"', async () => {
    const ctl = new AbortController();
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(ctl.signal);
    const f = async () => ({
      status: 202,
      json: async () => {
        ctl.abort();
        throw new Error('aborted');
      },
    });
    expect(await mod.postVerify(f, '/signup', TOKEN)).toBe('network');
    spy.mockRestore();
    const broken = async () => ({ status: 202, json: async () => JSON.parse('<') });
    expect(await mod.postVerify(broken, '/signup', TOKEN)).toBe('unavailable');
  });
  it('network failure -> network; an unusable token is never sent', async () => {
    expect(
      await mod.postVerify(
        fakeFetch(() => new Error('x')),
        '/signup',
        TOKEN,
      ),
    ).toBe('network');
    for (const bad of ['', 'x'.repeat(161), 'a b', 'a/../b']) {
      const f = fakeFetch(() => res(202, { ok: true }));
      expect(await mod.postVerify(f, '/signup', bad)).toBe('invalid');
      expect(f.calls).toHaveLength(0);
    }
  });
});

describe('resend client logic', () => {
  const setup = (answers) => {
    let n = 0;
    const f = fakeFetch((url) =>
      url.endsWith('form-token')
        ? res(200, { token: `w1.t${++n}`, ttl: 1800, minFill: 3 })
        : answers.shift(),
    );
    const slept = [];
    const sub = mod.createResender({
      fetchFn: f,
      base: '/signup',
      tokens: mod.createTokenStore({ fetchFn: f, base: '/signup', now: () => 0 }),
      sleep: async (ms) => slept.push(ms),
    });
    return { f, sub, slept };
  };
  const posts = (f) => f.calls.filter((c) => c.init.method === 'POST');
  it('waits the minimum fill time, posts {email, website, token} to /resend', async () => {
    const { f, sub, slept } = setup([res(200, { ok: true, status: 'received' })]);
    expect(await sub.submit({ email: 'a@example.com', website: '' })).toEqual({ ok: true });
    expect(slept).toEqual([3000]);
    expect(posts(f).map((c) => c.url)).toEqual(['/signup/resend']);
    expect(JSON.parse(posts(f)[0].init.body)).toEqual({
      email: 'a@example.com',
      website: '',
      token: 'w1.t1',
    });
  });
  it('401: one fresh token and one retry; 429 -> rate message', async () => {
    const a = setup([res(401, { error: 'expired' }), res(200, { ok: true })]);
    expect(await a.sub.submit({ email: 'a@example.com', website: '' })).toEqual({ ok: true });
    expect(posts(a.f).map((c) => JSON.parse(c.init.body).token)).toEqual(['w1.t1', 'w1.t2']);
    const b = setup([res(429, { error: 'rate_limited' })]);
    expect(await b.sub.submit({ email: 'a@example.com', website: '' })).toEqual({
      ok: false,
      msg: 'msgRate',
    });
  });
});

describe('hung requests are bounded', () => {
  afterEach(() => vi.useRealTimers());
  /** Never answers; like the real fetch it rejects when the signal aborts. */
  const hung = (signal) =>
    new Promise((_, reject) =>
      signal?.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  const tokenRes = res(200, { token: 'w1.t', ttl: 1800, minFill: 0 });
  const settle = async (promise) => {
    let value = 'pending';
    promise.then(
      (v) => (value = v),
      (e) => (value = e),
    );
    await vi.advanceTimersByTimeAsync(mod.REQUEST_TIMEOUT_MS - 1);
    expect(value).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    return value;
  };
  it.each(['headers', 'body'])(
    'form token (%s hang): network message, and the next call fetches again',
    async (where) => {
      vi.useFakeTimers();
      let n = 0;
      const tokens = mod.createTokenStore({
        base: '/signup',
        fetchFn: async (url, { signal }) => {
          if (n++) return tokenRes;
          if (where === 'headers') return hung(signal);
          return { status: 200, ok: true, json: () => hung(signal) };
        },
      });
      expect(await settle(tokens.get())).toEqual({ msg: 'msgNetwork' });
      expect(await tokens.get()).toBe('w1.t');
    },
  );
  it.each(['headers', 'body'])(
    'resend post (%s hang): network message, and the next submit is not blocked',
    async (where) => {
      vi.useFakeTimers();
      let posts = 0;
      const fetchFn = async (url, { signal }) => {
        if (url.endsWith('form-token')) return tokenRes;
        if (posts++) return res(200, { ok: true });
        if (where === 'headers') return hung(signal);
        return { status: 200, ok: true, json: () => hung(signal) };
      };
      const sub = mod.createResender({
        fetchFn,
        base: '/signup',
        tokens: mod.createTokenStore({ fetchFn, base: '/signup' }),
      });
      const body = { email: 'a@example.com', website: '' };
      expect(await settle(sub.submit(body))).toEqual({ ok: false, msg: 'msgNetwork' });
      expect(sub.busy).toBe(false);
      expect(await sub.submit(body)).toEqual({ ok: true });
    },
  );
});
