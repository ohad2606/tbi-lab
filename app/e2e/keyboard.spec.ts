/** A10: core actions are reachable by keyboard with visible focus. */
import { expect, test } from '@playwright/test';
import { component, createProject, storedProject, waitSaved } from './helpers.js';

test('A10: keyboard-only place, select, move, rotate and delete with visible focus', async ({
  page,
}) => {
  await createProject(page, 'Keys');
  // Reach the palette's resistor entry by Tab and activate it with Enter.
  const button = page.getByTestId('palette-component.resistor');
  for (let i = 0; i < 20 && !(await button.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(button).toBeFocused();
  expect(await button.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
  await page.keyboard.press('Enter');

  // The new component is placed at the view centre, selected and focused.
  const r1 = component(page, 'R1');
  await expect(r1).toBeFocused();
  await expect(r1).toHaveAttribute('data-selected', 'true');
  expect(await r1.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
  expect(await r1.locator('.focus-ring').evaluate((el) => getComputedStyle(el).visibility)).toBe(
    'visible',
  );
  await waitSaved(page);
  const placed = (await storedProject(page)).layout.components.R1!;

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await waitSaved(page);
  expect((await storedProject(page)).layout.components.R1).toEqual({
    x: placed.x + 20,
    y: placed.y + 20,
    rotation: 0,
  });

  await page.keyboard.press('r');
  await waitSaved(page);
  expect((await storedProject(page)).layout.components.R1!.rotation).toBe(90);

  // Tab moves focus between canvas components, selecting the focused one.
  await page.keyboard.press('Shift+Tab');
  await expect(component(page, 'GND1')).toBeFocused();
  await expect(component(page, 'GND1')).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('Tab');
  await expect(r1).toBeFocused();

  await page.keyboard.press('Delete');
  await waitSaved(page);
  expect((await storedProject(page)).components.map((c) => c.id)).toEqual(['PSU1', 'GND1']);
});
