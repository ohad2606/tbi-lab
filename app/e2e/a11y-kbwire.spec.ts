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
    start: /התחלת חוט מ-.*PSU1/,
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

test('A11Y-002 kbwire: leaving the canvas resets the mode and clears the message', async ({
  page,
}) => {
  const psu = await open(page, 'en');
  const status = page.getByTestId('kbwire-status');
  await page.keyboard.press('w');
  await page.keyboard.press('Enter');
  await expect(status).toHaveText(TEXT.en.start);
  await expect(page.locator('.kb-source')).toHaveCount(1);
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await expect(status).toHaveText('');
  await expect(page.locator('.kb-pin')).toHaveCount(0);
  // A later Enter on the part must not continue the stale wire.
  await psu.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect((await waitForStoredProject(page, () => true, 'stored')).layout.wires).toHaveLength(0);
});

test('A11Y-002 kbwire: pointer down on the canvas resets the mode', async ({ page }) => {
  await open(page, 'en');
  const status = page.getByTestId('kbwire-status');
  await page.keyboard.press('w');
  await expect(status).toHaveText(TEXT.en.pins);
  const box = (await page.getByTestId('canvas').boundingBox())!;
  await page.mouse.click(box.x + 5, box.y + 5);
  await expect(status).toHaveText('');
  await expect(page.locator('.kb-pin')).toHaveCount(0);
});

test('A11Y-002 kbwire: an identical consecutive message is re-announced', async ({ page }) => {
  await open(page, 'en');
  const status = page.getByTestId('kbwire-status');
  await page.keyboard.press('w');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(status).toHaveText(TEXT.en.candidate);
  // Record every mutation of the live region while the same candidate text is produced twice.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="kbwire-status"]')!;
    (window as unknown as { __m: string[] }).__m = [];
    new MutationObserver(() =>
      (window as unknown as { __m: string[] }).__m.push(el.textContent ?? ''),
    ).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(status).toHaveText(TEXT.en.candidate);
  const seen = await page.evaluate(() => (window as unknown as { __m: string[] }).__m);
  expect(seen.filter((x) => x === '').length).toBeGreaterThanOrEqual(2);
});

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

// ---- Slice 2: wire selection by keyboard ([ and ]), announcement, Delete, Escape ----

const SEL = {
  en: {
    sel: (n: number) => new RegExp(`^Wire ${n} of 2: .*PSU1.* to .+\\. .?Delete.? removes it`),
    removed: /^Removed wire: .*PSU1.* to /,
    cleared: 'Wire selection cleared',
  },
  he: {
    sel: (n: number) => new RegExp(`^חוט ${n} מתוך 2: .*PSU1.* אל .+\\. מקש .*Delete.* מסיר`),
    removed: /^החוט הוסר: .*PSU1.* אל /,
    cleared: 'בחירת החוט בוטלה',
  },
} as const;

async function twoWires(page: Page, lang: 'en' | 'he') {
  const psu = await open(page, lang);
  const status = page.getByTestId('kbwire-status');
  for (const moves of [0, 1]) {
    await page.keyboard.press('w');
    for (let i = 0; i < moves; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(status).toHaveText(TEXT[lang].done);
    await page.keyboard.press('Escape');
    await expect(psu).toBeFocused();
  }
  await waitForStoredProject(page, (d) => d.layout.wires.length === 2, 'two wires');
  return psu;
}

for (const lang of ['en', 'he'] as const) {
  test(`A11Y-002 kbwire s2 (${lang}): [ ] select wires with wrap, announce, Delete, undo, Escape`, async ({
    page,
  }) => {
    const t = SEL[lang];
    await twoWires(page, lang);
    const status = page.getByTestId('kbwire-status');
    const selected = page.locator('.wire-group.selected');
    await expect(selected).toHaveCount(0);

    await page.keyboard.press(']');
    await expect(status).toHaveText(t.sel(1));
    await expect(selected).toHaveCount(1);
    const first = await selected.getAttribute('data-id');
    await page.keyboard.press(']');
    await expect(status).toHaveText(t.sel(2));
    const second = await selected.getAttribute('data-id');
    expect(second).not.toBe(first);
    await page.keyboard.press(']'); // wrap forward
    await expect(status).toHaveText(t.sel(1));
    await expect(selected).toHaveAttribute('data-id', first!);
    await page.keyboard.press('['); // wrap backward
    await expect(status).toHaveText(t.sel(2));
    await expect(selected).toHaveAttribute('data-id', second!);
    await page.keyboard.press('[');
    await expect(status).toHaveText(t.sel(1));

    // Escape clears the selection and says so.
    await page.keyboard.press('Escape');
    await expect(selected).toHaveCount(0);
    await expect(status).toHaveText(t.cleared);

    // Delete removes the selected wire; announced; undo restores it.
    await page.keyboard.press(']');
    await expect(status).toHaveText(t.sel(1));
    await page.keyboard.press('Delete');
    await expect(status).toHaveText(t.removed);
    await waitForStoredProject(page, (d) => d.layout.wires.length === 1, 'one wire left');
    await page.keyboard.press('Control+z');
    await waitForStoredProject(page, (d) => d.layout.wires.length === 2, 'wire restored');
  });
}

test('A11Y-002 kbwire s2: no wires announces so; brackets do not select while wiring', async ({
  page,
}) => {
  await open(page, 'en');
  const status = page.getByTestId('kbwire-status');
  await page.keyboard.press(']');
  await expect(status).toHaveText('There are no wires.');
  await page.keyboard.press('w');
  await page.keyboard.press(']');
  await expect(page.locator('.wire-group.selected')).toHaveCount(0);
});

test('A11Y-002 kbwire s2: selected wire stays visible in forced-colors mode', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await twoWires(page, 'en');
  await page.keyboard.press(']');
  const halo = page.locator('.wire-group.selected .wire-hit');
  await expect(halo).toHaveCount(1);
  const [stroke, width] = await halo.evaluate((el) => {
    const c = getComputedStyle(el);
    return [c.stroke, c.strokeWidth];
  });
  expect(stroke).not.toBe('none');
  expect(stroke).not.toBe('rgba(0, 0, 0, 0)');
  expect(parseFloat(width!)).toBeGreaterThanOrEqual(10);
});
