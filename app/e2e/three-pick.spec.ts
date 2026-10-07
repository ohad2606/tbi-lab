/**
 * Limited 3D interaction (Sprint 10, owner-approved): in the 3D view a click selects the part or
 * wire under the pointer (the same selection as Circuit, Schematic and Inspector), a drag only
 * moves the camera, the bench selects nothing; a wire picked in 3D can be recoloured in the
 * Inspector and both 3D and the Circuit view show the colour. Nothing else is editable in 3D.
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects, storedProject } from './helpers.js';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.addInitScript(() => localStorage.setItem('tbi-lab.3d.inspect', '1'));
});

async function openExample(page: Page, id: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
}

type P3 = [number, number, number];
/** Screen point of a scene point (the opt-in viewer hook). */
const screenOf = (page: Page, p: P3) =>
  page.evaluate((q) => {
    const host = document.querySelector('[data-testid="view3d-host"]') as unknown as {
      tbiViewer: { screenOf(p: P3): { x: number; y: number } };
    };
    return host.tbiViewer.screenOf(q);
  }, p);
/** Scene facts the test needs: a part's centre and a long wire run's midpoint. */
const sceneFacts = (page: Page, part: string) =>
  page.evaluate((id) => {
    const host = document.querySelector('[data-testid="view3d-host"]') as unknown as {
      tbiScene: {
        components: { id: string; x: number; z: number }[];
        wires: { id: string; points: { x: number; y: number; z: number }[] }[];
      };
    };
    const s = host.tbiScene;
    const c = s.components.find((x) => x.id === id)!;
    // The longest straight run of any wire, at its middle.
    let best = { id: '', p: [0, 0, 0] as [number, number, number], len: 0 };
    for (const w of s.wires)
      for (let i = 1; i < w.points.length; i++) {
        const a = w.points[i - 1]!;
        const b = w.points[i]!;
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len > best.len && Math.abs(a.y - b.y) < 0.01)
          best = { id: w.id, p: [(a.x + b.x) / 2, a.y, (a.z + b.z) / 2], len };
      }
    return { part: [c.x, 4, c.z] as [number, number, number], wire: best };
  }, part);

test('3D: click selects a part or a wire, drag only orbits, the bench clears; colour a wire from 3D', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await openExample(page, 'relay-load');
  await page.getByTestId('view-3d').click();
  const view = page.getByTestId('view3d');
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 120_000 });
  await page.getByTestId('view3d-view-top').click();
  const facts = await sceneFacts(page, 'K1');

  // A click on the relay selects it (the Inspector shows it too).
  let at = await screenOf(page, facts.part);
  await page.mouse.click(at.x, at.y);
  await expect(view).toHaveAttribute('data-selected', 'C:K1');
  await expect(page.getByTestId('inspector')).toContainText('K1');

  // A drag (camera navigation) selects nothing new.
  const renders = Number(await view.getAttribute('data-renders'));
  await page.mouse.move(at.x + 120, at.y + 40);
  await page.mouse.down();
  await page.mouse.move(at.x + 60, at.y + 10, { steps: 6 });
  await page.mouse.move(at.x - 20, at.y - 30, { steps: 6 });
  await page.mouse.up();
  await expect(view).toHaveAttribute('data-selected', 'C:K1');
  // The camera did move (frames were drawn), and the selection is unchanged.
  expect(Number(await view.getAttribute('data-renders'))).toBeGreaterThan(renders);

  // Back to the top view; a click on a wire selects that wire.
  await page.getByTestId('view3d-view-top').click();
  at = await screenOf(page, facts.wire.p);
  await page.mouse.click(at.x, at.y);
  await expect(view).toHaveAttribute('data-selected', `W:${facts.wire.id}`);

  // Its colour, changed in the Inspector: 3D, the Circuit view and the stored project agree.
  const select = page.getByTestId('wire-color');
  await expect(select).toHaveValue('auto');
  await select.selectOption('blue');
  await expect(view).toHaveAttribute('data-wire-colors', new RegExp(`${facts.wire.id}:#1e88e5`));
  await page.getByTestId('view-circuit').click();
  const group = page.locator(`[data-hit="wire"][data-id="${facts.wire.id}"]`);
  await expect(group).toHaveAttribute('data-color', 'blue');
  await expect(group).toHaveAttribute('data-color-source', 'manual');
  await expect
    .poll(
      async () =>
        (await storedProject(page)).layout.wires.find((w) => w.id === facts.wire.id)?.color,
    )
    .toBe('blue');
  // Auto again restores the net colour.
  await select.selectOption('auto');
  await expect(group).not.toHaveAttribute('data-color-source', 'manual');

  // In 3D again: a click on the empty bench clears the selection.
  await page.getByTestId('view-3d').click();
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 120_000 });
  await page.getByTestId('view3d-view-top').click();
  const box = (await page.getByTestId('view3d-host').boundingBox())!;
  await page.mouse.click(box.x + 12, box.y + box.height - 40);
  await expect(view).toHaveAttribute('data-selected', '');
});

test('wire colour control in Hebrew; the supply wires are red and black automatically', async ({
  page,
}) => {
  await openExample(page, 'led-current');
  const red = page.locator('[data-hit="wire"][data-color="red"]');
  const black = page.locator('[data-hit="wire"][data-color="black"]');
  // (A straight SVG run has an empty box on one axis: counted, not "visible".)
  expect(await red.count()).toBeGreaterThan(0);
  expect(await black.count()).toBeGreaterThan(0);
  await red.first().locator('.wire-hit').click({ force: true });
  await page.getByTestId('language-select').selectOption('he');
  const select = page.getByTestId('wire-color');
  await expect(page.getByTestId('inspector')).toContainText('צבע חוט');
  await expect(select.locator('option[value="auto"]')).toHaveText('אוטומטי (אדום)');
});
