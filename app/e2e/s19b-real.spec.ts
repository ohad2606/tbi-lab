/**
 * Sprint 19B HEAVY acceptance (staging gate): the Exploration Foundation features in the product UI
 * through a REAL build service, Session Host and QEMU Runtime v4 (capability `unmodelled`), with
 * TBI_RUNTIME_PROXY / TBI_BUILD_PROXY pointing at the real backends (setup as s15-r4-real.spec.ts).
 * Skipped unless TBI_S19B_REAL=1 (routine CI has no QEMU).
 *
 * - X1: the `esp32-logic-and` example (AND gate at 3.0 V, read back by the ESP32) runs on Runtime
 *   v4: the gate output is shown and the sketch reports Y = A AND B on its serial output;
 * - MicroPython: the genuine interpreter builds a main.py on the LED-fade circuit; PWM at 50 % gives
 *   the LED's time-average with the PWM note;
 * - refused by name: an ADC read stops the run at the access (Runtime v4), naming analog input;
 *   an internal pull is refused at Build (the build reports it; Run refuses).
 */
import { expect, test, type Page } from '@playwright/test';
import { buildProgram, component, goToProjects, waitSaved } from './helpers.js';

test.setTimeout(420_000);
test.skip(
  !process.env.TBI_S19B_REAL,
  'heavy: needs the real stack on Runtime v4 (TBI_S19B_REAL=1)',
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
/** The LED-fade circuit with its program switched to MicroPython and replaced by `program`. */
async function micropython(page: Page, program: string) {
  await openExample(page, 'esp32-led-fade');
  await page.getByTestId('view-code').click();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('program-language').selectOption('esp32-micropython-1.29');
  await expect(page.getByTestId('code-view')).toContainText('main.py');
  await page.getByTestId('code-text').fill(program);
  await page.getByTestId('view-circuit').click();
  await waitSaved(page);
}

test('X1 on Runtime v4 (Sprint 21 review): GPIO18 driven HIGH into its 10 kΩ pull-down has no guaranteed ESP32 V_OH — refused by name', async ({
  page,
}, info) => {
  await openExample(page, 'esp32-logic-and');
  await buildProgram(page, 300_000);
  await page.getByTestId('sim-run').click();
  // ESP32 Table 5-3 states V_OH ≥ 0.8 × VDD with no load current (40 mA is typical): relied on
  // only at leakage-level current; GPIO18 HIGH feeds the 10 kΩ pull-down (≈ 330 µA).
  const err = page.getByTestId('sim-error');
  await expect(err).toHaveAttribute('data-code', 'logic_mcu_output_uncharacterized', {
    timeout: 120_000,
  });
  await expect(err).toContainText('GPIO18');
  await page.screenshot({ path: info.outputPath('s21l-real-x1-refused.png') });
});

test('MicroPython on Runtime v4: PWM at 50 % on GPIO18 gives the LED its time-average', async ({
  page,
}, info) => {
  await micropython(
    page,
    'from machine import Pin, PWM\nimport time\npwm = PWM(Pin(18), freq=5000, duty_u16=32768)\nprint("PWM-ON")\nwhile True:\n    time.sleep_ms(100)\n',
  );
  await buildProgram(page, 300_000);
  await runOnBoard(page);
  await select(page, 'U1');
  await expect(page.getByTestId('mcu-serial-output')).toContainText('PWM-ON', { timeout: 120_000 });
  await expect(page.getByTestId('mcu-live-18')).toHaveAttribute('data-pwm', 'wave', {
    timeout: 60_000,
  });
  await select(page, 'D1');
  await expect(page.getByTestId('result-pwm-note')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('result-current').first()).toContainText(/\d/);
  await page.screenshot({ path: info.outputPath('s19b-real-mpy-pwm.png') });
  await stop(page);
});

test('MicroPython: an ADC read stops the run at the access, naming analog input (Runtime v4)', async ({
  page,
}) => {
  await micropython(
    page,
    'from machine import ADC, Pin\nprint("ADC-START")\nadc = ADC(Pin(34))\nprint("ADC-VAL", adc.read_u16())\n',
  );
  await buildProgram(page, 300_000);
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'failed', { timeout: 120_000 });
  const error = page.getByTestId('sim-error');
  await expect(error).toContainText('analog input (ADC)');
  await expect(error).toContainText('does not model');
});

test('MicroPython: an internal pull-up is refused at Build, by name; Run refuses', async ({
  page,
}) => {
  await micropython(
    page,
    'from machine import Pin\nimport time\nb = Pin(4, Pin.IN, Pin.PULL_UP)\nwhile True:\n    time.sleep_ms(100)\n',
  );
  await page.getByTestId('view-code').click();
  await page.getByTestId('build-button').click();
  await expect(page.getByTestId('build-features')).toContainText('internal pull-up/pull-down', {
    timeout: 300_000,
  });
  await page.getByTestId('view-circuit').click();
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-error')).toContainText('internal pull-up/pull-down', {
    timeout: 90_000,
  });
});
