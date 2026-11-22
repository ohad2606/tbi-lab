/**
 * TBI-005: the MicroPython support panel (code area, MicroPython only), EN and HE:
 * - reachable and operable by keyboard; dialog role with an accessible name; Esc and the Close
 *   button close it and focus returns to the button that opened it; Tab stays inside while open;
 * - the content is the support contract (every entry: API as written, status as TEXT, refusal id,
 *   LTR technical tokens inside an RTL dialog), generated from runtime/builder/pyContract.ts;
 * - structure checks (named controls, headings, lists, no empty names); reflow at 320 CSS px.
 * (No axe-core in the repo; these are explicit structural checks. A screen-reader pass is manual.)
 */
import { expect, test, type Page } from '@playwright/test';
import { MICROPYTHON_CONTRACT } from '../../runtime/builder/pyContract.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import { goToProjects } from './helpers.js';

const TEXT = { en, he } as const;

async function openMicropythonCode(page: Page, example: string, lang: 'en' | 'he') {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(lang);
  await page.getByTestId(`open-example-${example}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.getByTestId('view-code').click();
}

for (const lang of ['en', 'he'] as const) {
  test(`${lang}: keyboard open, contract content, Esc, focus return`, async ({ page }) => {
    const T = TEXT[lang];
    await openMicropythonCode(page, 'mpy-blink', lang);
    const button = page.getByTestId('mpy-support-button');
    await expect(button).toHaveText(T['mpy.support.button']);
    await button.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByTestId('mpy-support-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
    // Role and accessible name.
    await expect(page.getByRole('dialog', { name: T['mpy.support.title'] })).toBeVisible();
    // Focus moved into the dialog (the Close button); the page behind is inert, so Tab never
    // reaches it (focus is in the dialog or has left the document for the browser's own UI).
    await expect(page.getByTestId('mpy-support-close')).toBeFocused();
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(
          () =>
            document.activeElement === document.body || !!document.activeElement?.closest('dialog'),
        ),
      ).toBe(true);
    }

    // Content = the contract: one entry each, API text, status as text, refusal id, notes.
    await expect(dialog.locator('li[data-testid^="mpy-entry-"]')).toHaveCount(
      MICROPYTHON_CONTRACT.length,
    );
    for (const e of MICROPYTHON_CONTRACT) {
      const li = dialog.getByTestId(`mpy-entry-${e.id}`);
      await expect(li).toHaveAttribute('data-status', e.status);
      await expect(li.locator('code').first()).toHaveText(e.api);
      await expect(li).toContainText(T[`mpy.support.status.${e.status}`]);
      await expect(li).toContainText(T[`mpy.support.at.${e.at}`]);
      if (e.refusal) await expect(li.locator('code').nth(1)).toHaveText(e.refusal);
      // Technical tokens stay LTR inside the (RTL) dialog.
      expect(await li.locator('bdi').first().getAttribute('dir')).toBe('ltr');
      const note = T[`mpy.contract.${e.id}.note` as keyof typeof T] as string;
      await expect(li).toContainText(note);
    }
    // Structure: one h2, sectioned h3, every control named, no empty headings.
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveCount(1);
    await expect(dialog.getByRole('heading', { level: 3 })).toHaveCount(2);
    for (const b of await dialog.getByRole('button').all())
      expect(((await b.textContent()) ?? '').trim().length).toBeGreaterThan(0);

    // Esc closes and focus returns to the button.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();

    // Close button path: Enter on Close, focus returns again.
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Enter'); // Close is focused
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();
  });
}

test('reflow at 320 CSS px: the dialog does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await openMicropythonCode(page, 'mpy-blink', 'he');
  const button = page.getByTestId('mpy-support-button');
  await button.scrollIntoViewIfNeeded();
  await button.click();
  const dialog = page.getByTestId('mpy-support-dialog');
  await expect(dialog).toBeVisible();
  const m = await dialog.evaluate((d) => ({
    sw: d.scrollWidth,
    cw: d.clientWidth,
    w: d.getBoundingClientRect().width,
  }));
  expect(m.sw).toBeLessThanOrEqual(m.cw);
  expect(m.w).toBeLessThanOrEqual(320);
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
});

test('the panel is offered for MicroPython only, not for Arduino C++', async ({ page }) => {
  await openMicropythonCode(page, 'esp32-led-fade', 'en');
  await expect(page.getByTestId('program-language')).toHaveValue(/arduino/);
  await expect(page.getByTestId('mpy-support-button')).toHaveCount(0);
  await page.getByTestId('program-language').selectOption('esp32-micropython-1.29');
  await expect(page.getByTestId('mpy-support-button')).toBeVisible();
});
