/**
 * Sprint 29 in the browser (local simulation in the worker):
 * - logic-full-adder (M2): Run; every gate's Inspector shows its live level and the truth-table row
 *   it is in — the intermediate X (A ⊕ B), C1, C2 and the outputs S, Cout; toggling a switch from
 *   a gate's panel moves the rows and the LEDs; Hebrew keeps pins/voltages/table LTR; save/reopen
 *   keeps the switch positions.
 * - logic-half-adder: the XOR's truth table (datasheet function) and its live row.
 * - NOR and XOR in the palette: placed, drawn, named in EN and HE.
 * Screenshots go to TBI_S29_SHOTS (a directory) when set.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  component,
  goToProjects,
  place,
  reopenFromLibrary,
  storedProject,
  waitSaved,
} from './helpers.js';

const SHOTS = process.env.TBI_S29_SHOTS;

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

const status = (page: Page) => page.getByTestId('sim-status');
async function run(page: Page) {
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
}
async function inspect(page: Page, id: string) {
  await component(page, id).locator('.component-hit').click({ force: true });
  await expect(page.getByTestId('inspector-ref')).toHaveText(id);
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.getByTestId('inspector').screenshot({ path: `${SHOTS}/${name}-inspector.png` });
  await page.screenshot({ path: `${SHOTS}/${name}-page.png` });
}
async function openExample(page: Page, id: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}
const level = (page: Page, pin: string) => page.getByTestId(`logic-level-${pin}`);

test('full adder (M2): every stage’s live level and truth-table row; toggling from the panel; HE; save/reopen', async ({
  page,
}) => {
  await openExample(page, 'logic-full-adder');
  // Shipped: A closed, B open, Cin closed → 1 + 0 + 1 = 2: S LOW, Cout HIGH.
  await run(page);
  const expectStage = async (id: string, y: 'HIGH' | 'LOW', row: string) => {
    await inspect(page, id);
    await expect(level(page, 'y')).toHaveText(y);
    await expect(page.getByTestId(`logic-truth-${row}`)).toHaveAttribute('aria-current', 'true');
  };
  await expectStage('U1', 'HIGH', 'HL'); // X = A ⊕ B = 1
  await expectStage('U2', 'LOW', 'HL'); // C1 = A · B = 0
  await expectStage('U3', 'LOW', 'HH'); // S = X ⊕ Cin = 0
  await expectStage('U4', 'HIGH', 'HH'); // C2 = X · Cin = 1
  await expectStage('U5', 'HIGH', 'LH'); // Cout = C1 + C2 = 1
  await expect(page.getByTestId('logic-why-a')).toContainText('V_CC = 3.3 V');
  await shot(page, 's29-fa-run-en');

  // Close B from the Inspector of U1: 1 + 1 + 1 = 3 → S HIGH, Cout HIGH.
  await inspect(page, 'U1');
  await page.getByTestId('logic-control-SW2').click();
  await expect(level(page, 'b')).toHaveText('HIGH');
  await expect(level(page, 'y')).toHaveText('LOW'); // X = 0
  await expectStage('U3', 'HIGH', 'LH'); // S = 0 ⊕ 1 = 1
  await expectStage('U5', 'HIGH', 'HL'); // Cout = C1 (1) + C2 (0)
  await shot(page, 's29-fa-run-111-en');

  // Hebrew: the panel is RTL; voltages and the truth table stay LTR; the levels are the same.
  await page.getByTestId('language-select').selectOption('he');
  await inspect(page, 'U3');
  await expect(page.getByTestId('logic-state')).toContainText('טבלת אמת');
  await expect(level(page, 'y')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-volts-a')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByTestId('logic-truth')).toHaveAttribute('dir', 'ltr');
  await shot(page, 's29-fa-run-111-he');
  await page.getByTestId('language-select').selectOption('en');
  await page.getByTestId('sim-stop').click();

  // Save / reopen: the switch positions are persistent edits.
  await waitSaved(page);
  const saved = await storedProject(page);
  expect(saved.components.find((c) => c.id === 'SW2')!.params.closed).toBe(true);
  await goToProjects(page);
  await reopenFromLibrary(page);
  await run(page);
  await expectStage('U3', 'HIGH', 'LH');
  await expectStage('U5', 'HIGH', 'HL');
  await page.getByTestId('sim-stop').click();
});

test('half adder: the XOR’s datasheet function table, and its live row (EN)', async ({ page }) => {
  await openExample(page, 'logic-half-adder');
  await inspect(page, 'U1');
  await expect(page.getByTestId('logic-thresholds')).toContainText('SN74LVC1G86');
  // The XOR function table: H only for HL and LH.
  await expect(page.getByTestId('logic-truth-HL')).toContainText('H');
  await expect(page.getByTestId('logic-truth-LH')).toContainText('H');
  await expect(page.getByTestId('logic-truth-HH')).toContainText('L');
  await expect(page.getByTestId('logic-truth-LL')).toContainText('L');
  await run(page);
  await inspect(page, 'U1');
  await expect(level(page, 'y')).toHaveText('HIGH'); // A closed, B open
  await expect(page.getByTestId('logic-truth-HL')).toHaveAttribute('aria-current', 'true');
  await inspect(page, 'U2');
  await expect(level(page, 'y')).toHaveText('LOW');
  await shot(page, 's29-ha-run-en');
  await page.getByTestId('sim-stop').click();
});

test('NOR and XOR are in the palette, placed and named (EN and HE)', async ({ page }) => {
  await openExample(page, 'logic-half-adder');
  await expect(page.getByTestId('palette-logic.gate_nor')).toBeVisible();
  await expect(page.getByTestId('palette-logic.gate_xor')).toBeVisible();
  await expect(page.getByTestId('palette-logic.gate_nor')).toContainText('NOR');
  await place(page, 'logic.gate_nor', { x: 0, y: 400 });
  await waitSaved(page);
  const doc = await storedProject(page);
  const nor = doc.components.find((c) => c.type === 'logic.gate_nor')!;
  expect(nor.params.model).toBe('model.logic.sn74lvc1g02');
  await inspect(page, nor.id);
  await expect(page.getByTestId('inspector')).toContainText('SN74LVC1G02');
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.getByTestId('palette-logic.gate_xor')).toContainText('XOR');
  await expect(page.getByTestId('inspector')).toContainText('שער NOR');
  await page.getByTestId('language-select').selectOption('en');
});
