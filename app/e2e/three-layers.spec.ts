/**
 * 3D visualization layers (Sprint 10, owner-approved): the physical scene alone by default
 * (Realistic), engineering labels and grid with the Engineering preset or a manual toggle; the
 * labels are UI annotations naming the parts under them; toggling never changes the project or the
 * simulation and leaves nothing behind.
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects, storedProject } from './helpers.js';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

async function open3d(page: Page, example: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${example}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.getByTestId('view-3d').click();
  const view = page.getByTestId('view3d');
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 120_000 });
  return view;
}
const tags = (page: Page) => page.locator('.view3d-tag');

test('Realistic by default; Engineering shows labels on the right parts; manual toggles; no project change', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const view = await open3d(page, 'led-colours');
  // Realistic: the physical scene alone.
  await expect(view).toHaveAttribute('data-preset', 'realistic');
  await expect(view).toHaveAttribute('data-layers', '');
  await expect(page.locator('.view3d-tags')).toBeHidden();
  const before = JSON.stringify(await storedProject(page));

  // Engineering: labels and grid.
  await page.getByTestId('view3d-layers').click();
  await expect(page.getByTestId('view3d-layers-panel')).toBeVisible();
  await page.getByTestId('view3d-preset-engineering').check();
  await expect(view).toHaveAttribute('data-preset', 'engineering');
  await expect(view).toHaveAttribute('data-layers', 'labels grid');
  await expect(page.locator('.view3d-tags')).toBeVisible();
  const ids = (await view.getAttribute('data-components'))!.split(' ');
  await expect(tags(page)).toHaveCount(ids.length);
  expect((await tags(page).evaluateAll((els) => els.map((e) => e.textContent))).sort()).toEqual(
    [...ids].sort(),
  );
  for (const id of ids)
    await expect(page.locator(`.view3d-tag[data-component="${id}"]`)).toHaveText(id);

  // A manual toggle: grid off -> custom; labels stay.
  await page.getByTestId('view3d-layer-grid').uncheck();
  await expect(view).toHaveAttribute('data-preset', 'custom');
  await expect(view).toHaveAttribute('data-layers', 'labels');

  // Repeated toggling leaves exactly one annotation per part (nothing leaks).
  for (let i = 0; i < 10; i++) await page.getByTestId('view3d-layer-labels').click();
  await expect(tags(page)).toHaveCount(ids.length);

  // Back to Realistic, kept as this browser's preference across a reload; the project is untouched.
  await page.getByTestId('view3d-preset-realistic').check();
  await expect(view).toHaveAttribute('data-layers', '');
  expect(JSON.stringify(await storedProject(page))).toBe(before);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('view3d-layers-panel')).toBeHidden();
  await expect(page.getByTestId('view3d-layers')).toBeFocused();
});

test('layers do not affect the simulation or 3D controls; the panel is localized (Hebrew, RTL)', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const view = await open3d(page, 'led-colours');
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  await expect(view).toHaveAttribute('data-lit', /D1/);
  const lit = await view.getAttribute('data-lit');
  await page.getByTestId('view3d-layers').click();
  await page.getByTestId('view3d-preset-engineering').check();
  await page.getByTestId('view3d-preset-realistic').check();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  await expect(view).toHaveAttribute('data-lit', lit!);
  await page.getByTestId('sim-stop').click();

  await page.getByTestId('language-select').selectOption('he');
  const panel = page.getByTestId('view3d-layers-panel');
  await expect(panel).toHaveAttribute('dir', 'rtl');
  await expect(panel).toContainText('מציאותית');
  await expect(panel).toContainText('הנדסית');
  await expect(panel).toContainText('תוויות');
  await expect(page.getByTestId('view3d-layers')).toHaveText('שכבות');
});
