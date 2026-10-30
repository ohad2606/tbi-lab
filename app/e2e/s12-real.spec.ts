/**
 * Sprint 12 (R2/R3) HEAVY acceptance: the three curated examples in the product UI through a REAL
 * build service, Session Host and QEMU Runtime v2 (staging or a local stack; T-E2E-1..3). Skipped
 * unless TBI_S12_REAL=1 (routine CI has no QEMU); setup as s11-real.spec.ts, with
 * TBI_RUNTIME_PROXY and TBI_BUILD_PROXY pointing at the real backends.
 *
 * - distance alarm: the HC-SR04 distance is a live part parameter; the firmware prints it from the
 *   measured echo and lights the LED on GPIO2 below 20 cm;
 * - thermo-hygrometer: the firmware decodes the DHT22 frame and prints exactly the environment;
 * - LCD hello: the firmware writes the 16x2 module over I2C; the solved module state shows it.
 *
 * TBI_S12_EXPECT=s11 runs the compatibility case instead (T-E2E-4): this frontend against a
 * Sprint 11 Session Host, which does not know the new parts; Run must fail explicitly, naming them.
 */
import { expect, test, type Page } from '@playwright/test';
import { buildProgram, component, goToProjects, waitSaved } from './helpers.js';

test.setTimeout(420_000);
test.skip(!process.env.TBI_S12_REAL, 'heavy: needs the real Session Host + QEMU (TBI_S12_REAL=1)');
test.describe.configure({ mode: 'serial' });
const OLD_HOST = process.env.TBI_S12_EXPECT === 's11';

const status = (page: Page) => page.getByTestId('sim-status');
const select = (page: Page, id: string) =>
  component(page, id).locator('.component-hit').click({ force: true });

async function openExample(page: Page, id: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  await buildProgram(page, 300_000);
}
async function runOnBoard(page: Page) {
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 90_000 });
  await expect(status(page)).toHaveAttribute('data-engine', 'mcu');
}
async function stop(page: Page) {
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 60_000 });
}
const serial = (page: Page) => page.getByTestId('mcu-serial-output');

test.describe('Runtime v2 host', () => {
  test.skip(OLD_HOST, 'the R2/R3 cases need a Sprint 12 Session Host on Runtime v2');

  test('ESP32 distance alarm on real QEMU: the measured distance follows the part; below 20 cm the LED lights', async ({
    page,
  }, info) => {
    await openExample(page, 'esp32-distance-alarm');
    await runOnBoard(page);
    await select(page, 'U1');
    // 0.5 m at 20 degC: echo 2911 us, printed by the sketch as us / 58.
    await expect(serial(page)).toContainText(/Distance: 50\.\d cm/, { timeout: 90_000 });
    await expect(page.getByTestId('pin-level-2')).toHaveAttribute('data-level', '0');
    await select(page, 'U2');
    const field = page.getByTestId('param-U2-distance');
    await expect(field).toBeEnabled();
    // 0.5 m is shown as 50 cm (Phase 1 units): 0.1 m is 10 cm.
    await field.fill('10');
    await field.press('Enter');
    await expect(page.getByTestId('pin-level-2')).toHaveAttribute('data-level', '1', {
      timeout: 30_000,
    });
    await select(page, 'U1');
    await expect(serial(page)).toContainText(/Distance: 10\.\d cm/, { timeout: 30_000 });
    await page.screenshot({ path: info.outputPath('s12-real-distance-alarm.png') });
    await select(page, 'U2');
    await field.fill('100'); // 100 cm = 1 m
    await field.press('Enter');
    await expect(page.getByTestId('pin-level-2')).toHaveAttribute('data-level', '0', {
      timeout: 30_000,
    });
    await expect(status(page)).toHaveAttribute('data-status', 'running');
    await stop(page);
  });

  test('ESP32 thermo-hygrometer on real QEMU: the firmware prints exactly the DHT22 environment', async ({
    page,
  }, info) => {
    await openExample(page, 'esp32-thermo-hygrometer');
    await runOnBoard(page);
    await select(page, 'U1');
    await expect(serial(page)).toContainText('Temperature: 21.5 C  Humidity: 55.0 %', {
      timeout: 90_000,
    });
    await select(page, 'U2');
    const t = page.getByTestId('param-U2-temperature');
    await expect(t).toBeEnabled();
    await t.fill('-7.3');
    await t.press('Enter');
    await select(page, 'U1');
    await expect(serial(page)).toContainText('Temperature: -7.3 C  Humidity: 55.0 %', {
      timeout: 30_000,
    });
    await page.screenshot({ path: info.outputPath('s12-real-thermo-hygrometer.png') });
    await expect(status(page)).toHaveAttribute('data-status', 'running');
    await stop(page);
  });

  test('ESP32 LCD hello on real QEMU: the module shows the text the firmware wrote over I2C', async ({
    page,
  }, info) => {
    await openExample(page, 'esp32-lcd-hello');
    await runOnBoard(page);
    await select(page, 'U1');
    await expect(serial(page)).toContainText('LCD ready', { timeout: 90_000 });
    await select(page, 'DS1');
    await expect(page.getByTestId('result-state-line1')).toHaveText('Hello, ESP32!', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('result-state-line2')).toHaveText(/^Up: \d+ s/, {
      timeout: 30_000,
    });
    await expect(component(page, 'DS1')).toHaveAttribute('data-backlight', 'true');
    await expect(component(page, 'DS1').getByTestId('lcd-text')).toBeVisible();
    await page.screenshot({ path: info.outputPath('s12-real-lcd-hello.png') });
    await expect(status(page)).toHaveAttribute('data-status', 'running');
    await stop(page);
  });
});

test('against a Sprint 11 Session Host: Run of an R2 example fails explicitly, naming the part', async ({
  page,
}) => {
  test.skip(!OLD_HOST, 'compatibility case: TBI_S12_EXPECT=s11');
  await openExample(page, 'esp32-distance-alarm');
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'failed', { timeout: 90_000 });
  const error = page.getByTestId('sim-error');
  await expect(error).toBeVisible();
  console.log(
    `old host refusal: code=${await error.getAttribute('data-code')} text=${await error.innerText()}`,
  );
  await expect(error).toContainText('U2');
});
