/**
 * MicroPython RC: the HC-SR04 and DHT22 twins on the REAL staging stack (build service with
 * analyzer 9, Session Host, QEMU Runtime v5), each with its Arduino twin, in English and Hebrew:
 * Build, Run, the printed measurement, a live change of the sensor's environment and the circuit's
 * response. Screenshots go to TBI_SHOTS_DIR. Skipped unless TBI_MPY_REAL=1; 8 session starts.
 */
import { expect, test, type Page } from '@playwright/test';
import { buildProgram, component, goToProjects, waitSaved } from './helpers.js';

test.setTimeout(900_000);
test.skip(!process.env.TBI_MPY_REAL, 'heavy: TBI_MPY_REAL=1');
test.describe.configure({ mode: 'serial' });
const SHOTS = process.env.TBI_SHOTS_DIR ?? 'test-results';
const status = (p: Page) => p.getByTestId('sim-status');
const serial = (p: Page) => p.getByTestId('mcu-serial-output');
const select = (p: Page, id: string) =>
  component(p, id).locator('.component-hit').click({ force: true });

async function openRun(page: Page, id: string, lang: 'en' | 'he', profile: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(lang);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  await page.getByTestId('view-code').click();
  await expect(page.getByTestId('program-language')).toHaveValue(profile);
  await buildProgram(page, 300_000);
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 300_000 });
  await expect(status(page)).toHaveAttribute('data-engine', 'mcu');
}
async function setParam(page: Page, part: string, key: string, value: string) {
  await select(page, part);
  const field = page.getByTestId(`param-${part}-${key}`);
  await field.fill(value);
  await field.press('Enter');
}
async function shot(page: Page, name: string) {
  await page.addStyleTag({
    content: '*, *::before, *::after { font-family: "Liberation Sans", sans-serif !important; }',
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}
async function stop(page: Page) {
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 60_000 });
}

const ARDUINO = 'esp32-arduino-3.3.12';
const MPY = 'esp32-micropython-1.29';

for (const lang of ['en', 'he'] as const) {
  for (const [id, profile] of [
    ['mpy-distance-alarm', MPY],
    ['esp32-distance-alarm', ARDUINO],
  ] as const)
    test(`${id} (${lang}): measures 0.5 m; at 0.1 m the LED lights`, async ({ page }) => {
      await openRun(page, id, lang, profile);
      await select(page, 'U1');
      // 0.5 m at 20 °C: echo 2911.9 µs → 50.2 cm (us / 58).
      await expect(serial(page)).toContainText(/Distance: 50\.\d cm/, { timeout: 120_000 });
      await setParam(page, 'U2', 'distance', '0.1');
      await expect(page.getByTestId('pin-level-2')).toHaveAttribute('data-level', '1', {
        timeout: 60_000,
      });
      await select(page, 'U1');
      await expect(serial(page)).toContainText(/Distance: 10\.\d cm/, { timeout: 60_000 });
      await shot(page, `rc-${id}-${lang}`);
      await stop(page);
    });

  for (const [id, profile] of [
    ['mpy-thermo-hygrometer', MPY],
    ['esp32-thermo-hygrometer', ARDUINO],
  ] as const)
    test(`${id} (${lang}): prints 21.5 C / 55.0 %; a live −10 °C is printed exactly`, async ({
      page,
    }) => {
      await openRun(page, id, lang, profile);
      await select(page, 'U1');
      await expect(serial(page)).toContainText('Temperature: 21.5 C  Humidity: 55.0 %', {
        timeout: 120_000,
      });
      await setParam(page, 'U2', 'temperature', '-10');
      await select(page, 'U1');
      await expect(serial(page)).toContainText('Temperature: -10.0 C  Humidity: 55.0 %', {
        timeout: 120_000,
      });
      await shot(page, `rc-${id}-${lang}`);
      await stop(page);
    });
}
