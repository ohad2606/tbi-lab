/**
 * RC6 W2: the REAL Build -> Run path for an Arduino and a MicroPython project, EN and
 * HE, on the staging stack (real build service, Session Host, QEMU Runtime v5). Screenshots of each
 * project running after a successful build go to TBI_SHOTS_DIR. Skipped unless TBI_W2_REAL=1; setup as
 * rc6-golden-real.spec.ts (TBI_RUNTIME_PROXY / TBI_BUILD_PROXY at the real backends).
 */
import { expect, test, type Page } from '@playwright/test';
import { buildProgram, component, goToProjects, waitSaved } from './helpers.js';

test.setTimeout(900_000);
test.skip(!process.env.TBI_W2_REAL, 'heavy: TBI_W2_REAL=1');
test.describe.configure({ mode: 'serial' });
const SHOTS = process.env.TBI_SHOTS_DIR ?? 'test-results';
const status = (p: Page) => p.getByTestId('sim-status');

async function open(page: Page, id: string, lang: 'en' | 'he') {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(lang);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}
async function buildRun(page: Page, profile: string) {
  await page.getByTestId('view-code').click();
  await expect(page.getByTestId('program-language')).toHaveValue(profile);
  await buildProgram(page, 300_000);
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 300_000 });
  await expect(status(page)).toHaveAttribute('data-engine', 'mcu');
}
async function shot(page: Page, name: string) {
  await page.addStyleTag({
    content: '*, *::before, *::after { font-family: "Liberation Sans", sans-serif !important; }',
  });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

for (const lang of ['en', 'he'] as const) {
  test(`Arduino (${lang}): LED fade builds and runs; GPIO18 is PWM, the LED shows its time-average`, async ({
    page,
  }) => {
    await open(page, 'esp32-led-fade', lang);
    await buildRun(page, 'esp32-arduino-3.3.12');
    await component(page, 'U1').locator('.component-hit').click({ force: true });
    await expect(page.getByTestId('mcu-live-18')).toHaveAttribute('data-pwm', 'wave', {
      timeout: 90_000,
    });
    await component(page, 'D1').locator('.component-hit').click({ force: true });
    await expect(page.getByTestId('result-pwm-note')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('result-current').first()).toContainText(/\d/);
    await shot(page, `arduino-led-fade-running-${lang}`);
    await page.getByTestId('sim-stop').click();
    await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 60_000 });
  });
  test(`MicroPython (${lang}): mpy-fade (genuine interpreter) builds and runs`, async ({
    page,
  }) => {
    await open(page, 'mpy-fade', lang);
    await buildRun(page, 'esp32-micropython-1.29');
    await component(page, 'U1').locator('.component-hit').click({ force: true });
    await expect(page.getByTestId('mcu-live-18')).toHaveAttribute('data-pwm', 'wave', {
      timeout: 90_000,
    });
    await component(page, 'D1').locator('.component-hit').click({ force: true });
    await expect(page.getByTestId('result-pwm-note')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('result-current').first()).toContainText(/\d/);
    await shot(page, `micropython-fade-running-${lang}`);
    await page.getByTestId('sim-stop').click();
    await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 60_000 });
  });
}
