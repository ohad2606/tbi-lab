/**
 * TBI-019 G2: the component guide panel (EN and HE).
 * - opens from the Projects card by keyboard; a non-modal complementary region named by its title;
 *   the title (h2) takes focus; sections are h3; values are LTR isolates (`bdi dir="ltr"`);
 * - "Open the example" loads led-current into the Lab and the panel stays open (announced politely);
 * - Escape (focus in the panel) and the close button close; focus returns to the opener;
 * - no focus trap: Tab leaves the panel; the Inspector link opens the same guide for the LED;
 * - nothing is stored; 320 px reflow; no overlap with the top bar at 1024 px; structural checks
 *   (no axe-core in the repo: an ad hoc axe run is reported separately).
 */
import { expect, test, type Page } from '@playwright/test';
import { component, goToProjects, waitSaved } from './helpers.js';

const T = {
  en: {
    title: 'LED and resistor',
    card: 'Component guides',
    open: 'Open the example',
    close: 'Close guide',
  },
  he: {
    title: 'נורית LED ונגד',
    card: 'מדריכי רכיבים',
    open: 'פתיחת הדוגמה',
    close: 'סגירת המדריך',
  },
} as const;

async function toHome(page: Page, lang: 'en' | 'he') {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(lang);
}

for (const lang of ['en', 'he'] as const) {
  test.describe(lang, () => {
    test('keyboard open from Home: region, heading focus, values isolated, Esc returns focus', async ({
      page,
    }) => {
      await toHome(page, lang);
      const card = page.getByTestId('home-guides');
      await expect(card.getByRole('heading', { level: 2, name: T[lang].card })).toBeVisible();
      const opener = page.getByTestId('open-guide-led-resistor');
      await opener.focus();
      await page.keyboard.press('Enter');

      const panel = page.getByRole('complementary', { name: T[lang].title });
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
      await expect(panel.getByRole('heading', { level: 2 })).toBeFocused();
      await expect(panel.getByRole('heading', { level: 2 })).toHaveCount(1);
      await expect(panel.getByRole('heading', { level: 3 })).toHaveCount(5);
      await expect(panel.getByRole('list')).toHaveCount(2); // behaviour items, the try-it step
      // Values: computed, each an LTR isolate; none left as a placeholder or a dash.
      const values = panel.locator('bdi[dir="ltr"]');
      expect(await values.count()).toBeGreaterThan(8);
      const text = (await panel.innerText()).replace(/\s+/g, ' ');
      expect(text).not.toMatch(/\{\w+\}/);
      await expect(page.getByTestId('guide-values-missing')).toHaveCount(0);
      await expect(panel.locator('bdi', { hasText: /mA/ }).first()).toBeVisible();
      // Not modal: no dialog, the page behind is not inert.
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(opener).toBeFocused();
    });

    test('no focus trap; close button works and returns focus', async ({ page }) => {
      await toHome(page, lang);
      const opener = page.getByTestId('open-guide-led-resistor');
      await opener.click();
      const panel = page.getByTestId('guide-panel');
      await expect(panel).toBeVisible();
      let left = false;
      for (let i = 0; i < 8 && !left; i++) {
        await page.keyboard.press('Tab');
        left = await page.evaluate(() => !document.activeElement?.closest('.guide-panel'));
      }
      expect(left).toBe(true);
      await page.getByRole('button', { name: T[lang].close }).click();
      await expect(panel).toHaveCount(0);
      await expect(opener).toBeFocused();
    });

    test('Open the example loads led-current; panel stays; status announced; Inspector link; nothing stored', async ({
      page,
    }) => {
      await toHome(page, lang);
      await page.getByTestId('open-guide-led-resistor').click();
      const panel = page.getByTestId('guide-panel');
      const open = panel.getByRole('button', { name: T[lang].open });
      await open.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('canvas')).toBeVisible();
      await waitSaved(page);
      await expect(panel).toBeVisible();
      await expect(page.getByTestId('guide-status')).toHaveText(/\S/);
      await expect(page.getByTestId('guide-status')).toHaveAttribute('aria-live', 'polite');

      // The guide stores nothing of its own.
      const keys = await page.evaluate(() => [
        ...Object.keys(localStorage),
        ...Object.keys(sessionStorage),
      ]);
      expect(keys.filter((k) => /guide/i.test(k))).toEqual([]);

      // Inspector link for the LED opens the same guide (focus returns to the link on close).
      await panel.getByTestId('guide-close').click();
      await expect(panel).toHaveCount(0);
      await component(page, 'D1').click();
      const link = page.getByTestId('inspector-guide-led-resistor');
      await expect(link).toBeVisible();
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('complementary', { name: T[lang].title })).toBeVisible();
      await expect(page.getByTestId('guide-title')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(link).toBeFocused();
      // A resistor has no guide: no link.
      await component(page, 'R1').click();
      await expect(page.getByTestId('inspector-guide-led-resistor')).toHaveCount(0);
    });

    test('reflow at 320 px and no overlap of the top bar at 1024 px', async ({ page }) => {
      await toHome(page, lang);
      await page.getByTestId('open-guide-led-resistor').click();
      const panel = page.getByTestId('guide-panel');
      await expect(panel).toBeVisible();
      const box = async () =>
        panel.evaluate((p) => {
          const r = p.getBoundingClientRect();
          return { l: r.left, r: r.right, t: r.top, w: p.scrollWidth, c: p.clientWidth };
        });
      await page.setViewportSize({ width: 1024, height: 768 });
      const top = await page.evaluate(
        () => document.querySelector('.topbar')!.getBoundingClientRect().bottom,
      );
      const wide = await box();
      expect(wide.t).toBeGreaterThanOrEqual(top - 1);
      expect(wide.w).toBeLessThanOrEqual(wide.c + 1);
      await page.setViewportSize({ width: 320, height: 640 });
      const narrow = await box();
      expect(narrow.w).toBeLessThanOrEqual(narrow.c + 1);
      expect(narrow.l).toBeGreaterThanOrEqual(-1);
    });

    test('docked: the panel never covers the editor (1024 sheet, 1400 column)', async ({
      page,
    }) => {
      await toHome(page, lang);
      await page.getByTestId('open-guide-led-resistor').click();
      await page.getByTestId('guide-open-example').click();
      await expect(page.getByTestId('canvas')).toBeVisible();
      const panel = page.getByTestId('guide-panel');
      const rects = () =>
        page.evaluate(() => {
          const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
          const p = r('.guide-panel');
          const w = r('.workspace');
          const side = r('.side-column');
          return { p, w, side, rtl: document.documentElement.dir === 'rtl' };
        });
      await page.setViewportSize({ width: 1024, height: 768 });
      await expect(panel).toBeVisible();
      await expect
        .poll(async () => (await rects()).p.top - (await rects()).side.bottom)
        .toBeGreaterThanOrEqual(-1);
      await page.setViewportSize({ width: 1400, height: 860 });
      await expect
        .poll(async () => {
          const { p, side, rtl } = await rects();
          return rtl ? side.left - p.right : p.left - side.right;
        })
        .toBeGreaterThanOrEqual(-1);
    });

    test('focus is never obscured by the panel while tabbing the editor (1024, 1280)', async ({
      page,
    }) => {
      for (const width of [1024, 1280]) {
        // Size first, then open: the editor fits the viewport it is laid out in.
        await page.setViewportSize({ width, height: 800 });
        await toHome(page, lang);
        await page.getByTestId('open-guide-led-resistor').click();
        await page.getByTestId('guide-open-example').click();
        await expect(page.getByTestId('canvas')).toBeVisible();
        await component(page, 'D1').click();
        await expect(page.getByTestId('guide-panel')).toBeVisible();
        await page.getByTestId('canvas').focus();
        let outside = 0;
        for (let i = 0; i < 60; i++) {
          await page.keyboard.press('Tab');
          const r = await page.evaluate(() => {
            const a = document.activeElement as HTMLElement | null;
            const p = document.querySelector('.guide-panel')?.getBoundingClientRect();
            if (!a || !p || a === document.body || a.closest('.guide-panel')) return null;
            const b = a.getBoundingClientRect();
            if (!b.width || !b.height) return null;
            const overlap =
              Math.min(b.right, p.right) - Math.max(b.left, p.left) > 1 &&
              Math.min(b.bottom, p.bottom) - Math.max(b.top, p.top) > 1;
            return {
              overlap,
              id: `${a.getAttribute('data-testid') ?? a.tagName} ${a.getAttribute('class')} b=${[b.left, b.top, b.right, b.bottom].map(Math.round)} p=${[p.left, p.top, p.right, p.bottom].map(Math.round)}`,
            };
          });
          if (r) {
            outside++;
            expect(r.overlap, `${r.id} under the panel at ${width}px`).toBe(false);
          }
        }
        expect(outside).toBeGreaterThan(3);
      }
    });

    test('values-unavailable note is a polite status when the example fails to load', async ({
      page,
    }) => {
      await page.route(/examples\/documents[^/]*\.(js|ts)|\/documents-[^/]*\.js/, (r) => r.abort());
      await toHome(page, lang);
      await page.getByTestId('open-guide-led-resistor').click();
      const notes = page.getByTestId('guide-notes');
      await expect(notes).toHaveAttribute('role', 'status');
      await expect(page.getByTestId('guide-values-missing')).toBeVisible();
      await expect(notes.getByTestId('guide-values-missing')).toHaveText(/\S/);
    });
  });
}
