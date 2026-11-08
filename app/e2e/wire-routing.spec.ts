/**
 * Wire routing integrity (owner-reported defect, 2026-10-22), in the product UI: the owner's video.
 * A PSU, a ground and an AND gate; the gate's supply wired by clicks; the gate dragged with the
 * mouse right, left and back to where it was. After every drop no crossing bridge appears; back
 * home the drawing is identical to the original; it stays identical across the Schematic and 3D
 * views and a reload. Screenshots of each step are attached. (Body intrusion in 2D and 3D is
 * checked geometrically by app/tests/wire-routing-integrity.test.ts.)
 */
import { expect, test, type Page } from '@playwright/test';
import { addComponent, addWire, createProject, type ProjectDocument } from '@tbi-lab/domain';
import {
  component,
  createProject as createProjectInUi,
  openImported,
  place,
  reopenFromLibrary,
  toScreen,
  waitSaved,
  wire,
} from './helpers.js';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

/** Every drawn wire's route (its hit polyline's points), by wire id. */
async function drawing(page: Page): Promise<Record<string, string>> {
  return page
    .locator('[data-hit="wire"]')
    .evaluateAll((els) =>
      Object.fromEntries(
        els.map((g) => [
          g.getAttribute('data-id')!,
          g.querySelector('polyline.wire-hit')!.getAttribute('points')!,
        ]),
      ),
    );
}

/** Drag a part by `dx` layout units, pressing on its own hit area wherever it is drawn. */
async function dragBy(page: Page, id: string, dx: number) {
  const box = (await component(page, id).locator('.component-hit').boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const o = await toScreen(page, { x: 0, y: 0 });
  const d = (await toScreen(page, { x: dx, y: 0 })).x - o.x;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + d / 2, from.y, { steps: 6 });
  await page.mouse.move(from.x + d, from.y, { steps: 6 });
  await page.mouse.up();
}

test("the owner's sequence: a gate wired to a PSU dragged right, left and back — clean, restored", async ({
  page,
}, info) => {
  await createProjectInUi(page, 'Routing integrity');
  await place(page, 'logic.gate_and', { x: 160, y: 0 });
  await wire(page, ['PSU1', 'negative'], ['GND1', 'ref']);
  await wire(page, ['PSU1', 'positive'], ['U1', 'vcc']);
  await wire(page, ['U1', 'gnd'], ['GND1', 'ref']);
  await page.keyboard.press('Escape');
  await waitSaved(page);
  const start = await drawing(page);
  expect(Object.keys(start)).toHaveLength(3);
  await page.screenshot({ path: info.outputPath('0-initial.png') });

  // Zoom out twice so the whole excursion stays inside the visible canvas.
  for (let k = 0; k < 2; k++) await page.getByRole('button', { name: 'Zoom out' }).click();
  // Right, left past the start, back: 160 -> 240 -> 40 -> 160.
  for (const [i, dx] of [80, -200, 120].entries()) {
    await dragBy(page, 'U1', dx);
    await waitSaved(page);
    // No crossing bridge (the three wires need none in any of these positions).
    await expect(page.getByTestId('wire-bridge')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`${i + 1}-after-drag-${dx}.png`) });
  }
  // Back where it started: exactly the original drawing (no obsolete segment, no detour).
  expect(await drawing(page)).toEqual(start);

  // Selecting a wire shows how it is routed.
  // (W1 is straight: the centre of its box is on the wire.)
  await page.locator('[data-hit="wire"][data-id="W1"] polyline.wire-hit').click({ force: true });
  await expect(page.getByTestId('wire-route')).toHaveAttribute('data-route', 'auto');

  // The other views and a reload do not resurrect anything.
  await page.getByTestId('view-schematic').click();
  await page.getByTestId('view-3d').click();
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready', {
    timeout: 120_000,
  });
  await page.screenshot({ path: info.outputPath('4-3d.png') });
  await page.getByTestId('view-circuit').click();
  expect(await drawing(page)).toEqual(start);
  await page.reload();
  await reopenFromLibrary(page);
  expect(await drawing(page)).toEqual(start);
});

/**
 * s20r6 (review r4 MAJOR 1): a crafted project of 2 500 manual wires of one node, 80 mm tall side
 * by side far off the bench (half a megabyte). Marking its crossings and branch points tested
 * every pair; now the work is counted and capped, and the Circuit view says some line hops and
 * junction dots are not drawn (the connections are unchanged), in English and Hebrew.
 */
test('a drawing too large to mark every crossing says so (EN, HE)', async ({ page }, info) => {
  let doc: ProjectDocument = createProject({
    projectId: 'prj_s20r6long',
    deviceId: 'device-test',
    name: 'Long wires',
    appVersion: '0.1.0',
    clock: { now: () => new Date('2026-10-25T00:00:00.000Z') },
  });
  const r1 = addComponent(doc, 'component.resistor', { x: 0, y: -100 });
  if (!r1.ok) throw new Error(r1.error);
  const one = addWire(
    r1.doc,
    { kind: 'terminal', component: 'PSU1', terminal: 'positive' },
    { kind: 'terminal', component: r1.id, terminal: 'a' },
    [
      { x: 20000, y: -20 },
      { x: 20000, y: -100 },
    ],
  );
  if (!one.ok) throw new Error(one.error);
  const w0 = one.doc.layout.wires[0]!;
  const N = 2500;
  const wires = Array.from({ length: N }, (_, i) => ({
    ...w0,
    id: `W${i + 1}`,
    vertices: [
      { x: 20000 + 20 * i, y: -20 - 20 * (i % 50) },
      { x: 20000 + 20 * i, y: -100 - 20 * (i % 50) },
    ],
  }));
  doc = {
    ...one.doc,
    layout: { ...one.doc.layout, wires },
    idCounters: { ...one.doc.idCounters, W: N },
  };
  // 2500 wires: opening (and repairing) them takes 4–8 s on the 1-vCPU DEV host.
  await openImported(page, doc, { timeout: 60_000 });
  const note = page.getByTestId('canvas-overlay-limit');
  await expect(note).toBeVisible({ timeout: 60_000 });
  await expect(note).toContainText('some line hops and junction dots are not drawn');
  await expect(page.locator('[data-hit="wire"]')).toHaveCount(N);
  await page.screenshot({ path: info.outputPath('overlay-limit-en.png') });
  await page.getByTestId('language-select').selectOption('he');
  await expect(note).toContainText('חלק מגשרי הקווים ומנקודות הצומת אינם משורטטים');
  await page.screenshot({ path: info.outputPath('overlay-limit-he.png') });
});
