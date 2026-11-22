/**
 * TBI-021 slice 2: the language picker.
 * - reachable and operable by keyboard; has an accessible name (EN and HE);
 * - each option carries lang and dir from the registry; the document lang/dir follow the switch;
 * - no unnamed/duplicate-id structure problems around it (structural checks; no axe-core in the repo).
 */
import { expect, test } from '@playwright/test';
import { goToProjects } from './helpers.js';

test('picker: name, option lang/dir, keyboard switch updates html lang/dir', async ({ page }) => {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  const select = page.getByTestId('language-select');
  await expect(select).toHaveAccessibleName('Language'); // app default locale is en
  const opts = await select
    .locator('option')
    .evaluateAll((os) =>
      os.map((o) => [o.getAttribute('value'), o.getAttribute('lang'), o.getAttribute('dir')]),
    );
  expect(opts).toEqual([
    ['en', 'en', 'ltr'],
    ['he', 'he', 'rtl'],
  ]);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await select.focus();
  await expect(select).toBeFocused();
  await page.keyboard.press('ArrowDown'); // en -> he
  await expect(select).toHaveValue('he');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(select).toHaveAccessibleName('שפה');
  await expect(select).toBeFocused();

  await page.keyboard.press('ArrowUp'); // he -> en
  await expect(select).toHaveValue('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(select).toBeFocused();
});

test('picker: structural a11y (no empty option names, unique ids, visible focus)', async ({
  page,
}) => {
  await page.goto('/');
  const select = page.getByTestId('language-select');
  await expect(select).toBeVisible();
  const empty = await select
    .locator('option')
    .evaluateAll((os) => os.filter((o) => !o.textContent?.trim()).length);
  expect(empty).toBe(0);
  const dupIds = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    return ids.length - new Set(ids).size;
  });
  expect(dupIds).toBe(0);
  await select.focus();
  const outline = await select.evaluate((e) => getComputedStyle(e).outlineStyle);
  expect(outline).not.toBe('none');
  const box = await select.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(24);
});
