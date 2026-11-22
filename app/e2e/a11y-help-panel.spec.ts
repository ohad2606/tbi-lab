/**
 * TBI-020 slice 4: the Help panel (the user guide), English and Hebrew.
 * - opened from the application menu; a labelled modal dialog; the title takes focus;
 * - the guide's sections are real headings (in order) and the contents links jump to them;
 * - Tab stays inside, Escape closes and focus returns to the menu button;
 * - the shortcuts dialog opens from the panel and Escape returns to the panel's button;
 * - code spans (key and pin names) are LTR inside the RTL page; no HTML from the text is live;
 * - the panel reflows at 320px without sideways scrolling.
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects, waitSaved } from './helpers.js';

const TITLE = { en: 'User guide', he: 'מדריך למשתמש' } as const;
const SHORTCUTS = { en: 'Keyboard shortcuts', he: 'קיצורי מקלדת' } as const;

async function openEditor(page: Page, lang: 'en' | 'he') {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(lang);
  await page.getByTestId('open-example-esp32-motion-relay').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}

async function openFromMenu(page: Page) {
  const button = page.getByTestId('app-menu-button');
  await button.focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('menu-guide').click();
  return button;
}

for (const lang of ['en', 'he'] as const) {
  test.describe(lang, () => {
    test('menu item opens a labelled modal; headings; Tab trapped; Escape returns focus', async ({
      page,
    }) => {
      await openEditor(page, lang);
      const button = await openFromMenu(page);
      const dialog = page.getByRole('dialog', { name: TITLE[lang] });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(dialog).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
      expect(await dialog.evaluate((d) => d.matches(':modal'))).toBe(true);
      await expect(dialog).toHaveAccessibleDescription(/\S/);
      await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused();

      // One h2 (the title), the guide's sections as h3 and every section is in the contents.
      await expect(dialog.getByRole('heading', { level: 2 })).toHaveCount(1);
      const sections = await dialog.getByRole('heading', { level: 3 }).count();
      expect(sections).toBeGreaterThanOrEqual(8);
      expect(await dialog.getByTestId('guide-toc').getByRole('link').count()).toBe(sections);
      expect(await dialog.getByRole('heading', { level: 4 }).count()).toBeGreaterThan(0);

      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
      }
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(button).toBeFocused();
    });

    test('contents link jumps to its heading and focuses it', async ({ page }) => {
      await openEditor(page, lang);
      await openFromMenu(page);
      const dialog = page.getByTestId('guide-dialog');
      const links = dialog.getByTestId('guide-toc').getByRole('link');
      const last = links.last();
      const name = (await last.textContent())!.trim();
      await last.focus();
      await page.keyboard.press('Enter');
      const target = dialog.getByRole('heading', { level: 3, name });
      await expect(target).toBeFocused();
      await expect(target).toBeInViewport();
      // The page URL did not change (no stray hash navigation).
      expect(page.url()).not.toContain('#guide-h');
    });

    test('shortcuts dialog opens from the panel; Escape returns to the panel button', async ({
      page,
    }) => {
      await openEditor(page, lang);
      await openFromMenu(page);
      const open = page.getByTestId('guide-shortcuts');
      await expect(open).toHaveAccessibleName(SHORTCUTS[lang]);
      await open.click();
      await expect(page.getByTestId('shortcuts-dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('shortcuts-dialog')).toBeHidden();
      await expect(page.getByTestId('guide-dialog')).toBeVisible();
      await expect(open).toBeFocused();
      await page.getByTestId('guide-close').click();
      await expect(page.getByTestId('guide-dialog')).toBeHidden();
      await expect(page.getByTestId('app-menu-button')).toBeFocused();
    });

    test('code spans are LTR, the text is never live HTML, the body scrolls by keyboard', async ({
      page,
    }) => {
      await openEditor(page, lang);
      await openFromMenu(page);
      const body = page.getByTestId('guide-body');
      await expect(body.locator('code[dir="ltr"]').first()).toBeVisible();
      expect(await body.locator('script, img, iframe, a').count()).toBe(0);
      await expect(body).toHaveAttribute('tabindex', '0');
      await expect(body).toHaveAccessibleName(/\S/);
    });

    test('reflows at 320px without sideways scrolling', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 700 });
      await openEditor(page, lang);
      await page.getByTestId('app-menu-button').click({ force: true });
      await page.getByTestId('menu-guide').click({ force: true });
      const dialog = page.getByTestId('guide-dialog');
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1)).toBe(true);
      const body = page.getByTestId('guide-body');
      expect(await body.evaluate((d) => d.scrollWidth <= d.clientWidth + 1)).toBe(true);
      await expect(page.getByTestId('guide-close')).toBeInViewport();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });

    test('after a contents jump Tab and Shift+Tab follow DOM order', async ({ page }) => {
      await openEditor(page, lang);
      await openFromMenu(page);
      const dialog = page.getByTestId('guide-dialog');
      const last = dialog.getByTestId('guide-toc').getByRole('link').last();
      await last.focus();
      await page.keyboard.press('Enter');
      const target = dialog.getByRole('heading', { level: 3 }).last();
      await expect(dialog.locator('h3:focus, h4:focus')).toHaveCount(1);
      // The next control after the body text is the body region itself (earlier in DOM), so go
      // through the real order: Tab reaches Close within a few steps and never leaves the dialog.
      const seen: string[] = [];
      for (let i = 0; i < 4 && seen.at(-1) !== 'guide-close'; i++) {
        await page.keyboard.press('Tab');
        seen.push(
          await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? ''),
        );
      }
      expect(seen).toContain('guide-close');
      await expect(page.getByTestId('guide-close')).toBeInViewport();
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
      ).not.toBe('guide-close');
      void target;
    });

    test('320x256 (400% zoom): text and Close stay reachable, no sideways scroll', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 256 });
      await openEditor(page, lang);
      await page.getByTestId('app-menu-button').click({ force: true });
      await page.getByTestId('menu-guide').dispatchEvent('click');
      const dialog = page.getByTestId('guide-dialog');
      await expect(dialog).toBeVisible();
      const body = page.getByTestId('guide-body');
      expect((await body.boundingBox())!.height).toBeGreaterThan(50);
      expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1)).toBe(true);
      const close = page.getByTestId('guide-close');
      await close.focus();
      await expect(close).toBeFocused();
      await expect(close).toBeInViewport();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeHidden();
    });
  });
}
