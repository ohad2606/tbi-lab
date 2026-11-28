/**
 * BETA-G3 (WCAG 2.1.1): several items are selected without a mouse, EN and HE: Shift+Enter on
 * focused parts, then the group is moved and deleted; Ctrl+A and Escape; the "Select several
 * items" button also gives single clicks (no Shift, no drag).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  addComponent,
  addWire,
  createProject,
  SCHEMA_VERSION,
  type ProjectDocument,
} from '@tbi-lab/domain';
import {
  component,
  openAppMenu,
  openImported,
  reopenFromLibrary,
  terminal,
  waitForStoredProject,
} from './helpers.js';

const TEXT = {
  en: {
    tool: 'Select several items',
    on: /^Selecting several items is on\. 1 item selected/,
    two: /^2 items selected/,
    one: /^1 item selected/,
    moved: /2 items moved right/,
    removed: /2 selected items removed/,
    cleared: /^Selection cleared/,
    off: /^Selecting several items is off/,
    help: 'Select all parts, wires and junctions',
    isSelected: /, selected$/,
    notSelected: /, not selected$/,
    switchOpen: /, open, selected$/,
    switchClosed: /, closed, selected$/,
    offThen: /^Selecting several items is off\. Wire /,
  },
  he: {
    tool: 'בחירה של כמה פריטים',
    on: /^בחירה של כמה פריטים פעילה\. נבחר פריט אחד/,
    two: /^2 פריטים נבחרו/,
    one: /^נבחר פריט אחד/,
    moved: /2 פריטים הוזזו ימינה/,
    removed: /2 פריטים שנבחרו הוסרו/,
    cleared: /^הבחירה נוקתה/,
    off: /^בחירה של כמה פריטים כבויה/,
    help: 'בחירת כל הרכיבים, החוטים והצמתים',
    isSelected: /, נבחר$/,
    notSelected: /, לא נבחר$/,
    switchOpen: /, פתוח, נבחר$/,
    switchClosed: /, סגור, נבחר$/,
    offThen: /^בחירה של כמה פריטים כבויה\. /,
  },
} as const;

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

function partsDoc(): ProjectDocument {
  let doc = createProject({
    projectId: 'prj_g3multi',
    deviceId: 'device-test',
    name: 'multi',
    appVersion: '0.1.0',
    clock: { now: () => new Date('2026-11-28T00:00:00.000Z') },
  });
  for (const x of [0, 140]) {
    const r = addComponent(doc, 'component.resistor', { x, y: -160 });
    if (!r.ok) throw new Error('add');
    doc = r.doc;
  }
  return doc;
}

async function open(page: Page, lang: keyof typeof TEXT): Promise<ProjectDocument> {
  await page.addInitScript((l) => localStorage.setItem('tbi-lab.locale', l), lang);
  await openImported(page, partsDoc());
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
  return waitForStoredProject(page, (d) => d.components.length === 4, 'open');
}

/** Real Tab presses until the target has focus. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('not reachable with Tab');
}

const selected = (page: Page) =>
  page
    .locator('[data-hit="component"][data-selected="true"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-id')).sort());

for (const lang of ['en', 'he'] as const) {
  const text = TEXT[lang];

  test(`keyboard only: select two parts, move and delete them (${lang})`, async ({ page }) => {
    const before = await open(page, lang);
    const status = page.getByTestId('kbwire-status');
    const [r1, r2] = [component(page, 'R1'), component(page, 'R2')];
    await expect(r1).not.toHaveAccessibleName(text.isSelected);

    await tabTo(page, r1);
    await page.keyboard.press('Shift+Enter');
    await expect(status).toHaveText(text.on);
    await expect(r1).toBeFocused();
    await expect(r1).toHaveAccessibleName(text.isSelected);
    await expect(r1).not.toHaveAttribute('aria-pressed');

    await tabTo(page, r2);
    // Moving focus keeps the selection while selecting several.
    expect(await selected(page)).toEqual(['R1']);
    await expect(r2).toHaveAccessibleName(text.notSelected);
    await page.keyboard.press('Shift+Enter');
    await expect(status).toHaveText(text.two);
    await expect(r2).toBeFocused();
    expect(await selected(page)).toEqual(['R1', 'R2']);

    // Plain Enter takes it out and puts it back.
    await page.keyboard.press('Enter');
    await expect(status).toHaveText(text.one);
    await expect(r2).toHaveAccessibleName(text.notSelected);
    await page.keyboard.press('Enter');
    await expect(status).toHaveText(text.two);

    await page.keyboard.press('ArrowRight');
    const moved = await waitForStoredProject(
      page,
      (d) => d.layout.components.R1!.x > before.layout.components.R1!.x,
      'arrow move',
    );
    expect(moved.layout.components.R2!.x).toBeGreaterThan(before.layout.components.R2!.x);
    expect(moved.layout.components.PSU1).toEqual(before.layout.components.PSU1);

    // The Properties group Move button, by keyboard.
    const right = page.getByTestId('move-right');
    await right.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByTestId('inspector').getByRole('status').filter({ hasText: text.moved }),
    ).toHaveCount(1);

    await r2.focus();
    expect(await selected(page)).toEqual(['R1', 'R2']);
    await page.keyboard.press('Delete');
    await expect(status).toHaveText(text.removed);
    await expect(page.getByTestId('canvas')).toBeFocused();
    const after = await waitForStoredProject(page, (d) => d.components.length === 2, 'delete');
    expect(after.components.map((c) => c.id).sort()).toEqual(['GND1', 'PSU1']);
  });

  test(`select all, Escape, the button and single clicks (${lang})`, async ({ page }) => {
    await open(page, lang);
    const status = page.getByTestId('kbwire-status');
    const tool = page.getByRole('button', { name: text.tool, exact: true });
    await expect(tool).toHaveAttribute('aria-pressed', 'false');
    const size = (await tool.boundingBox())!;
    expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(24);

    await page.getByTestId('canvas').focus();
    await page.keyboard.press('Control+a');
    expect(await selected(page)).toEqual(['GND1', 'PSU1', 'R1', 'R2']);
    await expect(tool).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(status).toHaveText(text.cleared);
    await expect(tool).toHaveAttribute('aria-pressed', 'false');
    expect(await selected(page)).toEqual([]);

    await tool.focus();
    await page.keyboard.press('Space');
    await expect(tool).toHaveAttribute('aria-pressed', 'true');
    await expect(tool).toBeFocused();
    await component(page, 'R1').locator('.component-hit').click();
    await component(page, 'R2').locator('.component-hit').click();
    await expect(status).toHaveText(text.two);
    await component(page, 'R1').locator('.component-hit').click();
    await expect(status).toHaveText(text.one);
    expect(await selected(page)).toEqual(['R2']);
    await tool.click();
    await expect(status).toHaveText(text.off);
    expect(await selected(page)).toEqual(['R2']);

    // Help lists the keys.
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog')).toContainText(text.help);
  });

  test(`Ctrl+A in a text field selects text, not the drawing (${lang})`, async ({ page }) => {
    await open(page, lang);
    await component(page, 'R1').focus();
    const field = page.getByTestId('inspector').locator('input').first();
    await field.focus();
    await page.keyboard.press('Control+a');
    expect(await selected(page)).toEqual(['R1']);
    await expect(page.getByTestId('canvas-several')).toHaveAttribute('aria-pressed', 'false');
  });
}

for (const lang of ['en', 'he'] as const) {
  const text = TEXT[lang];

  test(`a switch keeps its own state in its name; [ ], lists and Escape end it (${lang})`, async ({
    page,
  }) => {
    let doc = partsDoc();
    const added = addComponent(doc, 'component.toggle_switch', { x: 280, y: -160 });
    if (!added.ok) throw new Error('add');
    const wired = addWire(
      added.doc,
      { kind: 'terminal', component: 'R1', terminal: 'b' },
      { kind: 'terminal', component: 'R2', terminal: 'a' },
      [],
    );
    if (!wired.ok) throw new Error('wire');
    doc = wired.doc;
    await page.addInitScript((l) => localStorage.setItem('tbi-lab.locale', l), lang);
    await openImported(page, doc);
    const status = page.getByTestId('kbwire-status');
    const tool = page.getByTestId('canvas-several');
    const sw = component(page, added.id);

    await sw.focus();
    await page.keyboard.press('Shift+Enter');
    await expect(sw).toHaveAccessibleName(text.switchOpen);
    await page.keyboard.press('Space');
    await expect(sw).toHaveAccessibleName(text.switchClosed);
    await expect(sw).not.toHaveAttribute('aria-pressed');

    await page.keyboard.press(']');
    await expect(status).toHaveText(text.offThen);
    await expect(tool).toHaveAttribute('aria-pressed', 'false');

    await tool.click();
    await page.getByTestId('wires-list').getByRole('button').first().click();
    await expect(page.getByTestId('wires-list-status')).toHaveText(text.offThen);
    await expect(tool).toHaveAttribute('aria-pressed', 'false');

    await tool.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await expect(status).toHaveText(text.cleared);
    await expect(tool).toHaveAttribute('aria-pressed', 'false');
    await expect(tool).toBeFocused();
    expect(await selected(page)).toEqual([]);
  });
}

for (const lang of ['en', 'he'] as const) {
  test(`the toggle shares the zoom-in row, so the controls reach no further down (${lang})`, async ({
    page,
  }) => {
    await open(page, lang);
    const probe = page.getByTestId('canvas-probe');
    const tool = page.getByTestId('canvas-several');
    const controls = page.locator('.canvas-wrap .canvas-controls');
    const zoomIn = controls.locator('.view-tool-row button').last();
    const [t, z] = [(await tool.boundingBox())!, (await zoomIn.boundingBox())!];
    expect(t.y).toBeCloseTo(z.y, 0);
    for (const box of [t, z]) expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
    // The row is no wider than the pan buttons.
    const row = (await controls.locator('.view-tool-row').boundingBox())!;
    const pan = (await controls.locator('.view-pan').boundingBox())!;
    expect(row.width).toBeLessThanOrEqual(pan.width + 0.5);
    // As tall as without the toggle: four rows of single controls and the pan buttons.
    const withTool = (await controls.boundingBox())!.height;
    await tool.evaluate((el) => (el.style.display = 'none'));
    expect((await controls.boundingBox())!.height).toBeCloseTo(withTool, 0);
    await tool.evaluate((el) => (el.style.display = ''));
    // Tab order follows the rows.
    await probe.focus();
    await page.keyboard.press('Tab');
    await expect(tool).toBeFocused();
    expect(await tool.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.keyboard.press('Tab');
    await expect(zoomIn).toBeFocused();
  });
}

const MORE = {
  en: {
    part: /^Selecting several items is off\. .*R1.* selected/,
    junction: /^Selecting several items is off\. Junction /,
    cleared: /^Selection cleared\. Selecting several items is off/,
    stopToEdit: /^Stop the simulation to change the circuit/,
  },
  he: {
    part: /^בחירה של כמה פריטים כבויה\. .*R1.* נבחר/,
    junction: /^בחירה של כמה פריטים כבויה\. /,
    cleared: /^הבחירה נוקתה/,
    stopToEdit: /^יש לעצור את הסימולציה כדי לשנות את המעגל/,
  },
} as const;

/** R1 and R2 wired, with a junction on that wire. */
function junctionDoc(): ProjectDocument {
  const wired = addWire(
    partsDoc(),
    { kind: 'terminal', component: 'R1', terminal: 'b' },
    { kind: 'terminal', component: 'R2', terminal: 'a' },
    [],
  );
  if (!wired.ok) throw new Error('wire');
  const tee = addWire(
    wired.doc,
    { kind: 'terminal', component: 'R1', terminal: 'a' },
    { kind: 'wire', wire: wired.doc.layout.wires[0]!.id, at: { x: 60, y: -160 } },
    [],
  );
  if (!tee.ok) throw new Error('junction');
  return tee.doc;
}

