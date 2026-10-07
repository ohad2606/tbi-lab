/**
 * Visual-only body separation in the real app (Sprint 10 owner review): an LED matrix and a PIR
 * module placed acceptably in 2D overlap physically in 3D; the 3D view moves the PIR clear
 * (data-moved), while the stored project keeps its coordinates. A part laid on another beyond the
 * separation's cap gets a non-blocking notice (EN/HE), and the 3D view still works.
 */
import { expect, test, type Page } from '@playwright/test';
import { addComponent, createProject, type ProjectDocument } from '@tbi-lab/domain';
import { openImported, storedProject } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

function doc(pirX: number): ProjectDocument {
  let d = createProject({
    projectId: 'prj_sep00001',
    deviceId: 'device-e2e',
    name: 'Separation',
    appVersion: '0.1.0',
    clock: { now: () => new Date('2026-10-07T00:00:00.000Z') },
  });
  for (const [type, x] of [
    ['display.led_matrix_8x8', 300],
    ['sensor.pir_hc_sr501', pirX],
  ] as const) {
    const r = addComponent(d, type, { x, y: 0 });
    if (!r.ok) throw new Error(JSON.stringify(r));
    d = r.doc;
  }
  return d;
}

async function open3d(page: Page) {
  await page.getByTestId('view-3d').click();
  const view = page.getByTestId('view3d');
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 120_000 });
  return view;
}

test('PIR beside the matrix: moved apart in 3D only; the project keeps its coordinates', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await openImported(page, doc(460));
  const view = await open3d(page);
  await expect(view).toHaveAttribute('data-moved', /^U1:\d+(\.\d+)?,0$/);
  await expect(page.getByTestId('view3d-overlap')).toHaveCount(0);
  const stored = await storedProject(page);
  expect(stored.layout.components.U1).toEqual({ x: 460, y: 0, rotation: 0 });
  expect(stored.layout.components.DS1).toEqual({ x: 300, y: 0, rotation: 0 });
});

test('a part laid on another: a non-blocking notice in English and Hebrew', async ({ page }) => {
  test.setTimeout(150_000);
  await openImported(page, doc(320));
  const view = await open3d(page);
  const notice = page.getByTestId('view3d-overlap');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('DS1, U1');
  await expect(notice).toContainText('Circuit view');
  // Non-blocking: the 3D controls still work.
  await page.getByTestId('view3d-view-top').click();
  await expect(view).toHaveAttribute('data-status', 'ready');
  await page.getByTestId('language-select').selectOption('he');
  await expect(notice).toContainText('תצוגת המעגל');
  await expect(notice).toContainText('DS1, U1');
});
