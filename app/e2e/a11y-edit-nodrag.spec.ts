/**
 * BETA-G3 (WCAG 2.1.1, 2.5.7): the drawing can be edited without dragging, by single clicks and by
 * the keyboard alone, EN and HE:
 * - a part or junction moves one grid step with the Inspector's Move buttons (one undo step, same
 *   rules as the arrow keys), with the result or the refusal announced;
 * - an existing junction is selected in the Junctions list, moved and deleted;
 * - one segment of a wire is moved from the Inspector, with the same result as dragging it.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  addComponent,
  addWire,
  createProject,
  terminalPosition,
  wireRoute,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { clickWorld, component, openImported, toScreen, waitForStoredProject } from './helpers.js';

const TEXT = {
  en: {
    moveName: /^Move .?R1.? right$/,
    moved: /R1.? moved right/,
    refused: /R1.? was not moved/,
    segmentName: 'Move segment',
    segmentMoved: /^Segment moved (up|down|left|right)\. Now segment \d+ of \d+\./,
    junctionItem: /^.?J1.?: wires .?W2.?, .?W3.?, .?W4.?$/,
    junctionSelected: /Junction .?J1.? selected/,
    junctionMoved: /J1.? moved up/,
    junctionRemoved: /Junction .?J1.? and its wires removed/,
  },
  he: {
    moveName: /^הזזת .?R1.? ימינה$/,
    moved: /R1.? הוזז ימינה/,
    refused: /R1.? לא הוזז/,
    segmentName: 'הזזת המקטע',
    segmentMoved: /^המקטע הוזז .+\. כעת מקטע \d+ מתוך \d+\./,
    junctionItem: /צומת .?J1.?: חוטים .?2.?, .?3.?, .?4.?$/,
    junctionSelected: /צומת .?J1.? נבחר/,
    junctionMoved: /J1.? הוזז למעלה/,
    junctionRemoved: /צומת .?J1.? והחוטים שלו הוסרו/,
  },
} as const;
type Lang = keyof typeof TEXT;
type Mode = 'clicks' | 'keyboard';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

/** PSU1, GND1 (from a new project), R1 and R2 with room between them for a few steps only. */
function partsDoc(name: string): ProjectDocument {
  const base = createProject({
    projectId: 'prj_g3nodrag',
    deviceId: 'device-test',
    name,
    appVersion: '0.1.0',
    clock: { now: () => new Date('2026-11-27T00:00:00.000Z') },
  });
  const r1 = must(addComponent(base, 'component.resistor', { x: 0, y: -160 }));
  return must(addComponent(r1.doc, 'component.resistor', { x: 140, y: -160 })).doc;
}

/** The parts, plus two wires and a third one ending on the second: junction J1. */
function junctionDoc(name: string): ProjectDocument {
  const pin = (c: string, t: string) => ({ kind: 'terminal', component: c, terminal: t }) as const;
  const a = must(addWire(partsDoc(name), pin('PSU1', 'positive'), pin('R1', 'a'), []));
  const b = must(addWire(a.doc, pin('PSU1', 'negative'), pin('GND1', 'ref'), []));
  const target = b.doc.layout.wires[1]!;
  const route = wireRoute(b.doc, target)!;
  const [p, q] = [route[0]!, route[1]!];
  const at = { x: Math.round((p.x + q.x) / 40) * 20, y: Math.round((p.y + q.y) / 40) * 20 };
  const c = must(addWire(b.doc, pin('R2', 'a'), { kind: 'wire', wire: target.id, at }, []));
  expect(c.doc.layout.junctions.map((j) => j.id)).toEqual(['J1']);
  return c.doc;
}

/** PSU1+ to R1.a as a manual wire with three segments (right, up, right). */
function wireDoc(name: string): ProjectDocument {
  const base = partsDoc(name);
  const pin = (c: string, t: string) => ({ kind: 'terminal', component: c, terminal: t }) as const;
  const from = terminalPosition(base, 'PSU1', 'positive')!;
  const to = terminalPosition(base, 'R1', 'a')!;
  return must(
    addWire(base, pin('PSU1', 'positive'), pin('R1', 'a'), [
      { x: -60, y: from.y },
      { x: -60, y: to.y },
    ]),
  ).doc;
}

