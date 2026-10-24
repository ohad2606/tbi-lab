/**
 * Sprint 20 (s20r) owner report, in the product UI: one AND gate wired to a 5 V supply, the gate
 * turned 180 degrees. Before the fix two of its supply wires climbed ~12 mm over the gate's own
 * breakout board in 3D (a loop next to the pin); now every wire stays low beside it, and the 3D
 * view flags no routing limitation. A crowded bench whose 3D bodies cannot be separated: the view
 * names the wires it cannot route safely, in English and Hebrew (the connections are unchanged).
 * The geometry itself is checked on the cables as drawn by app/tests/wire-routing-3d-*.test.ts.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ProjectDocument } from '@tbi-lab/domain';
import { openImported } from './helpers.js';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/s20r/${name}.json`, import.meta.url), 'utf8'),
  ) as ProjectDocument;

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.addInitScript(() => localStorage.setItem('tbi-lab.3d.inspect', '1'));
});

async function open3d(page: Page) {
  await page.getByTestId('view-3d').click();
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready', {
    timeout: 120_000,
  });
}
type Scene = { wires: { id: string; points: { y: number }[] }[]; routeLimits?: string[] };
const shown = (page: Page) =>
  page.evaluate(
    () =>
      (document.querySelector('[data-testid="view3d-host"]') as unknown as { tbiScene: Scene })
        .tbiScene,
  );

test('owner bench, gate turned 180 degrees: no wire arches over the gate; nothing flagged', async ({
  page,
}, info) => {
  await openImported(page, fixture('owner-rot180'));
  await open3d(page);
  const scene = await shown(page);
  expect(scene.wires).toHaveLength(8);
  for (const id of ['W4', 'W5']) {
    const w = scene.wires.find((x) => x.id === id)!;
    expect(Math.max(...w.points.map((p) => p.y)), id).toBeLessThan(8);
  }
  expect(scene.routeLimits).toEqual([]);
  await expect(page.getByTestId('view3d-route-limit')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('owner-rot180-3d.png') });
});

test('a bench whose parts cannot be separated in 3D names the wires it cannot route safely (EN, HE)', async ({
  page,
}, info) => {
  await openImported(page, fixture('crowded'));
  await open3d(page);
  const scene = await shown(page);
  expect(scene.routeLimits!.length).toBeGreaterThan(0);
  const note = page.getByTestId('view3d-route-limit');
  await expect(note).toBeVisible();
  await expect(note).toContainText('could not be laid out cleanly in 3D');
  for (const id of scene.routeLimits!) await expect(note).toContainText(id);
  await page.screenshot({ path: info.outputPath('crowded-3d-en.png') });
  await page.getByTestId('language-select').selectOption('he');
  await expect(note).toContainText('בתלת־ממד');
  for (const id of scene.routeLimits!) await expect(note).toContainText(id);
  await page.screenshot({ path: info.outputPath('crowded-3d-he.png') });
});
