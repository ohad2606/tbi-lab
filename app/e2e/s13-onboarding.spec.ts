/**
 * Sprint 13 H4: the first-run guide on the Projects screen — three steps, the shared-simulator and
 * browser-storage note, a way into the capability panel; dismissed per device (survives a reload),
 * shown again on request; localized (Hebrew right-to-left).
 */
import { expect, test } from '@playwright/test';

test('first visit: the guide, its three steps and note; dismissal is remembered; it can come back', async ({
  page,
}) => {
  await page.goto('/');
  const guide = page.getByTestId('getting-started');
  await expect(guide).toBeVisible();
  for (const n of [1, 2, 3]) await expect(page.getByTestId(`onboarding-step-${n}`)).toBeVisible();
  await expect(page.getByTestId('onboarding-note')).toContainText('Export');
  await page.getByTestId('onboarding-capabilities').click();
  await expect(page.getByTestId('capabilities-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('onboarding-dismiss').click();
  await expect(guide).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('example-list')).toBeVisible();
  await expect(guide).toHaveCount(0);
  await page.getByTestId('onboarding-show').click();
  await expect(guide).toBeVisible();
});

test('Hebrew: the guide is translated and right-to-left', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('language-select').selectOption('he');
  const guide = page.getByTestId('getting-started');
  await expect(guide.locator('h2')).toHaveText('צעדים ראשונים');
  expect(await guide.evaluate((e) => getComputedStyle(e).direction)).toBe('rtl');
  await page.getByTestId('language-select').selectOption('en');
});
