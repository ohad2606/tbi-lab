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
  await page.getByTestId('view3d-layer-labels').focus();
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
  await expect(panel).toContainText('תוויות');
  await expect(panel).toContainText('עומק שדה');
  await expect(page.getByTestId('view3d-layers')).toHaveText('שכבות');
  // The visual mode, named for assistive technology in the UI language.
  const mode = page.getByRole('radiogroup', { name: 'מצב תצוגה' });
  await expect(mode).toContainText('מציאותית');
  await expect(mode).toContainText('הנדסית');
  await expect(page.getByRole('radio', { name: 'מציאותית' })).toBeChecked();
});

/** The camera, as where three scene points appear on screen (any camera change moves them). */
async function cameraProbe(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="view3d-host"]') as unknown as {
      tbiViewer: { screenOf(p: [number, number, number]): { x: number; y: number } };
    };
    return (
      [
        [0, 0, 0],
        [20, 5, -10],
        [-15, 10, 25],
      ] as [number, number, number][]
    ).map((p) => {
      const s = host.tbiViewer.screenOf(p);
      return [Math.round(s.x * 100) / 100, Math.round(s.y * 100) / 100];
    });
  });
}

test('visual mode (realism pass 8): Realistic / Engineering by keyboard, per browser, camera and project untouched', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => localStorage.setItem('tbi-lab.3d.inspect', '1'));
  const view = await open3d(page, 'led-colours');
  const realistic = page.getByRole('radio', { name: 'Realistic' });
  const engineering = page.getByRole('radio', { name: 'Engineering' });
  await expect(page.getByRole('radiogroup', { name: 'Visual mode' })).toBeVisible();
  await expect(realistic).toBeChecked();
  // Software rendering here (the reduced tier): no depth of field, and the view says so.
  await expect(view).toHaveAttribute('data-quality', 'reduced');
  await expect(view).toHaveAttribute('data-dof', 'unavailable');
  await page.getByTestId('view3d-layers').click();
  await expect(page.getByTestId('view3d-layer-dof')).toBeDisabled();
  await expect(page.getByTestId('view3d-layer-dof')).not.toBeChecked();
  await expect(page.getByTestId('view3d-layers-panel')).toContainText('Needs a hardware GPU');
  await page.getByTestId('view3d-layers').click();

  await page.getByTestId('view3d-rotate-left').click();
  await page.getByTestId('view3d-host').focus();
  await page.keyboard.press('+');
  const camera = await cameraProbe(page);
  const target = await view.getAttribute('data-target');
  const project = JSON.stringify(await storedProject(page));

  // Keyboard: arrow keys move between the two modes.
  await realistic.focus();
  await page.keyboard.press('ArrowRight');
  await expect(engineering).toBeChecked();
  await expect(view).toHaveAttribute('data-preset', 'engineering');
  await expect(view).toHaveAttribute('data-layers', 'labels grid');
  expect(await cameraProbe(page)).toEqual(camera);
  await expect(view).toHaveAttribute('data-target', target!);

  // Remembered by this browser (never in the project): leaving the 3D view and coming back
  // starts a new viewer from the stored preference.
  await page.getByTestId('view-circuit').click();
  await expect(view).toBeHidden();
  await page.getByTestId('view-3d').click();
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 120_000 });
  await expect(page.getByRole('radio', { name: 'Engineering' })).toBeChecked();
  expect(
    JSON.parse((await page.evaluate(() => localStorage.getItem('tbi-lab.3d.layers')))!),
  ).toMatchObject({ dof: false, labels: true, grid: true });
  expect(JSON.stringify(await storedProject(page))).toBe(project);
  await page.getByRole('radio', { name: 'Realistic' }).check();
  await expect(view).toHaveAttribute('data-preset', 'realistic');
});

test('full tier: depth of field on in Realistic, off in Engineering; no material per part', async ({
  page,
}) => {
  test.setTimeout(300_000);
  // The full renderer on this software rasteriser (slow, but the same code a real GPU runs).
  await page.addInitScript(() => localStorage.setItem('tbi-lab.3d.quality', 'full'));
  const view = await open3d(page, 'esp32-bench');
  await expect(view).toHaveAttribute('data-quality', 'full');
  await expect(view).toHaveAttribute('data-dof', 'on', { timeout: 60_000 });
  const materials = Number(await view.getAttribute('data-materials'));
  const parts = (await view.getAttribute('data-components'))!.split(' ').length;
  // A fixed family set, never one material per part or per pin (the varied finish is a
  // per-vertex attribute in the existing batches: variation.ts).
  expect(materials).toBeLessThanOrEqual(85);
  expect(materials).toBeLessThan(parts * 5);
  // A frame without the scene's one-off shadow-map pass (drawn only when the scene is built).
  await page.getByTestId('view3d-rotate-left').click();
  const renders = Number(await view.getAttribute('data-renders'));
  await expect
    .poll(async () => Number(await view.getAttribute('data-renders')), { timeout: 60_000 })
    .toBeGreaterThan(renders);
  const calls = Number(await view.getAttribute('data-draw-calls'));
  await page.getByRole('radio', { name: 'Engineering' }).check();
  await expect(view).toHaveAttribute('data-dof', 'off', { timeout: 60_000 });
  await page.getByRole('radio', { name: 'Realistic' }).check();
  await expect(view).toHaveAttribute('data-dof', 'on', { timeout: 60_000 });
  await expect
    .poll(async () => Number(await view.getAttribute('data-draw-calls')), { timeout: 60_000 })
    .toBe(calls);
  await expect(view).toHaveAttribute('data-materials', String(materials));
});
