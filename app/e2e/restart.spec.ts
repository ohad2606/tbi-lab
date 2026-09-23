/**
 * A7: closing the browser completely and reopening restores the project exactly.
 * A persistent profile directory makes this a genuine process restart, as Gate D proved for
 * the feasibility shape; here it is the real product and the production schema.
 */
import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProject } from '@tbi-lab/domain';
import {
  component,
  createProject,
  place,
  storedProject,
  waitForStoredProject,
  waitSaved,
  wire,
} from './helpers.js';

test('A7: full browser restart restores the project exactly', async ({ baseURL }) => {
  const profile = await mkdtemp(join(tmpdir(), 'tbi-lab-restart-'));
  const viewport = { width: 1400, height: 860 };
  try {
    // Session 1: build a circuit.
    let context = await chromium.launchPersistentContext(profile, { baseURL: baseURL!, viewport });
    let page = context.pages()[0] ?? (await context.newPage());
    await createProject(page, 'שולחן עבודה');
    await place(page, 'component.resistor', { x: 0, y: 0 });
    await place(page, 'component.resistor', { x: 0, y: 100 });
    await wire(page, ['PSU1', 'positive'], ['R1', 'a']);
    await wire(page, ['PSU1', 'negative'], ['GND1', 'ref']);
    await wire(page, ['R1', 'b'], ['R2', 'a']);
    const field = page.getByTestId('param-R2-resistance');
    await component(page, 'R2').locator('.component-hit').click();
    await field.fill('4k7');
    await field.press('Enter');
    await page.getByTestId('language-select').selectOption('he');
    // Prove the last edits reached IndexedDB before the browser is killed.
    const before = await waitForStoredProject(
      page,
      (d) =>
        JSON.stringify(d.components.find((c) => c.id === 'R2')?.params.resistance) ===
          JSON.stringify({ value: 4700, unit: 'ohm' }) &&
        d.connections.some((c) => c.component === 'R2' && c.terminal === 'a'),
      'R2 = 4.7 kΩ and wired',
    );
    await waitSaved(page);
    expect(validateProject(before)).toEqual([]);
    await context.close(); // the whole browser process ends

    // Session 2: a new browser process on the same profile.
    context = await chromium.launchPersistentContext(profile, { baseURL: baseURL!, viewport });
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto('/');
    // The last project reopens by itself, in the remembered language.
    await expect(page.getByTestId('project-name')).toHaveValue('שולחן עבודה');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const after = await storedProject(page);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    for (const id of ['PSU1', 'GND1', 'R1', 'R2']) await expect(component(page, id)).toBeVisible();
    await expect(page.locator('.wires .wire')).toHaveCount(3);
    await expect(page.getByTestId('value-R2')).toHaveText('4.7 kΩ');
    await context.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
