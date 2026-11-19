/**
 * A11Y-002 (keyboard wiring, slice 1): a wire between two pins can be made with the keyboard
 * alone, in English and Hebrew.
 * - on a focused component, W enters pin mode; pins are role=button with a label naming the
 *   component, the pin and whether it is connected (roving tabindex: one pin in the Tab order);
 * - Enter starts a wire; Tab / arrows choose a target; Enter connects; Escape cancels;
 * - a single polite live region announces each step in the page language;
 * - nothing is added while the simulation runs (refused, announced).
 */
import { expect, test, type Page } from '@playwright/test';
import { createProject, goToProjects, waitForStoredProject } from './helpers.js';

const TEXT = {
  en: {
    pins: /PSU1.*pins/,
    start: /Wire started from .*PSU1/,
    candidate: /\d+ of \d+/,
    done: /Connected .*PSU1.* to /,
    cancel: 'Wiring cancelled. No wire was added.',
    running: /unavailable while the simulation runs/,
  },
  he: {
    pins: /PSU1.*פינים/,
    start: /חוט התחיל מ-.*PSU1/,
    candidate: /\d+ מתוך \d+/,
    done: /חובר .*PSU1.* אל /,
    cancel: 'החיווט בוטל. לא נוסף חוט.',
    running: /אינו זמין בזמן שהסימולציה רצה/,
  },
} as const;

async function open(page: Page, lang: 'en' | 'he') {
  await page.addInitScript((l) => localStorage.setItem('tbi-lab.locale', l), lang);
  await createProject(page, `kbwire-${lang}`);
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
  const psu = page.locator('[data-hit="component"][data-id="PSU1"]');
  await psu.focus();
  return psu;
}

for (const lang of ['en', 'he'] as const) {
  test(`A11Y-002 kbwire (${lang}): wire two pins by keyboard only`, async ({ page }) => {
    const t = TEXT[lang];
    await open(page, lang);
    const status = page.getByTestId('kbwire-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');

    await page.keyboard.press('w');
    await expect(status).toHaveText(t.pins);
    // Roving tabindex: exactly one pin of PSU1 is tabbable, it has focus, role and a label.
    const pins = page.locator('[data-hit="terminal"][data-component="PSU1"]');
    await expect(pins.first()).toBeFocused();
    await expect(pins.first()).toHaveAttribute('role', 'button');
    await expect(pins.first()).toHaveAttribute('aria-label', /PSU1/);
    await expect(pins.first()).toHaveAttribute('aria-label', /./);
    await expect(page.locator('[data-hit="terminal"][tabindex="0"]')).toHaveCount(1);
    // Arrow keys move between pins; the label announces the pin.
    await page.keyboard.press('ArrowRight');
    await expect(pins.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(pins.first()).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(status).toHaveText(t.start);
    await page.keyboard.press('Tab');
    await expect(status).toHaveText(t.candidate);
    await expect(page.locator('[data-kb-candidate="true"]')).toHaveCount(1);
    await page.keyboard.press('Shift+Tab');
    await expect(status).toHaveText(t.candidate);
    await page.keyboard.press('Enter');
    await expect(status).toHaveText(t.done);

    const doc = await waitForStoredProject(
      page,
      (d) => d.layout.wires.length === 1 && d.connections.length === 2,
      'one wire created by keyboard',
    );
    expect(doc.layout.wires[0]!.from).toMatchObject({ kind: 'terminal', component: 'PSU1' });
  });

  test(`A11Y-002 kbwire (${lang}): Escape cancels with no wire, focus returns to the part`, async ({
    page,
  }) => {
    const t = TEXT[lang];
    const psu = await open(page, lang);
    const status = page.getByTestId('kbwire-status');
    await page.keyboard.press('w');
    await page.keyboard.press('Enter');
    await expect(status).toHaveText(t.start);
    await page.keyboard.press('Escape');
    await expect(status).toHaveText(t.cancel);
    await expect(psu).toBeFocused();
    await expect(page.locator('[data-hit="terminal"][tabindex]')).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid^="wire-"]')).toHaveCount(0);
    const stored = await waitForStoredProject(page, () => true, 'stored');
    expect(stored.layout.wires).toHaveLength(0);
    // Existing shortcuts still work after leaving the mode: Escape with a part focused is inert.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('canvas')).toBeVisible();
  });
}

test('A11Y-002 kbwire: refused while the simulation runs', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tbi-lab.locale', 'en'));
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('open-example-led-current').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  const status = page.getByTestId('kbwire-status');
  const part = page.locator('[data-hit="component"]').first();
  await part.focus();
  await page.keyboard.press('w');
  await expect(status).toHaveText(TEXT.en.running);
  await expect(page.locator('[data-hit="terminal"][tabindex]')).toHaveCount(0);
});
