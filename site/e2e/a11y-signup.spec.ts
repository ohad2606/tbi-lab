import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);
const LANGS = [
  { lang: 'he', dir: 'rtl' },
  { lang: 'en', dir: 'ltr' },
];

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

/** Stub the intake: records POST bodies; `postStatuses` are consumed in order, then 200. */
async function stub(page: Page, postStatuses: Array<[number, object?]> = []) {
  const posts: any[] = [];
  let tokens = 0;
  await page.route(/\/signup\/form-token$/, (r) =>
    r.fulfill({ json: { token: `w1.test${++tokens}`, ttl: 1800, minFill: 0 } }),
  );
  await page.route(/\/signup\/web$/, (r) => {
    posts.push(r.request().postDataJSON());
    const [status, b] = postStatuses.shift() ?? [200, { ok: true, status: 'received' }];
    return r.fulfill({ status, json: b ?? {} });
  });
  return { posts, tokenCount: () => tokens };
}

async function fillByKeyboard(page: Page) {
  await page.locator('#su-name').focus();
  await page.keyboard.type('Dana Test');
  await page.keyboard.press('Tab');
  await page.keyboard.type('dana@example.com');
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowDown'); // first real option
  await page.keyboard.press('Tab'); // how did you hear about us (optional free text)
  await page.keyboard.type('A friend');
  await page.keyboard.press('Tab'); // the support address link in the privacy text
  await page.keyboard.press('Tab'); // honeypot is skipped: next stop is the age checkbox
  await expect(page.locator('#su-age')).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab'); // consent checkbox
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab'); // the privacy link inside the consent label
  await page.keyboard.press('Tab');
  await expect(page.locator('#su-submit')).toBeFocused();
}

