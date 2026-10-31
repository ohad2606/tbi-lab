/**
 * OS-12: example search and category filters on the Projects screen (EN/HE, keyboard, RTL, no
 * overflow), and opening an example after filtering. The matching rules are unit-tested in
 * app/tests/examples-discover.test.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects } from './helpers.js';

async function home(page: Page) {
  await page.goto('/');
  const search = page.getByTestId('example-search');
  await expect(search.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await search.isVisible())) await goToProjects(page);
  await expect(search).toBeVisible();
}
const cards = (page: Page) => page.getByTestId('example-list').locator('li.example');
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('OS-12: search, categories, keyboard, empty state, clear, and opening a filtered example (EN)', async ({
  page,
}) => {
  await home(page);
  const total = await cards(page).count();
  await expect(page.getByTestId('example-count')).toHaveText(
    `Showing ${total} of ${total} examples`,
  );

  const search = page.getByTestId('example-search');
  await expect(search).toHaveAccessibleName('Search examples');
  await search.fill('ESP32 LCD');
  // Sprint 24: the Arduino LCD example and its MicroPython twin; Sprint 26: both with a managed library.
  await expect(cards(page)).toHaveCount(4);
  await expect(page.getByTestId('example-esp32-lcd-hello')).toBeVisible();
  await expect(page.getByTestId('example-mpy-lcd-hello')).toBeVisible();
  await expect(page.getByTestId('example-esp32-lcd-library')).toBeVisible();
  await expect(page.getByTestId('example-mpy-lcd-library')).toBeVisible();
  await expect(page.getByTestId('example-count')).toHaveText(`Showing 4 of ${total} examples`);

  await search.fill('LDR');
  await expect(page.getByTestId('example-light-sensor')).toBeVisible();
  await expect(page.getByTestId('example-ohms-law')).toHaveCount(0);

  // Categories by keyboard: Tab from the search to the first chip, Space toggles it.
  await search.fill('');
  await search.press('Tab');
  const basic = page.getByTestId('example-category-basic');
  await expect(basic).toBeFocused();
  await page.keyboard.press('Space');
  await expect(basic).toHaveAttribute('aria-pressed', 'true');
  const basicCount = await cards(page).count();
  expect(basicCount).toBeLessThan(total);
  await expect(page.getByTestId('example-esp32-blink')).toHaveCount(0);
  // A second category widens (OR), it never hides one already shown.
  await page.getByTestId('example-category-controllers').click();
  expect(await cards(page).count()).toBeGreaterThan(basicCount);
  await expect(page.getByTestId('example-esp32-blink')).toBeVisible();

  // Words AND categories: nothing basic is an ESP32 circuit -> the empty state.
  await page.getByTestId('example-category-controllers').click();
  await search.fill('ESP32');
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByTestId('example-empty')).toBeVisible();

  // One click clears everything and returns to the search field.
  await page.getByTestId('example-clear').click();
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(basic).toHaveAttribute('aria-pressed', 'false');
  await expect(cards(page)).toHaveCount(total);
  await expect(page.getByTestId('example-clear')).toHaveCount(0);

  // Escape in the field clears the words.
  await search.fill('relay');
  await search.press('Escape');
  await expect(search).toHaveValue('');

  // Opening an example after filtering works as before.
  await search.fill('HC-SR04');
  await page.getByTestId('open-example-esp32-distance-alarm').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
});

test('OS-12: Hebrew UI (RTL): Hebrew and English queries, translated filters, no horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await home(page);
  await page.getByTestId('language-select').selectOption('he');
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  const search = page.getByTestId('example-search');
  await expect(search).toHaveAccessibleName('חיפוש דוגמאות');
  await expect(page.getByTestId('example-category-sensors')).toHaveText(/חיישנים/);
  const total = await cards(page).count();

  await search.fill('ESP32 LCD'); // English words in the Hebrew UI (Sprint 24 and Sprint 26 library twins)
  await expect(cards(page)).toHaveCount(4);
  await search.fill('ממסר'); // Hebrew
  await expect(page.getByTestId('example-relay-load')).toBeVisible();
  await expect(page.getByTestId('example-count')).toContainText(`מתוך ${total}`);
  await search.fill('');
  await page.getByTestId('example-category-sensors').click();
  await page.getByTestId('example-category-lighting').click();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1400, height: 900 });
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});