/** A circuit the engine can run: supply, ground and both resistors in series. */
function runnableDoc(): ProjectDocument {
  let doc = partsDoc();
  const pin = (component: string, terminal: string) =>
    ({ kind: 'terminal', component, terminal }) as const;
  for (const [from, to] of [
    [pin('PSU1', 'positive'), pin('R1', 'a')],
    [pin('R1', 'b'), pin('R2', 'a')],
    [pin('R2', 'b'), pin('PSU1', 'negative')],
    [pin('PSU1', 'negative'), pin('GND1', 'ref')],
  ] as const) {
    const r = addWire(doc, from, to, []);
    if (!r.ok) throw new Error('wire');
    doc = r.doc;
  }
  return doc;
}

/** Whether Ctrl+A was kept from the browser (which would select the page's text). */
async function pressSelectAll(page: Page): Promise<{ prevented: boolean; text: string }> {
  await page.evaluate(() => {
    getSelection()!.removeAllRanges();
    window.addEventListener('keydown', function seen(e) {
      if (e.key.toLowerCase() !== 'a') return;
      window.removeEventListener('keydown', seen);
      document.body.dataset.prevented = String(e.defaultPrevented);
    });
  });
  await page.keyboard.press('Control+a');
  return page.evaluate(() => ({
    prevented: document.body.dataset.prevented === 'true',
    text: String(getSelection()),
  }));
}

