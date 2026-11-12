/**
 * RC6 for Alpha W2: the programming-language selector on the release that carries both the RC6
 * features and the approved Alpha branding. In English and Hebrew: the selector offers exactly
 * Arduino C++ and MicroPython, and switching works in both directions with an open example, as
 * docs/sprints/P1-LANGUAGE-SWITCH.md specifies: the other language's kept code (a verified twin) comes
 * back exactly, the code switched away from is kept in the project byte for byte, and no dialog
 * asks anything. Starting from an Arduino example (LED fade) and from a MicroPython one (its twin,
 * mpy-fade). With TBI_SHOTS_DIR set, the selector is also photographed expanded.
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects, storedProject, waitSaved } from './helpers.js';

const ARDUINO = 'esp32-arduino-3.3.12';
const MPY = 'esp32-micropython-1.29';
const SHOTS = process.env.TBI_SHOTS_DIR;
const RESTORED = { en: 'Its code is back exactly as you left it', he: 'חזר בדיוק' } as const;

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

/** Switch and check the notice: the target language's kept code came back. */
async function switchTo(page: Page, profile: string, lang: 'en' | 'he') {
  await page.getByTestId('program-language').selectOption(profile);
  await expect(page.getByTestId('program-language')).toHaveValue(profile);
  const notice = page.getByTestId('notice');
  await expect(notice).toHaveAttribute('data-key', 'program.language.restored');
  await expect(notice).toContainText(RESTORED[lang]);
}

for (const lang of ['en', 'he'] as const) {
  test(`selector (${lang}): Arduino C++ and MicroPython offered, in that order`, async ({
    page,
  }) => {
    await openExample(page, 'esp32-led-fade', lang);
    const select = page.getByTestId('program-language');
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue(ARDUINO);
    const options = await select
      .locator('option')
      .evaluateAll((o) => (o as HTMLOptionElement[]).map((x) => [x.value, x.textContent]));
    expect(options).toEqual([
      [ARDUINO, 'Arduino C++'],
      [MPY, 'MicroPython'],
    ]);
    // The code itself is left-to-right in both interface languages.
    expect(await page.getByTestId('code-text').evaluate((e) => getComputedStyle(e).direction)).toBe(
      'ltr',
    );
    if (SHOTS) {
      // A native <select> popup is not part of a page screenshot: show the list in place.
      await page.addStyleTag({
        content:
          '*, *::before, *::after { font-family: "Liberation Sans", sans-serif !important; }',
      });
      await select.evaluate((e) => {
        const s = e as HTMLSelectElement;
        s.size = s.options.length;
        s.style.height = 'auto';
        s.style.position = 'relative';
        s.style.zIndex = '50';
      });
      await select.focus();
      await page.screenshot({ path: `${SHOTS}/language-selector-open-${lang}.png` });
    }
  });

  test(`Arduino example (${lang}): Arduino -> MicroPython -> Arduino, both programs kept exactly`, async ({
    page,
  }) => {
    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs++;
      void d.dismiss();
    });
    page.on('pageerror', (e) => {
      throw e;
    });
    await openExample(page, 'esp32-led-fade', lang);
    const code = page.getByTestId('code-text');
    const arduino = await code.inputValue();
    expect(arduino).toMatch(/ledcWrite|analogWrite/);
    await switchTo(page, MPY, lang);
    await expect(page.getByTestId('code-view')).toContainText('main.py');
    await expect(code).toHaveValue(/PWM\(Pin\(18\), freq=1000/);
    const micropython = await code.inputValue();
    await switchTo(page, ARDUINO, lang);
    await expect(code).toHaveValue(arduino);
    await switchTo(page, MPY, lang);
    await expect(code).toHaveValue(micropython);
    await waitSaved(page);
    const stored = await storedProject(page);
    const board = Object.keys(stored.programs)[0]!;
    expect(stored.programs[board]!.profile).toBe(MPY);
    expect(stored.programs[board]!.text).toBe(micropython);
    expect(stored.programs[board]!.alternates?.map((a) => [a.profile, a.text])).toEqual([
      [ARDUINO, arduino],
    ]);
    expect(dialogs).toBe(0);
  });

  test(`MicroPython example (${lang}): MicroPython -> Arduino -> MicroPython, both programs kept exactly`, async ({
    page,
  }) => {
    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs++;
      void d.dismiss();
    });
    page.on('pageerror', (e) => {
      throw e;
    });
    await openExample(page, 'mpy-fade', lang);
    const select = page.getByTestId('program-language');
    await expect(select).toHaveValue(MPY);
    const code = page.getByTestId('code-text');
    const micropython = await code.inputValue();
    expect(micropython).toMatch(/PWM/);
    await switchTo(page, ARDUINO, lang);
    await expect(page.getByTestId('code-view')).not.toContainText('main.py');
    const arduino = await code.inputValue();
    expect(arduino).toMatch(/void setup\(\)/);
    await switchTo(page, MPY, lang);
    await expect(code).toHaveValue(micropython);
    await waitSaved(page);
    const stored = await storedProject(page);
    const board = Object.keys(stored.programs)[0]!;
    expect(stored.programs[board]!.text).toBe(micropython);
    expect(stored.programs[board]!.alternates?.map((a) => [a.profile, a.text])).toEqual([
      [ARDUINO, arduino],
    ]);
    expect(dialogs).toBe(0);
  });
}
