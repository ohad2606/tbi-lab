/**
 * Sprint POT-UNITS (DEV): Phase 1 units UX in the real Inspector, and the Phase 2 potentiometer
 * live in a running local simulation.
 * - a number plus a unit chosen from the list is stored as the exact SI value; the chosen unit is
 *   shown again after commit and after a reload; a unit change that leaves the range is refused
 *   with nothing committed and the list reverts;
 * - the Hebrew range hint renders each quantity left-to-right (`1 nF`, never `nF 1`): measured on
 *   the rendered glyph positions, not only on the DOM;
 * - the potentiometer divider example: the wiper probe reads 5 V x (1 - p); typing a position and
 *   moving the slider while running change the measured wiper voltage.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  component,
  createProject,
  goToProjects,
  place,
  reopenFromLibrary,
  storedProject,
  waitForStoredProject,
  waitSaved,
} from './helpers.js';

const resistance = async (page: Page, id = 'R1') =>
  (await storedProject(page)).components.find((c) => c.id === id)!.params.resistance;

test('units: number + unit list, exact SI storage, chosen unit kept after commit and reload', async ({
  page,
}) => {
  await createProject(page, 'Units');
  await place(page, 'component.resistor', { x: 0, y: 0 });
  await component(page, 'R1').locator('.component-hit').click();
  const field = page.getByTestId('param-R1-resistance');
  const unit = page.getByTestId('param-R1-resistance-unit');
  await expect(field).toHaveValue('1');
  await expect(unit).toHaveValue('3');
  expect(await unit.locator('option').allTextContents()).toEqual(['Ω', 'kΩ', 'MΩ']);
  await expect(unit).toHaveAccessibleName(/unit/i);

  // Type a number, choose its unit: one edit, stored exactly.
  await field.fill('2.2');
  await unit.selectOption('6');
  await waitForStoredProject(
    page,
    (d) =>
      JSON.stringify(d.components.find((c) => c.id === 'R1')?.params.resistance) ===
      JSON.stringify({ value: 2_200_000, unit: 'ohm' }),
    'R1 = 2.2 MΩ',
  );
  await expect(field).toHaveValue('2.2');
  await expect(unit).toHaveValue('6');
  await expect(page.getByTestId('value-R1')).toHaveText('2.2 MΩ');

  // Choose kΩ, enter 1: stored 1000, shown "1 kΩ"; the same after a reload.
  // Review M1: a unit choice on an UNTOUCHED field only re-expresses the stored value
  // (2.2 MΩ -> 2200 kΩ): nothing is committed.
  const rev0 = (await storedProject(page)).revision.localRevision;
  await unit.selectOption('3');
  await expect(field).toHaveValue('2200');
  await waitSaved(page);
  expect((await storedProject(page)).revision.localRevision).toBe(rev0);
  expect(await resistance(page)).toEqual({ value: 2_200_000, unit: 'ohm' });
  // Review L2: exponent notation is a plain number in the shown unit (1e3 kΩ = 1 MΩ).
  await field.fill('1e3');
  await field.press('Enter');
  await expect(field).toHaveValue('1');
  await expect(unit).toHaveValue('6');
  await waitForStoredProject(
    page,
    (d) =>
      (d.components.find((c) => c.id === 'R1')?.params.resistance as { value: number }).value ===
      1e6,
    'R1 = 1 MΩ',
  );
  await unit.selectOption('3'); // 1000 kΩ, display only
  await field.fill('1');
  await field.press('Enter');
  await waitForStoredProject(
    page,
    (d) =>
      (d.components.find((c) => c.id === 'R1')?.params.resistance as { value: number }).value ===
      1000,
    'R1 = 1 kΩ',
  );
  await waitSaved(page);
  await page.reload();
  await reopenFromLibrary(page);
  await component(page, 'R1').locator('.component-hit').click();
  await expect(field).toHaveValue('1');
  await expect(unit).toHaveValue('3');
  expect(await resistance(page)).toEqual({ value: 1000, unit: 'ohm' });

  // A unit change that leaves the range: refused, nothing committed, the list reverts.
  const before = (await storedProject(page)).revision.localRevision;
  await field.fill('2000');
  await unit.selectOption('6'); // 2000 MΩ > 1 GΩ
  await expect(page.getByTestId('param-R1-resistance-error')).toContainText('must be between');
  await expect(unit).toHaveValue('3');
  expect((await storedProject(page)).revision.localRevision).toBe(before);
  expect(await resistance(page)).toEqual({ value: 1000, unit: 'ohm' });
  await page.keyboard.press('Escape');

  // A prefixed form typed into the number field is converted into number + unit.
  await field.fill('4k7');
  await field.press('Enter');
  await expect(field).toHaveValue('4.7');
  await expect(unit).toHaveValue('3');
  await waitForStoredProject(
    page,
    (d) =>
      (d.components.find((c) => c.id === 'R1')?.params.resistance as { value: number }).value ===
      4700,
    'R1 = 4.7 kΩ',
  );
});

test('units: the Hebrew range hint keeps each quantity left-to-right (1 nF, never nF 1)', async ({
  page,
}) => {
  await createProject(page, 'טווח');
  await place(page, 'component.capacitor', { x: 0, y: 0 });
  await component(page, 'C1').locator('.component-hit').click();
  await page.getByTestId('language-select').selectOption('he');
  const hint = page.getByTestId('param-C1-capacitance-hint');
  await expect(hint).toContainText('טווח מותר');
  const values = hint.locator('bdi');
  await expect(values).toHaveText([/1 nF/, /10 mF/]);
  // Rendered glyph order: inside each value, the number is LEFT of its unit.
  const order = await values.evaluateAll((els) =>
    els.map((el) => {
      const text = el.firstChild as Text;
      const s = text.data;
      const at = (i: number) => {
        const r = document.createRange();
        r.setStart(text, i);
        r.setEnd(text, i + 1);
        return r.getBoundingClientRect().x;
      };
      const digit = s.search(/\d/);
      const letter = s.search(/[a-zA-Zµ]/);
      return at(digit) < at(letter);
    }),
  );
  expect(order).toEqual([true, true]);
  // The unit list is technical: LTR, with pF offered (1000 pF is in range).
  const unit = page.getByTestId('param-C1-capacitance-unit');
  expect(await unit.locator('option').allTextContents()).toEqual(['pF', 'nF', 'µF', 'mF']);
  expect(await unit.evaluate((e) => getComputedStyle(e).direction)).toBe('ltr');
  await expect(unit).toHaveAccessibleName(/יחידה/);
});

test('potentiometer divider: the wiper reads 5 V × (1 − p); position and slider change it live', async ({
  page,
}) => {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('open-example-pot-divider').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  const reading = page.getByTestId('probe-reading-RV1.wiper');
  await expect(reading).toContainText('2.5 V');

  await component(page, 'RV1').locator('.component-hit').click();
  const position = page.getByTestId('param-RV1-position');
  await expect(position).toBeEnabled(); // live while running
  await expect(position).toHaveValue('50');
  await expect(page.getByTestId('param-RV1-position-unit')).toHaveText('%');
  // Typed while running (A at GND, B at +5 V: V_W = 5 V × p): 25 % -> 1.25 V.
  await position.fill('25');
  await position.press('Enter');
  await expect(reading).toContainText('1.25 V');
  await expect(page.getByTestId('result-state-wiperVoltage')).toContainText('1.25 V');
  // Review M2: a typed position is rounded to the 0.01 % grid and shown so.
  await position.fill('12.3456');
  await position.press('Enter');
  await expect(position).toHaveValue('12.35');
  await expect(reading).toContainText('617.5 mV');
  // The slider while running: to the B end (100 %) -> 5 V; back to 80 % -> 4 V.
  const slider = page.getByTestId('param-RV1-position-slider');
  await slider.fill('1000');
  await expect(position).toHaveValue('100');
  await expect(reading).toContainText('5 V');
  await slider.fill('800');
  await expect(reading).toContainText('4 V');
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  await waitForStoredProject(
    page,
    (d) =>
      (d.components.find((c) => c.id === 'RV1')?.params.position as { value: number }).value === 80,
    'RV1 position = 80 %',
  );
  // Its limitations are listed (no ADC; end resistance idealised).
  await expect(page.getByTestId('limitation-potentiometer_no_adc')).toBeAttached();
  await expect(page.getByTestId('limitation-potentiometer_end_resistance')).toBeAttached();
  await page.getByTestId('sim-stop').click();
});

test('review M1: arrow keys on a focused unit list of a running supply re-express, never commit', async ({
  page,
}) => {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('open-example-ohms-law').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.getByTestId('sim-run').click();
  const status = page.getByTestId('sim-status');
  await expect(status).toHaveAttribute('data-status', 'running');
  await component(page, 'PSU1').locator('.component-hit').click();
  const limit = page.getByTestId('param-PSU1-currentLimit');
  const unit = page.getByTestId('param-PSU1-currentLimit-unit');
  await expect(limit).toHaveValue('100');
  await expect(unit).toHaveValue('-3');
  await waitSaved(page);
  const before = await storedProject(page);
  const solves = await status.getAttribute('data-solves');
  // Keyboard: focus the closed list and press ArrowDown (mA -> A), then ArrowUp (back).
  await unit.focus();
  await page.keyboard.press('ArrowDown');
  await expect(unit).toHaveValue('0');
  await expect(limit).toHaveValue('0.1'); // the same 100 mA, in A
  await page.keyboard.press('ArrowUp');
  await expect(unit).toHaveValue('-3');
  await expect(limit).toHaveValue('100');
  await page.waitForTimeout(300);
  const after = await storedProject(page);
  expect(after.revision.localRevision).toBe(before.revision.localRevision);
  expect(after.components.find((c) => c.id === 'PSU1')!.params.currentLimit).toEqual({
    value: 0.1,
    unit: 'ampere',
  });
  // Nothing reached the running session: no re-solve.
  await expect(status).toHaveAttribute('data-solves', solves!);
  await expect(status).toHaveAttribute('data-status', 'running');
  await page.getByTestId('sim-stop').click();
});
