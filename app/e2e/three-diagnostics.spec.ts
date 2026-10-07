/**
 * 3D rendering diagnostics (Sprint 10 realism pass 4, development readout): hidden in normal use;
 * with #diag3d the 3D view shows which renderer it runs on (hardware GPU or software), the
 * quality tier, the pixel ratio and the scene's cost, so a real-GPU review can record them.
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects } from './helpers.js';

async function open3d(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  // A hash change alone does not reload the app.
  await page.reload();
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('open-example-esp32-bench').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.getByTestId('view-3d').click();
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready', {
    timeout: 120_000,
  });
}

test('the diagnostics readout is hidden by default and shown with #diag3d', async ({ page }) => {
  test.setTimeout(150_000);
  await open3d(page, '');
  await expect(page.getByTestId('view3d-diagnostics')).toHaveCount(0);
  await open3d(page, '#diag3d');
  const diag = page.getByTestId('view3d-diagnostics');
  await expect(diag).toBeVisible();
  // This test browser renders in software: the readout says so, and the tier follows.
  await expect(diag).toContainText(/software/i);
  await expect(diag).toContainText('reduced');
  await expect(diag).toContainText(/Draw calls\s*\d+/);
});
