/**
 * Sprint 16A (R4) HEAVY acceptance: the two PWM examples in the product UI through a REAL build
 * service, Session Host and QEMU Runtime v3 (capability pwm), on a local stack or staging, with
 * TBI_RUNTIME_PROXY / TBI_BUILD_PROXY pointing at the real backends (setup as s12-real.spec.ts).
 * Skipped unless TBI_S15_REAL=1 (routine CI has no QEMU).
 *
 * - LED fade: the real build requires pwm; GPIO18 shows a PWM waveform; the LED's result is the
 *   time-average with the PWM note (not a static level);
 * - servo sweep: the SG90's published angle reaches the commanded 0 deg and 180 deg (+/- 0.1 deg
 *   display rounding) from the firmware's 1.0 / 2.0 ms pulses.
 */
import { expect, test, type Page } from '@playwright/test';
import { buildProgram, component, goToProjects, waitSaved } from './helpers.js';

test.setTimeout(420_000);
test.skip(
  !process.env.TBI_S15_REAL,
  'heavy: needs the real Session Host + QEMU v3 (TBI_S15_REAL=1)',
);
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

test('ESP32 LED fade on real QEMU: GPIO18 is a PWM waveform; the LED shows its time-average', async ({
  page,
}, info) => {
  await openExample(page, 'esp32-led-fade');
  await runOnBoard(page);
  await select(page, 'U1');
  await expect(page.getByTestId('mcu-live-18')).toHaveAttribute('data-pwm', 'wave', {
    timeout: 90_000,
  });
  await select(page, 'D1');
  await expect(page.getByTestId('result-pwm-note')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('result-current').first()).toContainText(/\d/);
  await page.screenshot({ path: info.outputPath('s15-real-led-fade.png') });
  await expect(status(page)).toHaveAttribute('data-status', 'running');
  await stop(page);
});

test('ESP32 servo sweep on real QEMU: the SG90 reaches 0 deg and 180 deg from 1.0 / 2.0 ms pulses', async ({
  page,
}, info) => {
  await openExample(page, 'esp32-servo-sweep');
  await runOnBoard(page);
  await select(page, 'M1');
  const angle = page.getByTestId('result-state-angleDeg');
  // The sketch alternates 1.0 ms, 2.0 ms and 1.5 ms every second; the angle is published as it
  // moves (600 deg/s), so each end of travel is shown at some point within a cycle.
  await expect(angle).toHaveText(/^0°$/, { timeout: 120_000 });
  await expect(angle).toHaveText(/^180°$|^179\.9°$/, { timeout: 30_000 });
  await page.screenshot({ path: info.outputPath('s15-real-servo-sweep.png') });
  await expect(status(page)).toHaveAttribute('data-status', 'running');
  await stop(page);
});
