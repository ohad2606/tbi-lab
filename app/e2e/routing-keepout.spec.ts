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
  addComponent,
  addWire,
  boardPinPosition,
  boardTerminalId,
  wireRoute,
  type Point,
  type ProjectDocument,
} from '@tbi-lab/domain';
import {
  goToProjects,
  openImported,
  place,
  reopenFromLibrary,
  storedProject,
  storedProjects,
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

/**
 * The drawn wire against the drawn board: every pin marker (circle) and pin stub (line) of U1, in
 * world coordinates (through each element's own transform), with the visible ink gap between the
 * wire's stroke and theirs. `adjacent`: within one pin pitch of the wire's own pin (its outward
 * exit necessarily passes those neighbours).
 */
async function renderedClearance(page: Page, wireId: string) {
  return page.getByTestId('canvas').evaluate((svg, id) => {
    const root = svg.querySelector('g.wires') as SVGGraphicsElement;
    const toWorld = root.getCTM()!.inverse();
    const world = (el: SVGGraphicsElement, x: number, y: number) => {
      const p = new DOMPoint(x, y).matrixTransform(el.getCTM()!).matrixTransform(toWorld);
      return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
    };
    const group = svg.querySelector(`[data-hit="wire"][data-id="${id}"]`)!;
    const wirePoints = group.querySelector('.wire-hit')!.getAttribute('points')!;
    const pts = wirePoints.split(' ').map((s) => {
      const [x, y] = s.split(',').map(Number);
      return { x: x!, y: y! };
    });
    const wireHalf = parseFloat(getComputedStyle(group.querySelector('.wire')!).strokeWidth) / 2;
    const d = (
      p: { x: number; y: number },
      a: { x: number; y: number },
      b: { x: number; y: number },
    ) => {
      const x = Math.max(Math.min(a.x, b.x), Math.min(p.x, Math.max(a.x, b.x)));
      const y = Math.max(Math.min(a.y, b.y), Math.min(p.y, Math.max(a.y, b.y)));
      return Math.hypot(p.x - x, p.y - y);
    };
    const toWire = (p: { x: number; y: number }) =>
      Math.min(...pts.slice(1).map((q, i) => d(p, pts[i]!, q)));
    const own = pts[0]!;
    const end = pts.at(-1)!;
    // Within the header band's reach (70 units) of either end: a clear gap is required there.
    const adjacent = (p: { x: number; y: number }) =>
      Math.hypot(p.x - own.x, p.y - own.y) <= 70.01 ||
      Math.hypot(p.x - end.x, p.y - end.y) <= 70.01;
    const gaps: { what: string; at: string; gap: number; adjacent: boolean }[] = [];
    const marks = [
      ...svg.querySelectorAll('[data-hit="terminal"][data-component="U1"] .terminal-mark'),
    ] as SVGCircleElement[];
    for (const m of marks) {
      const c = world(m, m.cx.baseVal.value, m.cy.baseVal.value);
      if (c.x === own.x && c.y === own.y) continue;
      const r = m.r.baseVal.value + parseFloat(getComputedStyle(m).strokeWidth) / 2;
      gaps.push({
        what: 'pin marker',
        at: `${c.x},${c.y}`,
        gap: toWire(c) - wireHalf - r,
        adjacent: adjacent(c),
      });
    }
    const board = svg.querySelector('[data-hit="component"][data-id="U1"]')!;
    const stubs = [...board.querySelectorAll('line')] as SVGLineElement[];
    for (const l of stubs) {
      const a = world(l, l.x1.baseVal.value, l.y1.baseVal.value);
      const b = world(l, l.x2.baseVal.value, l.y2.baseVal.value);
      if ([a, b].some((p) => p.x === own.x && p.y === own.y)) continue; // the GND pin's own stub
      const half = parseFloat(getComputedStyle(l).strokeWidth) / 2;
      let dist = Infinity;
      for (let i = 0; i < pts.length - 1; i++)
        dist = Math.min(
          dist,
          d(a, pts[i]!, pts[i + 1]!),
          d(b, pts[i]!, pts[i + 1]!),
          d(pts[i]!, a, b),
          d(pts[i + 1]!, a, b),
        );
      gaps.push({
        what: 'pin stub',
        at: `${a.x},${a.y}`,
        gap: dist - wireHalf - half,
        adjacent: adjacent(a) || adjacent(b),
      });
    }
    return { wirePoints, markers: marks.length, stubs: stubs.length, gaps };
  }, wireId);
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
  // Geometry: straight out of the GND pin to the right (perpendicular to the J3 row, away from
  // the board), over the top of the board and down three grid steps clear of the J2 row.
  // Never along the J3 column (x = 140), whose 18 pins the first route crossed.
  expect(route).toEqual([
    { x: 140, y: -180 },
    { x: 200, y: -180 },
    { x: 200, y: -240 },
    { x: -80, y: -240 },
    { x: -80, y: 220 },
    { x: -20, y: 220 },
  ]);

  // RENDERED geometry (what the owner sees): the drawn wire against every drawn pin marker and
  // pin stub of the board, in world units, with their real stroke widths.
  const drawn = await renderedClearance(page, w.id);
  expect(drawn.wirePoints).toBe('140,-180 200,-180 200,-240 -80,-240 -80,220 -20,220');
  expect(drawn.markers).toBeGreaterThan(20);
  expect(drawn.stubs).toBe(38);
  for (const g of drawn.gaps)
    expect(g.gap, `${g.what} at ${g.at}`).toBeGreaterThanOrEqual(g.adjacent ? 12 : 50);
  if (process.env.TBI_SHOTS)
    await page
      .getByTestId('canvas')
      .screenshot({ path: `${process.env.TBI_SHOTS}/esp32-gnd-route-before-save.png` });
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

test('an old project whose GND wire runs down the J3 header opens with that wire re-routed clear of the pins', async ({
  page,
}) => {
  await openExample(page, 'esp32-blink');
  await waitSaved(page);
  const base = await storedProject(page);
  // The stored geometry an older version could save: GND straight down the J3 column. Built with
  // the domain's own edits, so the netlist is valid; only the wire's stored vertex is old.
  const g = addComponent(base, 'component.ground', { x: -20, y: 240 });
  if (!g.ok) throw new Error('ground');
  const added = addWire(
    g.doc,
    { kind: 'terminal', component: 'U1', terminal: 'gnd' },
    { kind: 'terminal', component: g.id, terminal: 'ref' },
    [{ x: 140, y: 220 }],
  );
  if (!added.ok) throw new Error('wire');
  const doc = structuredClone(added.doc);
  const legacyWire = added.id;
  doc.projectId = 'prj_legacyroute';
  doc.name = 'Legacy route';
  await openImported(page, doc);
  // Opening shows the repaired route at once (no wire across the header in the drawing) but, by
  // the owner's Sprint 20 decision, stores nothing until a genuine edit: the stored route is
  // still the legacy one.
  await expect(page.getByTestId('notice')).toHaveAttribute('data-key', 'open.routesAdjusted');
  await waitSaved(page);
  const imported = (await storedProjects(page)).find((x) => x.name === 'Legacy route')!;
  expect(imported.layout.wires.find((x) => x.id === legacyWire)!.vertices).toEqual([
    { x: 140, y: 220 },
  ]);
  // A genuine edit (renaming the project) stores the document with the repaired route.
  const name = page.getByTestId('project-name');
  await name.fill('Legacy route (edited)');
  await name.press('Enter');
  await expect
    .poll(async () => {
      const p = (await storedProjects(page)).find((x) => x.name.startsWith('Legacy route'));
      const r =
        p &&
        wireRoute(
          p,
          p.layout.wires.find((x) => x.id === legacyWire)!,
        );
      return r ? pinsEntered(p!, r).length : -1;
    })
    .toBe(0);
  const opened = (await storedProjects(page)).find((x) => x.name.startsWith('Legacy route'));
  const w = opened!.layout.wires.find((x) => x.id === legacyWire)!;
  const route = wireRoute(opened!, w)!;
  expect(pinsEntered(opened!, route)).toEqual([]);
  expect(route[1]!.y).toBe(-180); // leaves the pin outward first (horizontally, to the right)
  expect(route[1]!.x).toBeGreaterThan(140);
  const drawn = await renderedClearance(page, legacyWire);
  for (const g of drawn.gaps)
    expect(g.gap, `${g.what} at ${g.at}`).toBeGreaterThanOrEqual(g.adjacent ? 12 : 50);
  // Presentation only: the same nets as stored.
  expect(netOf(opened!, g.id, 'ref')).toBe(netOf(opened!, 'U1', 'gnd'));
  await expect(page.locator('[data-code="wire_over_terminal"]')).toHaveCount(0);
});
