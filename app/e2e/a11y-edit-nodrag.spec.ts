/**
 * BETA-G3 (WCAG 2.1.1, 2.5.7): the drawing can be edited without dragging, by single clicks and by
 * the keyboard alone, EN and HE:
 * - a part or junction moves one grid step with the Inspector's Move buttons (one undo step, same
 *   rules as the arrow keys), with the result or the refusal announced.
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
import { component, openImported, toScreen, waitForStoredProject } from './helpers.js';

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

const geometry = (d: ProjectDocument) =>
  JSON.stringify([d.layout.components, d.layout.junctions, d.layout.wires, d.connections]);

for (const lang of ['en', 'he'] as const) {
  for (const mode of ['clicks', 'keyboard'] as const) {
    test(`move a part (${lang}, ${mode}): one grid step, nets unchanged, one undo`, async ({
      page,
    }) => {
      const before = await open(page, lang, partsDoc(`nodrag-part-${lang}-${mode}`));
      const x0 = before.layout.components.R1!.x;
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
      expect(geometry(undone)).toBe(geometry(before));

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
