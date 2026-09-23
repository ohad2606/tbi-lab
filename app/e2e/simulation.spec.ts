/**
 * Sprint 3 acceptance: the real electrical vertical slice in real Chromium.
 *
 * Every displayed value is checked against the production engine run in this Node process
 * on the SAME stored project (A16: visible results originate from the production solver).
 */
import { expect, test, type Page } from '@playwright/test';
import { createSnapshot, type ProjectDocument } from '@tbi-lab/domain';
import { EngineSession, type SolveSuccess } from '@tbi-lab/engine';
import { getLocale } from '../src/i18n/i18n.js';
import { formatResult } from '../src/sim/format.js';
import { drawLoop, run, setValue } from './circuits.js';
import {
  component,
  place,
  storedProject,
  terminal,
  waitForStoredProject,
  waitSaved,
} from './helpers.js';

const en = getLocale('en');

async function engineTruth(page: Page): Promise<SolveSuccess> {
  const doc = await storedProject(page);
  const outcome = new EngineSession(createSnapshot(doc)).solve();
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  return outcome;
}
const I = (v: number | null) => {
  if (v === null) throw new Error('current not defined');
  return formatResult(en, v, 'ampere');
};
const V = (v: number) => formatResult(en, v, 'volt');
const status = (page: Page) => page.getByTestId('sim-status');

/**
 * Sprint 4 dense-result rule: a part's solved values appear on the canvas when it is selected
 * or probed (supplies always). Select the part, then read its canvas result label.
 */
async function resultOf(page: Page, id: string) {
  await component(page, id).locator('.component-hit').click();
  return page.getByTestId(`result-${id}`);
}

test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

test('A3/A4: 5 V -> 1 kΩ -> GND runs in a real Web Worker and shows 5 mA', async ({ page }) => {
  const workers: string[] = [];
  page.on('worker', (w) => workers.push(w.url()));
  await drawLoop(page, { ohms: '1k' });
  await run(page);
  await expect(status(page)).toHaveAttribute('data-status', 'running');
  expect(workers.some((u) => /\/assets\/worker-[\w-]+\.js$/.test(u))).toBe(true);
  await expect(await resultOf(page, 'R1')).toHaveText('5 mA');
  await expect(page.getByTestId('result-PSU1')).toHaveText('5 V · 5 mA · CV');
  const truth = await engineTruth(page);
  expect(Math.abs(truth.components.R1!.current! - 5e-3) / 5e-3).toBeLessThanOrEqual(1e-9);
  await component(page, 'R1').locator('.component-hit').click();
  await expect(page.getByTestId('result-current')).toHaveText(I(truth.components.R1!.current));
  await expect(page.getByTestId('result-voltage')).toHaveText(V(truth.components.R1!.voltage!));
});

test('A5: 5 V -> 220 Ω -> LED -> GND shows the real nonlinear operating point', async ({
  page,
}) => {
  await drawLoop(page, { ohms: '220', led: true });
  await run(page);
  const truth = await engineTruth(page);
  const d1 = truth.components.D1!;
  expect(d1.current!).toBeGreaterThan(0.013);
  expect(d1.current!).toBeLessThan(0.0145);
  expect(d1.voltage).toBeGreaterThan(1.95);
  expect(d1.voltage).toBeLessThan(2.0);
  await expect(await resultOf(page, 'D1')).toHaveText(`${V(d1.voltage!)} · ${I(d1.current)}`);
  await expect(await resultOf(page, 'D1')).toHaveText('1.982 V · 13.72 mA');
  // The LED symbol's brightness cue follows the solved current (visual only).
  const opacity = await component(page, 'D1')
    .locator('.led-glow')
    .evaluate((el) => Number(getComputedStyle(el).fillOpacity));
  expect(opacity).toBeCloseTo(Math.min(1, d1.current! / 0.02), 3);
  await component(page, 'D1').locator('.component-hit').click();
  await expect(page.getByTestId('result-outside-model')).toHaveCount(0);
});

test('A6: 5 V / 100 mA PSU into 10 Ω enters CC at 100 mA / 1 V', async ({ page }) => {
  await drawLoop(page, { ohms: '10', limit: '100m' });
  await run(page);
  await expect(page.getByTestId('result-PSU1')).toHaveText('1 V · 100 mA · CC');
  await component(page, 'PSU1').locator('.component-hit').click();
  // The Sprint 4 PSU panel shows the solver's operating mode (formerly the result section).
  await expect(page.getByTestId('psu-mode')).toHaveAttribute('data-mode', 'cc');
  await expect(page.getByTestId('psu-mode')).toContainText('CC · current limit');
  // Current limiting is physical behaviour, never an error.
  await expect(page.getByTestId('sim-error')).toHaveCount(0);
});

