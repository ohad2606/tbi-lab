/**
 * Sprint 18F (owner acceptance): the SG90 horn in the 3D view turns, drawn, to the angle it is
 * given; no runtime needed (the renderer's live API, the same call the view makes with the
 * simulation's reported angle — that path is unit-tested, and on the real Runtime v3 in
 * s18-r4b-real.spec.ts).
 *
 * - the horn draws its own meshes (it was merged into the static batches before: nothing turned);
 * - 0 / 90 / 180 / 45 deg: the arm tip at that angle about the shaft, at the arm's reach;
 * - the PIXELS change: the region round the shaft differs between 0 and 180 deg, and 0 deg again
 *   draws what 0 deg drew;
 * - lifecycle: leaving the 3D view and coming back, the horn is still its own part, at rest
 *   (stopped: no angle reported).
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects } from './helpers.js';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.addInitScript(() => localStorage.setItem('tbi-lab.3d.inspect', '1'));
});

type Horn = { yaw: number; meshes: number; tip: number[]; shaft: number[] };
const horns = (page: Page) =>
  page.evaluate(() => {
    const host = document.querySelector('[data-testid="view3d-host"]') as unknown as {
      tbiViewer: { horns(): Record<string, Horn> };
    };
    return host.tbiViewer.horns();
  });
const setAngle = (page: Page, deg: number) =>
  page.evaluate((d) => {
    const host = document.querySelector('[data-testid="view3d-host"]') as unknown as {
      tbiViewer: { setLive(l: Record<string, unknown>): void };
    };
    host.tbiViewer.setLive({ M1: { servoDeg: d } });
  }, deg);
async function open3d(page: Page) {
  await page.getByTestId('view-3d').click();
  const view = page.getByTestId('view3d');
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 120_000 });
  await page.getByTestId('view3d-view-top').click();
}
/** The drawn pixels round the horn (after the next frames are drawn). */
async function hornPixels(page: Page, around: { x: number; y: number }) {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  return page.screenshot({
    clip: { x: around.x - 70, y: around.y - 70, width: 140, height: 140 },
  });
}
const differingBytes = (a: Buffer, b: Buffer) => {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n + Math.abs(a.length - b.length);
};

test('the SG90 horn turns, drawn, to 0 / 90 / 180 deg about its shaft; lifecycle', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('open-example-esp32-servo-sweep').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await open3d(page);

  const rest = (await horns(page)).M1!;
  expect(rest.meshes).toBe(4); // hub, arm, tip, screw: its own meshes, not batched away
  expect(rest.yaw).toBeCloseTo(Math.PI / 2, 9); // stopped: at rest

  const at: Record<number, Horn> = {};
  for (const deg of [0, 90, 180, 45]) {
    await setAngle(page, deg);
    at[deg] = (await horns(page)).M1!;
    expect(at[deg]!.yaw).toBeCloseTo((deg * Math.PI) / 180, 9);
    const [tx, , tz] = at[deg]!.tip;
    const [sx, , sz] = at[deg]!.shaft;
    expect(Math.hypot(tx! - sx!, tz! - sz!)).toBeCloseTo(15, 6); // the arm's reach
  }
  // The tip really goes round: opposite at 0 and 180, a quarter turn at 90.
  const vec = (h: Horn) => [h.tip[0]! - h.shaft[0]!, h.tip[2]! - h.shaft[2]!] as const;
  const [a0, b0] = vec(at[0]!);
  const [a90, b90] = vec(at[90]!);
  const [a180, b180] = vec(at[180]!);
  expect(a0 * a180 + b0 * b180).toBeCloseTo(-225, 4);
  expect(a0 * a90 + b0 * b90).toBeCloseTo(0, 4);

  // The pixels: the horn is drawn where its angle puts it.
  const shaftPx = await page.evaluate((p) => {
    const host = document.querySelector('[data-testid="view3d-host"]') as unknown as {
      tbiViewer: { screenOf(p: number[]): { x: number; y: number } };
    };
    return host.tbiViewer.screenOf(p);
  }, at[0]!.shaft);
  await setAngle(page, 0);
  const p0 = await hornPixels(page, shaftPx);
  await setAngle(page, 180);
  const p180 = await hornPixels(page, shaftPx);
  await setAngle(page, 0);
  const p0again = await hornPixels(page, shaftPx);
  await info.attach('horn-0deg.png', { body: p0, contentType: 'image/png' });
  await info.attach('horn-180deg.png', { body: p180, contentType: 'image/png' });
  expect(differingBytes(p0, p180)).toBeGreaterThan(500);
  expect(differingBytes(p0, p0again)).toBe(0);

  // Lifecycle: away and back (the scene is rebuilt): the horn is still its own part, at rest.
  await page.getByTestId('view-circuit').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await open3d(page);
  const back = (await horns(page)).M1!;
  expect(back.meshes).toBe(4);
  expect(back.yaw).toBeCloseTo(Math.PI / 2, 9);
});
