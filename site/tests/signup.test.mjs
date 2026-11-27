import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../build.mjs';
import {
  content,
  SIGNUP_PAGE_ENABLED,
  SIGNUP_NOINDEX,
  SIGNUP_API_BASE,
  SIGNUP_ROLE_VALUES,
} from '../content.mjs';
import { validate, createTokenStore, createSubmitter, MSG, TOKEN_MARGIN_MS } from '../signup.mjs';

let out;
let outOn;
const page = (o, lang) => readFileSync(join(o, lang, 'signup', 'index.html'), 'utf8');
beforeAll(() => {
  // Flag off builds no sign-up page at all (signup-review-fixes.test.mjs); the page is checked in the preview build.
  out = buildSite(mkdtempSync(join(tmpdir(), 'tbi-su-')), { signupPreview: true });
  outOn = buildSite(mkdtempSync(join(tmpdir(), 'tbi-su-on-')), { signupEnabled: true });
});

describe('sign-up page build', () => {
  it('ships disabled by default', () => {
    expect(SIGNUP_PAGE_ENABLED).toBe(false);
    expect(SIGNUP_API_BASE).toBe('/signup');
  });
  it.each(['he', 'en'])(
    '%s page exists with module script, lang/dir and noindex when disabled',
    (l) => {
      const h = page(out, l);
      expect(h).toContain(`<html lang="${l}" dir="${l === 'he' ? 'rtl' : 'ltr'}">`);
      expect(h).toContain('<meta name="robots" content="noindex">');
      expect(h.match(/<script/g)).toHaveLength(1);
      expect(h).toContain('<script type="module" src="/assets/signup.mjs"></script>');
      expect(existsSync(join(out, 'assets', 'signup.mjs'))).toBe(true);
      expect(h).not.toMatch(/\son[a-z]+=|\sstyle=/i);
    },
  );
  it('is not linked while disabled, linked when enabled', () => {
    for (const l of ['he', 'en']) {
      for (const p of ['', 'product/', 'alpha/', 'faq/', 'privacy/'])
        expect(readFileSync(join(out, l, p, 'index.html'), 'utf8')).not.toContain(`/${l}/signup/`);
      const home = readFileSync(join(outOn, l, 'index.html'), 'utf8');
      expect(home).toContain(`href="/${l}/signup/"`);
      expect(home).not.toContain('forms.gle');
    }
  });
  // Review finding 4 (DEC-07): noindex does not depend on the flag. SIGNUP_NOINDEX goes false on 15.12 only; that
  // commit updates the first test here.
  it('noindex has its own switch, on by default', () => {
    expect(SIGNUP_NOINDEX).toBe(true);
  });
  it.each(['he', 'en'])('%s: the enabled page is still noindex, and only that page', (l) => {
    expect(page(outOn, l)).toContain('<meta name="robots" content="noindex">');
    for (const p of ['', 'product/', 'alpha/', 'faq/', 'privacy/', 'accessibility/'])
      expect(readFileSync(join(outOn, l, p, 'index.html'), 'utf8')).not.toContain('noindex');
  });
  it.each([true, false])('signupNoindex=false removes it (signupEnabled=%s)', (enabled) => {
    const o = buildSite(mkdtempSync(join(tmpdir(), 'tbi-su-idx-')), {
      signupEnabled: enabled,
      signupPreview: true,
      signupNoindex: false,
    });
    for (const l of ['he', 'en']) expect(page(o, l)).not.toContain('noindex');
  });
  it.each(['he', 'en'])('%s form fields match the server contract', (l) => {
    const h = page(out, l);
    for (const n of ['name', 'email', 'role', 'heardFrom', 'website'])
      expect(h).toMatch(new RegExp(`name="${n}"`));
    expect(h).toContain('autocomplete="name"');
    expect(h).toContain('autocomplete="email"');
    expect(h).toMatch(/type="email"[^>]*dir="ltr"/);
    for (const v of SIGNUP_ROLE_VALUES) expect(h).toContain(`<option value="${v}">`);
    expect(h).toContain(`data-api="${SIGNUP_API_BASE}"`);
    expect(h).toContain(`data-lang="${l}"`);
    expect(h).toContain('href="/' + l + '/privacy/"');
    // every control has a visible label, none relies on placeholder
    expect(h).not.toContain('placeholder=');
    for (const id of ['su-name', 'su-email', 'su-role', 'su-heard', 'su-age', 'su-consent'])
      expect(h).toContain(`<label for="${id}"`);
  });
  it.each(['he', 'en'])('%s honeypot is hidden from everyone', (l) => {
    const h = page(out, l);
    const hp = h.match(/<div class="hp"[^>]*>[\s\S]*?<\/div>/)[0];
    expect(hp).toContain('aria-hidden="true"');
    const input = hp.match(/<input[^>]*>/)[0];
    for (const a of [
      'name="website"',
      'tabindex="-1"',
      'autocomplete="off"',
      'aria-hidden="true"',
      'value=""',
    ])
      expect(input).toContain(a);
    const css = readFileSync(join(out, 'assets', 'site.css'), 'utf8');
    expect(css).toMatch(/\.hp(?:,\s*\.hp input)?\s*{[^}]*inset-inline-start:\s*-10000px/);
  });
  it.each(['he', 'en'])('%s honeypot wrapper is inert', (l) => {
    expect(page(out, l)).toMatch(/<div class="hp"[^>]*\sinert[\s>]/);
  });
  it.each(['he', 'en'])(
    '%s visible no-JS fallback with the support address; script hides it',
    (l) => {
      const h = page(out, l);
      const p = h.match(/<p[^>]*id="su-nojs"[^>]*>[\s\S]*?<\/p>/)[0];
      expect(p).not.toContain('hidden');
      expect(p).toContain('mailto:support@tbi-tech.net');
      expect(p).toContain(content[l].signup.nojs.slice(0, 12));
      const js = readFileSync(join(out, 'assets', 'signup.mjs'), 'utf8');
      expect(js).toMatch(/getElementById\('su-nojs'\)\?\.setAttribute\('hidden'/);
    },
  );
  it.each(['he', 'en'])('%s consent link opens in a new tab and says so', (l) => {
    const h = page(out, l);
    const a = h
      .match(/<a href="\/[a-z]+\/privacy\/"[^>]*>[\s\S]*?<\/a>/g)
      .find((x) => x.includes('target'));
    expect(a).toContain('target="_blank"');
    expect(a).toContain('rel="noopener"');
    expect(a).toContain(`<span class="visually-hidden"> ${content[l].signup.newTab}</span>`);
  });
  it('Hebrew sign-up strings isolate Latin tokens in bdi-like LTR spans', () => {
    const h = page(out, 'he');
    for (const tok of ['TBI', 'Alpha', 'Arduino', 'Chrome', 'Edge'])
      expect(h).toContain(`<span dir="ltr" lang="en">${tok}`);
    const body = h
      .match(/<main[\s\S]*<\/main>/)[0]
      .replace(/<span dir="ltr"[^>]*>[^<]*<\/span>/g, '');
    const visible = body.replace(/<[^>]+>/g, ' ').replace(/support@tbi-tech\.net/g, '');
    expect(visible).not.toMatch(/[A-Za-z]{2,}/);
  });
  it('no leftover sending label / success announcement strings', () => {
    for (const l of ['he', 'en']) {
      expect(content[l].signup.sending).toBeUndefined();
      expect(content[l].signup.statusSuccess).toBeUndefined();
    }
  });
  it('role option count matches labels in both languages', () => {
    for (const l of ['he', 'en'])
      expect(content[l].signup.roles).toHaveLength(SIGNUP_ROLE_VALUES.length);
  });
  it('the script has no inline strings of UI text, no third-party URLs', () => {
    const js = readFileSync(join(out, 'assets', 'signup.mjs'), 'utf8');
    expect(js).not.toMatch(/https?:\/\//);
    expect(js).not.toMatch(/\beval\(|document\.write|innerHTML/);
  });
});

/* ---- client logic with a fake fetch ---- */
const res = (status, body = {}, ok = status >= 200 && status < 300) => ({
  status,
  ok,
  json: async () => body,
});
function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const h = handlers[`${init.method} ${url.replace(/^\/signup/, '')}`];
    const r = typeof h === 'function' ? h(calls.filter((c) => c.url === url).length) : h;
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}
const payload = {
  name: 'A',
  email: 'a@example.com',
  role: 'Student',
  lang: 'en',
  consent: true,
  heardFrom: 'Instagram',
  website: '',
};
function setup(handlers, now) {
  const fetchFn = fakeFetch(handlers);
  const tokens = createTokenStore({ fetchFn, base: '/signup', now });
  // The minimum-fill wait is covered in signup-contract.test.mjs; here time is not the subject.
  const sleep = async () => {};
  return { fetchFn, tokens, sub: createSubmitter({ fetchFn, base: '/signup', tokens, sleep }) };
}
const tokOk = (n) => res(200, { token: `w1.t${n}`, ttl: 1800 });
const body = (c) => JSON.parse(c.init.body);

describe('client script logic', () => {
  it('validate: required fields, email shape, consents', () => {
    expect(
      validate({ name: '', email: 'x', role: '', heard: '', age: false, consent: false }),
    ).toEqual(['name', 'email', 'role', 'age', 'consent']);
    expect(
      validate({
        name: 'N',
        email: 'a@b.co',
        role: 'Student',
        heard: 'Other',
        age: true,
        consent: true,
      }),
    ).toEqual([]);
    expect(
      validate({
        name: 'x'.repeat(81),
        email: 'a@b.co',
        role: 'r',
        heard: 'h',
        age: true,
        consent: true,
      }),
    ).toEqual(['name']);
  });
  it('token flow: one fetch is shared, token is posted with the exact contract body', async () => {
    const { fetchFn, tokens, sub } = setup({
      'GET /form-token': tokOk(1),
      'POST /web': res(200, { ok: true, status: 'received' }),
    });
    const warm = [tokens.get(), tokens.get()];
    await Promise.all(warm);
    expect(fetchFn.calls.filter((c) => c.url.endsWith('form-token'))).toHaveLength(1);
    expect(await sub.submit(payload)).toEqual({ ok: true });
    const post = fetchFn.calls.find((c) => c.url === '/signup/web');
    expect(post.init.headers['content-type']).toBe('application/json');
    expect(body(post)).toEqual({ ...payload, token: 'w1.t1' });
    expect(Object.keys(body(post)).sort()).toEqual([
      'consent',
      'email',
      'heardFrom',
      'lang',
      'name',
      'role',
      'token',
      'website',
    ]);
  });
  it('fetches the token on submit when none was loaded, and refreshes one that is about to expire', async () => {
    let t = 0;
    let n = 0;
    const { fetchFn, sub, tokens } = setup(
      { 'GET /form-token': () => tokOk(++n), 'POST /web': res(200, { ok: true }) },
      () => t,
    );
    await sub.submit(payload);
    expect(fetchFn.calls[0].url).toBe('/signup/form-token');
    expect(n).toBe(1);
    await tokens.get(); // the first token was consumed by the success, so a new one is fetched
    expect(n).toBe(2);
    await tokens.get(); // still fresh: no fetch
    expect(n).toBe(2);
    t = 1800_000 - TOKEN_MARGIN_MS + 1; // about to expire: refreshed before use
    await tokens.get();
    expect(n).toBe(3);
  });
  it('401 refetches the token and retries once, transparently', async () => {
    let posts = 0;
    let n = 0;
    const { fetchFn, sub } = setup({
      'GET /form-token': () => tokOk(++n),
      'POST /web': () => (++posts === 1 ? res(401, { error: 'expired' }) : res(200, { ok: true })),
    });
    expect(await sub.submit(payload)).toEqual({ ok: true });
    const posted = fetchFn.calls.filter((c) => c.url === '/signup/web').map(body);
    expect(posted.map((b) => b.token)).toEqual(['w1.t1', 'w1.t2']);
  });
  it('a second 401 gives the session message (no loop)', async () => {
    const { fetchFn, sub } = setup({
      'GET /form-token': tokOk(1),
      'POST /web': res(401, { error: 'unauthorized' }),
    });
    expect(await sub.submit(payload)).toEqual({ ok: false, msg: MSG.session });
    expect(fetchFn.calls.filter((c) => c.url === '/signup/web')).toHaveLength(2);
  });
  it.each([
    [429, {}, MSG.rate],
    [503, {}, MSG.unavailable],
    [403, {}, MSG.forbidden],
    [400, { error: 'too_fast' }, MSG.tooFast],
    [400, { error: 'invalid' }, MSG.invalid],
    [413, {}, MSG.generic],
    [500, {}, MSG.generic],
    // A gateway error or an unusable 200: the request may have arrived.
    [502, {}, MSG.unknown],
    [504, {}, MSG.unknown],
    [200, {}, MSG.unknown],
  ])('POST %s %j maps to %s', async (status, b, msg) => {
    const { sub } = setup({ 'GET /form-token': tokOk(1), 'POST /web': res(status, b) });
    expect(await sub.submit(payload)).toEqual({ ok: false, msg });
  });
  it('network failure on POST and on token fetch', async () => {
    let r = setup({ 'GET /form-token': tokOk(1), 'POST /web': new Error('offline') });
    expect(await r.sub.submit(payload)).toEqual({ ok: false, msg: MSG.network });
    r = setup({ 'GET /form-token': new Error('offline') });
    expect(await r.sub.submit(payload)).toEqual({ ok: false, msg: MSG.network });
    r = setup({ 'GET /form-token': res(429) });
    expect(await r.sub.submit(payload)).toEqual({ ok: false, msg: MSG.rate });
    r = setup({ 'GET /form-token': res(503) });
    expect(await r.sub.submit(payload)).toEqual({ ok: false, msg: MSG.unavailable });
  });
  it('502/504 on the token fetch: nothing was posted, so the generic "not sent" text', async () => {
    for (const s of [502, 504]) {
      const { sub } = setup({ 'GET /form-token': res(s) });
      expect(await sub.submit(payload)).toEqual({ ok: false, msg: MSG.generic });
    }
  });
  it('token survives 503, 429 and too_fast (retry with the same token), not an invalid answer', async () => {
    for (const [s, b, keep] of [
      [503, {}, true],
      [429, {}, true],
      [400, { error: 'too_fast' }, true],
      [400, { error: 'invalid' }, false],
    ]) {
      const { fetchFn, sub } = setup({ 'GET /form-token': tokOk(1), 'POST /web': res(s, b) });
      await sub.submit(payload);
      await sub.submit(payload);
      const gets = fetchFn.calls.filter((c) => c.url.endsWith('form-token')).length;
      expect(gets, `${s}`).toBe(keep ? 1 : 2);
    }
  });
  it('double submit while sending is ignored and sends once', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { fetchFn, sub } = setup({
      'GET /form-token': tokOk(1),
      'POST /web': async () => {
        await gate;
        return res(200, { ok: true });
      },
    });
    const first = sub.submit(payload);
    await Promise.resolve();
    expect(await sub.submit(payload)).toEqual({ ignored: true });
    release();
    expect(await first).toEqual({ ok: true });
    expect(fetchFn.calls.filter((c) => c.url === '/signup/web')).toHaveLength(1);
    expect(sub.busy).toBe(false);
  });
});
