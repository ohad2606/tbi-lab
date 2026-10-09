/**
 * Sprint 12 parts in the real app (product side): the HC-SR04, the DHT22 and the 16x2 I2C LCD are
 * placed from the palette, carry their header pin names on the canvas, expose their simulated
 * environment as live inspector controls bounded by the catalog ranges (stored as SI values), keep
 * technical tokens (I2C addresses, units) LTR and identical in every locale, and show the solved
 * module states. The LCD stays blank without an engine result.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  component,
  createProject,
  place,
  storedProject,
  waitForStoredProject,
  waitSaved,
  wire,
} from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

async function setField(page: Page, id: string, text: string) {
  const field = page.getByTestId(id);
  await field.fill(text);
  await field.press('Enter');
}

const select = async (page: Page, id: string) =>
  component(page, id).locator('.component-hit').click({ force: true });

test('HC-SR04, DHT22, LCD: placed, named pins, bounded live environment, solved states, LTR tokens', async ({
  page,
}, info) => {
  await createProject(page, 'Sprint 12 parts');
  await place(page, 'sensor.hc_sr04', { x: 60, y: -40 });
  await place(page, 'sensor.dht22', { x: 60, y: 100 });
  await place(page, 'display.lcd1602_i2c', { x: 40, y: 220 });
  const doc = await waitForStoredProject(
    page,
    (d) => d.components.length === 5,
    'the three parts placed',
  );
  const id = (type: string) => doc.components.find((c) => c.type === type)!.id;
  const us = id('sensor.hc_sr04');
  const dht = id('sensor.dht22');
  const lcd = id('display.lcd1602_i2c');

  // The header pin names, as the module silkscreen tokens (LTR).
  const pins = (c: string) =>
    component(page, c)
      .locator('.board-pins text')
      .evaluateAll((els) => els.map((e) => e.textContent));
  expect(await pins(us)).toEqual(['VCC', 'TRIG', 'ECHO', 'GND']);
  expect(await pins(dht)).toEqual(['VDD', 'DATA', 'NC', 'GND']);
  expect(await pins(lcd)).toEqual(['GND', 'VCC', 'SDA', 'SCL']);

  // The environment: bounded by the catalog ranges, stored as language-neutral SI values.
  await select(page, us);
  await expect(page.getByTestId(`environment-${us}`)).toBeVisible();
  await setField(page, `param-${us}-distance`, '6');
  await expect(page.getByTestId(`param-${us}-distance-error`)).toBeVisible();
  await setField(page, `param-${us}-distance`, '1.2');
  await expect(page.getByTestId(`param-${us}-distance-error`)).toHaveCount(0);
  await setField(page, `param-${us}-airTemperature`, '-5');
  await select(page, dht);
  await setField(page, `param-${dht}-humidity`, '120');
  await expect(page.getByTestId(`param-${dht}-humidity-error`)).toBeVisible();
  await setField(page, `param-${dht}-humidity`, '65.2');
  await setField(page, `param-${dht}-temperature`, '-12.5');
  // A temperature reads as a plain number, never with an SI prefix.
  await expect(page.getByTestId(`param-${dht}-temperature`)).toHaveValue('-12.5');
  await waitSaved(page);
  const saved = await storedProject(page);
  const params = (c: string) => saved.components.find((x) => x.id === c)!.params;
  expect(params(us).distance).toEqual({ value: 1.2, unit: 'metre' });
  expect(params(us).airTemperature).toEqual({ value: -5, unit: 'celsius' });
  expect(params(dht).humidity).toEqual({ value: 65.2, unit: 'percent_rh' });
  expect(params(dht).temperature).toEqual({ value: -12.5, unit: 'celsius' });

  // The I2C address: hex tokens, the default 0x27.
  await select(page, lcd);
  const address = page.getByTestId(`param-${lcd}-address`);
  await expect(address).toHaveValue('i2c.0x27');
  const options = () =>
    address.locator('option').evaluateAll((els) => els.map((e) => e.textContent));
  const hex = ['0x20', '0x21', '0x22', '0x23', '0x24', '0x25', '0x26', '0x27'];
  expect(await options()).toEqual(hex);
  // Without an engine result the display is blank and unlit.
  await expect(component(page, lcd)).toHaveAttribute('data-backlight', 'false');
  await expect(component(page, lcd).getByTestId('lcd-text')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('s12-parts-2d.png') });
  // The schematic: labelled blocks; the 3D view: the physical modules (the LCD dark and blank).
  await page.getByTestId('view-schematic').click();
  await expect(page.locator(`[data-part="${lcd}"] [data-glyph="lcd"]`)).toBeVisible();
  await expect(page.locator(`[data-part="${us}"] [data-glyph="ultrasonic"]`)).toBeVisible();
  await expect(page.locator(`[data-part="${dht}"] [data-glyph="dht22"]`)).toBeVisible();
  await page.screenshot({ path: info.outputPath('s12-parts-schematic.png') });
  await page.getByTestId('view-3d').click();
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready', {
    timeout: 60_000,
  });
  await page.screenshot({ path: info.outputPath('s12-parts-3d-stopped.png') });
  await page.getByTestId('view-circuit').click();

  // Hebrew: the same tokens, LTR; the labels translated.
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  expect(await options()).toEqual(hex);
  expect(await pins(lcd)).toEqual(['GND', 'VCC', 'SDA', 'SCL']);
  await select(page, dht);
  await expect(page.getByTestId(`environment-${dht}`)).toContainText('לחות יחסית');
  await expect(page.getByTestId(`environment-${dht}`)).toContainText('%RH');
  await page.screenshot({ path: info.outputPath('s12-parts-2d-he.png') });
  await page
    .getByTestId(`environment-${dht}`)
    .screenshot({ path: info.outputPath('s12-environment-he.png') });
  await page.getByTestId('language-select').selectOption('en');

  // Powered from the 5 V bench supply, the sensors solve locally (no ESP32): powered, output idle.
  await wire(page, ['PSU1', 'negative'], ['GND1', 'ref']);
  await wire(page, ['PSU1', 'positive'], [us, 'vcc']);
  await wire(page, [us, 'gnd'], ['GND1', 'ref']);
  await wire(page, ['PSU1', 'positive'], [dht, 'vdd']);
  await wire(page, [dht, 'gnd'], ['GND1', 'ref']);
  await waitSaved(page);
  // The LCD has no local engine model yet: run without it.
  await select(page, lcd);
  await page.getByTestId('inspector-delete').click();
  await waitSaved(page);
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  await select(page, us);
  await expect(page.getByTestId('result-state-powered')).toHaveText('yes');
  await expect(page.getByTestId('sim-results')).toContainText('Powered (supply at least 4.5 V)');
  await expect(page.getByTestId('result-state-output')).toHaveText('LOW');
  await expect(page.getByTestId('result-current-supply')).toHaveText(/15(\.0+)? mA/);
  // The environment stays live while running.
  await expect(page.getByTestId(`param-${us}-distance`)).toBeEnabled();
  await select(page, dht);
  await expect(page.getByTestId('result-state-powered')).toHaveText('yes');
  await expect(page.getByTestId('sim-results')).toContainText('Powered (supply at least 3.3 V)');
  await expect(page.getByTestId('result-state-output')).toContainText('released');
  await page.screenshot({ path: info.outputPath('s12-parts-running.png') });
  await page.getByTestId('view-3d').click();
  const view = page.getByTestId('view3d');
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await page.screenshot({ path: info.outputPath('s12-parts-3d.png') });
  await page.getByTestId('sim-stop').click();
});
