/**
 * A11Y-028 slice 2 (TBI-002): the connections list is a named, focusable scroll region; part and pin
 * names are isolated for mixed direction; selecting a part in the list selects it on the canvas and
 * back, by keyboard, without a focus trap.
 */
import { expect, test } from '@playwright/test';
import { goToProjects, waitSaved } from './helpers.js';

for (const lang of ['en', 'he'] as const)
  test(`A11Y-028b (${lang}): named scroll region, isolation, supply rail, selection sync`, async ({
    page,
  }) => {
    await page.goto('/');
    const library = page.getByTestId('example-list');
    await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
    if (!(await library.isVisible())) await goToProjects(page);
    await page.getByTestId('language-select').selectOption(lang);
    await page.getByTestId('open-example-voltage-divider').click();
    await expect(page.getByTestId('canvas')).toBeVisible();
    await waitSaved(page);

    const toggle = page.getByTestId('connections-toggle');
    await toggle.focus();
    await page.keyboard.press('Enter');

    // Scroll region: named, focusable.
    const region = page.getByRole('region', { name: lang === 'en' ? /Connections/ : /חיבורים/ });
    await expect(region).toHaveAttribute('tabindex', '0');

    // Tables and lists have accessible names; every net endpoint reference is an LTR island.
    await expect(page.getByTestId('connections-parts')).toHaveAccessibleName(/.+/);
    await expect(page.getByTestId('connections-nets')).toHaveAccessibleName(/.+/);
    const net1 = page.getByTestId('connections-net-1');
    await expect(net1.locator('bdi[dir="ltr"]', { hasText: 'R1' })).toHaveCount(1);
    // Supply rail named: the net with the supply positive terminal says so.
    await expect(net1).toContainText(lang === 'en' ? 'supply' : 'אספקה');

    // List -> canvas: keyboard-activate R1's select button.
    const r1 = page.getByTestId('connections-select-R1');
    await r1.focus();
    await page.keyboard.press('Enter');
    await expect(r1).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-hit="component"][data-id="R1"]')).toHaveAttribute(
      'data-selected',
      'true',
    );
    // No trap: Tab moves on.
    await page.keyboard.press('Tab');
    await expect(r1).not.toBeFocused();

    // Canvas -> list: focusing R2 on the canvas selects it (keyboard).
    await page.locator('[data-hit="component"][data-id="R2"]').focus();
    await expect(page.getByTestId('connections-select-R2')).toHaveAttribute('aria-pressed', 'true');
    await expect(r1).toHaveAttribute('aria-pressed', 'false');
  });
