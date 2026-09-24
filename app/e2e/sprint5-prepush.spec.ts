/**
 * Sprint 5 pre-push fixes, in Chromium: wire/component layering, wire segment dragging and
 * datasheet over-stress warnings. Durability is proven on the real IndexedDB.
 */
import { expect, test, type Page } from '@playwright/test';
import { createSnapshot, wireRoute, type ProjectDocument } from '@tbi-lab/domain';
import { EngineSession, ratingWarnings, type SolveSuccess } from '@tbi-lab/engine';
import { link, run, setValue } from './circuits.js';
import {
  component,
  createProject,
  place,
  storedProject,
  toScreen,
  waitForStoredProject,
} from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

/** The data-hit element topmost at a world point (what the user sees and clicks). */
async function topHit(page: Page, world: { x: number; y: number }) {
  const s = await toScreen(page, world);
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)?.closest('[data-hit]') as HTMLElement | null;
    return el ? `${el.dataset.hit}:${el.dataset.id ?? el.dataset.component ?? ''}` : 'none';
  }, s);
}

test('layering: a wire crossing a part runs behind its body; terminals and junctions stay on top', async ({
  page,
}) => {
  await createProject(page, 'Layers');
  await page.getByRole('button', { name: 'Zoom out' }).click();
  // R1 upright at (60,-20): its body spans y -60..20 on x = 60; terminals at (60,-60) and (60,20).
  await place(page, 'component.resistor', { x: 60, y: -20 });
  await component(page, 'R1').locator('.component-hit').click();
  await page.keyboard.press('r');
  await place(page, 'component.resistor', { x: 140, y: -20 });
  // PSU+ (-80,-20) -> R2.a (100,-20): a straight wire straight across R1's body.
  await link(page, ['PSU1', 'positive'], ['R2', 'a']);
  const doc = await waitForStoredProject(
    page,
    (d) => d.layout.wires.length === 1 && d.layout.components.R1?.rotation === 90,
    'crossing wire stored',
  );
  const route = wireRoute(doc, doc.layout.wires[0]!)!;
  expect(route.every((p) => p.y === -20)).toBe(true); // it really passes through R1's body
  expect(doc.connections.some((c) => c.component === 'R1')).toBe(false); // and is not connected

  await page.keyboard.press('Escape');
  // Where the wire crosses the part body, the part is on top (it is drawn over the wire).
  expect(await topHit(page, { x: 60, y: -20 })).toBe('component:R1');
  // Away from the part, the wire is the topmost thing.
  expect(await topHit(page, { x: -20, y: -20 })).toBe('wire:W1');
  // The wire's own end terminal is above the wire.
  expect(await topHit(page, { x: 100, y: -20 })).toBe('terminal:R2');
  // Every part has an opaque knock-out behind its symbol, inside the component layer.
  const layerOrder = await page
    .getByTestId('canvas')
    .evaluate((svg) =>
      [...svg.querySelectorAll(':scope > g')].map((g) => g.getAttribute('class')).filter(Boolean),
    );
  expect(layerOrder.indexOf('wires')).toBeLessThan(layerOrder.indexOf('components'));
  expect(layerOrder.indexOf('components')).toBeLessThan(layerOrder.indexOf('terminals'));
  expect(layerOrder.indexOf('terminals')).toBeLessThan(layerOrder.indexOf('junctions'));
  await expect(page.locator('.component .symbol-knockout')).toHaveCount(4);
  // ... and it is painted: opaque, in the canvas background colour, so the wire line under R1's
  // body is hidden (the visual defect was a wire drawn through a transparent symbol).
  const paint = await page.locator('[data-id="R1"] .symbol-knockout').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { fill: cs.fill, opacity: cs.opacity, fillOpacity: cs.fillOpacity };
  });
  expect(paint.fill).toBe('rgb(255, 255, 255)');
  expect([paint.opacity, paint.fillOpacity]).toEqual(['1', '1']);
});

