import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);
const PAGES = ['', 'product/', 'alpha/', 'faq/', 'privacy/', 'accessibility/'];
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
      // decorative images (empty alt) must sit inside a link that has its own text
      const alt = await img.getAttribute('alt');
      expect(alt).not.toBeNull();
      if (alt === '')
        expect(await img.evaluate((e) => !!e.closest('a')?.textContent?.trim())).toBe(true);
    }
    // default build links the owner-supplied https form; pending build links the how-to-apply section
    const primary = page.locator('a.btn-primary').first();
    if (await primary.count()) {
      // SITE_SIGNUP_ENABLED=1 (flip mode): the CTA is the own sign-up page, same tab
      if (process.env.SITE_SIGNUP_ENABLED === '1') {
        await expect(primary).toHaveAttribute('href', `/${lang}/signup/`);
        return;
      }
      await expect(primary).toHaveAttribute('href', /^https:\/\/forms\.gle\//);
      await expect(primary).toHaveAttribute('rel', 'noopener');
      return;
    }
    await page.locator('a.btn-pending').first().click();
    await expect(page).toHaveURL(new RegExp(`/${lang}/alpha/#how-to-apply$`));
    await expect(page.locator('#how-to-apply')).toBeVisible();
  });
}

test('keyboard tab order follows reading order (header, main, footer)', async ({ page }) => {
  await page.goto('/en/');
  const order: string[] = [];
  for (let i = 0; i < 14; i++) {
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

test('contrast: computed text colours meet 4.5:1 on key elements (en home)', async ({ page }) => {
  await page.goto('/en/');
  const ratio = await page.evaluate(() => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const L = ([r = 0, g = 0, b = 0]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const out: number[] = [];
    for (const sel of ['.hero h1', '.hero .value', '.card p', '.card h3']) {
      const e = document.querySelector(sel)!;
      const bg = e;
      let b = 'rgba(0, 0, 0, 0)';
      for (let n: Element | null = bg; n; n = n.parentElement) {
        b = getComputedStyle(n).backgroundColor;
        if (b !== 'rgba(0, 0, 0, 0)') break;
      }
      const [x = 0, y = 0] = [L(rgb(getComputedStyle(e).color)), L(rgb(b))].sort((p, q) => q - p);
      out.push((x + 0.05) / (y + 0.05));
    }
    return Math.min(...out);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test('1440px: content stays within the max width, no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en/');
  const w = await page.evaluate(() => ({
    over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    card: document.querySelector('.cards')!.getBoundingClientRect().width,
  }));
  expect(w.over).toBeLessThanOrEqual(0);
  expect(w.card).toBeLessThanOrEqual(72 * 16);
});

test('reduced motion: no transitions or animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/en/');
  const d = await page
    .locator('.btn')
    .first()
    .evaluate((e) => getComputedStyle(e).transitionDuration);
  expect(parseFloat(d)).toBe(0);
});

test('sign-in link goes to the Lab and contact is a mailto', async ({ page }) => {
  await page.goto('/en/alpha/');
  await expect(page.getByRole('link', { name: /Tester sign-in/ }).first()).toHaveAttribute(
    'href',
    'https://lab.tbi-tech.net/',
  );
  await expect(page.locator('footer a[href^="mailto:"]')).toHaveAttribute(
    'href',
    'mailto:support@tbi-tech.net',
  );
});

for (const { lang } of LANGS) {
  test(`${lang}/home: screenshots load, have alt and captions, no horizontal scroll at 320px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(`/${lang}/`);
    const imgs = page.locator('#screenshots ~ ul.shots img');
    expect(await imgs.count()).toBeGreaterThanOrEqual(2);
    for (const img of await imgs.all()) {
      await img.scrollIntoViewIfNeeded();
      await expect
        .poll(() => img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0))
        .toBe(true);
      expect(((await img.getAttribute('alt')) ?? '').length).toBeGreaterThan(20);
    }
    await expect(page.locator('figure figcaption')).toHaveCount(await imgs.count());
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
  });
}
