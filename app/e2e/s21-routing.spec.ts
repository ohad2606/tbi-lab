/**
 * Sprint 21 (s21r), in the product UI:
 *  - the owner-screenshot circuit (derived from the owner's screenshots; the lead's DEV-Lab bench:
 *    U1 at (-280, 0), wires V_CC, B, A, GND to PSU1) AS STORED BY THE PREVIOUS BUILD (0f8771d):
 *    importing it re-routes its automatic wires, and the "routes adjusted" notice is shown WITH
 *    the import's own confirmation (Sprint 20: the import replaced it), in English and Hebrew;
 *  - its 3D cables stay low (no arch over the supply's case or the gate's board, which reached
 *    12.2 mm), and nothing is flagged;
 *  - a wire drawn along a wire of another node is named by the Circuit view (EN, HE).
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ProjectDocument } from '@tbi-lab/domain';
import { openImported } from './helpers.js';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/s21r/${name}.json`, import.meta.url), 'utf8'),
  ) as ProjectDocument;

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.addInitScript(() => localStorage.setItem('tbi-lab.3d.inspect', '1'));
});

type Scene = { wires: { id: string; points: { y: number }[] }[]; routeLimits?: string[] };
const shown = (page: Page) =>
  page.evaluate(
    () =>
      (document.querySelector('[data-testid="view3d-host"]') as unknown as { tbiScene: Scene })
        .tbiScene,
  );

for (const name of ['owner-shot-stored-0f8771d', 'owner-shot-intended-stored-0f8771d'])
  test(`${name}: import keeps the routes-adjusted notice; 3D stays low, nothing flagged`, async ({
    page,
  }, info) => {
    await openImported(page, fixture(name));
    const notice = page.getByTestId('notice');
    await expect(notice).toHaveAttribute('data-key', 'import.done');
    const also = page.getByTestId('notice-also');
    await expect(also).toHaveAttribute('data-key', 'open.routesAdjusted');
    await expect(notice).toContainText('Imported');
    await expect(notice).toContainText('Some wire routes were redrawn');
    await page.screenshot({ path: info.outputPath(`${name}-2d-en.png`) });
    await page.getByTestId('language-select').selectOption('he');
    await expect(also).toBeVisible();
    await expect(also).not.toContainText('Some wire routes');
    await page.screenshot({ path: info.outputPath(`${name}-2d-he.png`) });
    await page.getByTestId('language-select').selectOption('en');
    await expect(page.getByTestId('canvas-route-conflict')).toHaveCount(0);
    await page.getByTestId('view-3d').click();
    await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready', {
      timeout: 120_000,
    });
    const scene = await shown(page);
    expect(scene.wires).toHaveLength(5);
    for (const w of scene.wires)
      expect(Math.max(...w.points.map((p) => p.y)), w.id).toBeLessThan(8);
    expect(scene.routeLimits).toEqual([]);
    await expect(page.getByTestId('view3d-route-limit')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`${name}-3d.png`) });
  });

test('a wire laid along a wire of another node is named by the Circuit view (EN, HE)', async ({
  page,
}, info) => {
  await openImported(page, fixture('conflict'));
  const note = page.getByTestId('canvas-route-conflict');
  await expect(note).toBeVisible();
  await expect(note).toContainText('NOT connected');
  await expect(page.locator('[data-hit="wire"][data-conflict="true"]')).not.toHaveCount(0);
  await page.screenshot({ path: info.outputPath('conflict-en.png') });
  await page.getByTestId('language-select').selectOption('he');
  await expect(note).toContainText('אינם מחוברים');
  await page.screenshot({ path: info.outputPath('conflict-he.png') });
});
