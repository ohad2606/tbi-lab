/**
 * K11 slice 2: the "tab is out of date" alert and the export reminder (status, dismissible).
 * Neither moves focus, both are reachable by keyboard, neither disappears on a timer.
 */
import { expect, test } from '@playwright/test';
import { createProject, place } from './helpers.js';

test('out-of-date tab: alert with a keyboard-reachable Reload, focus not stolen', async ({
  page,
}) => {
  await createProject(page);
  await page.getByTestId('project-name').focus();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('tbi:storage-versionchange')));
  const banner = page.getByTestId('tab-outdated');
  await expect(banner).toHaveAttribute('role', 'alert');
  await expect(banner).toBeVisible();
  await expect(page.getByTestId('project-name')).toBeFocused();
  const reload = page.getByTestId('tab-outdated-reload');
  await reload.focus();
  await expect(reload).toBeFocused();
  expect(await reload.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
  await expect(reload).toHaveAccessibleName(/reload/i);
});

test('export reminder: once, after an edit, when persistence is not granted; dismissible', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: async () => false, persist: async () => false },
      configurable: true,
    });
  });
  await createProject(page);
  await expect(page.getByTestId('export-reminder')).toHaveCount(0);
  await place(page, 'resistor', { x: 200, y: 200 });
  const note = page.getByTestId('export-reminder');
  await expect(note).toHaveAttribute('role', 'status');
  const dismiss = page.getByTestId('export-reminder-dismiss');
  await dismiss.focus();
  await page.keyboard.press('Enter');
  await expect(note).toHaveCount(0);
  await place(page, 'resistor', { x: 300, y: 200 });
  await expect(note).toHaveCount(0);
});
