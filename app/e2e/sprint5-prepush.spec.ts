/**
 * Sprint 5 pre-push fixes, in Chromium: wire/component layering, wire segment dragging and
 * datasheet over-stress warnings. Durability is proven on the real IndexedDB.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  addComponent,
  addWire,
  createProject as createProjectDoc,
  createSnapshot,
  rotateComponents,
  wireRoute,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { EngineSession, ratingWarnings, type SolveSuccess } from '@tbi-lab/engine';
import { getLocale } from '../src/i18n/i18n.js';
import { formatPower, formatResult } from '../src/sim/format.js';

const en = getLocale('en');
const plain = (s: string) => s.replace(/[\u200e\u200f\u2066-\u2069]/g, '');
import { link, run, setValue } from './circuits.js';
import {
  component,
  createProject,
  openImported,
  place,
  storedProject,
  terminal,
  toScreen,
  waitForStoredProject,
} from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

/** The data-hit element topmost at a world point (what the user sees and clicks). */
function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`fixture edit failed: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

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
  // R1 upright at (60,-20): its body spans y -60..20 on x = 60; terminals at (60,-60) and (60,20).
  // PSU+ (-80,-20) -> R2.a (100,-20): a stored straight wire straight across R1's body (e.g.
  // drawn before new wires were auto-routed around bodies, or dragged there).
  let fixture = createProjectDoc({
    projectId: 'prj_layers01',
    deviceId: 'e2e',
    name: 'Layers',
    appVersion: '0.1.0',
  });
  fixture = must(addComponent(fixture, 'component.resistor', { x: 60, y: -20 })).doc;
  fixture = must(rotateComponents(fixture, ['R1'])).doc;
  fixture = must(addComponent(fixture, 'component.resistor', { x: 140, y: -20 })).doc;
  fixture = must(
    addWire(
      fixture,
      { kind: 'terminal', component: 'PSU1', terminal: 'positive' },
      { kind: 'terminal', component: 'R2', terminal: 'a' },
    ),
  ).doc;
  await openImported(page, fixture);
  await page.getByRole('button', { name: 'Zoom out' }).click();
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
  const r = truth(doc).components.D1!;
  const current = formatResult(en, r.current!, 'ampere');
  const power = formatPower(en, Math.abs(r.current! * r.voltage!));
  const banner = page.getByTestId('rating-warning');
  await expect(banner).toBeVisible();
  // One glance: title, which part, what exceeded, actual vs maximum, and a short footer.
  expect(
    plain(await banner.innerText())
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  ).toEqual([
    'Component rating exceeded',
    'D1 may be damaged',
    `Current: ${current} (maximum 30 mA)`,
    `Power: ${power} (maximum 100 mW)`,
    'The simulation continues to show the calculated values and does not model physical damage.',
  ]);
  await expect(banner.getByTestId('rating-D1')).toHaveAttribute(
    'data-model',
    'model.led.vishay_tlhr5400',
  );
  await expect(banner).not.toContainText(/error/i); // a warning, never called an error
  await expect(page.getByTestId('sim-error')).toHaveCount(0);
  await expect(component(page, 'D1')).toHaveAttribute('data-overstressed', 'true');
  // The warning never alters the solved values shown.
  await component(page, 'D1').locator('.component-hit').click();
  await expect(page.getByTestId('result-current')).toHaveText(current);
  const inspector = page.getByTestId('result-rating');
  await expect(inspector).toHaveCount(1); // one compact group, no repeated prose
  await expect(inspector.locator('li')).toHaveCount(2);
  await expect(inspector).not.toContainText('does not model');
  // Hebrew: the same facts, localized; values and identifiers stay LTR.
  await page.getByTestId('language-select').selectOption('he');
  const he = plain(await banner.innerText())
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  expect(he).toEqual([
    'חריגה מדירוגי הרכיב',
    'D1 עלול להינזק',
    `זרם: ${current} (מקסימום 30 mA)`,
    `הספק: ${power} (מקסימום 100 mW)`,
    'הסימולציה ממשיכה להציג את הערכים המחושבים ואינה מדמה נזק לרכיב.',
  ]);
  await expect(banner).not.toContainText('שגיאה');
  // Nothing about the warning is stored in the project.
  expect(JSON.stringify(await storedProject(page))).not.toMatch(/rating|overstress|warning/i);
});

// ------------------------------------------------------------------------------------------
// Wire bridges at unconnected crossings (visual only).

/**
 * PSU+ (5 V) -> W1 straight along y = -20 to R3 (200,-20) -> GND2; and a 1 kΩ + 1 kΩ divider
 * PSU+ -> R1 (0,-100) ... R2 (0,100) -> GND, whose middle wire runs vertically along x = 40,
 * straight across W1 at (40,-20). Unconnected, the divider middle is 2.5 V; if the crossing
 * were ever a connection it would be 5 V.
 */
async function crossingBench(page: Page, name: string) {
  await createProject(page, name);
  for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Zoom out' }).click();
  await place(page, 'component.resistor', { x: 0, y: -100 });
  await place(page, 'component.resistor', { x: 0, y: 100 });
  await place(page, 'component.resistor', { x: 200, y: -20 });
  await place(page, 'component.ground', { x: 240, y: 40 });
  await link(page, ['PSU1', 'positive'], ['R3', 'a']); // W1
  await link(page, ['R3', 'b'], ['GND2', 'ref']);
  await link(page, ['PSU1', 'negative'], ['GND1', 'ref']);
  await link(page, ['PSU1', 'positive'], ['R1', 'a']);
  await link(page, ['R2', 'a'], ['GND1', 'ref']);
  await component(page, 'PSU1').locator('.component-hit').click();
  await page.getByTestId('param-PSU1-outputEnabled').check();
}

const bridges = (page: Page) => page.getByTestId('wire-bridge');
/** The electrical result only (revision bookkeeping legitimately advances with every edit). */
const electrical = (o: SolveSuccess) => ({
  components: o.components,
  netVoltages: o.netVoltages,
  notConnected: o.notConnected,
});
const netOf = (d: ProjectDocument, c: string, t: string) =>
  d.connections.find((x) => x.component === c && x.terminal === t)?.net;

test('bridges: an unconnected crossing hops; the same geometry with a junction does not', async ({
  page,
}) => {
  await crossingBench(page, 'Crossing');
  await link(page, ['R1', 'b'], ['R2', 'b']); // vertical x = 40, across W1
  const crossed = await waitForStoredProject(
    page,
    (d) => d.layout.wires.length === 6 && d.components[0]!.params.outputEnabled === true,
    'crossing circuit stored',
    'Crossing',
  );
  // 1. A bridge at (40,-20) on the vertical wire; the nets stay separate.
  await expect(bridges(page)).toHaveCount(1);
  await expect(bridges(page)).toHaveAttribute('data-x', '40');
  await expect(bridges(page)).toHaveAttribute('data-y', '-20');
  const vertical = crossed.layout.wires.find(
    (w) => w.from.kind === 'terminal' && w.from.component === 'R1' && w.from.terminal === 'b',
  )!;
  await expect(bridges(page)).toHaveAttribute('data-over', vertical.id);
  // Its drawn path really hops (an arc), while its hit line stays straight.
  expect(
    await page.locator(`[data-hit="wire"][data-id="${vertical.id}"] path.wire`).getAttribute('d'),
  ).toMatch(/ A[\d.]+ [\d.]+ 0 0 [01] /);
  await expect(page.locator('.junctions .junction-dot')).toHaveCount(0); // no explicit junction
  expect(netOf(crossed, 'R1', 'b')).toBe(netOf(crossed, 'R2', 'b'));
  expect(netOf(crossed, 'R1', 'b')).not.toBe(netOf(crossed, 'PSU1', 'positive'));
  // 5. The solver sees no connection: the divider middle is 2.5 V, not 5 V.
  await run(page);
  await component(page, 'R1').locator('.component-hit').click();
  await expect(page.getByTestId('result-terminal-b')).toHaveText(
    formatResult(en, truth(crossed).components.R1!.terminals.b!, 'volt'),
  );
  expect(truth(crossed).components.R1!.terminals.b).toBeCloseTo(2.5, 12);
  await page.getByTestId('sim-stop').click();

  // 2. Same geometry, but connected through an explicit junction: no bridge, a dot, one net.
  await crossingBench(page, 'Joined');
  await terminal(page, 'R1', 'b').locator('.terminal-hit').click();
  const onW1 = await toScreen(page, { x: 40, y: -20 });
  await page.mouse.click(onW1.x, onW1.y); // ends on W1: splits it with a junction
  await terminal(page, 'R2', 'b').locator('.terminal-hit').click();
  await page.mouse.click(onW1.x, onW1.y); // ends on that junction
  const joined = await waitForStoredProject(
    page,
    (d) => d.layout.junctions.length === 1 && d.layout.wires.length === 8,
    'joined circuit stored',
    'Joined',
  );
  expect(joined.layout.junctions[0]).toMatchObject({ x: 40, y: -20 });
  await expect(bridges(page)).toHaveCount(0);
  await expect(page.locator('.junctions .junction-dot')).toHaveCount(1);
  const net = netOf(joined, 'PSU1', 'positive');
  expect(netOf(joined, 'R1', 'b')).toBe(net);
  expect(netOf(joined, 'R2', 'b')).toBe(net);
  expect(truth(joined).components.R1!.terminals.b).toBeCloseTo(5, 12);
});

test('bridges: follow a dragged wire, vanish when the crossing is dragged away or deleted, never change the solve', async ({
  page,
}) => {
  await crossingBench(page, 'Moving');
  await link(page, ['R1', 'b'], ['R2', 'b']);
  const before = await waitForStoredProject(
    page,
    (d) => d.layout.wires.length === 6,
    'crossing circuit stored',
  );
  const vertical = before.layout.wires.find(
    (w) => w.from.kind === 'terminal' && w.from.component === 'R1',
  )!;
  const solved = truth(before);
  // 3. Drag the vertical run 60 to the right: the bridge moves with it.
  const a = await toScreen(page, { x: 40, y: 40 });
  await page.mouse.click(a.x, a.y); // select the vertical wire (away from the crossing)
  const b = await toScreen(page, { x: 100, y: 40 });
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  const moved = await waitForStoredProject(
    page,
    (d) => d.layout.wires.find((w) => w.id === vertical.id)!.vertices.length > 0,
    'vertical run moved',
  );
  await expect(bridges(page)).toHaveCount(1);
  await expect(bridges(page)).toHaveAttribute('data-x', '100');
  expect(moved.connections).toEqual(before.connections);
  expect(moved.nets).toEqual(before.nets);
  // 5. Same topology, same solve: moving the bridge changes no solved value.
  expect(electrical(truth(moved))).toEqual(electrical(solved));
  // Undo / redo carry the bridge back and forth.
  await page.getByTestId('undo').click();
  await expect(bridges(page)).toHaveAttribute('data-x', '40');
  await page.getByTestId('redo').click();
  await expect(bridges(page)).toHaveAttribute('data-x', '100');
  // 4a. Re-route W1 below everything: the crossing, and its bridge, are gone.
  const w1 = await toScreen(page, { x: 130, y: -20 });
  await page.mouse.click(w1.x, w1.y);
  const w1to = await toScreen(page, { x: 130, y: -160 });
  await page.mouse.move(w1.x, w1.y);
  await page.mouse.down();
  await page.mouse.move(w1to.x, w1to.y, { steps: 6 });
  await page.mouse.up();
  await expect(bridges(page)).toHaveCount(0);
  const rerouted = await waitForStoredProject(
    page,
    (d) =>
      JSON.stringify(d.layout.wires) !== JSON.stringify(moved.layout.wires) &&
      d.revision.localRevision > moved.revision.localRevision + 2,
    'W1 rerouted',
  );
  expect(rerouted.connections).toEqual(before.connections);
  expect(electrical(truth(rerouted))).toEqual(electrical(solved));
  // 4b. Undo the reroute (bridge back), then delete the vertical wire: the bridge goes.
  await page.getByTestId('undo').click();
  await expect(bridges(page)).toHaveCount(1);
  const v = await toScreen(page, { x: 100, y: 40 });
  await page.mouse.click(v.x, v.y);
  await page.keyboard.press('Delete');
  await expect(bridges(page)).toHaveCount(0);
});