/** Two wires with no stored bends and no automatic routing. */
function straightWiresDoc(name: string): ProjectDocument {
  const pin = (c: string, t: string) => ({ kind: 'terminal', component: c, terminal: t }) as const;
  const a = must(addWire(partsDoc(name), pin('PSU1', 'positive'), pin('R1', 'a'), []));
  const b = must(addWire(a.doc, pin('PSU1', 'negative'), pin('GND1', 'ref'), []));
  for (const w of b.doc.layout.wires) {
    w.vertices = [];
    delete w.auto;
  }
  return b.doc;
}

/** Adds a wire to the selection: Shift+click in the middle of its longest drawn segment. */
async function shiftClickWire(page: Page, doc: ProjectDocument, index: number): Promise<void> {
  const route = wireRoute(doc, doc.layout.wires[index]!)!;
  const [p, q] = route
    .slice(1)
    .map((b, i) => [route[i]!, b] as const)
    .sort(
      ([a, b], [c, d]) => Math.hypot(d.x - c.x, d.y - c.y) - Math.hypot(b.x - a.x, b.y - a.y),
    )[0]!;
  await clickWorld(page, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, ['Shift']);
}

async function open(page: Page, lang: Lang, doc: ProjectDocument): Promise<ProjectDocument> {
  await page.addInitScript((l) => localStorage.setItem('tbi-lab.locale', l), lang);
  await openImported(page, doc);
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
  return waitForStoredProject(page, (d) => d.components.length === doc.components.length, 'open');
}

/** Every drawn wire's route as shown (hit polyline points), by wire id. */
const drawing = (page: Page): Promise<Record<string, string>> =>
  page
    .locator('[data-hit="wire"]')
    .evaluateAll((els) =>
      Object.fromEntries(
        els.map((g) => [
          g.getAttribute('data-id')!,
          g.querySelector('polyline.wire-hit')!.getAttribute('points')!,
        ]),
      ),
    );

/** Choose a segment: with the mouse, or with the arrow keys on the focused list. */
async function choose(page: Page, mode: Mode, index: number): Promise<void> {
  const select = page.getByTestId('segment-select');
  if (mode === 'clicks') await select.selectOption(String(index));
  else {
    await select.focus();
    // After the route changed nothing is chosen: the first arrow key picks the first segment.
    if ((await select.inputValue()) === '') await page.keyboard.press('ArrowDown');
    for (let k = Number(await select.inputValue()); k !== index; k += Math.sign(index - k))
      await page.keyboard.press(index > k ? 'ArrowDown' : 'ArrowUp');
  }
  await expect(select).toHaveValue(String(index));
}

/** A single click, or Enter on the focused control: never a drag. */
async function activate(page: Page, mode: Mode, target: Locator): Promise<void> {
  if (mode === 'clicks') return target.click();
  await target.focus();
  await page.keyboard.press('Enter');
}

async function undo(page: Page, mode: Mode): Promise<void> {
  if (mode === 'clicks') await page.getByTestId('undo').click();
  else await page.keyboard.press('Control+z');
}

