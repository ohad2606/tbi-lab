/**
 * Sprint 9: three views of one circuit — Circuit (editing), Schematic (generated, topological)
 * and 3D (generated visualization). Both generated views follow the document live, hold no
 * project state, survive simulation, and degrade cleanly; the 3D renderer is lazy-loaded and
 * releases its WebGL context when left.
 */
import { expect, test, type Page } from '@playwright/test';
import { component, goToProjects, storedProjects } from './helpers.js';

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

const tab = (page: Page, v: string) => page.getByTestId(`view-${v}`);
const schematicParts = (page: Page) =>
  page
    .locator('.schematic')
    .getAttribute('data-parts')
    .then((s) => (s ?? '').split(' '));
const sceneParts = (page: Page) =>
  page
    .getByTestId('view3d')
    .getAttribute('data-components')
    .then((s) => (s ?? '').split(' '));
const revision = async (page: Page) =>
  (await storedProjects(page)).map((d) => d.revision.localRevision).join(',');

test('every project offers Circuit · Schematic · 3D; arrow keys move between the tabs', async ({
  page,
}) => {
  await openExample(page, 'voltage-divider');
  await expect(page.getByRole('tab')).toHaveText(['Circuit', 'Schematic', '3D']);
  await tab(page, 'circuit').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'schematic')).toBeFocused();
  await expect(tab(page, 'schematic')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('schematic-view')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, '3d')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight'); // wraps
  await expect(tab(page, 'circuit')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('canvas')).toBeVisible();
  // An ESP32 project adds Code.
  await openExample(page, 'esp32-blink');
  await expect(page.getByRole('tab')).toHaveText(['Circuit', 'Schematic', '3D', /Code/]);
});

test('the schematic follows circuit edits; selecting in it never changes the project', async ({
  page,
}) => {
  await openExample(page, 'voltage-divider');
  await tab(page, 'schematic').click();
  expect(await schematicParts(page)).toEqual(expect.arrayContaining(['PSU1', 'R1', 'R2']));
  const before = await revision(page);
  // Clicking a symbol selects that component (inspector), nothing is written.
  await page.locator('[data-part="R2"] .sch-hit').click();
  await expect(page.getByTestId('inspector-ref')).toHaveText('R2');
  await page.locator('[data-part="R2"]').press('Enter');
  expect(await revision(page)).toBe(before);
  // Back in the circuit editor, delete R2: the schematic no longer has it.
  await tab(page, 'circuit').click();
  await component(page, 'R2').locator('.component-hit').click();
  await page.keyboard.press('Delete');
  await tab(page, 'schematic').click();
  await expect.poll(() => schematicParts(page)).not.toContain('R2');
  // Add a resistor from the palette (keyboard): it appears, unconnected.
  await tab(page, 'circuit').click();
  await page.getByTestId('palette-component.resistor').press('Enter');
  await tab(page, 'schematic').click();
  await expect.poll(() => schematicParts(page)).toContain('R3');
});