for (const lang of ['en', 'he'] as const) {
  const text = TEXT[lang];
  const more = MORE[lang];

  test(`opening another project ends the mode (${lang})`, async ({ page }) => {
    await open(page, lang);
    await openImported(page, { ...partsDoc(), projectId: 'prj_g3other', name: 'other' });
    const tool = page.getByTestId('canvas-several');
    await tool.click();
    await expect(tool).toHaveAttribute('aria-pressed', 'true');
    await openAppMenu(page);
    await page.getByTestId('menu-recent-prj_g3multi').click();
    await expect(tool).toHaveAttribute('aria-pressed', 'false');
  });

  test(`Connections, Schematic, 3D and Junctions selections end the mode (${lang})`, async ({
    page,
  }) => {
    await page.addInitScript((l) => localStorage.setItem('tbi-lab.locale', l), lang);
    await openImported(page, junctionDoc());
    const tool = page.getByTestId('canvas-several');
    const status = page.getByTestId('several-status');
    const turnOn = async () => {
      await page.getByTestId('view-circuit').click();
      await tool.click();
      await expect(tool).toHaveAttribute('aria-pressed', 'true');
    };
    const isOff = async () => {
      await page.getByTestId('view-circuit').click();
      await expect(tool).toHaveAttribute('aria-pressed', 'false');
    };

    await turnOn();
    await page.getByTestId('connections-toggle').click();
    await page.getByTestId('connections-select-R1').click();
    await expect(status).toHaveText(more.part);
    await isOff();

    await turnOn();
    await page.getByTestId('view-schematic').click();
    await page.locator('[data-part="R1"]').focus();
    await page.keyboard.press('Enter');
    await expect(status).toHaveText(more.part);
    await isOff();

    await turnOn();
    await page.getByTestId('view-3d').click();
    await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready');
    await page.getByTestId('view3d-host').click({ position: { x: 4, y: 4 } });
    await expect(status).toHaveText(more.cleared);
    await isOff();

    await turnOn();
    await page.getByTestId('junctions-list').getByRole('button').first().click();
    await expect(page.getByTestId('junctions-list-status')).toHaveText(more.junction);
    await isOff();
  });

  test(`Escape on the toggle cancels a pending placement first (${lang})`, async ({ page }) => {
    await open(page, lang);
    const tool = page.getByTestId('canvas-several');
    const tile = page.getByTestId('palette-component.resistor');
    await tool.click();
    await tile.click();
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
    await tool.focus();
    await page.keyboard.press('Escape');
    await expect(tile).toHaveAttribute('aria-pressed', 'false');
    await expect(tool).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(tool).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('kbwire-status')).toHaveText(text.cleared);
  });

  test(`a part can be placed while selecting several; the mode stays (${lang})`, async ({
    page,
  }) => {
    await open(page, lang);
    const tool = page.getByTestId('canvas-several');
    await tool.click();
    await page.getByTestId('palette-component.resistor').click();
    await page.getByTestId('canvas').click({ position: { x: 200, y: 300 } });
    await waitForStoredProject(page, (d) => d.components.length === 5, 'placed');
    await expect(tool).toHaveAttribute('aria-pressed', 'true');
    expect(await selected(page)).toEqual(['R3']);
    await component(page, 'R1').focus();
    await page.keyboard.press('Enter');
    expect(await selected(page)).toEqual(['R1', 'R3']);
  });

  test(`while the simulation runs, selecting works and Delete removes nothing (${lang})`, async ({
    page,
  }) => {
    // Wired parts: removing them would change the running circuit, so it is refused.
    await page.addInitScript((l) => localStorage.setItem('tbi-lab.locale', l), lang);
    await openImported(page, runnableDoc());
    await page.getByTestId('sim-run').click();
    await expect(page.getByTestId('sim-stop')).toBeVisible();
    await component(page, 'R1').focus();
    await page.keyboard.press('Shift+Enter');
    await component(page, 'R2').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('kbwire-status')).toHaveText(text.two);
    await page.keyboard.press('Delete');
    await expect(page.getByText(more.stopToEdit)).toBeVisible();
    expect(await selected(page)).toEqual(['R1', 'R2']);
    await expect(page.locator('[data-hit="component"]')).toHaveCount(4);
  });

  test(`Ctrl+A never selects page text from a view, and still works in fields (${lang})`, async ({
    page,
  }) => {
    await open(page, lang);
    await component(page, 'R1').focus();
    await page.keyboard.press('w');
    await expect(terminal(page, 'R1', 'a')).toBeFocused();
    expect(await pressSelectAll(page)).toEqual({ prevented: true, text: '' });
    await page.keyboard.press('Escape');

    await page.getByTestId('canvas-probe').focus();
    expect(await pressSelectAll(page)).toEqual({ prevented: true, text: '' });

    await page.getByTestId('view-schematic').click();
    for (const target of ['svg.schematic', '[data-part="R1"]']) {
      await page.locator(target).focus();
      expect(await pressSelectAll(page)).toEqual({ prevented: true, text: '' });
    }

    const field = page.getByTestId('inspector').locator('input').first();
    await field.focus();
    expect((await pressSelectAll(page)).prevented).toBe(false);
    expect(
      await field.evaluate((el: HTMLInputElement) => el.selectionEnd! - el.selectionStart!),
    ).toBe((await field.inputValue()).length);
  });

  test(`a read-only project has no several-selection toggle (${lang})`, async ({ page }) => {
    await open(page, lang);
    const doc = await waitForStoredProject(page, (d) => d.projectId === 'prj_g3multi', 'stored');
    await page.evaluate(
      ([d, v]) =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('tbi-lab');
          req.onsuccess = () => {
            const tx = req.result.transaction('projects', 'readwrite');
            tx.objectStore('projects').put({ ...d, schemaVersion: v });
            tx.oncomplete = () => (req.result.close(), resolve());
            tx.onerror = () => reject(tx.error);
          };
        }),
      [doc, SCHEMA_VERSION + 1] as const,
    );
    await page.reload();
    await reopenFromLibrary(page);
    await expect(page.getByTestId('readonly-banner')).toBeVisible();
    await expect(page.getByTestId('canvas-probe')).toBeVisible();
    await expect(page.getByTestId('canvas-several')).toHaveCount(0);
    await component(page, 'R1').focus();
    await page.keyboard.press('Shift+Enter');
    expect(await selected(page)).toEqual(['R1']);
    await component(page, 'R2').focus();
    expect(await selected(page)).toEqual(['R2']);
    expect((await pressSelectAll(page)).prevented).toBe(true);
  });
}
