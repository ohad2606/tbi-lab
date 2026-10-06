/**
 * High-fidelity 3D proof set (Sprint 10): the bundled glTF asset loads lazily (never at start-up,
 * once per page), the standard views frame the circuit from fixed directions (EN/HE), and viewing
 * still writes nothing.
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects, storedProject } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

async function openExample(page: Page, id: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
}

test('the ESP32 glTF asset is fetched only when 3D opens, once per page; standard views work (EN/HE)', async ({
  page,
}) => {
  const glb: string[] = [];
  page.on('request', (r) => r.url().endsWith('.glb') && glb.push(new URL(r.url()).pathname));
  await openExample(page, 'esp32-blink');
  await page.waitForTimeout(1500); // idle prefetch of example documents has run
  expect(glb).toEqual([]); // nothing 3D at start-up
  const before = JSON.stringify(await storedProject(page));
  const view = page.getByTestId('view3d');
  await page.getByTestId('view-3d').click();
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  expect(glb).toHaveLength(1);
  expect(glb[0]).toMatch(/^\/assets\/esp32-devkitc-v4-[\w-]+\.glb$/);
  await expect(view).toHaveAttribute('data-assets-ms', /^\d+$/);
  // Standard views: each re-frames (the camera target is the circuit's centre in every one).
  const target = await view.getAttribute('data-target');
  for (const v of ['top', 'front', 'side', 'rear'] as const) {
    await page.getByTestId(`view3d-view-${v}`).click();
    await expect(view).toHaveAttribute('data-target', target!);
  }
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.getByTestId('view3d-view-top')).toHaveText('מלמעלה');
  await expect(page.getByTestId('view3d-view-rear')).toHaveText('אחור');
  await page.getByTestId('language-select').selectOption('en');
  // Leave and re-enter: the parsed asset is reused, not fetched again.
  await page.getByTestId('view-circuit').click();
  await page.getByTestId('view-3d').click();
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  expect(glb).toHaveLength(1);
  expect(Number(await view.getAttribute('data-gpu-bytes'))).toBeGreaterThan(100_000);
  expect(JSON.stringify(await storedProject(page))).toBe(before); // viewing writes nothing
});