test('wire editing: drag a segment of a selected wire; ends stay connected; undo restores', async ({
  page,
}) => {
  await createProject(page, 'Drag wire');
  await place(page, 'component.resistor', { x: 140, y: -20 });
  await link(page, ['PSU1', 'positive'], ['R1', 'a']); // straight, along y = -20
  const before = await waitForStoredProject(page, (d) => d.layout.wires.length === 1, 'wire');
  // Select the wire, then drag its middle down by 60 (3 grid steps).
  const from = await toScreen(page, { x: 20, y: -20 });
  await page.mouse.click(from.x, from.y);
  await expect(page.getByTestId('canvas-hint')).toContainText('Drag a straight part of the wire');
  const to = await toScreen(page, { x: 20, y: 40 });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  const after = await waitForStoredProject(
    page,
    (d) => d.layout.wires[0]!.vertices.length > 0,
    'wire segment moved',
  );
  const r = wireRoute(after, after.layout.wires[0]!)!;
  expect(r).toEqual([
    { x: -80, y: -20 },
    { x: -80, y: 40 },
    { x: 100, y: 40 },
    { x: 100, y: -20 },
  ]);
  // Only geometry changed: same ends, same connectivity, a new revision.
  expect(after.connections).toEqual(before.connections);
  expect(after.nets).toEqual(before.nets);
  expect(after.layout.wires[0]!.from).toEqual(before.layout.wires[0]!.from);
  expect(after.layout.wires[0]!.to).toEqual(before.layout.wires[0]!.to);
  expect(after.revision.localRevision).toBe(before.revision.localRevision + 1);
  // Undo returns the straight wire (a new revision, never an old one).
  await page.getByTestId('undo').click();
  const undone = await waitForStoredProject(
    page,
    (d) => d.layout.wires[0]!.vertices.length === 0,
    'undo of the drag',
  );
  expect(wireRoute(undone, undone.layout.wires[0]!)).toEqual(
    wireRoute(before, before.layout.wires[0]!),
  );
  expect(undone.revision.localRevision).toBe(after.revision.localRevision + 1);
});

function truth(doc: ProjectDocument): SolveSuccess {
  const o = new EngineSession(createSnapshot(doc)).solve();
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o;
}

test('over-stress: an LED past its datasheet maximum is a warning (not an error); a normal one is quiet', async ({
  page,
}) => {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await page.getByRole('button', { name: /Projects/ }).click();
  await page.getByTestId('open-example-led-current').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await run(page);
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('rating-warning')).toHaveCount(0); // ~13.7 mA: within rating
  await page.getByTestId('sim-stop').click();

  await setValue(page, 'R1', 'resistance', '47');
  const doc = await waitForStoredProject(
    page,
    (d) =>
      (d.components.find((c) => c.id === 'R1')!.params.resistance as { value: number }).value ===
      47,
    'R1 = 47 Ω',
  );
  await run(page);
  const expected = ratingWarnings(createSnapshot(doc), truth(doc));
  expect(expected.map((w) => w.code).sort()).toEqual(['forward_current', 'power']);
  const banner = page.getByTestId('rating-warning');
  await expect(banner).toBeVisible();
  await expect(banner.locator('li')).toHaveCount(2);
  await expect(banner).toContainText('TLHR5400');
  await expect(banner).toContainText('30 mA');
  await expect(banner).toContainText('not a simulation error');
  await expect(page.getByTestId('sim-error')).toHaveCount(0);
  await expect(component(page, 'D1')).toHaveAttribute('data-overstressed', 'true');
  // The warning never alters the solved values shown.
  await component(page, 'D1').locator('.component-hit').click();
  const r = truth(doc).components.D1!;
  await expect(page.getByTestId('result-rating')).toHaveCount(2);
  await expect(page.getByTestId('result-current')).toContainText(
    `${Math.round(r.current! * 1e5) / 100}`,
  );
  // Nothing about the warning is stored in the project.
  expect(JSON.stringify(await storedProject(page))).not.toMatch(/rating|overstress|warning/i);
});
