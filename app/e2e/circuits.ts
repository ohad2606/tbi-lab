/** Draw the Sprint 3 acceptance circuits through the real UI, as a user would. */
import { expect, type Page } from '@playwright/test';
import { parseQuantity, type ProjectDocument } from '@tbi-lab/domain';
import {
  clickWorld,
  component,
  createProject,
  place,
  terminal,
  waitForStoredProject,
  waitSaved,
} from './helpers.js';

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
  // The configured circuit must be durable before any test takes a baseline of the stored
  // project (the save indicator alone may still show a previous "saved" state).
  const num = (text: string, unit: 'ohm' | 'volt' | 'ampere') => {
    const r = parseQuantity(text, unit);
    if (!r.ok) throw new Error(`bad test value ${text}`);
    return r.value;
  };
  const q = (d: ProjectDocument, id: string, key: string) =>
    (d.components.find((c) => c.id === id)?.params[key] as { value: number } | undefined)?.value;
  const wired = (d: ProjectDocument, id: string, t: string) =>
    d.connections.some((c) => c.component === id && c.terminal === t);
  await waitForStoredProject(
    page,
    (d) =>
      q(d, 'R1', 'resistance') === num(loop.ohms, 'ohm') &&
      (!loop.volts || q(d, 'PSU1', 'setpointVoltage') === num(loop.volts, 'volt')) &&
      (!loop.limit || q(d, 'PSU1', 'currentLimit') === num(loop.limit, 'ampere')) &&
      d.components[0]!.params.outputEnabled === (loop.enable ?? true) &&
      wired(d, 'PSU1', 'negative') &&
      (loop.led ? wired(d, 'D1', 'cathode') : wired(d, 'R1', 'b')),
    'drawn circuit stored',
    name,
  );
  await waitSaved(page);
}

export async function run(page: Page): Promise<void> {
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', /running|failed/);
}
