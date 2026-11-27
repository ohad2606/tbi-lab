/**
 * BETA-G1 G1-AUTO-VERIFY slice 3: confirm view and resend form (built with --signup-verify), HE and EN, mocked
 * network. The built files are served through page.route with the real site CSP, so the shared web server (a build
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
      await expect(page.locator('#vf-result-h')).toBeFocused();
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
      await expect(h).toBeFocused();
      await expect(h).toHaveText((await msg(page, 'resultReceivedH'))!);
      await expect(page.getByRole('status').filter({ has: h })).toContainText(
        (await msg(page, 'resultReceivedP'))!,
      );
      await expect(page.locator('#vf-button')).toBeHidden();
      await expect(page.locator('#vf-resend')).toBeHidden();
      const outline = await h.evaluate((e) => getComputedStyle(e).outlineStyle);
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
        await expect(h).toBeFocused();
        await expect(h).toHaveText((await msg(page, `result${name}H`))!);
        await expect(page.locator('#vf-button')).toBeHidden();
        const email = page.locator('#vf-email');
        await expect(email).toBeVisible();
        await expect(email).toHaveAttribute('dir', 'ltr');
        await expect(email).toHaveAccessibleName(/Google/);
        await expect(email).toHaveAttribute('aria-describedby', 'vf-hint-email');
        expect(await axe(page)).toEqual([]);
        await page.keyboard.press('Tab'); // heading -> email (the honeypot is skipped later)
        await expect(email).toBeFocused();
        await page.keyboard.type('not-an-address');
        await page.keyboard.press('Enter');
        await expect(email).toBeFocused();
        await expect(email).toHaveAttribute('aria-invalid', 'true');
        await expect(email).toHaveAttribute('aria-describedby', 'vf-hint-email vf-err-email');
        await expect(page.locator('#vf-err-email')).toBeVisible();
        expect(log.resend).toHaveLength(0);
        expect(await axe(page)).toEqual([]);
        await email.fill('dana@example.com');
        await expect(email).not.toHaveAttribute('aria-invalid', 'true');
        await page.keyboard.press('Tab');
        await expect(page.locator('#vf-resend-button')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(h).toHaveText((await msg(page, 'resultSentH'))!);
        await expect(h).toBeFocused();
        await expect(page.locator('#vf-resend')).toBeHidden();
        expect(log.resend).toEqual([{ email: 'dana@example.com', website: '', token: 'w1.test2' }]);
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
      for (const name of ['Rate', 'Network', 'Network', 'Unavailable', 'Received']) {
        await button.focus();
        await page.keyboard.press('Enter');
        await expect(h).toBeFocused();
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
      await expect(page.locator('#vf-result-h')).toBeFocused();
      await expect(page.locator('#vf-progress')).toHaveText('');
      expect(posts).toBe(1);
    });

    test('resend failure keeps the form and the address', async ({ page }) => {
      await stub(page, {
        verify: [[410, {}]],
        resend: [[429, { error: 'rate_limited' }]],
      });
      await page.goto(url);
      await page.locator('#vf-button').click();
      await expect(page.locator('#vf-result-h')).toBeFocused();
      await page.locator('#vf-email').fill('dana@example.com');
      await page.locator('#vf-resend-button').click();
      await expect(page.locator('#vf-result-h')).toHaveText((await msg(page, 'resultFailH'))!);
      await expect(page.locator('#vf-result-h')).toBeFocused();
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
      await expect(page.locator('#vf-result-h')).toBeFocused();
      await check('#vf-email');
      await check('#vf-resend-button');
      await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
      expect(await noOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
}
