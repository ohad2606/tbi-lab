/**
 * Sprint 20 (logic) HEAVY acceptance (staging gate, run by the integrator): the ESP32 logic
 * examples in the product UI through a REAL build service, Session Host and QEMU runtime, with
 * TBI_RUNTIME_PROXY / TBI_BUILD_PROXY pointing at the real backends (setup as
 * s15-r4-real.spec.ts / s19b-real.spec.ts). Skipped unless TBI_S20L_REAL=1 (routine CI has no
 * QEMU; this file was NOT run by the logic agent).
 *
 * - C `esp32-logic-quad-and` (with the Sprint 20 1A/1B pull-downs): the session starts with every
 *   pad an input (1A/1B LOW through 10 kΩ, not floating); after setup() GPIO18/19 drive 1A/1B
 *   HIGH: 1Y HIGH lights D1; holding the push button makes 2Y HIGH (D2);
 * - D `esp32-logic-override`: the sketch toggles GPIO18 every second and prints the gate's output
 *   read back on GPIO19; closing the switch from the Inspector's logic panel keeps Y HIGH and the
 *   sketch reports the override.
 */
import { expect, test, type Page } from '@playwright/test';
import { buildProgram, component, goToProjects, waitSaved } from './helpers.js';

test.setTimeout(420_000);
test.skip(!process.env.TBI_S20L_REAL, 'heavy: needs the real stack (TBI_S20L_REAL=1)');
test.describe.configure({ mode: 'serial' });

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

test('C on the real runtime: ESP32 → SN74LVC08A → LEDs; D2 only while the button is held', async ({
  page,
}, info) => {
  await openExample(page, 'esp32-logic-quad-and');
  await buildProgram(page, 300_000);
  await runOnBoard(page);
  await expect(page.getByTestId('mcu-serial-output')).toContainText('1A=1 1B=1', {
    timeout: 90_000,
  });
  await select(page, 'U2');
  await expect(page.getByTestId('logic-level-a1')).toHaveText('HIGH', { timeout: 30_000 });
  await expect(page.getByTestId('logic-level-b1')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-level-y1')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-truth-HH')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('probe-reading-D1')).toContainText('mA');
  await expect(page.getByTestId('probe-reading-D2')).toContainText('0 A');
  await page.getByTestId('logic-gate-2').click();
  const hold = page.getByTestId('logic-control-SW1');
  // In an ESP32 project the docked terminal covers the lower Inspector: scroll the control into
  // view first, as a user would (a raw mouse press at an off-screen box lands on the terminal).
  await hold.scrollIntoViewIfNeeded();
  const b = (await hold.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId('logic-level-y2')).toHaveText('HIGH', { timeout: 30_000 });
  await expect(page.getByTestId('probe-reading-D2')).toContainText('mA');
  await page.screenshot({ path: info.outputPath('s20l-real-c.png') });
  await page.mouse.up();
  await expect(page.getByTestId('logic-level-y2')).toHaveText('LOW', { timeout: 30_000 });
  await stop(page);
});

test('D on the real runtime: GPIO18 blinks the OR gate, GPIO19 reads it back; the switch overrides', async ({
  page,
}, info) => {
  await openExample(page, 'esp32-logic-override');
  await buildProgram(page, 300_000);
  await runOnBoard(page);
  const serial = page.getByTestId('mcu-serial-output');
  await expect(serial).toContainText('A=1 Y=1', { timeout: 90_000 });
  await expect(serial).toContainText('A=0 Y=0', { timeout: 30_000 });
  await expect(serial).not.toContainText('A=1 Y=0');
  await select(page, 'U2');
  await expect(page.getByTestId('logic-mcu-a')).toContainText('GPIO18');
  await page.getByTestId('logic-control-SW1').click();
  await expect(page.getByTestId('logic-level-b')).toHaveText('HIGH', { timeout: 30_000 });
  await expect(serial).toContainText('A=0 Y=1 (switch override)', { timeout: 30_000 });
  await expect(page.getByTestId('logic-level-y')).toHaveText('HIGH');
  await page.screenshot({ path: info.outputPath('s20l-real-d.png') });
  await stop(page);
});
