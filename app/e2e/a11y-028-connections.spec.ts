/**
 * A11Y-028: the connections text alternative. Opens the voltage-divider example and checks the
 * disclosure is reachable by keyboard, lists parts and nets (derived from the netlist), has no
 * focus trap, and works in Hebrew with technical references kept LTR.
 */
import { expect, test } from '@playwright/test';
import { goToProjects, waitSaved } from './helpers.js';

for (const lang of ['en', 'he'] as const)
  test(`A11Y-028 (${lang}): connections list is keyboard operable and lists parts and nets`, async ({
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
    await expect(toggle).toBeFocused();
    await expect(page.getByTestId('connections-parts')).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('connections')).toHaveAttribute('open', '');

    const parts = page.getByTestId('connections-parts');
    await expect(parts.locator('tbody tr')).toHaveCount(5);
    for (const ref of ['PSU1', 'R1', 'R2'])
      await expect(parts.getByRole('rowheader', { name: ref })).toBeVisible();
    await expect(parts.locator('bdi[dir="ltr"]', { hasText: 'R1' })).toHaveCount(1);

    const nets = page.getByTestId('connections-nets');
    await expect(nets.getByTestId('connections-net-gnd')).toContainText('GND1');
    await expect(nets.getByTestId('connections-net-1')).toContainText('PSU1');
    await expect(nets.getByTestId('connections-net-1')).toContainText('R1');
    await expect(nets.getByTestId('connections-net-2')).toContainText('R2');

    // No trap: Tab moves on from the toggle, Shift+Tab comes back, Enter closes.
    await page.keyboard.press('Tab');
    await expect(toggle).not.toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('connections')).not.toHaveAttribute('open', '');
  });
