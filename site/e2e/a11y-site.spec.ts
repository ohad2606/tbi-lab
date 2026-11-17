import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);
const PAGES = ['', 'product/', 'alpha/', 'faq/', 'privacy/', 'terms/', 'accessibility/'];
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

test('root is a static language pair', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'עברית' })).toHaveAttribute('href', '/he/');
  await expect(page.getByRole('link', { name: 'English' })).toHaveAttribute('href', '/en/');
  expect(await axe(page)).toEqual([]);
});

for (const { lang, dir } of LANGS) {
  for (const p of PAGES) {
    test(`${lang}/${p || 'home'}: axe, lang/dir, one h1, landmarks`, async ({ page }) => {
      await page.goto(`/${lang}/${p}`);
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      await expect(page.locator('h1')).toHaveCount(1);
      for (const l of ['banner', 'navigation', 'main', 'contentinfo'])
        await expect(page.getByRole(l as 'main').first()).toBeVisible();
      expect(await axe(page)).toEqual([]);
    });
  }

  test(`${lang}: skip link is first tab stop and focus is visible`, async ({ page }) => {
    await page.goto(`/${lang}/`);
    await page.keyboard.press('Tab');
    const skip = page.locator('a.skip');
    await expect(skip).toBeFocused();
    const box = await skip.boundingBox();
    expect(box && box.y >= 0).toBe(true);
    const ring = await skip.evaluate((e) => getComputedStyle(e).outlineWidth);
    expect(parseFloat(ring)).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
    // Every interactive element shows a >= 2px outline when focused, and is >= 24px.
    for (const a of await page.locator('a').all()) {
      await a.focus();
      const s = await a.evaluate((e) => {
        const c = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        return { w: parseFloat(c.outlineWidth), style: c.outlineStyle, h: r.height };
      });
      expect(s.style).not.toBe('none');
      expect(s.w).toBeGreaterThanOrEqual(2);
      if (!(await a.evaluate((e) => e.classList.contains('skip'))))
        expect(s.h).toBeGreaterThanOrEqual(24);
    }
  });

  test(`${lang}: reflow at 320px without horizontal scroll`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    for (const p of PAGES) {
      await page.goto(`/${lang}/${p}`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, p).toBeLessThanOrEqual(0);
    }
  });

  test(`${lang}: language switch keeps the page and has hreflang`, async ({ page }) => {
    await page.goto(`/${lang}/alpha/`);
    const other = lang === 'he' ? 'en' : 'he';
    const sw = page.locator(`nav a[hreflang="${other}"]`);
    await expect(sw).toHaveAttribute('lang', other);
    await sw.click();
    await expect(page).toHaveURL(new RegExp(`/${other}/alpha/$`));
  });

  test(`${lang}: images have alt, apply link goes to the how-to-apply section`, async ({
    page,
  }) => {
    await page.goto(`/${lang}/`);
    for (const img of await page.locator('img').all()) {
      expect((await img.getAttribute('alt'))?.length ?? 0).toBeGreaterThan(0);
    }
    await page.locator('a.btn-pending').click();
    await expect(page).toHaveURL(new RegExp(`/${lang}/alpha/#how-to-apply$`));
    await expect(page.locator('#how-to-apply')).toBeVisible();
  });
}

test('keyboard tab order follows reading order (header, main, footer)', async ({ page }) => {
  await page.goto('/en/');
  const order: string[] = [];
  for (let i = 0; i < 11; i++) {
    await page.keyboard.press('Tab');
    order.push(
      await page.evaluate(
        () => document.activeElement?.closest('header,main,footer')?.tagName ?? 'BODY',
      ),
    );
  }
  const rank = (t: string) => ({ BODY: 0, HEADER: 1, MAIN: 2, FOOTER: 3 })[t] ?? 0;
  const ranks = order.map(rank);
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
});
