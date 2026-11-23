/**
 * A11Y-002 / TBI-001 slice 4: re-pick one end of a wire by keyboard only, English and Hebrew.
 * E (wire selected) -> 1/2 or Tab+Enter chooses the end -> Tab cycles targets -> Enter reconnects
 * in ONE edit (one undo step), Escape cancels; every step is announced in the live region.
 */
import { expect, test, type Page } from '@playwright/test';
import { createProject, waitForStoredProject } from './helpers.js';

const TEXT = {
  en: {
    ends: /^Wire 1: .*PSU1.* to .+\. Choose the end to move/,
    end2: /^End .?2.?: .+\. .?Enter.? chooses it\.$/,
    start: /^Moving end .?2.?, now at .+\. .?Tab.? chooses the new target/,
    candidate: /\d+ of \d+/,
    done: /^Wire 1 reconnected: .*PSU1.* to /,
    cancel: 'Re-pick cancelled. Wire 1 is unchanged.',
    noWire: /^No wire is selected\./,
  },
  he: {
    ends: /^חוט 1: .*PSU1.* אל .+\. בחרו את הקצה להזזה/,
    end2: /^קצה .?2.?: .+\. .?Enter.? בוחר בו\.$/,
    start: /^מזיזים את קצה .?2.?, כעת ב-.+\. .?Tab.? בוחר יעד חדש/,
    candidate: /\d+ מתוך \d+/,
    done: /^חוט 1 חובר מחדש: .*PSU1.* אל /,
    cancel: 'בחירה מחדש בוטלה. חוט 1 לא השתנה.',
    noWire: /^לא נבחר חוט\./,
  },
} as const;

async function oneWire(page: Page, lang: 'en' | 'he') {
  await page.addInitScript((l) => localStorage.setItem('tbi-lab.locale', l), lang);
  await createProject(page, `kbrepick-${lang}`);
  const psu = page.locator('[data-hit="component"][data-id="PSU1"]');
  await psu.focus();
  const status = page.getByTestId('kbwire-status');
  await page.keyboard.press('w');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(status).toHaveText(/./);
  await page.keyboard.press('Escape');
  await expect(psu).toBeFocused();
  const doc = await waitForStoredProject(page, (d) => d.layout.wires.length === 1, 'one wire');
  return { psu, status, wire: doc.layout.wires[0]! };
}

const inCanvas = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.closest('svg.canvas, [data-testid="canvas"]'));

for (const lang of ['en', 'he'] as const) {
  test(`A11Y-002 kbwire s4 (${lang}): re-pick the second end by keyboard only, undo is one step`, async ({
    page,
  }) => {
    const t = TEXT[lang];
    const { status, wire } = await oneWire(page, lang);
    await page.keyboard.press(']');
    await page.keyboard.press('e');
    await expect(status).toHaveText(t.ends);
    expect(await inCanvas(page)).toBe(true);

    // Tab switches the highlighted end, Enter chooses it (keys 1/2 are the shortcut).
    await page.keyboard.press('Tab');
    await expect(status).toHaveText(t.end2);
    await expect(page.locator('.kb-source')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(status).toHaveText(t.start);
    await page.keyboard.press('Tab');
    await expect(status).toHaveText(t.candidate);
    await expect(page.locator('[data-kb-candidate="true"]')).toHaveCount(1);
    await expect(page.locator('.kb-ring')).toHaveCount(2); // moving end + candidate: visible
    await page.keyboard.press('Enter');
    await expect(status).toHaveText(t.done);
    expect(await inCanvas(page)).toBe(true);

    const moved = await waitForStoredProject(
      page,
      (d) =>
        d.layout.wires.length === 1 &&
        JSON.stringify(d.layout.wires[0]!.to) !== JSON.stringify(wire.to),
      'second end moved',
    );
    const w = moved.layout.wires[0]!;
    expect(w.id).toBe(wire.id);
    expect(w.from).toEqual(wire.from);
    await expect(page.locator('.wire-group.selected')).toHaveCount(1);
    await expect(page.locator('.kb-ring')).toHaveCount(0);

    // One undo step restores the original end.
    await page.keyboard.press('Control+z');
    await waitForStoredProject(
      page,
      (d) =>
        d.layout.wires.length === 1 &&
        JSON.stringify(d.layout.wires[0]!.to) === JSON.stringify(wire.to),
      'undo restored the end',
    );
  });

  test(`A11Y-002 kbwire s4 (${lang}): keys 1/2 pick the end; Escape cancels with no change`, async ({
    page,
  }) => {
    const t = TEXT[lang];
    const { status, wire } = await oneWire(page, lang);
    await page.keyboard.press(']');
    await page.keyboard.press('e');
    await expect(status).toHaveText(t.ends);
    await page.keyboard.press('2');
    await expect(status).toHaveText(t.start);
    await page.keyboard.press('Escape');
    await expect(status).toHaveText(t.cancel);
    expect(await inCanvas(page)).toBe(true);
    await page.waitForTimeout(400);
    const stored = await waitForStoredProject(page, () => true, 'stored');
    expect(stored.layout.wires).toEqual([wire]);
    // Left the mode: Escape now clears the wire selection as before.
    await page.keyboard.press('Escape');
    await expect(page.locator('.wire-group.selected')).toHaveCount(0);
  });
}

test('A11Y-002 kbwire s4: E without a selected wire says what to do and changes nothing', async ({
  page,
}) => {
  const { status } = await oneWire(page, 'en');
  await page.keyboard.press('e');
  await expect(status).toHaveText(TEXT.en.noWire);
});

test('A11Y-002 kbwire s4: refused while the simulation runs', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tbi-lab.locale', 'en'));
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) {
    const { goToProjects } = await import('./helpers.js');
    await goToProjects(page);
  }
  await page.getByTestId('open-example-led-current').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  await page.locator('[data-hit="component"]').first().focus();
  await page.keyboard.press(']');
  await page.keyboard.press('e');
  await expect(page.getByTestId('kbwire-status')).toHaveText(
    /unavailable while the simulation runs/,
  );
});