for (const lang of ['en', 'he'] as const) {
  for (const mode of ['clicks', 'keyboard'] as const) {
    test(`move a part (${lang}, ${mode}): one grid step, nets unchanged, one undo`, async ({
      page,
    }) => {
      // R1 is wired, so "nets unchanged" is about a real net.
      const before = await open(page, lang, wireDoc(`nodrag-part-${lang}-${mode}`));
      expect(before.connections.length).toBeGreaterThan(0);
      const x0 = before.layout.components.R1!.x;
      await expect(page.locator('[data-hit="wire"]')).toHaveCount(1);
      const drawn = await drawing(page);
      if (mode === 'clicks') await component(page, 'R1').locator('.component-hit').click();
      else await component(page, 'R1').focus();

      const button = page.getByTestId('move-right');
      await expect(button).toHaveAccessibleName(TEXT[lang].moveName);
      const box = (await button.boundingBox())!;
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
      // Physical directions: "left" is drawn left of "right" in RTL too.
      expect((await page.getByTestId('move-left').boundingBox())!.x).toBeLessThan(box.x);

      await activate(page, mode, button);
      const moved = await waitForStoredProject(
        page,
        (d) => d.layout.components.R1!.x === x0 + 20,
        'R1 one grid step right',
      );
      expect(moved.connections).toEqual(before.connections);
      await expect(button).toBeFocused();
      await expect(page.getByTestId('inspector-status')).toContainText(TEXT[lang].moved);

      await undo(page, mode);
      const undone = await waitForStoredProject(
        page,
        (d) => d.layout.components.R1!.x === x0,
        'one undo restores',
      );
      expect(undone.connections).toEqual(before.connections);
      expect(undone.layout.components).toEqual(before.layout.components);
      await expect.poll(() => drawing(page)).toEqual(drawn);

      // Towards R2 the same rule as the arrow keys refuses the overlap, and it is said.
      const status = page.getByTestId('inspector-status');
      for (let i = 0; i < 8; i++) {
        await activate(page, mode, button);
        await expect(status).toContainText(/R1/);
        if (TEXT[lang].refused.test((await status.textContent()) ?? '')) break;
      }
      await expect(status).toContainText(TEXT[lang].refused);
      await expect(button).toBeFocused();
    });
  }
}

for (const lang of ['en', 'he'] as const) {
  for (const mode of ['clicks', 'keyboard'] as const) {
    test(`junction (${lang}, ${mode}): select in the list, move, delete, one undo each`, async ({
      page,
    }) => {
      const before = await open(page, lang, junctionDoc(`nodrag-junction-${lang}-${mode}`));
      const y0 = before.layout.junctions[0]!.y;
      // The routes as drawn at open (the stored file may predate the open-time route repair).
      await expect(page.locator('[data-hit="wire"]')).toHaveCount(4);
      const drawn = await drawing(page);
      const list = page.getByTestId('junctions-list');
      const item = list.getByRole('button');
      await expect(item).toHaveCount(1);
      await expect(item).toHaveText(TEXT[lang].junctionItem);
      await expect(item).toHaveClass('junctions-list-item');
      expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(24);
      if (mode === 'keyboard') {
        // Reached by Tab from the last wire of the Wires list.
        await page.locator('.wires-list-item').last().focus();
        await page.keyboard.press('Tab');
        await expect(item).toBeFocused();
        await page.keyboard.press('Enter');
      } else await item.click();
      await expect(item).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('junctions-list-status')).toContainText(
        TEXT[lang].junctionSelected,
      );
      await expect(page.locator('.junction.selected .junction-selected-ring')).toBeInViewport();

      const up = page.getByTestId('move-up');
      await activate(page, mode, up);
      const moved = await waitForStoredProject(
        page,
        (d) => d.layout.junctions[0]!.y === y0 - 20,
        'J1 one grid step up',
      );
      expect(moved.connections).toEqual(before.connections);
      await expect(up).toBeFocused();
      await expect(page.getByTestId('inspector-status')).toContainText(TEXT[lang].junctionMoved);
      await undo(page, mode);
      const undone = await waitForStoredProject(
        page,
        (d) => d.layout.junctions[0]!.y === y0,
        'one undo restores the junction',
      );
      expect(undone.connections).toEqual(before.connections);
      await expect.poll(() => drawing(page)).toEqual(drawn);

      await activate(page, mode, item);
      await activate(page, mode, page.getByTestId('inspector-delete'));
      await waitForStoredProject(page, (d) => d.layout.junctions.length === 0, 'J1 removed');
      await expect(list).toHaveCount(0);
      await expect(page.getByTestId('inspector-status')).toContainText(TEXT[lang].junctionRemoved);
      await expect(page.locator('#inspector-heading')).toBeFocused();
      await undo(page, mode);
      const restored = await waitForStoredProject(
        page,
        (d) => d.layout.junctions.length === 1,
        'one undo restores the junction and its wires',
      );
      expect(restored.connections).toEqual(before.connections);
      await expect.poll(() => drawing(page)).toEqual(drawn);
    });
  }
}

