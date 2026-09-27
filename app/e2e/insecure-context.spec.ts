/**
 * Regression: the app must start where `crypto.randomUUID` does not exist. Browsers expose it
 * only in secure contexts, so plain HTTP on a LAN address or a dev hostname lacks it. Playwright
 * serves on 127.0.0.1 (a secure context), so the API is removed before the app loads.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { projectHash, type ProjectDocument } from '@tbi-lab/domain';
import { createProject, exportFromMenu, goToProjects, waitForStoredProject } from './helpers.js';

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

test('export, hashing and import work without crypto.subtle or randomUUID (plain HTTP)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    // Both secure-context-only APIs are absent on plain HTTP from a non-localhost address.
    // @ts-expect-error: simulate a non-secure context
    delete Crypto.prototype.randomUUID;
    Object.defineProperty(Crypto.prototype, 'subtle', { get: () => undefined });
  });
  await page.goto('/');
  expect(await page.evaluate(() => typeof crypto.subtle)).toBe('undefined');
  await createProject(page, 'Plain HTTP');
  const download = await exportFromMenu(page);
  const text = readFileSync((await download.path())!, 'utf8');
  const pkg = JSON.parse(text) as { project: ProjectDocument; integrity: { project: string } };
  expect(pkg.integrity.project).toBe(projectHash(pkg.project)); // same SHA-256 as Node's
  await goToProjects(page);
  await page.getByTestId('import-file').setInputFiles({
    name: 'plain.tbilab',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  // Same id AND same name as the local project: a copy with a copy-style name (Product Alpha
  // maintenance: no two projects may read the same).
  await expect(page.getByTestId('notice')).toHaveAttribute('data-key', 'import.doneCopyRenamed');
  expect(errors).toEqual([]);
});
