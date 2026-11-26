/**
 * WCAG 2.1.1 (BETA-G3): in probe mode every probe the pointer places can be placed with the
 * keyboard (EN + HE), with the same target and reading; outside probe mode keys do as before.
 */
import { expect, test, type Page } from '@playwright/test';
import { component, createProject, goToProjects, waitForStoredProject } from './helpers.js';

const TEXT = {
  en: {
    pins: /Enter or Space probes/,
    added: /Probe added: /,
    exists: /already placed/,
    clear: 'Remove all probes',
  },
  he: {
    pins: /Enter או רווח מודדים/,
    added: /נוסף .*: /,
    exists: /כבר מוצב/,
    clear: /הסרת כל נקודות המדידה/,
  },
} as const;

const plain = (s: string | null) => (s ?? '').replace(/[‎‏⁦-⁩]/g, '');

/** A project with PSU1 and, by default, a wire between its two pins, made by keyboard. */
async function open(page: Page, lang: 'en' | 'he', wire = true) {
  await page.addInitScript((l) => localStorage.setItem('tbi-lab.locale', l), lang);
  await createProject(page, `kbprobe-${lang}`);
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
  const psu = component(page, 'PSU1');
  await psu.focus();
  if (!wire) return psu;
  for (const key of ['w', 'Enter', 'Tab', 'Enter']) await page.keyboard.press(key);
  await waitForStoredProject(page, (d) => d.layout.wires.length === 1, 'one wire');
  return psu;
}

const readings = async (page: Page) =>
  (await page.locator('[data-testid^="probe-reading-"]').allTextContents()).map(plain).sort();

for (const lang of ['en', 'he'] as const) {
  test(`kbprobe (${lang}): part, pin and wire probes equal the pointer ones`, async ({ page }) => {
    const t = TEXT[lang];
    const psu = await open(page, lang);
    const status = page.getByTestId('kbwire-status');
    const toggle = page.getByTestId('canvas-probe');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('canvas-hint')).toContainText('Enter');

    // Current probe on the focused part.
    await psu.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('probe-reading-PSU1')).toBeVisible();
    await expect(status).toHaveText(t.added);
    await page.keyboard.press('Space');
    await expect(status).toHaveText(t.exists);
    await expect(page.locator('[data-testid^="probe-reading-"]')).toHaveCount(1);

    // Voltage probes on two pins (pin mode stays on, so several can be placed).
    await page.keyboard.press('w');
    await expect(status).toHaveText(t.pins);
    const pins = page.locator('[data-hit="terminal"][data-component="PSU1"]');
    await expect(pins.first()).toBeFocused();
    const first = await pins.first().getAttribute('data-terminal');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(`probe-reading-PSU1.${first}`)).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await expect(page.locator('[data-testid^="probe-reading-"]')).toHaveCount(3);
    // No wire was started.
    await expect(page.locator('.wire-preview, [data-kb-candidate="true"]')).toHaveCount(0);
    // Escape: first leaves the pins (focus back on the part), then probe mode.
    await page.keyboard.press('Escape');
    await expect(psu).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // Net probe on a wire selected with ].
    await page.keyboard.press(']');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid^="probe-reading-"]')).toHaveCount(4);
    await expect(page.locator('.probe-net')).toHaveCount(1);
    const keyboard = await readings(page);
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // The same targets by pointer give the same probes and readings.
    await page.getByRole('button', { name: t.clear }).click();
    await expect(page.locator('[data-testid^="probe-reading-"]')).toHaveCount(0);
    await toggle.click();
    await component(page, 'PSU1').locator('.component-hit').click();
    for (const i of [0, 1]) await pins.nth(i).locator('.terminal-hit').click({ force: true });
    const box = await page
      .locator('[data-hit="wire"] .wire-hit')
      .first()
      .evaluate((el) => {
        const line = el as SVGPolylineElement;
        const at = line.getPointAtLength(line.getTotalLength() / 2);
        const s = at.matrixTransform(line.getScreenCTM()!);
        return { x: s.x, y: s.y };
      });
    await page.mouse.click(box.x, box.y);
    await expect(page.locator('[data-testid^="probe-reading-"]')).toHaveCount(4);
    expect(await readings(page)).toEqual(keyboard);
  });

  test(`kbprobe (${lang}): readings while running; outside probe mode unchanged`, async ({
    page,
  }) => {
    const t = TEXT[lang];
    const psu = await open(page, lang, false);
    const none = page.locator('[data-testid^="probe-reading-"]');
    // Outside probe mode: Enter / Space on a part, on a pin (starts a wire) and on a wire.
    await psu.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press(']');
    await page.keyboard.press('Enter');
    await expect(none).toHaveCount(0);
    await psu.focus();
    await page.keyboard.press('w');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-kb-candidate="true"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(none).toHaveCount(0);

    // A grounded example, running: solved values, not the "no value" dash.
    await goToProjects(page);
    await page.getByTestId('open-example-ohms-law').click();
    const r1 = component(page, 'R1');
    await expect(r1).toBeVisible();
    const clear = page.getByRole('button', { name: t.clear });
    if (await clear.isVisible()) await clear.click();
    await page.getByTestId('sim-run').click();
    await expect(page.getByTestId('sim-stop')).toBeEnabled();
    await page.getByTestId('canvas-probe').focus();
    await page.keyboard.press('Space');
    await r1.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('probe-reading-R1')).toHaveText(/\d.*A/);
    await page.keyboard.press('w');
    const pin = page.locator('[data-hit="terminal"][data-component="R1"]').first();
    await expect(pin).toBeFocused();
    const name = `R1.${await pin.getAttribute('data-terminal')}`;
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(`probe-reading-${name}`)).toHaveText(/\d.*V/);
  });
}