for (const lang of ['en', 'he'] as const) {
  for (const mode of ['clicks', 'keyboard'] as const) {
    test(`wire segment (${lang}, ${mode}): moved as by a drag, nets unchanged, one undo`, async ({
      page,
    }) => {
      const before = await open(page, lang, wireDoc(`nodrag-wire-${lang}-${mode}`));
      await expect(page.locator('[data-hit="wire"]')).toHaveCount(1);
      const drawn = await drawing(page);
      const route = wireRoute(before, before.layout.wires[0]!)!;
      const m = route.length - 1;
      expect(m).toBeGreaterThanOrEqual(3);
      // The first vertical segment.
      const i = route.findIndex((p, k) => k < m && p.x === route[k + 1]!.x);
      const mid = { x: route[i]!.x, y: (route[i]!.y + route[i + 1]!.y) / 2 };
      const select = async () => {
        await activate(page, mode, page.locator('.wires-list-item'));
        await choose(page, mode, i);
      };

      // The reference result: the same segment dragged one grid step left with the mouse.
      await page.locator('.wires-list-item').click();
      const start = await toScreen(page, mid);
      const end = await toScreen(page, { x: mid.x - 20, y: mid.y });
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await page.mouse.up();
      const dragged = await waitForStoredProject(
        page,
        (d) => d.layout.wires[0]!.vertices.some((v) => v.x === mid.x - 20),
        'dragged',
      );
      await page.getByTestId('undo').click();
      await expect.poll(() => drawing(page)).toEqual(drawn);
      await page.keyboard.press('Escape');

      await select();
      await expect(page.getByTestId('segment-highlight')).toHaveAttribute('data-segment', `${i}`);
      await expect(page.getByTestId('segment-highlight')).toHaveCSS('pointer-events', 'none');
      await expect(page.getByTestId('segment-move-up')).toHaveCount(0);
      const left = page.getByTestId('segment-move-left');
      await expect(left).toHaveAccessibleName(new RegExp(`^${TEXT[lang].segmentName}`));
      const box = (await left.boundingBox())!;
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
      expect(box.x).toBeLessThan((await page.getByTestId('segment-move-right').boundingBox())!.x);
      await activate(page, mode, left);
      const moved = await waitForStoredProject(
        page,
        (d) => d.layout.wires[0]!.vertices.some((v) => v.x === mid.x - 20),
        'moved by the button',
      );
      expect(moved.layout.wires[0]!.vertices).toEqual(dragged.layout.wires[0]!.vertices);
      expect(moved.layout.wires[0]!.auto).toBeUndefined();
      expect(moved.connections).toEqual(before.connections);
      await expect(left).toBeFocused();
      await expect(page.getByTestId('inspector-status')).toContainText(TEXT[lang].segmentMoved);
      await undo(page, mode);
      await expect.poll(() => drawing(page)).toEqual(drawn);

      // The first segment gains a jog at its fixed end: the choice follows the moved segment.
      await choose(page, mode, 0);
      const up = page.getByTestId('segment-move-up');
      await activate(page, mode, up);
      await expect(page.getByTestId('segment-select')).toHaveValue('1');
      await expect(page.getByTestId('segment-highlight')).toHaveAttribute('data-segment', '1');
      await expect(up).toBeFocused();

      await page.screenshot({ path: `/var/tmp/g3nodrag/wide-${lang}-${mode}.png` });
      // At 320 CSS px wide the controls stay inside the page.
      await page.setViewportSize({ width: 320, height: 640 });
      await up.scrollIntoViewIfNeeded();
      // The app shell itself scrolls sideways this narrow (see a11y-028c): the group must fit it.
      const panel = (await page.getByTestId('segment-group').boundingBox())!;
      expect(panel.width).toBeLessThanOrEqual(320);
      await page.screenshot({ path: `/var/tmp/g3nodrag/narrow-${lang}-${mode}.png` });
      for (const id of ['segment-select', 'segment-move-up', 'segment-move-down']) {
        const b = (await page.getByTestId(id).boundingBox())!;
        const group = (await page.getByTestId('segment-group').boundingBox())!;
        expect(b.x + b.width).toBeLessThanOrEqual(group.x + group.width + 1);
      }
    });
  }
}

