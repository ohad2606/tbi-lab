/**
 * BETA-G1 G1-AUTO-VERIFY slice 3: confirm view and resend form (built with --signup-verify), HE and EN, mocked
 * network; and the public pages whose copy changes with that option. The built files are served through page.route with the real site CSP, so the shared web server (a build
 * without the option) is not changed.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);
const ORIGIN = 'http://127.0.0.1:4391';
const TOKEN = `v1.01ARZ3NDEKTSV4RRFFQ69G5FAV.1.1900000000.abcdefghijklmnopqrstuv.${'m'.repeat(43)}`;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
let dist = '';
let csp = '';
test.beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'tbi-vf-e2e-'));
  execFileSync('node', ['site/build.mjs', dist, '--signup-verify']);
  // @ts-expect-error plain .mjs without type declarations
  csp = (await import('../csp.mjs')).SITE_CSP;
});
test.afterAll(() => rmSync(dist, { recursive: true, force: true }));

async function axe(page: Page) {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const r = await (window as any).axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    });
    return r.violations.map(
      (v: any) => `${v.id}: ${v.nodes.map((n: any) => n.target.join(' ')).join(', ')}`,
    );
  });
}

type Answer = [number, object] | 'abort';
const RECEIVED: Answer = [202, { ok: true, status: 'received' }];

async function stub(page: Page, o: { verify?: Answer[]; resend?: Answer[] } = {}) {
  const log = {
    verify: [] as any[],
    resend: [] as any[],
    urls: [] as string[],
    console: [] as string[],
  };
  page.on('console', (m) => log.console.push(m.text()));
  page.on('request', (r) => log.urls.push(r.url()));
  await page.route(`${ORIGIN}/**`, (r) => {
    let path = new URL(r.request().url()).pathname;
    if (path.endsWith('/')) path += 'index.html';
    let body: Buffer;
    try {
      body = readFileSync(join(dist, path));
    } catch {
      return r.fulfill({ status: 404, body: '' });
    }
    return r.fulfill({
      body,
      headers: {
        'content-type': TYPES[extname(path)] ?? 'text/plain',
        'content-security-policy': csp,
      },
    });
  });
  let tokens = 0;
  await page.route(/\/signup\/form-token$/, (r) =>
    r.fulfill({ json: { token: `w1.test${++tokens}`, ttl: 1800, minFill: 0 } }),
  );
  for (const key of ['verify', 'resend'] as const)
    await page.route(new RegExp(`/signup/${key}$`), (r) => {
      expect(r.request().method()).toBe('POST');
      log[key].push(r.request().postDataJSON());
      const a = o[key]?.shift() ?? (key === 'verify' ? RECEIVED : [200, { ok: true }]);
      if (a === 'abort') return r.abort('connectionrefused');
      return r.fulfill({ status: a[0], json: a[1] });
    });
  return log;
}

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const { lang, dir } of [
  { lang: 'he', dir: 'rtl' },
  { lang: 'en', dir: 'ltr' },
]) {
  test.describe(lang, () => {
    const url = `/${lang}/signup/#verify=${TOKEN}`;
    const msg = (page: Page, key: string) => page.locator(`[data-vf="${key}"]`).textContent();

    test('load never verifies; the token leaves the address bar and stays out of page, storage and URLs', async ({
      page,
    }) => {
      const log = await stub(page);
      await page.goto(url);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      await expect(page.locator('#vf-button')).toBeVisible();
      await expect(page).toHaveURL(`${ORIGIN}/${lang}/signup/`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        (await msg(page, 'confirmH'))!,
      );
      await expect(page).toHaveTitle((await msg(page, 'confirmTitle'))!);
      await expect(page.locator('#signup-form')).toBeHidden();
      await expect(page.locator('#su-intro-extra')).toBeHidden();
      await expect(page.locator('#vf-resend')).toBeHidden();
      await page.waitForLoadState('networkidle');
      expect(log.verify).toHaveLength(0);
      expect(await axe(page)).toEqual([]);
      await page.locator('#vf-button').click();
      await expect(page.locator('#vf-result')).toBeFocused();
      expect(log.verify).toEqual([{ token: TOKEN }]);
      const leak = await page.evaluate(() =>
        [
          document.documentElement.outerHTML,
          JSON.stringify(localStorage),
          JSON.stringify(sessionStorage),
          document.cookie,
          location.href,
        ].join('\n'),
      );
      expect(leak).not.toContain(TOKEN);
      for (const s of [...log.urls.slice(1), ...log.console]) expect(s).not.toContain(TOKEN);
      expect(log.console.filter((m) => /Content Security Policy/i.test(m))).toEqual([]);
    });

    test('keyboard: Enter confirms; received is announced, focused and claims no approval', async ({
      page,
    }) => {
      const log = await stub(page);
      await page.goto(url);
      await page.locator('#vf-button').focus();
      await page.keyboard.press('Enter');
      const h = page.locator('#vf-result-h');
      const box = page.locator('#vf-result');
      await expect(box).toBeFocused();
      await expect(h).toHaveText((await msg(page, 'resultReceivedH'))!);
      await expect(box).toHaveRole('group');
      await expect(box).toHaveAccessibleName((await msg(page, 'resultReceivedH'))!);
      await expect(box).toHaveAccessibleDescription(
        new RegExp((await msg(page, 'resultReceivedP'))!.slice(0, 20)),
      );
      // not also a live region (it would be read twice)
      expect(
        await box.evaluate((e) => e.matches('[role=status], [aria-live], [aria-atomic]')),
      ).toBe(false);
      await expect(page.locator('#vf-button')).toBeHidden();
      await expect(page.locator('#vf-resend')).toBeHidden();
      const outline = await box.evaluate((e) => getComputedStyle(e).outlineStyle);
      expect(outline).not.toBe('none');
      expect(await axe(page)).toEqual([]);
      expect(log.verify).toHaveLength(1);
    });

    for (const [name, answer] of [
      ['Expired', [410, { error: 'expired' }]],
      ['Invalid', [400, { error: 'invalid' }]],
    ] as const) {
      test(`${name}: resend form by keyboard, described error, neutral answer`, async ({
        page,
      }) => {
        const log = await stub(page, { verify: [answer as unknown as Answer] });
        await page.goto(url);
        await page.locator('#vf-button').click();
        const h = page.locator('#vf-result-h');
        const box = page.locator('#vf-result');
        await expect(box).toBeFocused();
        await expect(h).toHaveText((await msg(page, `result${name}H`))!);
        await expect(page.locator('#vf-button')).toBeHidden();
        const email = page.locator('#vf-email');
        await expect(email).toBeVisible();
        await expect(email).toHaveAttribute('dir', 'ltr');
        await expect(email).toHaveAccessibleName(/Google/);
        await expect(email).toHaveAttribute('aria-describedby', 'vf-hint-email');
        expect(await axe(page)).toEqual([]);
        await page.keyboard.press('Tab'); // result -> email (the honeypot is skipped later)
        await expect(email).toBeFocused();
        await page.keyboard.type('not-an-address');
        await page.keyboard.press('Enter');
        await expect(email).toBeFocused();
        await expect(email).toHaveAttribute('aria-invalid', 'true');
        await expect(email).toHaveAttribute('aria-describedby', 'vf-hint-email vf-err-email');
        await expect(page.locator('#vf-err-email')).toBeVisible();
        // Focus did not move, so the error is announced by the live region, and again on a repeat.
        const live = page.locator('#vf-progress');
        const errText = (await page.locator('#vf-err-email').textContent())!;
        await expect(live).toHaveText(errText);
        await live.evaluate((el) => {
          const seen: string[] = [];
          (window as any).seen = seen;
          new MutationObserver(() => seen.push(el.textContent ?? '')).observe(el, {
            childList: true,
          });
        });
        await page.keyboard.press('Enter');
        await expect
          .poll(() => page.evaluate(() => (window as any).seen as string[]))
          .toEqual(['', errText]);
        await expect(email).toBeFocused();
        expect(log.resend).toHaveLength(0);
        expect(await axe(page)).toEqual([]);
        await email.fill('dana@example.com');
        await expect(email).not.toHaveAttribute('aria-invalid', 'true');
        await page.keyboard.press('Tab');
        await expect(page.locator('#vf-resend-button')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(h).toHaveText((await msg(page, 'resultSentH'))!);
        await expect(box).toBeFocused();
        await expect(page.locator('#vf-resend')).toBeHidden();
        expect(log.resend).toEqual([{ email: 'dana@example.com', website: '', token: 'w1.test1' }]);
        expect(await axe(page)).toEqual([]);
      });
    }

    test('rate limit and network error: said in text, the button stays, a retry works', async ({
      page,
    }) => {
      const log = await stub(page, {
        verify: [[429, { error: 'rate_limited' }], 'abort', 'abort', [503, {}]],
      });
      await page.goto(url);
      const button = page.locator('#vf-button');
      const h = page.locator('#vf-result-h');
      const box = page.locator('#vf-result');
      for (const name of ['Rate', 'Network', 'Network', 'Unavailable', 'Received']) {
        await button.focus();
        await page.keyboard.press('Enter');
        await expect(box).toBeFocused();
        await expect(h).toHaveText((await msg(page, `result${name}H`))!);
        if (name !== 'Received') {
          await expect(button).toBeVisible();
          await expect(button).toHaveAttribute('aria-disabled', 'false');
          await expect(page.locator('#vf-resend')).toBeHidden();
          if (name === 'Unavailable') await page.keyboard.press('Tab'); // the support link in the text
          await page.keyboard.press('Tab');
          await expect(button).toBeFocused();
        }
      }
      expect(log.verify).toHaveLength(5);
    });

    test('sending: focus stays on the button, one request, progress announced', async ({
      page,
    }) => {
      await stub(page);
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      let posts = 0;
      await page.route(/\/signup\/verify$/, async (r) => {
        posts++;
        await gate;
        await r.fulfill({ status: 202, json: { ok: true } });
      });
      await page.goto(url);
      const button = page.locator('#vf-button');
      await button.focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await expect(button).toBeFocused();
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator('#vf-progress')).toHaveText((await msg(page, 'confirmSending'))!);
      await expect(page.locator('#vf-sending')).toBeVisible();
      release();
      await expect(page.locator('#vf-result')).toBeFocused();
      await expect(page.locator('#vf-progress')).toHaveText('');
      expect(posts).toBe(1);
    });

    test('resend sending line sits next to its button; unavailable and invalid have resend texts', async ({
      page,
    }) => {
      await stub(page, { verify: [[410, {}]] });
      let release: () => void = () => {};
      const answers = [503, 400];
      await page.route(/\/signup\/resend$/, async (r) => {
        const status = answers.shift()!;
        if (status === 503) await new Promise<void>((done) => (release = done));
        await r.fulfill({ status, json: {} });
      });
      await page.goto(url);
      await page.locator('#vf-button').click();
      await expect(page.locator('#vf-result')).toBeFocused();
      await page.locator('#vf-email').fill('dana@example.com');
      await page.locator('#vf-resend-button').click();
      const line = page.locator('#vf-resend-sending');
      await expect(line).toBeVisible();
      await expect(line).toHaveText((await msg(page, 'resendSending'))!);
      await expect(page.locator('#vf-progress')).toHaveText((await msg(page, 'resendSending'))!);
      await expect(page.locator('#vf-sending')).toBeHidden();
      const gap = await page.evaluate(
        () =>
          document.getElementById('vf-resend-sending')!.getBoundingClientRect().top -
          document.getElementById('vf-resend-button')!.getBoundingClientRect().bottom,
      );
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(48);
      release();
      for (const key of ['resendUnavailable', 'resendInvalid']) {
        if (key === 'resendInvalid') await page.locator('#vf-resend-button').click();
        await expect(page.locator('#vf-result-p')).toHaveText((await msg(page, key))!);
        await expect(page.locator('#vf-result')).toBeFocused();
        await expect(line).toBeHidden();
      }
    });

    test('without JavaScript the page says how to confirm', async ({ browser }) => {
      const context = await browser.newContext({ javaScriptEnabled: false, baseURL: ORIGIN });
      const page = await context.newPage();
      await stub(page);
      await page.goto(url);
      await expect(page.locator('#su-nojs')).toBeVisible();
      await expect(page.locator('#su-nojs')).toContainText(
        lang === 'he'
          ? 'כדי לאשר את המייל, הפעילו JavaScript וטענו את הדף מחדש'
          : 'To confirm your email, turn on JavaScript and reload the page',
      );
      await context.close();
    });

    test('resend failure keeps the form and the address', async ({ page }) => {
      await stub(page, {
        verify: [[410, {}]],
        resend: [[429, { error: 'rate_limited' }]],
      });
      await page.goto(url);
      await page.locator('#vf-button').click();
      await expect(page.locator('#vf-result')).toBeFocused();
      await page.locator('#vf-email').fill('dana@example.com');
      await page.locator('#vf-resend-button').click();
      await expect(page.locator('#vf-result-h')).toHaveText((await msg(page, 'resultFailH'))!);
      await expect(page.locator('#vf-result')).toBeFocused();
      await expect(page.locator('#vf-result-p')).toHaveText(
        (await page.locator('[data-msg="msgRate"]').textContent())!,
      );
      await expect(page.locator('#vf-email')).toHaveValue('dana@example.com');
      await expect(page.locator('#vf-resend')).toBeVisible();
    });

    test('a link opened in the same tab switches to the confirm view and is stripped', async ({
      page,
    }) => {
      const log = await stub(page);
      await page.goto(`/${lang}/signup/`);
      await expect(page.locator('#signup-form')).toBeVisible();
      await expect(page.locator('#vf')).toBeHidden();
      await expect(page.locator('label[for=su-email]')).toContainText('Google');
      expect(await axe(page)).toEqual([]);
      await page.evaluate((t) => (location.hash = `verify=${t}`), TOKEN);
      await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
      await expect(page).toHaveURL(`${ORIGIN}/${lang}/signup/`);
      await expect(page.locator('#signup-form')).toBeHidden();
      expect(log.verify).toHaveLength(0);
    });

    test('24px targets, visible focus, reflow at 320px and 200% text', async ({ page }) => {
      await stub(page, { verify: [[410, {}]] });
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto(url);
      const check = async (sel: string) => {
        const el = page.locator(sel);
        await page.keyboard.press('Shift'); // keyboard modality for :focus-visible
        await el.focus();
        const s = await el.evaluate((e) => {
          const c = getComputedStyle(e);
          const r = e.getBoundingClientRect();
          return { w: parseFloat(c.outlineWidth), st: c.outlineStyle, h: r.height, wd: r.width };
        });
        expect(s.st, sel).not.toBe('none');
        expect(s.w, sel).toBeGreaterThanOrEqual(2);
        expect(Math.min(s.h, s.wd), sel).toBeGreaterThanOrEqual(24);
      };
      await check('#vf-button');
      expect(await noOverflow(page)).toBeLessThanOrEqual(0);
      await page.keyboard.press('Enter');
      await expect(page.locator('#vf-result')).toBeFocused();
      await check('#vf-email');
      await check('#vf-resend-button');
      await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
      expect(await noOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('a confirm link load asks for no form token until the resend form is shown', async ({
      page,
    }) => {
      const log = await stub(page, { verify: [[410, {}]] });
      const tokenGets = () => log.urls.filter((u) => u.endsWith('/signup/form-token')).length;
      await page.goto(url);
      await expect(page.locator('#vf-button')).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(tokenGets()).toBe(0);
      await page.locator('#vf-button').click();
      await expect(page.locator('#vf-resend')).toBeVisible();
      await expect.poll(tokenGets).toBe(1);
    });

    test('Back after a same-tab link restores the sign-up form; focus on its heading', async ({
      page,
    }) => {
      const log = await stub(page);
      await page.goto(`/${lang}/signup/`);
      const h1 = page.getByRole('heading', { level: 1 });
      const title = await page.title();
      const heading = await h1.innerHTML();
      await page.locator('#su-name').fill('Dana');
      await page.evaluate((t) => (location.hash = `verify=${t}`), TOKEN);
      await expect(page.locator('#vf')).toBeVisible();
      await page.goBack();
      await expect(page.locator('#signup-form')).toBeVisible();
      await expect(page.locator('#vf')).toBeHidden();
      await expect(page.locator('#su-intro-extra')).toBeVisible();
      await expect(page.locator('#su-nojs')).toBeHidden();
      await expect(page).toHaveTitle(title);
      expect(await h1.innerHTML()).toBe(heading);
      await expect(h1).toBeFocused();
      await expect(page.locator('#su-name')).toHaveValue('Dana');
      expect(await axe(page)).toEqual([]);
      // Forward does not bring the dropped link back; opening it again does.
      await page.goForward();
      await expect(page.locator('#signup-form')).toBeVisible();
      await expect(page.locator('#vf')).toBeHidden();
      await page.evaluate((t) => (location.hash = `verify=${t}`), TOKEN);
      await expect(page.locator('#vf-button')).toBeVisible();
      await page.locator('#vf-button').click();
      await expect(page.locator('#vf-result')).toBeFocused();
      expect(log.verify).toEqual([{ token: TOKEN }]);
    });

    test('after Back, a resend still pending does not swallow the next one', async ({ page }) => {
      await stub(page, {
        verify: [
          [410, {}],
          [410, {}],
        ],
      });
      let posts = 0;
      await page.route(/\/signup\/resend$/, (r) => {
        if (posts++ === 0) return; // the first one never answers
        return r.fulfill({ json: { ok: true } });
      });
      await page.goto(`/${lang}/signup/`);
      const askForLink = async () => {
        await page.evaluate((t) => (location.hash = `verify=${t}`), TOKEN);
        await page.locator('#vf-button').click();
        await expect(page.locator('#vf-result')).toBeFocused();
        await page.locator('#vf-email').fill('dana@example.com');
        await page.locator('#vf-resend-button').focus();
        await page.keyboard.press('Enter');
      };
      await askForLink();
      await expect.poll(() => posts).toBe(1);
      await page.goBack();
      await expect(page.locator('#vf')).toBeHidden();
      await askForLink();
      await expect(page.locator('#vf-result-h')).toHaveText((await msg(page, 'resultSentH'))!);
      await expect(page.locator('#vf-result')).toBeFocused();
      expect(posts).toBe(2);
    });

    test('Back to the skip-link entry puts focus on the heading, in view', async ({ page }) => {
      await stub(page);
      await page.setViewportSize({ width: 1024, height: 400 });
      await page.goto(`/${lang}/signup/`);
      await page.locator('a.skip').focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`${ORIGIN}/${lang}/signup/#main`);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.evaluate((t) => (location.hash = `verify=${t}`), TOKEN);
      const h1 = page.getByRole('heading', { level: 1 });
      await expect(h1).toBeFocused();
      await page.goBack();
      await expect(page).toHaveURL(`${ORIGIN}/${lang}/signup/#main`);
      await expect(page.locator('#signup-form')).toBeVisible();
      await page.waitForTimeout(300); // the browser's own fragment and scroll handling is over
      await expect(h1).toBeFocused();
      await expect(h1).toBeInViewport({ ratio: 1 });
      expect(await h1.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe('none');
      await page.keyboard.press('Tab');
      await expect(page.locator('#su-name')).toBeFocused();
    });

    test('a sign-up that succeeds behind the confirm view: Back shows success without the lead', async ({
      page,
    }) => {
      await stub(page);
      let answer: (() => Promise<void>) | undefined;
      await page.route(/\/signup\/web$/, (r) => {
        answer = () => r.fulfill({ json: { ok: true } });
      });
      await page.goto(`/${lang}/signup/`);
      await page.locator('#su-name').fill('Dana');
      await page.locator('#su-email').fill('dana@example.com');
      await page.locator('#su-role').selectOption({ index: 1 });
      await page.locator('#su-age').check();
      await page.locator('#su-consent').check();
      await page.locator('#su-submit').click();
      await expect.poll(() => !!answer).toBe(true);
      await page.evaluate((t) => (location.hash = `verify=${t}`), TOKEN);
      await expect(page.locator('#vf')).toBeVisible();
      await answer!();
      await expect(page.locator('#su-success')).not.toHaveAttribute('hidden');
      await expect(page.locator('#su-intro-extra')).toBeHidden();
      await page.goBack();
      await expect(page.locator('#su-success')).toBeVisible();
      await expect(page.locator('#su-success-h')).toBeFocused();
      await expect(page.locator('#su-intro-extra')).toBeHidden();
      await expect(page.locator('#signup-form')).toBeHidden();
    });

    /** Sends the sign-up form, then opens a confirm link while the answer is still pending. */
    async function sendThenConfirmLink(page: Page) {
      await stub(page);
      let route: import('@playwright/test').Route | undefined;
      await page.route(/\/signup\/web$/, (r) => {
        route = r;
      });
      await page.goto(`/${lang}/signup/`);
      await page.locator('#su-name').fill('Dana');
      await page.locator('#su-email').fill('dana@example.com');
      await page.locator('#su-role').selectOption({ index: 1 });
      await page.locator('#su-age').check();
      await page.locator('#su-consent').check();
      await page.locator('#su-submit').click();
      await expect.poll(() => !!route).toBe(true);
      await page.evaluate((t) => (location.hash = `verify=${t}`), TOKEN);
      await expect(page.locator('#vf')).toBeVisible();
      return route!;
    }

    test('a success that arrives right after Back keeps focus on the success heading', async ({
      page,
    }) => {
      const route = await sendThenConfirmLink(page);
      // Hold the delayed focus (60 ms) so the answer certainly arrives between Back and it.
      await page.evaluate(() => {
        const real = window.setTimeout.bind(window);
        const held: (() => void)[] = [];
        Object.assign(window, {
          held,
          setTimeout: (f: () => void, ms?: number) => (ms === 60 ? held.push(f) : real(f, ms)),
        });
      });
      await page.goBack();
      await expect(page.locator('#signup-form')).toBeVisible();
      await route.fulfill({ json: { ok: true } });
      await expect(page.locator('#su-success-h')).toBeFocused();
      await page.evaluate(() => (window as any).held.forEach((f: () => void) => f()));
      await expect(page.locator('#su-success-h')).toBeFocused();
    });

    test('a sign-up that fails behind the confirm view: Back focuses the error summary', async ({
      page,
    }) => {
      const route = await sendThenConfirmLink(page);
      await route.fulfill({ status: 503, json: {} });
      await expect(page.locator('#su-summary')).not.toHaveAttribute('hidden');
      await page.goBack();
      await expect(page.locator('#su-summary')).toBeFocused();
      await expect(page.locator('#su-summary')).toBeInViewport();
      await page.waitForTimeout(200);
      await expect(page.locator('#su-summary')).toBeFocused();
    });

    test('a sign-up with no answer is not headed as "not sent"', async ({ page }) => {
      const route = await sendThenConfirmLink(page);
      await page.goBack();
      await route.abort('connectionrefused');
      await expect(page.locator('#su-summary')).toBeFocused();
      const heading = page.locator('#su-summary-h');
      const signupMsg = (key: string) => page.locator(`[data-msg="${key}"]`).textContent();
      await expect(heading).toHaveText((await signupMsg('summaryNetworkH'))!);
      await expect(heading).not.toHaveText((await signupMsg('summaryFailH'))!);
      await expect(page.locator('#su-summary-msg')).toHaveText((await signupMsg('msgNetwork'))!);
    });

    test('the skip link and Back from it keep the confirm view', async ({ page }) => {
      const log = await stub(page);
      await page.goto(url);
      await page.locator('a.skip').focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`${ORIGIN}/${lang}/signup/#main`);
      await expect(page.locator('#vf-button')).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(`${ORIGIN}/${lang}/signup/`);
      await expect(page.locator('#vf-button')).toBeVisible();
      await page.locator('#vf-button').click();
      await expect(page.locator('#vf-result')).toBeFocused();
      expect(log.verify).toEqual([{ token: TOKEN }]);
    });

    for (const hang of ['form-token', 'resend']) {
      test(`a hung ${hang} request times out with a message; the next click works`, async ({
        page,
      }) => {
        await stub(page, { verify: [[410, {}]] });
        let calls = 0;
        await page.route(new RegExp(`/signup/${hang}$`), (r) => {
          if (calls++ === 0) return; // never answered
          return r.fulfill({
            json: hang === 'resend' ? { ok: true } : { token: 'w1.late', ttl: 1800, minFill: 0 },
          });
        });
        await page.clock.install();
        await page.goto(url);
        await page.locator('#vf-button').click();
        await page.clock.runFor(100);
        await expect(page.locator('#vf-result')).toBeFocused();
        await page.locator('#vf-email').fill('dana@example.com');
        const send = page.locator('#vf-resend-button');
        await send.focus();
        await page.keyboard.press('Enter');
        await expect.poll(() => calls).toBe(1);
        await expect(send).toHaveAttribute('aria-disabled', 'true');
        await page.clock.fastForward(21_000);
        await page.clock.runFor(100);
        await expect(page.locator('#vf-result-h')).toHaveText((await msg(page, 'resultNetworkH'))!);
        await expect(page.locator('#vf-result-p')).toHaveText((await msg(page, 'resendNetwork'))!);
        await expect(page.locator('#vf-result')).toBeFocused();
        await expect(send).toHaveAttribute('aria-disabled', 'false');
        await send.focus();
        await page.keyboard.press('Enter');
        await page.clock.runFor(5_000);
        await expect(page.locator('#vf-result-h')).toHaveText((await msg(page, 'resultSentH'))!);
        expect(calls).toBe(2);
      });
    }

    test('a missing message element does not throw: the generic message is shown', async ({
      page,
    }) => {
      await stub(page, {
        verify: [[410, {}]],
        resend: [
          [429, {}],
          [429, {}],
        ],
      });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(url);
      await page.evaluate(() => document.querySelector('[data-msg="msgRate"]')!.remove());
      await page.locator('#vf-button').click();
      await expect(page.locator('#vf-result')).toBeFocused();
      await page.locator('#vf-email').fill('dana@example.com');
      await page.locator('#vf-resend-button').click();
      await expect(page.locator('#vf-result-h')).toHaveText((await msg(page, 'resultFailH'))!);
      await expect(page.locator('#vf-result-p')).toHaveText(
        (await page.locator('[data-msg="msgGeneric"]').textContent())!,
      );
      await page.evaluate(() => document.querySelector('[data-msg="msgGeneric"]')!.remove());
      await page.locator('#vf-resend-button').click();
      await expect(page.locator('#vf-result')).toBeFocused();
      await expect(page.locator('#vf-result-h')).toHaveText((await msg(page, 'resultFailH'))!);
      await expect(page.locator('#vf-result-p')).toHaveText('');
      expect(errors).toEqual([]);
    });
  });
}