test('3D: opens lazily, reflects the circuit, follows edits and project changes', async ({
  page,
}) => {
  const scripts: string[] = [];
  page.on('request', (r) => r.resourceType() === 'script' && scripts.push(r.url()));
  await openExample(page, 'esp32-input-echo');
  expect(scripts.some((u) => /renderer-/.test(u))).toBe(false); // not loaded before it is needed
  await tab(page, '3d').click();
  const view = page.getByTestId('view3d');
  await expect(view).toHaveAttribute('data-status', 'ready');
  expect(scripts.some((u) => /renderer-/.test(u))).toBe(true);
  expect((await sceneParts(page)).sort()).toEqual(
    ['D1', 'GND1', 'GND2', 'GND3', 'GND4', 'PSU1', 'R1', 'R2', 'R3', 'SW1', 'SW2', 'U1'].sort(),
  );
  await expect(view).toHaveAttribute('data-wires', '13');
  // Navigation controls never edit the project.
  const before = await revision(page);
  for (const id of ['view3d-rotate-left', 'view3d-rotate-right', 'view3d-fit', 'view3d-reset'])
    await page.getByTestId(id).click();
  const box = (await page.locator('.view3d-host').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  await page.mouse.wheel(0, -300);
  expect(await revision(page)).toBe(before);
  // Delete D1 in the circuit view: the scene follows.
  await tab(page, 'circuit').click();
  await component(page, 'D1').locator('.component-hit').click();
  await page.keyboard.press('Delete');
  await tab(page, '3d').click();
  await expect(view).toHaveAttribute('data-status', 'ready');
  await expect.poll(() => sceneParts(page)).not.toContain('D1');
  // Another project replaces the scene entirely.
  await openExample(page, 'ohms-law');
  await tab(page, '3d').click();
  await expect(view).toHaveAttribute('data-status', 'ready');
  expect((await sceneParts(page)).sort()).toEqual(['GND1', 'GND2', 'PSU1', 'R1']);
});

test('3D: entering and leaving repeatedly releases the renderer every time', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => /WebGL|context/i.test(m.text()) && warnings.push(m.text()));
  await openExample(page, 'esp32-input-echo');
  let geometries: string | null = null;
  for (let i = 0; i < 20; i++) {
    await tab(page, '3d').click();
    const view = page.getByTestId('view3d');
    await expect(view).toHaveAttribute('data-status', 'ready');
    await expect(view).toHaveAttribute('data-geometries', /\d+/);
    const g = await view.getAttribute('data-geometries');
    if (geometries === null) geometries = g;
    expect(g).toBe(geometries); // the same scene costs the same, every time
    expect(await page.locator('canvas.view3d-canvas').count()).toBe(1);
    await tab(page, i % 2 ? 'circuit' : 'schematic').click();
    expect(await page.locator('canvas.view3d-canvas').count()).toBe(0);
  }
  // More openings than the browser allows live WebGL contexts (16): none was leaked.
  expect(warnings.filter((w) => /too many active webgl contexts/i.test(w))).toEqual([]);
});

test('3D without WebGL: a localized explanation; Circuit and Schematic keep working', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...rest: unknown[]
    ) {
      if (/webgl/i.test(type)) return null;
      return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof original;
  });
  await openExample(page, 'voltage-divider');
  await tab(page, '3d').click();
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'unavailable');
  await expect(page.getByTestId('view3d-unavailable')).toContainText('WebGL');
  await tab(page, 'schematic').click();
  await expect(page.getByTestId('schematic-view')).toBeVisible();
  await tab(page, 'circuit').click();
  await expect(component(page, 'R1')).toBeVisible();
  // Hebrew explanation.
  await page.getByTestId('language-select').selectOption('he');
  await tab(page, '3d').click();
  await expect(page.getByTestId('view3d-unavailable')).toContainText('תלת־ממד');
});

test('switching views while simulating is safe and changes neither the run nor the project', async ({
  page,
}) => {
  await openExample(page, 'led-current');
  await tab(page, '3d').click();
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-lit', ''); // stopped: dark
  await page.getByTestId('sim-run').click();
  const status = page.getByTestId('sim-status');
  await expect(status).toHaveAttribute('data-status', 'running');
  // The 3D view shows the running LED lit (the solved current, as on the circuit canvas).
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-lit', 'D1');
  const before = await revision(page);
  for (const v of ['schematic', '3d', 'circuit', '3d', 'schematic', 'circuit']) {
    await tab(page, v).click();
    await expect(status).toHaveAttribute('data-status', 'running');
  }
  expect(await revision(page)).toBe(before);
});

test('Hebrew: tabs and notes are localized; technical labels stay LTR', async ({ page }) => {
  await openExample(page, 'esp32-input-echo');
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.getByRole('tab')).toHaveText(['מעגל', 'סכמה', 'תלת־ממד', /קוד/]);
  await tab(page, 'schematic').click();
  const view = page.getByTestId('schematic-view');
  await expect(view).toHaveAttribute('dir', 'ltr');
  await expect(view.locator('.sch-pin-name')).toContainText(['IO34']);
  await expect(view.locator('.view-note')).toHaveAttribute('dir', 'rtl');
  await tab(page, '3d').click();
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('view3d').locator('.view-note')).toContainText('העריכה');
  await expect(page.getByRole('button', { name: 'איפוס המצלמה' })).toBeVisible();
});
