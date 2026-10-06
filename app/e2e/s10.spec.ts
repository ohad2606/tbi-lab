/**
 * Sprint 10 in the real app:
 * - the approved LED colour cards: chosen in the inspector (EN/HE names), solved by the engine
 *   (each its own current), glowing in their own colour on the canvas, and drawn in 3D with their
 *   datasheet package (5 mm tinted / 3 mm clear);
 * - the physically scaled 3D view: the LED colours example lights all three LEDs while running,
 *   viewing writes nothing, and repeated entering/leaving keeps resources flat.
 */
import { expect, test, type Page } from '@playwright/test';
import { component, goToProjects, storedProjects, waitSaved } from './helpers.js';

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
async function show3d(page: Page) {
  await tab(page, '3d').click();
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready');
}
const glowFill = (page: Page, id: string) =>
  component(page, id)
    .locator('.led-glow')
    .evaluate((e) => getComputedStyle(e).fill);

test('LED colours: three approved cards, three currents, each glowing in its own colour in 2D and 3D', async ({
  page,
}) => {
  await openExample(page, 'led-colours');
  await expect(page.getByTestId('example-led-colours')).toHaveCount(0); // the editor is open
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  // Canvas glow: the datasheet colour of each card (red, yellow, green).
  const fills = [
    await glowFill(page, 'D1'),
    await glowFill(page, 'D2'),
    await glowFill(page, 'D3'),
  ];
  expect(fills).toEqual(['rgb(229, 57, 53)', 'rgb(251, 192, 45)', 'rgb(67, 198, 74)']);
  // The engine gives the red LED more current than the higher-V_F yellow and green ones.
  const current = async (id: string) => {
    await component(page, id).locator('.component-hit').click();
    return (await page.getByTestId('result-current').textContent()) ?? '';
  };
  const mA = (t: string) => Number(/([\d.]+)\s*mA/.exec(t)?.[1]);
  const [r, y, g] = [mA(await current('D1')), mA(await current('D2')), mA(await current('D3'))];
  expect(r).toBeCloseTo(16.7, 1);
  expect(y).toBeCloseTo(14.5, 1);
  expect(g).toBeCloseTo(14.5, 1);
  // Schematic: each LED labelled with its part number (language-neutral, LTR).
  await tab(page, 'schematic').click();
  for (const [id, part] of [
    ['D1', 'TLHR5400'],
    ['D2', 'TLHY5400'],
    ['D3', 'TLHG4900'],
  ] as const)
    await expect(page.locator(`[data-part="${id}"] .sch-value`)).toHaveText(part);
  // 3D: each LED with its datasheet package, all three lit while running.
  await show3d(page);
  const view = page.getByTestId('view3d');
  await expect(view).toHaveAttribute('data-leds', 'D1:t1_34 D2:t1_34 D3:t1');
  await expect(view).toHaveAttribute('data-lit', 'D1 D2 D3');
  await page.getByTestId('sim-stop').click();
  await expect(view).toHaveAttribute('data-lit', '');
});

test('the inspector offers the approved LED cards by name (EN/HE); a choice changes only that part', async ({
  page,
}) => {
  await openExample(page, 'led-current');
  await waitSaved(page);
  await component(page, 'D1').locator('.component-hit').click();
  const select = page.getByTestId('param-D1-model');
  await expect(select.locator('option')).toHaveText([
    'Red 5 mm (Vishay TLHR5400)',
    'Yellow 5 mm (Vishay TLHY5400)',
    'Green 3 mm (Vishay TLHG4900)',
  ]);
  await select.selectOption('model.led.vishay_tlhg4900');
  await expect
    .poll(async () => {
      const docs = await storedProjects(page);
      docs.sort((a, b) => b.revision.updatedAt.localeCompare(a.revision.updatedAt));
      return docs[0]!.components.find((c) => c.id === 'D1')!.params.model;
    })
    .toBe('model.led.vishay_tlhg4900');
  await show3d(page);
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-leds', 'D1:t1');
  await tab(page, 'circuit').click();
  await page.getByTestId('language-select').selectOption('he');
  await component(page, 'D1').locator('.component-hit').click();
  await expect(page.getByTestId('param-D1-model').locator('option')).toHaveText([
    'אדומה 5 מ"מ (Vishay TLHR5400)',
    'צהובה 5 מ"מ (Vishay TLHY5400)',
    'ירוקה 3 מ"מ (Vishay TLHG4900)',
  ]);
  await page.getByTestId('language-select').selectOption('en');
});

test('physical 3D: viewing writes nothing; 20 enter/leave cycles of the ESP32 scene keep resources flat', async ({
  page,
}) => {
  // 20 openings on the software renderer at ~3 s each (Sprint 10 realism pass, SPRINT-10 Part H).
  test.setTimeout(150_000);
  await openExample(page, 'esp32-input-echo');
  await waitSaved(page);
  const revisions = async () =>
    (await storedProjects(page)).map((d) => `${d.projectId}@${d.revision.localRevision}`).join();
  const before = await revisions();
  const warnings: string[] = [];
  page.on('console', (m) => /WebGL|context/i.test(m.text()) && warnings.push(m.text()));
  let geometries: string | null = null;
  let textures: string | null = null;
  for (let i = 0; i < 20; i++) {
    await show3d(page);
    const view = page.getByTestId('view3d');
    await expect(view).toHaveAttribute('data-geometries', /\d+/);
    const g = await view.getAttribute('data-geometries');
    const t = await view.getAttribute('data-textures');
    geometries ??= g;
    textures ??= t;
    expect(g).toBe(geometries);
    expect(t).toBe(textures);
    expect(await page.locator('canvas.view3d-canvas').count()).toBe(1);
    await tab(page, i % 2 ? 'circuit' : 'schematic').click();
    expect(await page.locator('canvas.view3d-canvas').count()).toBe(0);
  }
  expect(warnings.filter((w) => /too many active webgl contexts/i.test(w))).toEqual([]);
  expect(await revisions()).toBe(before);
});