const PAGE_HEADINGS = {
  he: {
    '': ['אלפא חינמית, מקומות מוגבלים'],
    'alpha/': ['איך מקבלים גישה', 'איך נרשמים'],
    'faq/': ['איך מקבלים גישה?', 'לא קיבלתי את מייל האישור. מה עושים?'],
    'accessibility/': ['נגישות TBI Lab', 'מה נבדק באתר הזה', 'מה לא נבדק באתר הזה'],
  },
  en: {
    '': ['Free Alpha, limited places'],
    'alpha/': ['How you get access', 'How to sign up'],
    'faq/': ['How do I get access?', 'I didn’t get the confirmation email. What can I do?'],
    'accessibility/': [
      'Accessibility of TBI Lab',
      'What was checked on this website',
      'What was not checked on this website',
    ],
  },
} as const;
const MANUAL_APPROVAL =
  /reviewed manually|Applying does not give access|Approved applicants|Google Forms|ידנית|אינה מקנה גישה|מי שיאושר/i;

for (const lang of ['he', 'en'] as const) {
  test.describe(`${lang}: public pages with the option on`, () => {
    for (const [path, headings] of Object.entries(PAGE_HEADINGS[lang])) {
      test(`${path || 'home'}: new copy, axe, 320px, visible focus and target size`, async ({
        page,
      }) => {
        await stub(page);
        await page.goto(`/${lang}/${path}`);
        await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
        await expect(page.locator('h1')).toHaveCount(1);
        for (const name of headings)
          await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
        expect(await page.locator('main').innerText()).not.toMatch(MANUAL_APPROVAL);
        expect(await axe(page)).toEqual([]);
        for (const a of await page.locator('main a, header a').all()) {
          await a.focus();
          const s = await a.evaluate((e) => {
            const c = getComputedStyle(e);
            return {
              width: parseFloat(c.outlineWidth),
              style: c.outlineStyle,
              height: e.getBoundingClientRect().height,
            };
          });
          expect(s.style).not.toBe('none');
          expect(s.width).toBeGreaterThanOrEqual(2);
          expect(s.height).toBeGreaterThanOrEqual(24);
        }
        await page.setViewportSize({ width: 320, height: 640 });
        expect(await noOverflow(page)).toBeLessThanOrEqual(0);
      });
    }

    test('accessibility: two limitations as a list, e-mail link reachable by keyboard', async ({
      page,
    }) => {
      await stub(page);
      await page.goto(`/${lang}/accessibility/`);
      const statement = page.locator('main section').first();
      await expect(statement.getByRole('list')).toHaveCount(1);
      await expect(statement.getByRole('listitem')).toHaveCount(2);
      const mail = statement.getByRole('link', { name: 'support@tbi-tech.net' });
      await expect(mail).toHaveAttribute('href', 'mailto:support@tbi-tech.net');
      await expect(mail.locator('span')).toHaveAttribute('dir', 'ltr');
      // Tab from the statement's heading lands on the address, its only link.
      await page.locator('#statement').focus();
      await page.keyboard.press('Tab');
      await expect(mail).toBeFocused();
    });

    test('the alpha call to action and the navigation lead to the own sign-up page', async ({
      page,
    }) => {
      await stub(page);
      await page.goto(`/${lang}/alpha/`);
      await expect(page.locator(`header nav a[href="/${lang}/signup/"]`)).toBeVisible();
      await page.locator('#how-to-apply ~ p a.btn-primary').click();
      await expect(page).toHaveURL(`${ORIGIN}/${lang}/signup/`);
      await expect(page.locator('#signup-form')).toBeVisible();
    });
  });
}
