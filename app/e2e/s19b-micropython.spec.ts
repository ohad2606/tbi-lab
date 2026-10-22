/**
 * Sprint 19B (MicroPython M1): choosing the programming language of a board's program. Switching
 * starts the other environment's starter program (never a translation), after a confirmation when
 * the code was edited; the file is main.py and the toolchain is the genuine interpreter. (Building
 * and running MicroPython on the real stack: s19b-mpy.runtime.test.ts and the staging gate.)
 */
import { expect, test } from '@playwright/test';
import { goToProjects, waitSaved } from './helpers.js';

test('the Code view switches Arduino C++ ⇄ MicroPython, confirming before replacing edited code', async ({
  page,
}) => {
  page.on('pageerror', (e) => {
    throw e;
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
  // The example's code is not the starter: a confirmation first. Declined: nothing changes.
  let asked = 0;
  page.once('dialog', (d) => {
    asked++;
    void d.dismiss();
  });
  await language.selectOption('esp32-micropython-1.29');
  await expect(language).toHaveValue('esp32-arduino-3.3.12');
  await expect(page.getByTestId('code-text')).toHaveValue(/analogWrite/);
  // Accepted: the MicroPython starter, main.py, the genuine interpreter's toolchain.
  page.once('dialog', (d) => {
    asked++;
    void d.accept();
  });
  await language.selectOption('esp32-micropython-1.29');
  await expect(language).toHaveValue('esp32-micropython-1.29');
  await expect(page.getByTestId('code-text')).toHaveValue(/main\.py runs once/);
  await expect(page.getByTestId('code-view')).toContainText('main.py');
  await expect(page.getByTestId('code-view')).toContainText('MicroPython v1.29.0');
  await waitSaved(page);
  expect(asked).toBe(2);
  // Back to Arduino from the unedited starter: no confirmation needed.
  await language.selectOption('esp32-arduino-3.3.12');
  await expect(page.getByTestId('code-text')).toHaveValue(/void setup\(\)/);
  expect(asked).toBe(2);
});
