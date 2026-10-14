/**
 * Alpha UX-P1: the toolbar with Build fits every supported desktop width (1024 px and up), in
 * English and Hebrew, in its widest state (a failed build: "Show problems"). Nothing overflows,
 * no two controls overlap, every control is on screen (Build is never moved into a menu).
 * Breakpoints: below 1536 px secondary labels are visually hidden; below 1200 px also the brand
 * word and a narrower project-name minimum (styles.css, "Alpha UX-P1").
 */
import { expect, test } from '@playwright/test';
import { goToProjects, waitSaved } from './helpers.js';
for (const width of [1024, 1100, 1199, 1200, 1280, 1366, 1440, 1535, 1536, 1600, 1920])
  for (const lang of ['en', 'he'])
    test(`toolbar fits at ${width} px (${lang})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      const library = page.getByTestId('example-list');
      await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
      if (!(await library.isVisible())) await goToProjects(page);
      await page.getByTestId('open-example-esp32-blink').click();
      await waitSaved(page);
      await page.getByTestId('language-select').selectOption(lang);
      await page.getByTestId('view-code').click();
      await page.getByTestId('code-text').fill('// no setup\nvoid loop() {}\n');
      await page.getByTestId('toolbar-build').click();
      await expect(page.getByTestId('toolbar-build-problems')).toBeVisible({ timeout: 15000 });
      await waitSaved(page);
      const r = await page.evaluate(() => {
        const bar = document.querySelector('.topbar') as HTMLElement;
        const vw = document.documentElement.clientWidth;
        const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        const sel = [
          '.project-name-box',
          '[data-testid="save-state"]',
          '[data-testid="undo"]',
          '[data-testid="redo"]',
          '[data-testid="toolbar-build"]',
          '[data-testid="toolbar-build-problems"]',
          '[data-testid="sim-run"]',
          '.sim-status',
          '[data-testid="language-select"]',
          '[data-testid="brand"]',
        ];
        const rs = sel.map((s) => ({ s, r: box(s) }));
        const overlaps: string[] = [];
        for (let i = 0; i < rs.length; i++)
          for (let j = i + 1; j < rs.length; j++) {
            const a = rs[i]!.r,
              b = rs[j]!.r;
            if (a.width && b.width && Math.max(a.left, b.left) < Math.min(a.right, b.right) - 0.5)
              overlaps.push(`${rs[i]!.s}~${rs[j]!.s}`);
          }
        const out = rs.filter(({ r }) => r.left < 0 || r.right > vw).map(({ s }) => s);
        return {
          overflow: bar.scrollWidth - bar.clientWidth,
          overlaps,
          out,
          nameW: Math.round(box('.project-name-box').width),
        };
      });
      expect(r, JSON.stringify(r)).toMatchObject({ overflow: 0, overlaps: [], out: [] });
    });
