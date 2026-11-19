/**
 * TBI-014: the first-run welcome. A brand-new device (no flag, no projects) sees a modal with three
 * steps; "Start with the example" opens the real LED example and puts Run under the keyboard;
 * Skip / Esc hide it for the session; "Don't show again" and starting the example are remembered.
 * Every other spec runs as a returning user (playwright.app.config.ts storageState).
 */
import { expect, test, type Page } from '@playwright/test';

// A new device: no stored flag.
test.use({ storageState: { cookies: [], origins: [] } });

const dialog = (p: Page) => p.getByTestId('first-run-dialog');

test('EN: dialog semantics, keyboard-only path to a running example, remembered', async ({
  page,
}) => {
  await page.goto('/');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute('aria-labelledby', 'first-run-title');
  expect(await dialog(page).evaluate((d: HTMLDialogElement) => d.matches(':modal'))).toBe(true);
  await expect(page.getByRole('dialog', { name: 'Welcome to TBI Lab' })).toBeVisible();
  for (const n of [1, 2, 3]) await expect(page.getByTestId(`first-run-step-${n}`)).toBeVisible();
  await expect(page.getByTestId('first-run-step-3')).toContainText('I(D1)');
  // Initial focus: the primary action. Tab stays inside the dialog.
  await expect(page.getByTestId('first-run-start')).toBeFocused();
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    // A modal dialog may hand focus to the browser UI (body), never to the inert page behind it.
    expect(
      await page.evaluate(
        () =>
          document.activeElement === document.body || !!document.activeElement?.closest('dialog'),
      ),
    ).toBe(true);
  }
  await page.getByTestId('first-run-start').focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.getByTestId('first-run-status')).toHaveText(/Example opened/);
  // Step 2 by keyboard: Run is focused.
  await expect(page.getByTestId('sim-run')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('sim-stop')).toBeVisible();
  // Remembered: not shown on the next load, even from the Projects screen.
  await page.reload();
  await expect(dialog(page)).toHaveCount(0);
});

test('Esc closes and returns focus; Skip is for the session only; reopen from the menu', async ({
  page,
}) => {
  await page.goto('/');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  // Not remembered: a reload shows it again.
  await page.reload();
  await expect(dialog(page)).toBeVisible();
  await page.getByTestId('first-run-skip').click();
  await expect(dialog(page)).toHaveCount(0);
  // Menu entry reopens it (the menu lives in the editor's top bar).
  await page.getByTestId('create-project').click();
  await page.getByTestId('app-menu-button').click();
  await page.getByTestId('menu-first-run').click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
});

test("Don't show again is remembered", async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('first-run-never').click();
  await expect(dialog(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('example-list')).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
});

test('HE: translated, right-to-left, technical token stays left-to-right', async ({ page }) => {
  await page.goto('/');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('language-select').selectOption('he');
  await page.reload();
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'ברוכים הבאים ל־TBI Lab' })).toBeVisible();
  expect(await dialog(page).evaluate((e) => getComputedStyle(e).direction)).toBe('rtl');
  await expect(page.getByTestId('first-run-start')).toHaveText('התחילו עם הדוגמה');
  await expect(page.getByTestId('first-run-step-3')).toContainText('⁦I(D1)⁩');
  await page.getByTestId('first-run-start').click();
  await expect(page.getByTestId('first-run-status')).toHaveText(/הדוגמה נפתחה/);
  await expect(page.getByTestId('sim-run')).toBeFocused();
  await page
    .getByTestId('language-select')
    .selectOption('en')
    .catch(() => undefined);
});

test('no axe helper in this repo: the target size of the actions is at least 24px', async ({
  page,
}) => {
  await page.goto('/');
  for (const id of ['first-run-skip', 'first-run-never', 'first-run-start']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    expect(box!.width).toBeGreaterThanOrEqual(24);
  }
});
