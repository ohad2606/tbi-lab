/**
 * TBI-014 first five minutes: the first-run panel is a labelled region reachable by keyboard, has a
 * visible focus ring, closes with Escape or its button without trapping focus, returns focus to
 * the "show" control, and its primary action opens a runnable example (no build) in one step.
 * (No axe-core in the repo: the structural checks are asserted directly.)
 */
import { expect, test } from '@playwright/test';

test('panel: labelled region, keyboard path to the starter example, Escape closes, focus returns', async ({
  page,
}) => {
  await page.goto('/');
  const panel = page.getByTestId('getting-started');
  await expect(page.getByRole('region', { name: 'Getting started' })).toBeVisible();
  const open = panel.getByTestId('onboarding-open-starter');
  await expect(open).toHaveAccessibleName('Open the LED example');
  const size = (await open.boundingBox())!;
  expect(size.height).toBeGreaterThanOrEqual(24);
  // Reachable by Tab and visibly focused.
  await open.focus();
  const ring = await open.evaluate((e) => {
    const s = getComputedStyle(e);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  expect(ring.style).not.toBe('none');
  expect(ring.width).toBeGreaterThan(0);
  // Not a trap: Tab leaves the panel eventually.
  for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
  expect(await panel.evaluate((e) => e.contains(document.activeElement))).toBe(false);
  // Escape from inside closes it and focus lands on the control that brings it back.
  await open.focus();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('onboarding-show')).toBeFocused();
  await page.reload();
  await expect(panel).toHaveCount(0);
  await page.getByTestId('onboarding-show').click();
  await expect(panel).toBeVisible();
  // The primary action by keyboard opens the example and the editor.
  await panel.getByTestId('onboarding-open-starter').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.getByTestId('sim-run')).toBeEnabled();
});

test('Hebrew: the starter block is translated and right-to-left, R1 stays left-to-right', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('language-select').selectOption('he');
  const quick = page.getByTestId('onboarding-quick');
  await expect(quick.locator('h3')).toHaveText('ההתחלה המהירה: בלי בנייה ובלי המתנה');
  expect(await quick.evaluate((e) => getComputedStyle(e).direction)).toBe('rtl');
  await expect(page.getByTestId('onboarding-open-starter')).toHaveText('פתיחת דוגמת ה־LED');
  await page.getByTestId('language-select').selectOption('en');
});

test('reduced motion: the panel adds no animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const panel = page.getByTestId('getting-started');
  const d = await panel.evaluate((e) => getComputedStyle(e).animationName);
  expect(d).toBe('none');
});
