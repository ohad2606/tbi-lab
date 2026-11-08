/**
 * P1 (owner report): the ESP32 ultrasonic distance alarm's Arduino code disappeared after
 * Arduino -> MicroPython -> Arduino. In the browser, English and Hebrew, desktop and tablet: the
 * example's code comes back byte for byte (also after a reload), the MicroPython side says plainly
 * that no verified version exists, and a multi-file program with a pinned library keeps every file.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { goToProjects, reopenFromLibrary, storedProject, waitSaved } from './helpers.js';

const OUT = 'test-results/p1-language-switch';
mkdirSync(OUT, { recursive: true });

async function openExample(page: Page, id: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}

for (const vp of [
  { n: 'desktop', width: 1400, height: 860 },
  { n: 'tablet', width: 1024, height: 768 },
])
  for (const lang of ['en', 'he'] as const)
    test(`distance alarm (${vp.n}, ${lang}): Arduino -> MicroPython -> Arduino keeps the example; reload keeps it`, async ({
      page,
    }) => {
      page.on('pageerror', (e) => {
        throw e;
      });
      let dialogs = 0;
      page.on('dialog', (d) => {
        dialogs++;
        void d.dismiss();
      });
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openExample(page, 'esp32-distance-alarm');
      if (lang === 'he') await page.getByTestId('language-select').selectOption('he');
      await page.getByTestId('view-code').click();
      const language = page.getByTestId('program-language');
      const code = page.getByTestId('code-text');
      await expect(language).toHaveValue('esp32-arduino-3.3.12');
      const original = await code.inputValue();
      expect(original).toMatch(/pulseIn/);
      // MicroPython: no verified version of this example; the starter, said so; nothing asked.
      await language.selectOption('esp32-micropython-1.29');
      await expect(language).toHaveValue('esp32-micropython-1.29');
      const notice = page.getByTestId('notice');
      await expect(notice).toHaveAttribute('data-key', 'program.language.started');
      await expect(notice).toContainText(lang === 'en' ? 'none has been verified' : 'לא אומתה');
      await expect(code).not.toHaveValue(/pulseIn/);
      await page.screenshot({ path: `${OUT}/alarm-${vp.n}-${lang}-mpy.png` });
      await waitSaved(page);
      // Back to Arduino: the example's code, byte for byte.
      await language.selectOption('esp32-arduino-3.3.12');
      await expect(notice).toHaveAttribute('data-key', 'program.language.restored');
      await expect(code).toHaveValue(original);
      expect(await code.evaluate((el) => getComputedStyle(el).direction)).toBe('ltr');
      await page.screenshot({ path: `${OUT}/alarm-${vp.n}-${lang}-arduino.png` });
      await waitSaved(page);
      const stored = await storedProject(page);
      const board = Object.keys(stored.programs)[0]!;
      expect(stored.schemaVersion).toBe(7);
      expect(stored.programs[board]!.text).toBe(original);
      expect(stored.programs[board]!.alternates?.[0]?.profile).toBe('esp32-micropython-1.29');
      // Reload: still exact.
      await page.reload();
      await reopenFromLibrary(page, stored.projectId);
      await page.getByTestId('view-code').click();
      await expect(page.getByTestId('code-text')).toHaveValue(original);
      expect(dialogs).toBe(0);
    });

test('a multi-file program with a pinned library: MicroPython twin and back, every file and the library kept', async ({
  page,
}) => {
  await openExample(page, 'esp32-lcd-library');
  await page.getByTestId('view-code').click();
  const before = await storedProject(page);
  const board = Object.keys(before.programs)[0]!;
  // The example comes with its verified MicroPython twin kept (alternates); the active side:
  const { alternates: _twin, ...arduinoActive } = before.programs[board]!;
  const arduino = JSON.stringify(arduinoActive);
  // An unsaved edit in display.cpp, then switch at once.
  await page.getByTestId('code-file-display.cpp').click();
  const edited =
    (await page.getByTestId('code-text').inputValue()) + '// edited before switching\n';
  await page.getByTestId('code-text').fill(edited);
  await page.getByTestId('program-language').selectOption('esp32-micropython-1.29');
  await expect(page.getByTestId('code-view')).toContainText('display.py');
  await expect(page.getByTestId('library-micropython.python-lcd')).toBeVisible();
  await page.getByTestId('program-language').selectOption('esp32-arduino-3.3.12');
  await expect(page.getByTestId('library-arduino.liquidcrystal-pcf8574')).toBeVisible();
  await waitSaved(page);
  const after = (await storedProject(page)).programs[board]!;
  const { alternates, ...active } = after;
  const expected = JSON.parse(arduino);
  expected.files = expected.files.map((f: { path: string; text: string }) =>
    f.path === 'display.cpp' ? { ...f, text: edited } : f,
  );
  expect(active).toEqual(expected);
  expect(alternates?.[0]?.files?.map((f) => f.path)).toEqual(['display.py']);
  expect(alternates?.[0]?.libraries).toEqual([
    { id: 'micropython.python-lcd', version: '0.0.0-git.7affb0b' },
  ]);
});
