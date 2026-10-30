/**
 * Sprint 13 OS-03 / OS-06 under an ACTIVE ESP32 session on the real stack (Session Host + QEMU
 * Runtime v2, through TBI_RUNTIME_PROXY / TBI_BUILD_PROXY): dragging an environment slider sends
 * the intermediate values at a bounded rate (at most 10 per second, below the host's 50 per
 * second), the session never fails or warns about the rate, and the firmware reacts to the final
 * value of the drag.
 *
 * Skipped unless TBI_S12_REAL=1.
 */
import { expect, test, type Page } from '@playwright/test';
import { buildProgram, component, goToProjects } from './helpers.js';

test.skip(!process.env.TBI_S12_REAL, 'heavy: needs the real Session Host + QEMU (TBI_S12_REAL=1)');
test.describe.configure({ mode: 'serial' });

const status = (page: Page) => page.getByTestId('sim-status');

async function openExample(page: Page, id: string) {
  await page.goto('/');
  await expect(page.getByTestId('example-list').or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await page.getByTestId('example-list').isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
}

/** Build if Run says so (OS-08), then Run on the ESP32. */
async function runOnBoard(page: Page) {
  const run = page.getByTestId('sim-run');
  if ((await run.getAttribute('data-blocked')) === 'run.blocked.buildRequired') {
    await page.getByTestId('view-code').click();
    await buildProgram(page, 180_000);
    await page.getByTestId('view-circuit').click();
  }
  await expect(run).toBeEnabled();
  await run.click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 90_000 });
  await expect(status(page)).toHaveAttribute('data-engine', 'mcu');
}

/** Drag a range input from one end to the other in `moves` steps over about `ms`. */
async function drag(page: Page, testId: string, from: 'left' | 'right', moves: number, ms: number) {
  const box = (await page.getByTestId(testId).boundingBox())!;
  const y = box.y + box.height / 2;
  const x0 = from === 'left' ? box.x + 3 : box.x + box.width - 3;
  const x1 = from === 'left' ? box.x + box.width - 3 : box.x + 3;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  for (let i = 1; i <= moves; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / moves, y);
    await page.waitForTimeout(ms / moves);
    // The session is never failed by the stream of live values.
    expect(await status(page).getAttribute('data-status')).toBe('running');
  }
  await page.mouse.up();
}

async function noRateWarnings(page: Page) {
  const codes = await page
    .getByTestId('mcu-warnings')
    .locator('li')
    .evaluateAll((li) => li.map((e) => e.getAttribute('data-code')));
  expect(codes).not.toContain('rate_limited');
  expect(codes).not.toContain('transient_rejected');
}

test('night light: dragging the light from bright to dark and back; the firmware follows the final value', async ({
  page,
}) => {
  await openExample(page, 'esp32-night-light');
  await runOnBoard(page);
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0', {
    timeout: 60_000,
  });
  await component(page, 'LDR1').focus();
  const field = page.getByTestId('param-LDR1-illuminance');
  // To the dark end (1 lx) in 40 moves over 2 s: darkness reads HIGH.
  await drag(page, 'param-LDR1-illuminance-slider', 'right', 40, 2000);
  await expect(field).toHaveValue('1');
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '1', {
    timeout: 30_000,
  });
  // And back to the bright end (10 000 lx): LOW again.
  await drag(page, 'param-LDR1-illuminance-slider', 'left', 40, 2000);
  await expect(field).toHaveValue('10000');
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0', {
    timeout: 30_000,
  });
  await expect(status(page)).toHaveAttribute('data-status', 'running');
  if (await page.getByTestId('mcu-warnings').count()) await noRateWarnings(page);
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 60_000 });
});

test('distance alarm: dragging the HC-SR04 target near (0.10 m) lights the LED; the firmware measures it', async ({
  page,
}) => {
  await openExample(page, 'esp32-distance-alarm');
  await runOnBoard(page);
  await component(page, 'U2').focus();
  const field = page.getByTestId('param-U2-distance');
  // Drag towards the near end in 30 moves over 1.5 s, then 18 keyboard steps of exactly 5 mm
  // from the 1 cm end: 0.10 m (inside the HC-SR04's 2 cm ... 4 m range, below the sketch's
  // 20 cm alarm threshold).
  await drag(page, 'param-U2-distance-slider', 'right', 30, 1500);
  await expect(field).toHaveValue('0.01');
  const slider = page.getByTestId('param-U2-distance-slider');
  for (let i = 0; i < 18; i++) await slider.press('ArrowRight');
  await expect(field).toHaveValue('0.1');
  await expect(page.getByTestId('pin-level-2')).toHaveAttribute('data-level', '1', {
    timeout: 60_000,
  });
  await expect(status(page)).toHaveAttribute('data-status', 'running');
  if (await page.getByTestId('mcu-warnings').count()) await noRateWarnings(page);
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 60_000 });
});
