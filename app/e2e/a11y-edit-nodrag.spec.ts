/**
 * BETA-G3 (WCAG 2.1.1, 2.5.7): the drawing can be edited without dragging, by single clicks and by
 * the keyboard alone, EN and HE:
 * - a part or junction moves one grid step with the Inspector's Move buttons (one undo step, same
 *   rules as the arrow keys), with the result or the refusal announced.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { addComponent, createProject, type ProjectDocument } from '@tbi-lab/domain';
import { component, openImported, waitForStoredProject } from './helpers.js';

const TEXT = {
  en: {
    moveName: /^Move .?R1.? right$/,
    moved: /R1.? moved right/,
    refused: /R1.? was not moved/,
  },
  he: {
    moveName: /^הזזת .?R1.? ימינה$/,
    moved: /R1.? הוזז ימינה/,
    refused: /R1.? לא הוזז/,
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

async function open(page: Page, lang: Lang, doc: ProjectDocument): Promise<ProjectDocument> {
  await page.addInitScript((l) => localStorage.setItem('tbi-lab.locale', l), lang);
  await openImported(page, doc);
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
  return waitForStoredProject(page, (d) => d.components.length === doc.components.length, 'open');
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
