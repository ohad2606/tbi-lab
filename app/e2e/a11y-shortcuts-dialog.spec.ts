/**
 * TBI-020 slice 2: the keyboard shortcuts dialog, English and Hebrew.
 * - the top-bar button and the typed "?" (Shift+/) open it; it is a labelled modal dialog;
 * - focus moves inside, Tab stays inside, Escape closes, focus returns to the opener;
 * - "?" is ignored while typing in a field or the code editor and while another dialog is open;
 * - one real table per area with column headers; key names are LTR inside the RTL page;
 * - the button is a >= 24px target; the dialog reflows at 320px without sideways scrolling.
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects, waitSaved } from './helpers.js';

const TITLE = { en: 'Keyboard shortcuts', he: 'קיצורי מקלדת' } as const;

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

for (const lang of ['en', 'he'] as const) {
  test.describe(lang, () => {
    test('button opens a labelled modal dialog; Tab stays inside; Escape returns focus', async ({
      page,
    }) => {
      await openEditor(page, lang);
      const button = page.getByTestId('shortcuts-open');
      await expect(button).toHaveAccessibleName(TITLE[lang]);
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);

      await button.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: TITLE[lang] });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(await dialog.evaluate((d) => d.matches(':modal'))).toBe(true);
      await expect(dialog).toHaveAccessibleDescription(/\S/);
      await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused();

      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
      }
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(button).toBeFocused();
    });

    test('"?" opens it, the close button closes it, focus returns to where it was', async ({
      page,
    }) => {
      await openEditor(page, lang);
      const tab = page.getByTestId('view-code');
      await tab.focus();
      await page.keyboard.press('?');
      const dialog = page.getByTestId('shortcuts-dialog');
      await expect(dialog).toBeVisible();
      // A second "?" while it is open does nothing (one dialog).
      await page.keyboard.press('?');
      await expect(page.locator('dialog[open]')).toHaveCount(1);
      await dialog.getByTestId('shortcuts-close').click();
      await expect(dialog).toBeHidden();
      await expect(tab).toBeFocused();
    });

    test('"?" is a character in the project name and the code editor', async ({ page }) => {
      await openEditor(page, lang);
      const name = page.getByTestId('project-name');
      await name.focus();
      await page.keyboard.type('?');
      await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0);
      await expect(name).toBeFocused();
      await page.keyboard.press('Escape'); // revert the draft name
      await page.getByTestId('view-code').click();
      const code = page.getByTestId('code-text');
      await code.focus();
      await page.keyboard.type('?');
      await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0);
      await expect(code).toBeFocused();
    });

    test('real tables: headers, same rows, LTR key names', async ({ page }) => {
      await openEditor(page, lang);
      await page.getByTestId('shortcuts-open').click();
      const dialog = page.getByTestId('shortcuts-dialog');
      await expect(dialog).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
      const tables = dialog.getByRole('table');
      await expect(tables).toHaveCount(7);
      expect(await dialog.locator('tbody tr').count()).toBeGreaterThan(30);
      for (const table of await tables.all()) {
        await expect(table.locator('caption')).not.toBeEmpty();
        await expect(table.locator('thead th[scope="col"]')).toHaveCount(3);
      }
      expect(await dialog.locator('tbody tr').count()).toBe(
        await dialog.locator('tbody th[scope="row"]').count(),
      );
      // Every key name sits in a left-to-right isolate.
      expect(
        await dialog
          .locator('kbd')
          .evaluateAll((els) =>
            els.every((k) => getComputedStyle(k.closest('.shortcut-chord')!).direction === 'ltr'),
          ),
      ).toBe(true);
      await expect(dialog.getByTestId('shortcut-undo')).toContainText('Z');
    });

    test('key names are LTR English; Ctrl and Cmd are separate keys with the "or" outside', async ({
      page,
    }) => {
      await openEditor(page, lang);
      await page.getByTestId('shortcuts-open').click();
      const dialog = page.getByTestId('shortcuts-dialog');
      expect(await dialog.locator('kbd:not([lang="en"])').count()).toBe(0);
      expect(await dialog.locator('kbd', { hasText: /Ctrl or|או Cmd/ }).count()).toBe(0);
      const undo = dialog.getByTestId('shortcut-undo').locator('th');
      await expect(undo.locator('kbd')).toHaveText(['Ctrl', 'Z', 'Cmd', 'Z']);
      await expect(undo.locator('.shortcut-or')).toHaveText(lang === 'he' ? 'או' : 'or');
      expect(
        await undo.locator('.shortcut-or').evaluate((e) => !e.closest('.shortcut-chord')),
      ).toBe(true);
      // Key names inside the intro text are isolated too.
      const bdi = dialog.locator('#shortcuts-intro bdi');
      await expect(bdi.first()).toHaveText('Esc');
      await expect(bdi.first()).toHaveAttribute('dir', 'ltr');
    });

    test('narrow layout keeps the table semantics', async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 700 });
      await openEditor(page, lang);
      await page.getByTestId('shortcuts-open').click({ force: true });
      const dialog = page.getByTestId('shortcuts-dialog');
      const table = dialog.getByTestId('shortcuts-global');
      expect(await table.evaluate((t) => getComputedStyle(t).display)).toBe('block');
      await expect(table).toHaveAttribute('role', 'table');
      expect(
        await table
          .locator('tr')
          .evaluateAll((r) => r.every((e) => e.getAttribute('role') === 'row')),
      ).toBe(true);
      await expect(table.locator('thead th').first()).toHaveAttribute('role', 'columnheader');
      await expect(table.locator('tbody th').first()).toHaveAttribute('role', 'rowheader');
      await expect(table.locator('tbody td').first()).toHaveAttribute('role', 'cell');
      await expect(table.getByRole('rowheader').first()).toBeVisible();
      await expect(table.getByRole('cell').first()).toBeVisible();
    });

    test('forced colors: key names keep a ButtonText border', async ({ page }) => {
      await page.emulateMedia({ forcedColors: 'active' });
      await openEditor(page, lang);
      await page.getByTestId('shortcuts-open').click();
      const kbd = page.getByTestId('shortcuts-dialog').locator('kbd').first();
      const ok = await kbd.evaluate((k) => {
        const probe = document.createElement('span');
        probe.style.color = 'ButtonText';
        document.body.append(probe);
        const want = getComputedStyle(probe).color;
        probe.remove();
        const cs = getComputedStyle(k);
        return (
          cs.borderTopStyle === 'solid' && cs.borderTopWidth === '1px' && cs.borderTopColor === want
        );
      });
      expect(ok).toBe(true);
    });

    test('reflows at 320px without sideways scrolling', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 700 });
      await openEditor(page, lang);
      await page.getByTestId('shortcuts-open').click({ force: true });
      const dialog = page.getByTestId('shortcuts-dialog');
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1)).toBe(true);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
  });
}

test('"?" is ignored while another dialog is open', async ({ page }) => {
  await openEditor(page, 'en');
  await page.getByTestId('app-menu-button').click();
  await page.getByTestId('menu-capabilities').click();
  await expect(page.getByTestId('capabilities-dialog')).toBeVisible();
  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0);
});
