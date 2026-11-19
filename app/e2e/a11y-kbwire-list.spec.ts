/**
 * A11Y-002 (keyboard wiring, slice 3): the "Wires" list panel is a screen-reader/keyboard
 * alternative to clicking a wire. One button per wire; activating selects it through the normal
 * store selection, so Inspector and Delete work unchanged. EN and HE.
 */
import { expect, test } from '@playwright/test';
import { createProject, waitForStoredProject } from './helpers.js';

const T = {
  en: { empty: 'No wires yet. Connect two pins to add one.', item: /^W1: .*PSU1.* to / },
  he: { empty: 'עדיין אין חוטים. חברו שני פינים כדי להוסיף חוט.', item: /^W1: .*PSU1.* אל / },
} as const;

for (const lang of ['en', 'he'] as const) {
  test(`A11Y-002 kbwire s3 (${lang}): wires list shows, selects and follows delete`, async ({
    page,
  }) => {
    await page.addInitScript((l) => localStorage.setItem('tbi-lab.locale', l), lang);
    await createProject(page, `kbwire-list-${lang}`);
    const list = page.getByTestId('wires-list');
    await expect(list.getByRole('heading')).toBeVisible();
    await expect(list).toContainText(T[lang].empty);
    await expect(list.getByRole('button')).toHaveCount(0);

    // Create a wire by keyboard (slice 1) and see it listed, without focus moving.
    const psu = page.locator('[data-hit="component"][data-id="PSU1"]');
    await psu.focus();
    await page.keyboard.press('w');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await waitForStoredProject(page, (d) => d.layout.wires.length === 1, 'one wire');
    await page.keyboard.press('Escape');
    const item = list.getByRole('button');
    await expect(item).toHaveCount(1);
    await expect(item).toHaveText(T[lang].item);
    await expect(item).toHaveAttribute('aria-pressed', 'false');
    await expect(list).not.toContainText(T[lang].empty);
    // Target size >= 24px.
    const box = (await item.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(24);

    // Select with the keyboard.
    await item.focus();
    await page.keyboard.press('Enter');
    await expect(item).toHaveAttribute('aria-pressed', 'true');
    await expect(item).toBeFocused();
    await expect(page.locator('.wire-group.selected')).toHaveCount(1);

    // Delete via the Inspector button (keyboard); list updates, empty state returns.
    await page.getByTestId('inspector-delete').focus();
    await page.keyboard.press('Enter');
    await waitForStoredProject(page, (d) => d.layout.wires.length === 0, 'wire removed');
    await expect(list.getByRole('button')).toHaveCount(0);
    await expect(list).toContainText(T[lang].empty);
  });
}
