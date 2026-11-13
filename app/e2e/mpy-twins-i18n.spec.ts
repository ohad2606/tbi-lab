/**
 * MicroPython expansion phase 2, in the browser (fake services, no build): English and Hebrew.
 * - Every verified twin pair opens from the list in both interface languages; switching the
 *   programming language shows the twin's exact program ("restored"), and switching back gives the
 *   original byte for byte; both are stored in the project; a reload keeps them.
 * - The managed-libraries panel follows the language: on the LCD library example it lists
 *   LiquidCrystal_PCF8574 for Arduino and python_lcd for MicroPython, in both interface languages;
 *   the thermo-hygrometer (the firmware's dht module, not a library) lists none in either language.
 * Screenshots go to TBI_SHOTS_DIR (default test-results/mpy-i18n).
 */
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { EXAMPLE_VARIANTS } from '../src/examples/catalog.js';
import { goToProjects, reopenFromLibrary, storedProjects, waitSaved } from './helpers.js';

const SHOTS = process.env.TBI_SHOTS_DIR ?? 'test-results/mpy-i18n';
mkdirSync(SHOTS, { recursive: true });
const ARDUINO = 'esp32-arduino-3.3.12';
const MPY = 'esp32-micropython-1.29';

async function openExample(page: Page, id: string, lang: 'en' | 'he') {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(lang);
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  await page.getByTestId('view-code').click();
}

const PAIRS = Object.entries(EXAMPLE_VARIANTS).filter(([a]) => !a.startsWith('mpy-'));

for (const lang of ['en', 'he'] as const)
  test(`every twin pair (${lang}): switch both ways, exact code, stored, kept after reload`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs++;
      void d.dismiss();
    });
    for (const [arduino] of PAIRS) {
      await openExample(page, arduino, lang);
      const code = page.getByTestId('code-text');
      const select = page.getByTestId('program-language');
      await expect(select).toHaveValue(ARDUINO);
      const original = await code.inputValue();
      await select.selectOption(MPY);
      await expect(page.getByTestId('notice')).toHaveAttribute(
        'data-key',
        'program.language.restored',
      );
      const twin = await code.inputValue();
      expect(twin, arduino).not.toBe(original);
      expect(await code.evaluate((e) => getComputedStyle(e).direction)).toBe('ltr');
      if (arduino === 'esp32-thermo-hygrometer' || arduino === 'esp32-distance-alarm')
        await page.screenshot({ path: `${SHOTS}/${arduino}-mpy-${lang}.png` });
      await select.selectOption(ARDUINO);
      await expect(code).toHaveValue(original);
      await waitSaved(page);
      // This project (each example opens a new one): its Arduino code and the kept twin, stored.
      const find = async () =>
        (await storedProjects(page)).find((p) => {
          const prog = Object.values(p.programs)[0];
          return prog?.text === original && prog.alternates?.[0]?.text === twin;
        });
      await expect.poll(find, { timeout: 10_000 }).toBeTruthy();
      const stored = (await find())!;
      if (arduino === 'esp32-thermo-hygrometer') {
        await page.reload();
        await reopenFromLibrary(page, stored.projectId);
        await page.getByTestId('view-code').click();
        await expect(page.getByTestId('code-text')).toHaveValue(original);
        await page.getByTestId('program-language').selectOption(MPY);
        await expect(page.getByTestId('code-text')).toHaveValue(twin);
      }
    }
    expect(dialogs).toBe(0);
  });

for (const lang of ['en', 'he'] as const)
  test(`managed libraries follow the programming language (${lang})`, async ({ page }) => {
    await openExample(page, 'esp32-lcd-library', lang);
    const libs = page.getByTestId('code-libraries');
    const arduinoLib = page.getByTestId('library-arduino.liquidcrystal-pcf8574');
    const mpyLib = page.getByTestId('library-micropython.python-lcd');
    await expect(arduinoLib).toBeVisible();
    await expect(mpyLib).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/libraries-arduino-${lang}.png` });
    await page.getByTestId('program-language').selectOption(MPY);
    await expect(mpyLib).toBeVisible();
    await expect(arduinoLib).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/libraries-micropython-${lang}.png` });
    // The DHT22 example: the dht module is the interpreter's, no managed library in either language.
    await openExample(page, 'mpy-thermo-hygrometer', lang);
    await expect(page.getByTestId('code-libraries-count')).toContainText('0');
    await expect(libs).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/libraries-none-dht-${lang}.png` });
  });