test('A7 + A10: output OFF is an open circuit; enabling it live re-solves with persisted revision', async ({
  page,
}) => {
  await drawLoop(page, { ohms: '220', led: true, enable: false });
  await run(page);
  await expect(page.getByTestId('result-PSU1')).toHaveText('0 V · 0 A · OFF');
  await expect(await resultOf(page, 'D1')).toHaveText('0 V · 0 A');
  const before = await storedProject(page);

  // Live persistent edit while running: persisted first, mirrored, re-solved in the worker.
  await component(page, 'PSU1').locator('.component-hit').click();
  await page.getByTestId('param-PSU1-outputEnabled').check();
  await expect(page.getByTestId('result-PSU1')).toHaveText(/ · CV$/);
  const after = await waitForStoredProject(
    page,
    (d) => d.components[0]!.params.outputEnabled === true,
    'PSU1 output enabled',
  );
  expect(after.components[0]!.params.outputEnabled).toBe(true);
  expect(after.revision.localRevision).toBe(before.revision.localRevision + 1);
  await expect(status(page)).toHaveAttribute(
    'data-applied-revision',
    String(after.revision.localRevision),
  );
  await expect(status(page)).toHaveAttribute('data-solves', '2');
  await expect(await resultOf(page, 'D1')).toHaveText('1.982 V · 13.72 mA');

  // Setpoint change while running (reselect the supply: reading D1 selected D1).
  await component(page, 'PSU1').locator('.component-hit').click();
  const v = page.getByTestId('param-PSU1-setpointVoltage');
  await expect(v).toBeEnabled();
  await v.fill('3.3');
  await v.press('Enter');
  await waitForStoredProject(
    page,
    (d) => (d.components[0]!.params.setpointVoltage as { value: number }).value === 3.3,
    'PSU1 setpoint = 3.3 V',
  );
  const truth = await engineTruth(page);
  await expect(await resultOf(page, 'D1')).toHaveText(
    `${V(truth.components.D1!.voltage!)} · ${I(truth.components.D1!.current)}`,
  );
  expect((await storedProject(page)).components[0]!.params.setpointVoltage).toEqual({
    value: 3.3,
    unit: 'volt',
  });
});

test('A8: a floating circuit is refused with a localized diagnostic naming its parts', async ({
  page,
}) => {
  await drawLoop(page, { ohms: '1k' });
  // Within the default fitted view (world x ≲ 190 is visible on a 1400 px window).
  await place(page, 'component.resistor', { x: -40, y: 220 });
  await place(page, 'component.led', { x: 100, y: 220 });
  await terminal(page, 'R2', 'b').locator('.terminal-hit').click();
  await terminal(page, 'D1', 'anode').locator('.terminal-hit').click();
  await terminal(page, 'D1', 'cathode').locator('.terminal-hit').click();
  await terminal(page, 'R2', 'a').locator('.terminal-hit').click();
  await waitSaved(page);
  await run(page);
  await expect(status(page)).toHaveAttribute('data-status', 'failed');
  const banner = page.getByTestId('sim-error');
  await expect(banner).toHaveAttribute('data-code', 'floating_circuit');
  await expect(banner).toContainText('floating circuit with no connection to GND');
  await expect(banner).toContainText('R2, D1');
  expect(await banner.innerText()).not.toMatch(/singular|matrix|pivot|Error:/i);
  await page.getByTestId('language-select').selectOption('he');
  await expect(banner).toContainText('מעגל צף');
  await expect(banner).toContainText('R2, D1');
  // No values are invented for a refused circuit.
  await expect(page.locator('.runtime-label')).toHaveCount(0);
});

