/**
 * Regression: the app must start where `crypto.randomUUID` does not exist. Browsers expose it
 * only in secure contexts, so plain HTTP on a LAN address or a dev hostname lacks it. Playwright
 * serves on 127.0.0.1 (a secure context), so the API is removed before the app loads.
 */
import { expect, test } from '@playwright/test';
import { createProject, waitForStoredProject } from './helpers.js';

test('starts, creates and stores a project without crypto.randomUUID', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    // @ts-expect-error: simulate a non-secure context
    delete Crypto.prototype.randomUUID;
  });
  await page.goto('/');
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  await createProject(page, 'Insecure origin');
  await expect(page.getByTestId('canvas')).toBeVisible();
  const doc = await waitForStoredProject(page, () => true, 'project stored', 'Insecure origin');
  expect(doc.projectId).toMatch(/^prj_[0-9a-f]{32}$/);
  expect(errors).toEqual([]);
});
