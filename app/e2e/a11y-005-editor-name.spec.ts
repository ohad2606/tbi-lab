/**
 * A11Y-005 (accessibility assessment): the code editor's accessible name follows the program's
 * ACTIVE language, in English and Hebrew — after Arduino → MicroPython → Arduino, after a reload,
 * and for a project opened directly in MicroPython. The name is read the way assistive technology
 * gets it (Playwright's role + accessible name, and an ARIA snapshot); the code is preserved
 * byte for byte across the switch.
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects, reopenFromLibrary, storedProjects, waitSaved } from './helpers.js';

const ARDUINO = 'esp32-arduino-3.3.12';
const MPY = 'esp32-micropython-1.29';
/** The accessible name, per interface language and programming language (isolates removed). */
const NAME = {
  en: { arduino: 'Arduino C++ source code of U1', mpy: 'MicroPython source code of U1' },
  he: { arduino: 'קוד המקור (Arduino C++) של U1', mpy: 'קוד המקור (MicroPython) של U1' },
} as const;
const strip = (s: string) => s.replace(/[⁦-⁩‎‏]/g, '');

async function open(page: Page, id: string, lang: 'en' | 'he') {
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

/** The editor's accessible name, as computed by the browser's accessibility tree. */
async function editorName(page: Page): Promise<string> {
  const editor = page.getByTestId('code-text');
  await expect(editor).toBeVisible();
  const snap = await editor.ariaSnapshot();
  const m = /textbox "([^"]*)"/.exec(snap);
  expect(m, snap).not.toBeNull();
  return strip(m![1]!);
}

async function expectName(page: Page, name: string) {
  await expect.poll(() => editorName(page)).toBe(name);
  // The same through Playwright's role query (what a screen reader user would search by): the
  // editor is found by its language, and not by the other one.
  const [is, isNot] = name.includes('MicroPython')
    ? ['MicroPython', 'Arduino']
    : ['Arduino C++', 'MicroPython'];
  await expect(page.getByRole('textbox', { name: is })).toHaveAttribute('data-testid', 'code-text');
  await expect(page.getByRole('textbox', { name: isNot })).toHaveCount(0);
}

for (const lang of ['en', 'he'] as const) {
  test(`A11Y-005 (${lang}): the editor's name follows Arduino → MicroPython → Arduino and a reload; code kept`, async ({
    page,
  }) => {
    await open(page, 'esp32-led-fade', lang);
    const code = page.getByTestId('code-text');
    const select = page.getByTestId('program-language');
    await expect(select).toHaveValue(ARDUINO);
    await expectName(page, NAME[lang].arduino);
    const arduinoCode = await code.inputValue();

    await select.selectOption(MPY);
    await expect(select).toHaveValue(MPY);
    await expectName(page, NAME[lang].mpy);
    const mpyCode = await code.inputValue();
    expect(mpyCode).not.toBe(arduinoCode);

    await select.selectOption(ARDUINO);
    await expectName(page, NAME[lang].arduino);
    await expect(code).toHaveValue(arduinoCode);

    // Back to MicroPython and reload: the stored project reopens in MicroPython, named so.
    await select.selectOption(MPY);
    await expect(code).toHaveValue(mpyCode);
    await waitSaved(page);
    const id = (await storedProjects(page)).find(
      (p) => Object.values(p.programs)[0]?.profile === MPY,
    )!.projectId;
    await page.reload();
    await reopenFromLibrary(page, id);
    await page.getByTestId('view-code').click();
    await expect(page.getByTestId('program-language')).toHaveValue(MPY);
    await expectName(page, NAME[lang].mpy);
    await expect(page.getByTestId('code-text')).toHaveValue(mpyCode);
    await page.getByTestId('program-language').selectOption(ARDUINO);
    await expect(page.getByTestId('code-text')).toHaveValue(arduinoCode);
    await expectName(page, NAME[lang].arduino);
  });

  test(`A11Y-005 (${lang}): a project opened directly in MicroPython is named MicroPython`, async ({
    page,
  }) => {
    await open(page, 'mpy-blink', lang);
    await expect(page.getByTestId('program-language')).toHaveValue(MPY);
    await expectName(page, NAME[lang].mpy);
    expect(await page.getByTestId('code-text').getAttribute('aria-label')).not.toMatch(/Arduino/);
  });
}
