/**
 * Sprint 13 H1: "What runs on the ESP32" — opened from the application menu and from a palette
 * refusal, generated from the registry (firmware facilities, parts, timing, limits), keyboard
 * closable, and fully localized (Hebrew: right-to-left).
 */
import { expect, test } from '@playwright/test';
import { goToProjects, openAppMenu } from './helpers.js';

async function openExample(page: import('@playwright/test').Page, id: string) {
  await page.goto('/');
  await expect(page.getByTestId('example-list').or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await page.getByTestId('example-list').isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
}

test('from the menu: firmware facilities, parts, timing and limits; Escape closes', async ({
  page,
}) => {
  await openExample(page, 'esp32-motion-relay');
  await openAppMenu(page);
  await page.getByTestId('menu-capabilities').click();
  const dialog = page.getByTestId('capabilities-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-section', 'firmware');
  await expect(dialog.getByTestId('capability-facility-digital_io')).toHaveAttribute(
    'data-status',
    'supported',
  );
  await expect(dialog.getByTestId('capability-facility-i2c')).toHaveAttribute(
    'data-status',
    'supported',
  );
  await expect(dialog.getByTestId('capability-facility-pwm')).toHaveAttribute(
    'data-status',
    'unsupported',
  );
  await expect(dialog.getByTestId('capability-facility-dual_core')).toHaveAttribute(
    'data-status',
    'limited',
  );
  await expect(dialog.getByTestId('capability-part-sensor.hc_sr04')).toHaveAttribute(
    'data-status',
    'supported',
  );
  await expect(dialog.locator('[data-testid^="capability-timing-"]')).toHaveCount(7);
  await expect(dialog.getByTestId('capability-timing-no_us_claim')).toBeVisible();
  await expect(dialog.getByTestId('capabilities-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('from a palette refusal: opens at the parts section, the refused part says why', async ({
  page,
}) => {
  await openExample(page, 'esp32-motion-relay');
  const note = page.getByTestId('palette-note-part_time_dependent');
  await expect(note).toBeVisible();
  await note.getByTestId('capabilities-link-parts').click();
  const dialog = page.getByTestId('capabilities-dialog');
  await expect(dialog).toHaveAttribute('data-section', 'parts');
  const cap = dialog.getByTestId('capability-part-component.capacitor');
  await expect(cap).toHaveAttribute('data-status', 'unsupported');
  await expect(cap).toBeInViewport();
  await dialog.getByTestId('capabilities-close').click();
  await expect(dialog).toBeHidden();
});

test('Hebrew: right-to-left, translated, same entries', async ({ page }) => {
  await openExample(page, 'esp32-motion-relay');
  await page.getByTestId('language-select').selectOption('he');
  await openAppMenu(page);
  await page.getByTestId('menu-capabilities').click();
  const dialog = page.getByTestId('capabilities-dialog');
  await expect(dialog).toHaveAttribute('dir', 'rtl');
  await expect(dialog.locator('#capabilities-title')).toHaveText('מה רץ על ה־ESP32 ב־TBI Lab');
  await expect(dialog.getByTestId('capability-facility-pwm')).toContainText('לא נתמך');
  await expect(dialog.locator('[data-testid^="capability-facility-"]')).toHaveCount(18);
  await page.keyboard.press('Escape');
  await page.getByTestId('language-select').selectOption('en');
});
