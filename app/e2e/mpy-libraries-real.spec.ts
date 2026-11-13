/**
 * MicroPython expansion phase 2: supported and refused libraries on the REAL stack (staging build
 * service, Session Host, QEMU Runtime v5), in English and Hebrew, both programming languages.
 * - Supported: the managed LCD library examples (LiquidCrystal_PCF8574 / python_lcd) build and run.
 * - Refused: a MicroPython `import neopixel` is named at Build (library:neopixel) and Run is
 *   refused; an Arduino `#include <DHT.h>` (a library the build service does not have) does not
 *   build — the compiler's own message, in both interface languages.
 * Screenshots go to TBI_SHOTS_DIR. Skipped unless TBI_MPY_REAL=1; four session starts.
 */
import { expect, test, type Page } from '@playwright/test';
import { buildProgram, goToProjects, waitSaved } from './helpers.js';

test.setTimeout(900_000);
test.skip(!process.env.TBI_MPY_REAL, 'heavy: TBI_MPY_REAL=1');
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
async function shot(page: Page, name: string) {
  await page.addStyleTag({
    content: '*, *::before, *::after { font-family: "Liberation Sans", sans-serif !important; }',
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

for (const lang of ['en', 'he'] as const) {
  for (const id of ['esp32-lcd-library', 'mpy-lcd-library'])
    test(`${id} (${lang}): the managed library builds and runs`, async ({ page }) => {
      await open(page, id, lang);
      await page.getByTestId('view-code').click();
      await expect(page.getByTestId('code-libraries-count')).toContainText('1');
      await buildProgram(page, 300_000);
      await page.getByTestId('sim-run').click();
      await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 300_000 });
      await page.waitForTimeout(8000);
      await expect(status(page)).toHaveAttribute('data-status', 'running');
      await shot(page, `library-${id}-running-${lang}`);
      await page.getByTestId('sim-stop').click();
      await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 60_000 });
    });

  test(`MicroPython (${lang}): import neopixel is refused by name at Build; Run refused`, async ({
    page,
  }) => {
    await open(page, 'mpy-blink', lang);
    await page.getByTestId('view-code').click();
    await page
      .getByTestId('code-text')
      .fill('import neopixel\nfrom machine import Pin\nn = neopixel.NeoPixel(Pin(2), 1)\n');
    await page.getByTestId('build-button').click();
    await expect(page.getByTestId('build-phase')).toHaveAttribute('data-phase', 'current', {
      timeout: 300_000,
    });
    await expect(
      page.getByTestId('build-features').locator('li[data-feature="library:neopixel"]'),
    ).toBeVisible();
    await shot(page, `library-refused-neopixel-${lang}`);
    await page.getByTestId('view-circuit').click();
    await page.getByTestId('sim-run').click();
    await expect(page.getByTestId('sim-error')).toBeVisible({ timeout: 60_000 });
    await expect(status(page)).not.toHaveAttribute('data-status', 'running');
    await shot(page, `library-refused-neopixel-run-${lang}`);
  });

  test(`Arduino (${lang}): #include <DHT.h> (not on the build service) does not build`, async ({
    page,
  }) => {
    await open(page, 'esp32-blink', lang);
    await page.getByTestId('view-code').click();
    await page
      .getByTestId('code-text')
      .fill(
        '#include <DHT.h>\nDHT dht(4, DHT22);\nvoid setup() { dht.begin(); }\nvoid loop() {}\n',
      );
    await page.getByTestId('build-button').click();
    await expect(page.getByTestId('build-phase')).toHaveAttribute('data-phase', 'failed', {
      timeout: 300_000,
    });
    await expect(page.getByTestId('diagnostic').first()).toContainText('DHT.h');
    await shot(page, `library-refused-dht-arduino-${lang}`);
  });
}