test('A9 + A11: results are runtime only; structural edits cannot reach the running topology', async ({
  page,
}) => {
  await drawLoop(page, { ohms: '1k' });
  const bytes = JSON.stringify(await storedProject(page));
  await run(page);
  await expect(await resultOf(page, 'R1')).toHaveText('5 mA');
  await page.waitForTimeout(500);
  expect(JSON.stringify(await storedProject(page))).toBe(bytes);

  // Structural edits are refused while running.
  await expect(page.getByTestId('palette-component.resistor')).toBeDisabled();
  await component(page, 'R1').locator('.component-hit').click();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('notice')).toContainText(
    'Stop the simulation to change the circuit',
  );
  await expect(component(page, 'R1')).toBeVisible();
  await expect(page.getByTestId('param-R1-resistance')).toBeDisabled();
  await expect(page.getByTestId('param-R1-resistance-locked')).toBeVisible();
  // Clicking a terminal selects its part instead of starting a wire.
  await terminal(page, 'R1', 'b').locator('.terminal-hit').click();
  await expect(page.locator('.wire-preview')).toHaveCount(0);
  expect(JSON.stringify(await storedProject(page))).toBe(bytes);

  // Stop removes runtime state and leaves the project untouched.
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped');
  await expect(page.locator('.runtime-label')).toHaveCount(0);
  await expect(page.getByTestId('sim-results')).toHaveCount(0);
  expect(JSON.stringify(await storedProject(page))).toBe(bytes);

  // Stop -> edit -> Run again.
  await setValue(page, 'R1', 'resistance', '2k');
  await waitSaved(page);
  await run(page);
  await expect(await resultOf(page, 'R1')).toHaveText('2.5 mA');
});

test('A13: English and Hebrew show identical numbers; switching language writes nothing', async ({
  page,
}) => {
  await drawLoop(page, { ohms: '220', led: true });
  await run(page);
  await component(page, 'D1').locator('.component-hit').click();
  const labels = async () =>
    page
      .locator('.runtime-label')
      .evaluateAll((els) => els.map((e) => e.textContent!.replace(/ · (CV|CC|OFF|כבוי)$/, '')));
  const enValues = await labels();
  const bytes = JSON.stringify(await storedProject(page));
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.getByTestId('sim-status')).toHaveText('פועל · נקודת עבודה DC');
  expect(await labels()).toEqual(enValues);
  await page.waitForTimeout(400);
  expect(JSON.stringify(await storedProject(page))).toBe(bytes);
  expect(
    await page
      .locator('.runtime-label')
      .first()
      .evaluate((el) => getComputedStyle(el).direction),
  ).toBe('ltr');
  await component(page, 'D1').locator('.component-hit').click();
  await expect(page.getByTestId('sim-results')).toContainText('מתח קדמי');
  await expect(page.getByTestId('result-voltage')).toHaveText('1.982 V');
});

test('A14: a Worker failure leaves the project intact and gives a useful diagnostic', async ({
  page,
}) => {
  await drawLoop(page, { ohms: '1k' });
  const bytes = JSON.stringify(await storedProject(page));
  await page.route(/\/assets\/worker-[\w-]+\.js$/, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: 'throw new Error("injected engine failure");',
    }),
  );
  await run(page);
  await expect(status(page)).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('sim-error')).toHaveAttribute('data-code', 'worker_crashed');
  await expect(page.getByTestId('sim-error')).toContainText('The project is not affected');
  expect(await page.getByTestId('sim-error').innerText()).not.toMatch(/injected|stack|at /);
  expect(JSON.stringify(await storedProject(page))).toBe(bytes);
  // Editing continues, and Stop / a retried Run work once the worker is healthy again.
  await page.unroute(/\/assets\/worker-[\w-]+\.js$/);
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped');
  await run(page);
  await expect(await resultOf(page, 'R1')).toHaveText('5 mA');
});

test('empty and ground-less circuits are refused with specific messages', async ({ page }) => {
  await drawLoop(page, { ohms: '1k' });
  await component(page, 'GND1').locator('.component-hit').click();
  await page.keyboard.press('Delete');
  await waitSaved(page);
  await run(page);
  await expect(page.getByTestId('sim-error')).toHaveAttribute('data-code', 'no_ground');
  await expect(page.getByTestId('sim-error')).toContainText('no reference');
});

test('parts with nothing wired are reported as not simulated, and get no values', async ({
  page,
}) => {
  await drawLoop(page, { ohms: '1k' });
  await place(page, 'component.led', { x: 160, y: 100 });
  await waitSaved(page);
  await run(page);
  await expect(page.getByTestId('sim-not-connected')).toContainText('D1');
  await expect(await resultOf(page, 'D1')).toHaveCount(0);
  await expect(await resultOf(page, 'R1')).toHaveText('5 mA');
});

export type { ProjectDocument };
