/**
 * BETA-G3 (WCAG 2.1.1): several items are selected without a mouse, EN and HE: Shift+Enter on
 * focused parts, then the group is moved and deleted; Ctrl+A and Escape; the "Select several
 * items" button also gives single clicks (no Shift, no drag).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { addComponent, createProject, type ProjectDocument } from '@tbi-lab/domain';
import { component, openImported, waitForStoredProject } from './helpers.js';

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
    await expect(r1).not.toHaveAttribute('aria-pressed');

    await tabTo(page, r1);
    await page.keyboard.press('Shift+Enter');
    await expect(status).toHaveText(text.on);
    await expect(r1).toBeFocused();
    await expect(r1).toHaveAttribute('aria-pressed', 'true');

    await tabTo(page, r2);
    // Moving focus keeps the selection while selecting several.
    expect(await selected(page)).toEqual(['R1']);
    await expect(r2).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Shift+Enter');
    await expect(status).toHaveText(text.two);
    await expect(r2).toBeFocused();
    expect(await selected(page)).toEqual(['R1', 'R2']);

    // Plain Enter takes it out and puts it back.
    await page.keyboard.press('Enter');
    await expect(status).toHaveText(text.one);
    await expect(r2).toHaveAttribute('aria-pressed', 'false');
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
