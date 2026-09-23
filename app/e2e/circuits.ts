/** Draw the Sprint 3 acceptance circuits through the real UI, as a user would. */
import { expect, type Page } from '@playwright/test';
import { clickWorld, component, createProject, place, terminal, waitSaved } from './helpers.js';

export async function setValue(page: Page, id: string, key: string, text: string): Promise<void> {
  await component(page, id).locator('.component-hit').click();
  const field = page.getByTestId(`param-${id}-${key}`);
  await field.fill(text);
  await field.press('Enter');
}

async function link(page: Page, a: [string, string], b: [string, string]) {
  await terminal(page, ...a)
    .locator('.terminal-hit')
    .click();
  await terminal(page, ...b)
    .locator('.terminal-hit')
    .click();
}

export interface Loop {
  volts?: string;
  limit?: string;
  ohms: string;
  led?: boolean;
  enable?: boolean;
}

/** PSU1 -> R1 -> [D1 ->] GND1, PSU1- -> GND1, drawn and configured through the UI. */
export async function drawLoop(page: Page, loop: Loop, name = 'Bench'): Promise<void> {
  await createProject(page, name);
  await place(page, 'component.resistor', { x: 0, y: -20 });
  if (loop.led) {
    await place(page, 'component.led', { x: 140, y: -20 });
    await link(page, ['PSU1', 'positive'], ['R1', 'a']);
    await link(page, ['R1', 'b'], ['D1', 'anode']);
    await link(page, ['D1', 'cathode'], ['GND1', 'ref']);
  } else {
    await link(page, ['PSU1', 'positive'], ['R1', 'a']);
    await link(page, ['R1', 'b'], ['GND1', 'ref']);
  }
  await link(page, ['PSU1', 'negative'], ['GND1', 'ref']);
  await setValue(page, 'R1', 'resistance', loop.ohms);
  if (loop.volts) await setValue(page, 'PSU1', 'setpointVoltage', loop.volts);
  if (loop.limit) await setValue(page, 'PSU1', 'currentLimit', loop.limit);
  if (loop.enable ?? true) {
    await component(page, 'PSU1').locator('.component-hit').click();
    await page.getByTestId('param-PSU1-outputEnabled').check();
  }
  await clickWorld(page, { x: 400, y: 300 }); // clear the selection on empty canvas
  await waitSaved(page);
}

export async function run(page: Page): Promise<void> {
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', /running|failed/);
}