for (const [width, height] of [
  [640, 360],
  [1280, 400],
  [1400, 860],
] as const) {
  test(`Properties is not squeezed by the lists at ${width}x${height}`, async ({ page }) => {
    await open(page, 'en', junctionDoc(`nodrag-short-${width}`));
    await page.setViewportSize({ width, height });
    await page.locator('.connections > summary').click();
    await page.locator('.junctions-list-item').click();
    // A floor of about 10rem: the lists scroll the column instead of covering Properties.
    expect((await page.getByTestId('inspector').boundingBox())!.height).toBeGreaterThanOrEqual(149);
    for (const id of ['move-up', 'move-down', 'inspector-delete']) {
      const button = page.getByTestId(id);
      await button.focus();
      await expect(button).toBeInViewport({ ratio: 1 });
      expect(
        await button.evaluate((el) => {
          const b = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2));
        }),
        `${id} is not covered`,
      ).toBe(true);
    }
  });
}

for (const lang of ['en', 'he'] as const) {
  test(`focus and announcements after delete and undo (${lang})`, async ({ page }) => {
    await open(page, lang, junctionDoc(`nodrag-focus-${lang}`));
    const status = page.getByTestId('inspector-status');
    const heading = page.locator('#inspector-heading');

    // Undo takes the selected part away while a Move button has focus.
    await component(page, 'R2').locator('.component-hit').click();
    await page.getByTestId('move-down').click();
    await expect(status).toContainText(/R2/);
    // A new selection clears the old message.
    await component(page, 'R1').locator('.component-hit').click();
    await expect(status).toHaveText('');

    // Deleting a part with the Properties button: announced, focus on the heading.
    await page.getByTestId('inspector-delete').click();
    await expect(status).toContainText(lang === 'en' ? /R1.? removed/ : /R1.? הוסר/);
    await expect(heading).toBeFocused();
    await page.keyboard.press('Control+z');

    await page.locator('.wires-list-item').first().click();
    await page.getByTestId('inspector-delete').click();
    await expect(status).toContainText(lang === 'en' ? /Wire 1 removed/ : /חוט 1 הוסר/);
    await expect(heading).toBeFocused();

    // Delete key on a junction in the drawing.
    await page.locator('.junctions-list-item').click();
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('Delete');
    await expect(page.getByText(TEXT[lang].junctionRemoved).first()).toBeAttached();
  });

  test(`Delete key while running removes nothing and announces no removal (${lang})`, async ({
    page,
  }) => {
    await open(page, lang, junctionDoc(`nodrag-running-${lang}`));
    await page.locator('.junctions-list-item').click();
    await page.getByTestId('sim-run').click();
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('Delete');
    await expect(
      page
        .getByText(
          lang === 'en' ? /Stop the simulation to change/ : /יש לעצור את הסימולציה כדי לשנות/,
        )
        .first(),
    ).toBeVisible();
    await expect(page.locator('.junction')).toHaveCount(1);
    await expect(page.getByText(TEXT[lang].junctionRemoved)).toHaveCount(0);
  });

  test(`undo removes the selection under a Move button (${lang})`, async ({ page }) => {
    const before = await open(page, lang, partsDoc(`nodrag-undo-${lang}`));
    await page.getByTestId('palette-component.resistor').click();
    const at = await toScreen(page, { x: 60, y: -60 });
    await page.mouse.click(at.x, at.y);
    await waitForStoredProject(
      page,
      (d) => d.components.length === before.components.length + 1,
      'placed',
    );
    await page.getByTestId('move-down').focus();
    await page.keyboard.press('Control+z');
    // The first undo may be this one: the placed part is gone, and so are its buttons.
    await expect(page.getByTestId('move-group')).toHaveCount(0);
    await expect(page.locator('#inspector-heading')).toBeFocused();
  });
}

