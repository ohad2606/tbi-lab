/**
 * Terminal keep-out in the real app (Sprint 10 owner blocker). The owner's case: in the ESP32
 * blink example (its GND pin already wired out to a ground), place a new ground below-left of the
 * board and wire the GND pin to it. The route used to run straight down the J3 header over 18
 * pins; it now goes around the board, entering no unrelated pin, and only U1.gnd joins the new
 * ground's net, in the canvas, the stored project, after reload, in the schematic and in 3D.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  ESP32_DEVKITC_WROOM32,
  boardPinPosition,
  boardTerminalId,
  wireRoute,
  type Point,
  type ProjectDocument,
} from '@tbi-lab/domain';
import {
  goToProjects,
  place,
  reopenFromLibrary,
  storedProject,
  waitSaved,
  wire,
} from './helpers.js';

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

const dist = (p: Point, a: Point, b: Point) => {
  const x = Math.max(Math.min(a.x, b.x), Math.min(p.x, Math.max(a.x, b.x)));
  const y = Math.max(Math.min(a.y, b.y), Math.min(p.y, Math.max(a.y, b.y)));
  return Math.hypot(p.x - x, p.y - y);
};

/** Board pins (all 38 header positions) the route passes within half a grid step of. */
function pinsEntered(doc: ProjectDocument, route: Point[]): string[] {
  const at = doc.layout.components.U1!;
  const [a, b] = [route[0]!, route.at(-1)!];
  return ESP32_DEVKITC_WROOM32.pins
    .map((pin) => ({ pin, p: boardPinPosition(pin) }))
    .map(({ pin, p }) => ({ id: pin.headerLabel, p: { x: at.x + p.x, y: at.y + p.y } }))
    .filter(({ p }) => !(p.x === a.x && p.y === a.y) && !(p.x === b.x && p.y === b.y))
    .filter(({ p }) => route.slice(1).some((q, i) => dist(p, route[i]!, q) < 10))
    .map(({ id }) => id);
}

const netOf = (doc: ProjectDocument, c: string, t: string) =>
  doc.connections.find((x) => x.component === c && x.terminal === t)?.net;

test('ESP32 GND to a new ground: the wire goes around the board; only GND joins the ground net', async ({
  page,
}) => {
  await openExample(page, 'esp32-blink');
  await waitSaved(page);
  const before = await storedProject(page);
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await place(page, 'component.ground', { x: -20, y: 240 });
  await expect
    .poll(async () => (await storedProject(page)).components.length)
    .toBe(before.components.length + 1);
  const placed = await storedProject(page);
  const ground = placed.components.find((c) => !before.components.some((b) => b.id === c.id))!;
  expect(ground.type).toBe('component.ground');
  expect(placed.layout.components[ground.id]).toMatchObject({ x: -20, y: 240 });

  await wire(page, ['U1', 'gnd'], [ground.id, 'ref']);
  await expect
    .poll(async () => (await storedProject(page)).layout.wires.length)
    .toBe(placed.layout.wires.length + 1);
  await waitSaved(page);
  const doc = await storedProject(page);
  const w = doc.layout.wires.find((x) => !placed.layout.wires.some((p) => p.id === x.id))!;
  const route = wireRoute(doc, w)!;

  // Geometry: around the top of the board and down its far side, two grid steps clear of the
  // pins; never down the J3 header (x = 140), whose 18 pins the old route crossed.
  expect(route).toEqual([
    { x: 140, y: -180 },
    { x: 140, y: -220 },
    { x: -60, y: -220 },
    { x: -60, y: 220 },
    { x: -20, y: 220 },
  ]);
  expect(pinsEntered(doc, route)).toEqual([]);
  await expect(page.locator('[data-code="wire_over_terminal"]')).toHaveCount(0);

  // Connectivity: U1.gnd and the new ground share a net; every other board pin keeps its own.
  const gnd = netOf(doc, 'U1', 'gnd');
  expect(gnd).toBeDefined();
  expect(netOf(doc, ground.id, 'ref')).toBe(gnd);
  for (const pin of ESP32_DEVKITC_WROOM32.pins) {
    const t = boardTerminalId(pin);
    if (!t || t === 'gnd') continue;
    expect(netOf(doc, 'U1', t) ?? null, t).not.toBe(gnd);
    expect(netOf(doc, 'U1', t) ?? null, t).toBe(netOf(before, 'U1', t) ?? null);
  }
  if (process.env.TBI_SHOTS)
    await page
      .getByTestId('canvas')
      .screenshot({ path: `${process.env.TBI_SHOTS}/esp32-gnd-route.png` });

  // Schematic and 3D receive the netlist: no board pin other than GND joins anything new.
  await page.getByTestId('view-schematic').click();
  await expect(page.locator('.schematic')).toBeVisible();
  await page.getByTestId('view-3d').click();
  const view = page.getByTestId('view3d');
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await expect(view).not.toHaveAttribute('data-contacts', /U1:/);
  await page.getByTestId('view-circuit').click();

  // Reload: the stored route and nets are unchanged (no re-routing on load).
  await page.reload();
  await reopenFromLibrary(page, doc.projectId);
  const back = await storedProject(page);
  expect(
    wireRoute(
      back,
      back.layout.wires.find((x) => x.id === w.id)!,
    ),
  ).toEqual(route);
  expect(back.connections).toEqual(doc.connections);
  await expect(page.locator('[data-code="wire_over_terminal"]')).toHaveCount(0);
});
