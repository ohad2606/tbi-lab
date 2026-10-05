/**
 * Sprint 9 owner review fixes, in the real app:
 * 1. a wire dragged along with a moved part is re-routed off the ESP32 header it would run down;
 *    crossing a pin never connects to it;
 * 2. a lead dropped on another part's lead makes a real connection (canvas dot, netlist, 3D
 *    solder joint, simulation), and pulling it away breaks it; touching-but-unconnected leads in
 *    an imported project are marked as not connected in the canvas and in 3D;
 * 3. the 3D view pans (right or middle drag, Shift + arrows) without touching the project, and
 *    Fit / Reset re-centre it.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  ESP32_DEVKITC_WROOM32,
  boardPinPosition,
  wireRoute,
  type Point,
  type ProjectDocument,
} from '@tbi-lab/domain';
import {
  createProject,
  goToProjects,
  openImported,
  place,
  storedProject,
  storedProjects,
  toScreen,
  waitSaved,
  wire,
} from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

const tab = (page: Page, v: string) => page.getByTestId(`view-${v}`);
async function show3d(page: Page) {
  await tab(page, '3d').click();
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready');
}

/** Drag with the left button from one world point to another. */
async function dragWorld(page: Page, from: Point, to: Point) {
  const a = await toScreen(page, from);
  const b = await toScreen(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

/** A new project opens zoomed in on its supply: zoom out so the whole bench is on screen. */
async function zoomOut(page: Page) {
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Zoom out' }).click();
}

const netOf = (doc: ProjectDocument, c: string, t: string) =>
  doc.connections.find((x) => x.component === c && x.terminal === t)?.net;

test('a wire dragged along with a part is routed off the ESP32 header; crossed pins never connect', async ({
  page,
}) => {
  await createProject(page, 'Header routing');
  await zoomOut(page);
  await place(page, 'board.esp32_devkitc_wroom32', { x: 300, y: 0 });
  await place(page, 'component.ground', { x: 600, y: 0 });
  await wire(page, ['U1', 'gnd'], ['GND2', 'ref']);
  await waitSaved(page);
  // Move the ground straight under the GND pin (J3 top, x = 380): the stored route would now run
  // down the whole header.
  await dragWorld(page, { x: 600, y: 0 }, { x: 380, y: 260 });
  await expect
    .poll(async () => (await storedProject(page)).layout.components.GND2)
    .toMatchObject({ x: 380, y: 260 });
  const doc = await storedProject(page);
  const w = doc.layout.wires.find(
    (x) =>
      x.from.kind === 'terminal' &&
      [x.from.component, x.to.kind === 'terminal' && x.to.component].includes('GND2'),
  )!;
  const route = wireRoute(doc, w)!;
  const at = doc.layout.components.U1!;
  const onRoute = (p: Point) =>
    route.slice(1).some((b, i) => {
      const a = route[i]!;
      return a.x === b.x
        ? p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)
        : p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
    });
  const passed = ESP32_DEVKITC_WROOM32.pins
    .map((p) => boardPinPosition(p))
    .map((p) => ({ x: at.x + p.x, y: at.y + p.y }))
    .filter((p) => !(p.x === route[0]!.x && p.y === route[0]!.y))
    .filter(onRoute);
  expect(passed).toEqual([]);
  // Only the two ends are connected.
  expect(doc.connections.map((c) => `${c.component}.${c.terminal}`).sort()).toEqual([
    'GND2.ref',
    'U1.gnd',
  ]);
  await expect(page.locator('[data-code="wire_over_terminal"]')).toHaveCount(0);
});

test('a lead dropped on another lead connects in every view and the simulation; pulled away, it does not', async ({
  page,
}) => {
  await createProject(page, 'Direct contact');
  await zoomOut(page);
  await place(page, 'component.resistor', { x: 200, y: 200 }); // R1: leads at 160 and 240
  await place(page, 'component.led', { x: 460, y: 200 }); // D1: anode 420, cathode 500
  await wire(page, ['PSU1', 'positive'], ['R1', 'a']);
  await wire(page, ['D1', 'cathode'], ['GND1', 'ref']);
  await wire(page, ['PSU1', 'negative'], ['GND1', 'ref']);
  await waitSaved(page);
  // Drop D1 a few units off the exact spot: it snaps, its anode lands on R1.b.
  await dragWorld(page, { x: 460, y: 200 }, { x: 287, y: 204 });
  await expect(page.getByTestId('contact-R1.b')).toBeVisible();
  await expect(page.getByTestId('contact-D1.anode')).toBeVisible();
  await expect.poll(async () => netOf(await storedProject(page), 'R1', 'b')).toBeDefined();
  const joined = await storedProject(page);
  expect(netOf(joined, 'R1', 'b')).toBe(netOf(joined, 'D1', 'anode'));
  // The schematic draws them as one node (R1.b and D1.anode on one track).
  await tab(page, 'schematic').click();
  await expect(page.locator('.schematic')).toHaveAttribute('data-parts', /R1/);
  // The 3D view shows a solder joint there, and only there.
  await show3d(page);
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-contacts', 'D1:anode+R1:b');
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-open', '');
  // The simulation conducts through the contact: the LED lights.
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-lit', 'D1');
  await page.getByTestId('sim-stop').click();
  await expect(page.getByTestId('sim-status')).not.toHaveAttribute('data-status', 'running');
  // Pull D1 away: separated everywhere at once.
  await tab(page, 'circuit').click();
  await dragWorld(page, { x: 280, y: 200 }, { x: 280, y: 320 });
  await expect(page.getByTestId('contact-R1.b')).toHaveCount(0);
  await expect.poll(async () => netOf(await storedProject(page), 'R1', 'b')).toBeUndefined();
  const apart = await storedProject(page);
  expect(
    apart.layout.wires.filter(
      (w) =>
        w.vertices.length === 0 &&
        w.from.kind === 'terminal' &&
        w.to.kind === 'terminal' &&
        [w.from.component, w.to.component].sort().join() === 'D1,R1',
    ),
  ).toEqual([]);
  await show3d(page);
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-contacts', '');
});

test('touching leads that an imported project does not connect are marked as not connected', async ({
  page,
}) => {
  await createProject(page, 'Source');
  await zoomOut(page);
  await place(page, 'component.resistor', { x: 200, y: 200 });
  await place(page, 'component.led', { x: 460, y: 200 });
  await waitSaved(page);
  const doc = JSON.parse(JSON.stringify(await storedProject(page))) as ProjectDocument;
  doc.projectId = 'prj_d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';
  doc.name = 'Touching, not connected';
  doc.layout.components.D1!.x = 280; // anode on R1.b, laid there without an edit
  await openImported(page, doc);
  const marker = page.getByTestId('check-marker-R1.b');
  await expect(marker).toHaveAttribute('data-code', 'terminals_touching');
  await expect(page.getByTestId('contact-R1.b')).toHaveCount(0);
  await show3d(page);
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-open', 'D1:anode+R1:b');
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-contacts', '');
  // Opening and viewing it changed nothing: still not connected.
  const stored = (await storedProjects(page)).find((d) => d.projectId === doc.projectId)!;
  expect(netOf(stored, 'R1', 'b')).toBeUndefined();
});

test('3D pans with right or middle drag and Shift + arrows; Fit and Reset re-centre; nothing is written', async ({
  page,
}) => {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('open-example-voltage-divider').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  const revision = async () =>
    (await storedProjects(page)).map((d) => `${d.projectId}@${d.revision.localRevision}`).join();
  const before = await revision();
  await show3d(page);
  const view = page.getByTestId('view3d');
  await expect(view).toHaveAttribute('data-target', /,/);
  const home = (await view.getAttribute('data-target'))!;
  const host = page.getByTestId('view3d-host');
  const box = (await host.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const drag = async (button: 'left' | 'right' | 'middle', dx: number, dy: number) => {
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button });
    await page.mouse.move(cx + dx, cy + dy, { steps: 6 });
    await page.mouse.up({ button });
  };
  const target = async () => (await view.getAttribute('data-target'))!;

  await drag('right', 160, 0);
  await expect.poll(target).not.toBe(home);
  const afterRight = await target();
  await drag('middle', 0, 120);
  await expect.poll(target).not.toBe(afterRight);
  // Orbit (left drag) keeps the target: it turns around it.
  const panned = await target();
  await drag('left', 120, 0);
  await expect.poll(target).toBe(panned);
  // Fit re-centres on the circuit; so does Reset.
  await page.getByTestId('view3d-fit').click();
  await expect.poll(target).toBe(home);
  await drag('right', -140, 60);
  await expect.poll(target).not.toBe(home);
  await page.getByTestId('view3d-reset').click();
  await expect.poll(target).toBe(home);
  // Keyboard: Shift + arrows pan, Home resets.
  await host.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(target).not.toBe(home);
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Home');
  await expect.poll(target).toBe(home);

  // Repeated pan / orbit / zoom: same scene, same resources, one canvas.
  const geometries = await view.getAttribute('data-geometries');
  for (let i = 0; i < 8; i++) {
    await drag('right', 40, 20);
    await drag('left', 60, 0);
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, i % 2 ? 200 : -200);
  }
  await expect(view).toHaveAttribute('data-geometries', geometries!);
  expect(await page.locator('canvas.view3d-canvas').count()).toBe(1);
  // Navigation is not an edit.
  await tab(page, 'circuit').click();
  expect(await revision()).toBe(before);
});