for (const lang of ['en', 'he'] as const) {
  const T = {
    en: {
      stale: 'The wire changed. Choose a segment before moving it.',
      partRemoved: /R1.? removed/,
      manyRemoved: /^2 selected items removed/,
      groupName: /^Move .?2.? selected items down$/,
      groupMoved: /2.? items moved down/,
      groupRefused: /^The selected items were not moved\. .*would overlap/,
      unchanged: /^The selected items were not moved\. The selected wires have no bends/,
      unchangedShown: /The selected wires have no bends of their own to move/,
      partial: /Some of the selected items moved down/,
      refusedWhy: /R1.? was not moved\. .*would overlap/,
    },
    he: {
      stale: 'החוט השתנה. בחרו מקטע לפני ההזזה.',
      partRemoved: /R1.? הוסר/,
      manyRemoved: /^2 פריטים שנבחרו הוסרו/,
      groupName: /^הזזת .?2.? הפריטים שנבחרו למטה$/,
      groupMoved: /2.? פריטים הוזזו למטה/,
      groupRefused: /^הפריטים שנבחרו לא הוזזו\. /,
      unchanged: /^הפריטים שנבחרו לא הוזזו\. לחוטים שנבחרו אין כיפופים/,
      unchangedShown: /לחוטים שנבחרו אין כיפופים משלהם להזזה/,
      partial: /חלק מהפריטים שנבחרו הוזזו למטה/,
      refusedWhy: /R1.? לא הוזז\. /,
    },
  }[lang];

  test(`after undo and redo no segment moves until one is chosen again (${lang})`, async ({
    page,
  }) => {
    await open(page, lang, wireDoc(`nodrag-stale-${lang}`));
    await page.locator('.wires-list-item').click();
    await choose(page, 'clicks', 0);
    const up = page.getByTestId('segment-move-up');
    await up.click();
    const select = page.getByTestId('segment-select');
    await expect(select).toHaveValue('1');
    const moved = await drawing(page);

    await up.focus();
    await page.keyboard.press('Control+z');
    await expect(select).toHaveValue('');
    await expect(page.getByTestId('segment-stale')).toHaveText(T.stale);
    await expect(page.getByTestId('segment-highlight')).toHaveCount(0);
    const buttons = page.getByTestId('segment-group').getByRole('button');
    await expect(buttons).toHaveCount(2);
    const before = await drawing(page);
    for (const button of await buttons.all()) {
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).toHaveAccessibleDescription(T.stale);
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(button).toBeFocused();
    }
    await expect(page.getByTestId('inspector-status')).toContainText(T.stale);
    expect(await drawing(page)).toEqual(before);
    // Nothing was applied: redo is still there, and brings back the route the pick was made on.
    await page.keyboard.press('Control+Shift+Z');
    await expect.poll(() => drawing(page)).toEqual(moved);
    await expect(select).toHaveValue('1');

    await page.keyboard.press('Control+z');
    await choose(page, 'keyboard', 0);
    await expect(page.getByTestId('segment-stale')).toHaveCount(0);
    await page.getByTestId('segment-move-up').click();
    await expect(select).toHaveValue('1');
  });

  test(`Rotate and Delete keep focus on a sensible element (${lang})`, async ({ page }) => {
    const before = await open(page, lang, partsDoc(`nodrag-actions-${lang}`));
    const heading = page.locator('#inspector-heading');
    for (const id of ['inspector-rotate', 'inspector-delete']) {
      await page.keyboard.press('Escape');
      await page.getByTestId('palette-component.resistor').click();
      const at = await toScreen(page, { x: 60, y: -60 });
      await page.mouse.click(at.x, at.y);
      await waitForStoredProject(
        page,
        (d) => d.components.length === before.components.length + 1,
        'placed',
      );
      const button = page.getByTestId(id);
      if (id === 'inspector-rotate') {
        await button.focus();
        await page.keyboard.press('Enter');
        await expect(button).toBeFocused();
        await page.keyboard.press('Control+z');
        await expect(button).toBeFocused();
      }
      await button.focus();
      await page.keyboard.press('Control+z');
      await expect(button).toHaveCount(0);
      await expect(heading).toBeFocused();
    }
  });

  test(`Delete key announces a part and a multi-selection (${lang})`, async ({ page }) => {
    await open(page, lang, partsDoc(`nodrag-delkey-${lang}`));
    const status = page.getByTestId('kbwire-status');
    await component(page, 'R1').locator('.component-hit').click();
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('Delete');
    await expect(status).toContainText(T.partRemoved);
    await page.keyboard.press('Control+z');
    await component(page, 'R1').locator('.component-hit').click();
    await component(page, 'R2')
      .locator('.component-hit')
      .click({ modifiers: ['Shift'] });
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('Backspace');
    await expect(status).toContainText(T.manyRemoved);
    await expect(component(page, 'R2')).toHaveCount(0);
  });

  test(`a group moves with the Move buttons, one undo per press (${lang})`, async ({ page }) => {
    const before = await open(page, lang, partsDoc(`nodrag-group-${lang}`));
    await component(page, 'R1').locator('.component-hit').click();
    await component(page, 'R2')
      .locator('.component-hit')
      .click({ modifiers: ['Shift'] });
    const down = page.getByTestId('move-down');
    await expect(down).toHaveAccessibleName(T.groupName);
    const y = before.layout.components.R1!.y;
    const at = (d: ProjectDocument) => [d.layout.components.R1!.y, d.layout.components.R2!.y];
    await activate(page, 'keyboard', down);
    await waitForStoredProject(page, (d) => at(d).every((v) => v === y + 20), 'one step');
    await activate(page, 'keyboard', down);
    await waitForStoredProject(page, (d) => at(d).every((v) => v === y + 40), 'two steps');
    await expect(down).toBeFocused();
    await expect(page.getByTestId('inspector-status')).toContainText(T.groupMoved);
    await page.keyboard.press('Control+z');
    await waitForStoredProject(page, (d) => at(d).every((v) => v === y + 20), 'one undo');
    await expect(down).toBeFocused();
  });

  test(`a refused move is announced once, with the reason (${lang})`, async ({ page }) => {
    await open(page, lang, partsDoc(`nodrag-once-${lang}`));
    await component(page, 'R1').locator('.component-hit').click();
    const status = page.getByTestId('inspector-status');
    const right = page.getByTestId('move-right');
    for (let i = 0; i < 8; i++) {
      await right.click();
      await expect(status).toContainText(/R1/);
      if (T.refusedWhy.test((await status.textContent()) ?? '')) break;
    }
    await expect(status).toContainText(T.refusedWhy);
    // The banner is visible, but it is not a second live region.
    const notice = page.getByTestId('notice');
    await expect(notice).toBeVisible();
    await expect(notice).not.toHaveAttribute('role', /.*/);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test(`wires with nothing to move: shown with the reason, said once (${lang})`, async ({
    page,
  }) => {
    const opened = await open(page, lang, straightWiresDoc(`nodrag-unchanged-${lang}`));
    expect(opened.layout.wires.map((w) => [w.vertices, w.auto])).toEqual([
      [[], undefined],
      [[], undefined],
    ]);
    await page.locator('.wires-list-item').first().click();
    await shiftClickWire(page, opened, 1);
    const before = await drawing(page);
    const down = page.getByTestId('move-down');
    await expect(down).toHaveAccessibleName(T.groupName);
    await activate(page, 'keyboard', down);
    await expect(page.getByTestId('inspector-status')).toHaveText(T.unchanged);
    const notice = page.getByTestId('notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(T.unchangedShown);
    // Visible only: the Properties status is the one announcement.
    await expect(notice).not.toHaveAttribute('role', /.*/);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await drawing(page)).toEqual(before);
    await expect(down).toBeFocused();
  });

  test(`a partly moved selection reports no selected count (${lang})`, async ({ page }) => {
    const opened = await open(page, lang, straightWiresDoc(`nodrag-partial-${lang}`));
    // R2 and the wire from PSU1 to GND1, which is not attached to it.
    await component(page, 'R2').locator('.component-hit').click();
    await shiftClickWire(page, opened, 1);
    await expect(page.getByTestId('move-down')).toHaveAccessibleName(T.groupName);
    await activate(page, 'keyboard', page.getByTestId('move-down'));
    const y = opened.layout.components.R2!.y;
    await waitForStoredProject(page, (d) => d.layout.components.R2!.y === y + 20, 'R2 moved');
    await expect(page.getByTestId('inspector-status')).toHaveText(T.partial);
  });
}
