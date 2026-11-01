/**
 * Sprint 19B (MicroPython M1): choosing the programming language of a board's program. Code is never
 * translated; the file is main.py and the toolchain is the genuine interpreter. P1 (schema v7):
 * switching discards nothing, so no confirmation is asked: each language's code is kept and comes
 * back exactly; an example with a verified twin shows the twin's code. (Building
 * and running MicroPython on the real stack: s19b-mpy.runtime.test.ts and the staging gate.)
 */
import { expect, test } from '@playwright/test';
import { goToProjects, waitSaved } from './helpers.js';

test('the Code view switches Arduino C++ ⇄ MicroPython without confirmation and without losing code', async ({
  page,
}) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  let asked = 0;
  page.on('dialog', (d) => {
    asked++;
    void d.dismiss();
  });
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('open-example-esp32-led-fade').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.getByTestId('view-code').click();
  const language = page.getByTestId('program-language');
  await expect(language).toHaveValue('esp32-arduino-3.3.12');
  const arduino = await page.getByTestId('code-text').inputValue();
  expect(arduino).toMatch(/analogWrite/);
  // The LED fade has a verified MicroPython twin (mpy-fade, same circuit): its code, main.py.
  await language.selectOption('esp32-micropython-1.29');
  await expect(language).toHaveValue('esp32-micropython-1.29');
  await expect(page.getByTestId('code-text')).toHaveValue(/PWM\(Pin\(18\), freq=1000/);
  await expect(page.getByTestId('code-view')).toContainText('main.py');
  await expect(page.getByTestId('code-view')).toContainText('MicroPython v1.29.0');
  await expect(page.getByTestId('notice')).toHaveAttribute('data-key', 'program.language.restored');
  await waitSaved(page);
  // Back to Arduino: the example's code, exactly.
  await language.selectOption('esp32-arduino-3.3.12');
  await expect(page.getByTestId('code-text')).toHaveValue(arduino);
  expect(asked).toBe(0);
});

// Sprint 24 (M1): the MicroPython examples open as MicroPython programs (main.py, the genuine
// interpreter), on their circuits. (Their real-QEMU circuit results: s24-mpy/s24-i2c runtime tests.)
for (const [id, text] of [
  ['mpy-blink', /led = Pin\(2, Pin\.OUT\)/],
  ['mpy-button', /button = Pin\(34, Pin\.IN\)/],
  ['mpy-fade', /PWM\(Pin\(18\), freq=1000/],
  ['mpy-lcd-hello', /I2C\(0, scl=Pin\(22\), sda=Pin\(21\), freq=100000\)/],
] as const)
  test(`the ${id} example opens as a MicroPython program`, async ({ page }) => {
    page.on('pageerror', (e) => {
      throw e;
    });
    await page.goto('/');
    const library = page.getByTestId('example-list');
    await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
    if (!(await library.isVisible())) await goToProjects(page);
    await page.getByTestId(`open-example-${id}`).click();
    await expect(page.getByTestId('canvas')).toBeVisible();
    await page.getByTestId('view-code').click();
    await expect(page.getByTestId('program-language')).toHaveValue('esp32-micropython-1.29');
    await expect(page.getByTestId('code-text')).toHaveValue(text);
    await expect(page.getByTestId('code-view')).toContainText('main.py');
  });
