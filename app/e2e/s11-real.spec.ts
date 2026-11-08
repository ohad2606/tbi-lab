/**
 * Sprint 11 (R1) HEAVY acceptance: the two curated R1 examples in the product UI through a REAL
 * build service, Session Host and QEMU (staging or a local stack). Skipped unless TBI_S11_REAL=1
 * (routine CI has no QEMU); setup as s6-real.spec.ts, with TBI_RUNTIME_PROXY and TBI_BUILD_PROXY
 * pointing at the real backends. The firmware (the examples' program, built by the real build
 * service) copies GPIO34 to GPIO4; the PIR dome and the light level are live part parameters
 * mirrored to the running board (ADR-010).
 *
 * TBI_S11_EXPECT=s10 runs the compatibility case instead: this frontend against a Sprint 10
 * Session Host, which does not know the R1 parts; Run must fail explicitly, naming them.
 */
import { expect, test, type Page } from '@playwright/test';
import { buildProgram, component, goToProjects, waitSaved } from './helpers.js';

test.setTimeout(420_000);
test.skip(!process.env.TBI_S11_REAL, 'heavy: needs the real Session Host + QEMU (TBI_S11_REAL=1)');
test.describe.configure({ mode: 'serial' });
const OLD_HOST = process.env.TBI_S11_EXPECT === 's10';

const status = (page: Page) => page.getByTestId('sim-status');

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

test.describe('R1 host', () => {
  test.skip(OLD_HOST, 'the R1 cases need an R1 Session Host');

  test('ESP32 motion alarm on real QEMU: motion pulls the relay in, LED and buzzer follow; no motion releases it', async ({
    page,
  }) => {
    await openExample(page, 'esp32-motion-relay');
    await runOnBoard(page);
    await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0', {
      timeout: 60_000,
    });
    await page.getByTestId('actuator-U2').click();
    await expect(component(page, 'U2')).toHaveAttribute('data-motion', 'true');
    await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '1', {
      timeout: 30_000,
    });
    await expect(component(page, 'K1')).toHaveAttribute('data-energized', 'true');
    await expect(component(page, 'BZ1')).toHaveAttribute('data-sounding', 'true');
    await page.getByTestId('actuator-U2').click();
    await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0', {
      timeout: 30_000,
    });
    await expect(component(page, 'K1')).toHaveAttribute('data-energized', 'false');
    await expect(status(page)).toHaveAttribute('data-status', 'running');
    await stop(page);
  });

  test('ESP32 night light on real QEMU: darkness reads HIGH and lights the RGB LED; bright turns it off', async ({
    page,
  }) => {
    await openExample(page, 'esp32-night-light');
    await runOnBoard(page);
    await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0', {
      timeout: 60_000,
    });
    await component(page, 'LDR1').locator('.component-hit').click();
    const field = page.getByTestId('param-LDR1-illuminance');
    await expect(field).toBeEnabled();
    await field.fill('1');
    await field.press('Enter');
    await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '1', {
      timeout: 30_000,
    });
    await field.fill('300');
    await field.press('Enter');
    await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0', {
      timeout: 30_000,
    });
    await expect(status(page)).toHaveAttribute('data-status', 'running');
    await stop(page);
  });

  test('ESP32 projects: the matrix and the capacitor stay unavailable; the six R1 parts are offered', async ({
    page,
  }) => {
    await page.goto('/');
    const library = page.getByTestId('example-list');
    await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
    if (!(await library.isVisible())) await goToProjects(page);
    await page.getByTestId('open-example-esp32-motion-relay').click();
    await expect(page.getByTestId('canvas')).toBeVisible();
    for (const t of [
      'component.rgb_led',
      'component.buzzer',
      'sensor.pir_hc_sr501',
      'component.bjt_npn',
      'component.relay',
      'component.photoresistor',
    ])
      await expect(page.getByTestId(`palette-${t}`)).toBeEnabled();
    await expect(page.getByTestId('palette-display.led_matrix_8x8')).toHaveAttribute(
      'data-unavailable',
      'part_needs_runtime',
    );
    await expect(page.getByTestId('palette-component.capacitor')).toHaveAttribute(
      'data-unavailable',
      'part_time_dependent',
    );
  });
});

test('against a Sprint 10 Session Host: Run of an R1 example fails explicitly, naming the parts', async ({
  page,
}) => {
  test.skip(!OLD_HOST, 'compatibility case: TBI_S11_EXPECT=s10');
  await openExample(page, 'esp32-motion-relay');
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'failed', { timeout: 90_000 });
  const error = page.getByTestId('sim-error');
  await expect(error).toBeVisible();
  console.log(
    `old host refusal: code=${await error.getAttribute('data-code')} text=${await error.innerText()}`,
  );
  await expect(error).toContainText('U2');
});
