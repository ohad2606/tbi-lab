/**
 * 3D performance measurements (Sprint 10 realism pass), the same procedure for any build (it uses
 * only attributes every Sprint 10 build has): first 3D open, re-open, orbit drag, pan, fit/reset,
 * a dense scene, JS heap, and repeated enter/leave. Writes perf.json to EVIDENCE_OUT.
 *   EVIDENCE_SPEC=perf-3d.spec.ts EVIDENCE_URL=http://127.0.0.1:4175 EVIDENCE_QUALITY=auto|full|reduced
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createPackage, serializePackage } from '../../packages/domain/src/index.js';
import { denseBench } from './benches.js';

const OUT = process.env.EVIDENCE_OUT ?? 'evidence-out';
const QUALITY = process.env.EVIDENCE_QUALITY ?? 'auto';
const result: Record<string, unknown> = { quality: QUALITY };

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));
test.afterAll(() => writeFileSync(join(OUT, 'perf.json'), JSON.stringify(result, null, 2)));
test.beforeEach(async ({ page }) => {
  await page.addInitScript((q) => {
    if (q !== 'auto') localStorage.setItem('tbi-lab.3d.quality', q);
  }, QUALITY);
});

async function openText(page: Page, text: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) {
    await page.getByTestId('app-menu-button').click();
    await page.getByTestId('menu-projects').click();
  }
  await page.getByTestId('import-file').setInputFiles({
    name: 'bench.tbilab',
    mimeType: 'application/json',
    buffer: Buffer.from(text, 'utf8'),
  });
  await expect(page.getByTestId('canvas')).toBeVisible();
}
const pkg = (doc: unknown) =>
  serializePackage(
    createPackage(doc as Parameters<typeof createPackage>[0], {
      appVersion: '0.1.0',
      exportedAt: '2026-10-06T00:00:00.000Z',
    }),
  );

/** Click the 3D tab and wait for the first built frame; ms. */
async function open3d(page: Page): Promise<number> {
  const view = page.getByTestId('view3d');
  const t0 = Date.now();
  await page.getByTestId('view-3d').click();
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 180_000 });
  await expect
    .poll(async () => Number(await view.getAttribute('data-gpu-bytes')), {
      timeout: 180_000,
      intervals: [50],
    })
    .toBeGreaterThan(0);
  return Date.now() - t0;
}
const attrs = async (page: Page) => {
  const v = page.getByTestId('view3d');
  const n = async (k: string) => {
    const x = await v.getAttribute(k);
    return x === null ? null : Number(x);
  };
  return {
    quality: await v.getAttribute('data-quality'),
    geometries: await n('data-geometries'),
    textures: await n('data-textures'),
    gpuBytes: await n('data-gpu-bytes'),
    objects: await n('data-objects'),
    drawCalls: await n('data-draw-calls'),
    triangles: await n('data-triangles'),
    materials: await n('data-materials'),
    renderMs: await n('data-render-ms'),
    programs: await n('data-programs'),
  };
};
const heapMb = (page: Page) =>
  page.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return m ? Math.round(m.usedJSHeapSize / 1e5) / 10 : null;
  });

/** Wall time of a pointer drag over the 3D view in `steps` moves, ms per step. */
async function drag(page: Page, button: 'left' | 'right', steps = 24): Promise<number> {
  const box = (await page.getByTestId('view3d-host').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button });
  const t0 = Date.now();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx + i * 8, cy + (i % 2) * 2);
    // One frame per step: wait for the browser to paint.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }
  const ms = (Date.now() - t0) / steps;
  await page.mouse.up({ button });
  return Math.round(ms);
}

test('ESP32 example: open, re-open, orbit, pan, fit/reset, heap, enter/leave', async ({ page }) => {
  const doc = JSON.parse(
    readFileSync(new URL('../../app/src/examples/data/esp32-blink.json', import.meta.url), 'utf8'),
  );
  doc.projectId = 'prj_perfesp32';
  await openText(page, pkg(doc));
  const heap0 = await heapMb(page);
  const first = await open3d(page);
  await page.waitForTimeout(500);
  const scene = await attrs(page);
  const orbit = await drag(page, 'left');
  const pan = await drag(page, 'right');
  const t0 = Date.now();
  await page.getByTestId('view3d-fit').click();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  const fit = Date.now() - t0;
  const t1 = Date.now();
  await page.getByTestId('view3d-reset').click();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  const reset = Date.now() - t1;
  const heapOpen = await heapMb(page);
  // Leave and re-enter (assets cached, renderer chunk cached).
  await page.getByTestId('view-circuit').click();
  const reopen = await open3d(page);
  // Five more enter/leave cycles: the heap after them, and the 3D canvas count.
  for (let i = 0; i < 5; i++) {
    await page.getByTestId('view-circuit').click();
    await open3d(page);
  }
  await page.getByTestId('view-circuit').click();
  await page.waitForTimeout(500);
  const canvases = await page.locator('canvas.view3d-canvas').count();
  await page.evaluate(() => (globalThis as unknown as { gc?: () => void }).gc?.());
  const heapAfter = await heapMb(page);
  result.esp32 = {
    first,
    reopen,
    orbitMsPerStep: orbit,
    panMsPerStep: pan,
    fit,
    reset,
    scene,
    heap0,
    heapOpen,
    heapAfterCycles: heapAfter,
    canvasesAfterLeave: canvases,
  };
});

test('dense bench: open and orbit', async ({ page }) => {
  const doc = denseBench();
  doc.projectId = 'prj_perfdense';
  await openText(page, pkg(doc));
  const first = await open3d(page);
  await page.waitForTimeout(500);
  const scene = await attrs(page);
  const orbit = await drag(page, 'left');
  result.dense = { first, orbitMsPerStep: orbit, scene, heap: await heapMb(page) };
});