for (const { lang, dir } of LANGS) {
  test.describe(lang, () => {
    test('axe 0 violations: empty form, error state, success; noindex while disabled', async ({
      page,
    }) => {
      await stub(page);
      await page.goto(`/${lang}/signup/`);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      if (process.env.SITE_SIGNUP_ENABLED === '1')
        await expect(page.locator('meta[name=robots]')).toHaveCount(0);
      else await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex');
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('#signup-form')).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await page.locator('#su-submit').click();
      await expect(page.locator('#su-summary')).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await page.locator('#su-name').fill('Dana');
      await page.locator('#su-email').fill('dana@example.com');
      await page.locator('#su-role').selectOption({ index: 1 });
      await page.locator('#su-heard').fill('A friend');
      await page.locator('#su-age').check();
      await page.locator('#su-consent').check();
      await page.locator('#su-submit').click();
      await expect(page.locator('#su-success-h')).toBeFocused();
      expect(await axe(page)).toEqual([]);
    });

    test('error summary takes focus, fields are described, errors clear when fixed', async ({
      page,
    }) => {
      await stub(page);
      await page.goto(`/${lang}/signup/`);
      await page.locator('#su-submit').click();
      await expect(page.locator('#su-summary')).toBeFocused();
      await expect(page.locator('#su-summary li')).toHaveCount(5); // heardFrom is optional
      const name = page.locator('#su-name');
      await expect(name).toHaveAttribute('aria-invalid', 'true');
      await expect(name).toHaveAttribute('aria-describedby', 'su-err-name');
      await expect(page.locator('#su-email')).toHaveAttribute(
        'aria-describedby',
        'su-hint-email su-err-email',
      );
      // a summary link moves focus to its field
      await page.locator('#su-summary a').first().click();
      await expect(name).toBeFocused();
      await name.fill('Dana');
      await expect(name).not.toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#su-err-name')).toBeHidden();
      // the fixed field leaves the summary; an empty summary disappears
      await expect(page.locator('#su-summary li')).toHaveCount(4);
      await page.locator('#su-email').fill('dana@example.com');
      await page.locator('#su-role').selectOption({ index: 1 });
      await page.locator('#su-heard').fill('A friend');
      await page.locator('#su-age').check();
      await expect(page.locator('#su-summary li')).toHaveCount(1);
      await expect(page.locator('#su-summary')).toBeVisible();
      await page.locator('#su-consent').check();
      await expect(page.locator('#su-summary li')).toHaveCount(0);
      await expect(page.locator('#su-summary')).toBeHidden();
    });

    test('no-JS fallback paragraph is hidden once the script runs; honeypot is inert; consent link opens a new tab', async ({
      page,
    }) => {
      await stub(page);
      await page.goto(`/${lang}/signup/`);
      await expect(page.locator('#su-nojs')).toBeHidden();
      await expect(page.locator('.hp')).toHaveAttribute('inert', '');
      const a = page.locator('label[for=su-consent] a');
      await expect(a).toHaveAttribute('target', '_blank');
      await expect(a).toHaveAttribute('rel', 'noopener');
      await expect(a).toContainText(/\(.+\)/);
    });

    test('keyboard-only submit sends the contract body and shows the thank-you', async ({
      page,
    }) => {
      const s = await stub(page);
      await page.goto(`/${lang}/signup/`);
      await expect.poll(s.tokenCount).toBe(1); // token fetched on load, not on submit
      await fillByKeyboard(page);
      await page.keyboard.press('Enter');
      await expect(page.locator('#su-success-h')).toBeFocused();
      // the focused heading is the announcement: the live region is not used a second time
      await expect(page.locator('#su-status')).toHaveText('');
      await expect(page.locator('#signup-form')).toBeHidden();
      expect(s.posts).toHaveLength(1);
      expect(s.posts[0]).toMatchObject({
        name: 'Dana Test',
        email: 'dana@example.com',
        lang,
        consent: true,
        website: '',
        token: 'w1.test1',
      });
      expect(typeof s.posts[0].role).toBe('string');
      expect(s.posts[0].heardFrom).toBe('A friend');
    });

    test('429 and 503: friendly message in the summary, focus there, form data kept, retry works', async ({
      page,
    }) => {
      const s = await stub(page, [
        [429, { error: 'rate_limited' }],
        [503, { error: 'unavailable' }],
      ]);
      await page.goto(`/${lang}/signup/`);
      await fillByKeyboard(page);
      await page.keyboard.press('Enter');
      await expect(page.locator('#su-summary')).toBeFocused();
      const first = await page.locator('#su-summary-msg').textContent();
      expect(first).toMatch(/\S/);
      await expect(page.locator('#su-name')).toHaveValue('Dana Test');
      await page.locator('#su-submit').focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => s.posts.length).toBe(2);
      await expect(page.locator('#su-summary-msg')).not.toHaveText(first!);
      await page.locator('#su-submit').focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#su-success-h')).toBeFocused();
    });

    test('401 is retried silently with a fresh token', async ({ page }) => {
      const s = await stub(page, [[401, { error: 'expired' }]]);
      await page.goto(`/${lang}/signup/`);
      await fillByKeyboard(page);
      await page.keyboard.press('Enter');
      await expect(page.locator('#su-success-h')).toBeFocused();
      expect(s.posts.map((p) => p.token)).toEqual(['w1.test1', 'w1.test2']);
    });

    test('network failure message, and the button keeps focus while sending', async ({ page }) => {
      await page.route(/\/signup\/form-token$/, (r) =>
        r.fulfill({ json: { token: 't', ttl: 1800, minFill: 0 } }),
      );
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      await page.route(/\/signup\/web$/, async (r) => {
        await gate;
        await r.abort('connectionrefused');
      });
      await page.goto(`/${lang}/signup/`);
      await fillByKeyboard(page);
      await page.keyboard.press('Enter');
      const btn = page.locator('#su-submit');
      await expect(btn).toHaveAttribute('aria-disabled', 'true');
      await expect(btn).toBeFocused();
      const label = await btn.textContent();
      await expect(page.locator('#su-status')).toHaveText(/\S/);
      expect(await btn.textContent()).toBe(label); // label is stable while sending
      release();
      await expect(page.locator('#su-summary')).toBeFocused();
      await expect(btn).toHaveAttribute('aria-disabled', 'false');
    });

    test('honeypot is out of the tab order and the accessibility tree', async ({ page }) => {
      await stub(page);
      await page.goto(`/${lang}/signup/`);
      const hp = page.locator('#su-website');
      await expect(hp).toHaveAttribute('tabindex', '-1');
      await expect(page.getByRole('textbox', { name: /.*/ })).toHaveCount(3); // name, email, heard
      const box = await hp.boundingBox();
      expect(box!.width).toBeLessThanOrEqual(1);
    });

    test('controls: 24px targets, visible focus, reflow at 320px, 200% text', async ({ page }) => {
      await stub(page);
      await page.goto(`/${lang}/signup/`);
      for (const sel of [
        '#su-name',
        '#su-email',
        '#su-role',
        '#su-heard',
        '#su-age',
        '#su-consent',
        '#su-submit',
      ]) {
        const el = page.locator(sel);
        await el.focus();
        const s = await el.evaluate((e) => {
          const c = getComputedStyle(e);
          const r = e.getBoundingClientRect();
          return { w: parseFloat(c.outlineWidth), st: c.outlineStyle, h: r.height, wd: r.width };
        });
        expect(s.st, sel).not.toBe('none');
        expect(s.w, sel).toBeGreaterThanOrEqual(2);
        expect(Math.min(s.h, s.wd), sel).toBeGreaterThanOrEqual(24);
      }
      await expect(page.locator('#su-email')).toHaveAttribute('dir', 'ltr');
      await page.setViewportSize({ width: 320, height: 640 });
      await page.locator('#su-submit').click();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
    });
  });
}

test('no-JavaScript visitors get the noscript message and no usable form', async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto('/en/signup/');
  await expect(page.locator('#su-nojs')).toBeVisible();
  await expect(page.locator('#su-nojs')).toContainText('support@tbi-tech.net');
  await expect(page.locator('noscript + .notice, .notice').first()).toContainText('JavaScript');
  await expect(page.locator('#signup-form')).toBeHidden();
  await ctx.close();
});
