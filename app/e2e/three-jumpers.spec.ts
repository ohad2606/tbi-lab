/**
 * Jumper exit geometry in the running app (Sprint 10, owner review of "ESP32: blink an LED"):
 * the drawn wires leave their jumper housings through a neck (straight relief, one wide bend),
 * the same in Realistic and Engineering, the same on every build of the view; viewing them
 * close up changes nothing in the project (the stored project and the exported project are
 * byte-identical before and after, and after a reload).
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { exportFromMenu, goToProjects, reopenFromLibrary, storedProject } from './helpers.js';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.addInitScript(() => localStorage.setItem('tbi-lab.3d.inspect', '1'));
});

const shapes = (page: Page) =>
  page.evaluate(() => {
    const host = document.querySelector('[data-testid="view3d-host"]') as unknown as {
      tbiViewer: { wireShapes(): ReadonlyMap<string, unknown> };
    };
    return JSON.stringify([...host.tbiViewer.wireShapes()]);
  });

/** The exported package's project, without the export's own timestamp. */
const exported = async (page: Page) => {
  const pkg = JSON.parse(readFileSync((await (await exportFromMenu(page)).path())!, 'utf8'));
  delete pkg.exported.exportedAt;
  return JSON.stringify(pkg);
};

test('ESP32 blink: jumpers leave through a neck, mode-independent, project unchanged', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('open-example-esp32-blink').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  const stored = JSON.stringify(await storedProject(page));
  const file = await exported(page);

  await page.getByTestId('view-3d').click();
  const view = page.getByTestId('view3d');
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 120_000 });
  await expect(view).toHaveAttribute('data-preset', 'realistic');
  const realistic = await shapes(page);
  const parsed = new Map(
    JSON.parse(realistic) as [
      string,
      { points: { x: number; y: number; z: number }[]; necks?: number[] },
    ][],
  );
  // Both jumpers (orange to the resistor, black to ground) leave their housings through a neck:
  // straight up 3 mm out of the housing's top, then the bend.
  for (const id of ['W1', 'W4']) {
    const s = parsed.get(id)!;
    expect(s.necks?.[0], id).toBeGreaterThanOrEqual(4);
    expect(s.points[1]!.y - s.points[0]!.y, id).toBeCloseTo(3, 6);
    expect(s.points[1]!.x, id).toBeCloseTo(s.points[0]!.x, 6);
    expect(s.points[1]!.z, id).toBeCloseTo(s.points[0]!.z, 6);
  }

  // Close up on the orange jumper's housing, then Engineering: the same cables, point for point.
  await page.evaluate(() => {
    const host = document.querySelector('[data-testid="view3d-host"]') as unknown as {
      tbiViewer: { inspect(t: number[], f: number[]): void };
    };
    host.tbiViewer.inspect([23.5, 26, 13.5], [6, 36, 36]);
  });
  await page.getByTestId('view3d-preset-engineering').check();
  await expect(view).toHaveAttribute('data-preset', 'engineering');
  expect(await shapes(page)).toBe(realistic);
  await page.getByTestId('view3d-preset-realistic').check();
  expect(await shapes(page)).toBe(realistic);

  // Nothing of it reached the project: stored and exported bytes unchanged, and after a reload.
  await page.getByTestId('view-circuit').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  expect(JSON.stringify(await storedProject(page))).toBe(stored);
  expect(await exported(page)).toBe(file);
  await page.reload();
  await reopenFromLibrary(page);
  expect(JSON.stringify(await storedProject(page))).toBe(stored);
  expect(await exported(page)).toBe(file);
  // Viewed again after the reload: the very same cables.
  await page.getByTestId('view-3d').click();
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 120_000 });
  expect(await shapes(page)).toBe(realistic);
});
