/**
 * Accessibility GATE for the Lab (a11y-audit branch): axe-core at WCAG 2.0/2.1/2.2 A and AA tags on
 * the main screens, in English (LTR) and Hebrew (RTL), plus scripted keyboard regressions.
 *
 * A violation fails the test unless it is listed in app/e2e/a11y-baseline.json, where every entry
 * names the gap-register ID it is tracked under. Fixing a gap means deleting its baseline entries;
 * new violations always fail. With TBI_A11Y_OUT set, every scan is also written as JSON.
 *
 * Runs under playwright.app.config.ts (CI's `npm run test:e2e`, the routine :4173 build) and under
 * playwright.a11y.config.ts (a protected build: sign-out, problem reports, administration).
 * Screens that a build does not have (e.g. the problem report) are skipped there.
 *
 * NOT a conformance claim: axe-core detects only part of the WCAG 2.2 failures. Keyboard, screen
 * reader, zoom, forced-colours and RTL checks by people remain required (manual protocol).
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects, waitSaved } from './helpers.js';
import { scan, unbaselined, writeJson } from './a11y-helpers.js';

const FAKE = 'http://127.0.0.1:7499';
const LANGS = ['en', 'he'] as const;
type Lang = (typeof LANGS)[number];

async function home(page: Page, lang: Lang) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(lang);
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
}

async function openBlink(page: Page) {
  await page.getByTestId('open-example-esp32-blink').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}

async function gate(page: Page, screen: string, lang: Lang) {
  const violations = await scan(page);
  writeJson(`gate/${lang}-${screen}.json`, violations);
  expect(unbaselined(screen, violations), `new axe violations on ${screen} (${lang})`).toEqual([]);
}

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/reset-builds`);
  await request.post(`${FAKE}/__test/end-all?reason=terminated`);
});

for (const lang of LANGS) {
  test(`axe (${lang}): Projects screen`, async ({ page }) => {
    await home(page, lang);
    await gate(page, 'home', lang);
  });

  test(`axe (${lang}): editor views, build, run, failure and menu`, async ({ page }) => {
    test.setTimeout(150_000);
    await home(page, lang);
    await openBlink(page);
    await gate(page, 'editor-circuit', lang);
    await page.getByTestId('view-schematic').click();
    await expect(page.locator('.view-slot')).toBeVisible();
    await page.waitForTimeout(1000);
    await gate(page, 'editor-schematic', lang);
    await page.getByTestId('view-code').click();
    await expect(page.getByTestId('code-text')).toBeVisible();
    await gate(page, 'editor-code', lang);
    // Build, Run: the running state with its serial terminal.
    await page.getByTestId('toolbar-build').click();
    await expect(page.getByTestId('toolbar-build-state')).toHaveAttribute('data-phase', 'current', {
      timeout: 20_000,
    });
    await page.getByTestId('sim-run').click();
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running', {
      timeout: 30_000,
    });
    await gate(page, 'running', lang);
    await page.getByTestId('sim-stop').click();
    await expect(page.getByTestId('sim-status')).not.toHaveAttribute('data-status', 'running', {
      timeout: 20_000,
    });
    // A failed build and the Run refusal it causes.
    await page.getByTestId('code-text').fill('// no setup here\nvoid loop() {}\n');
    await page.getByTestId('build-button').click();
    await expect(page.getByTestId('build-phase')).toHaveAttribute('data-phase', 'failed', {
      timeout: 20_000,
    });
    await gate(page, 'build-failed', lang);
    await page.getByTestId('sim-run').click({ force: true });
    await expect(page.getByTestId('notice')).toBeVisible();
    await gate(page, 'run-refused', lang);
    await page.getByTestId('app-menu-button').click();
    await expect(page.getByTestId('app-menu')).toBeVisible();
    await gate(page, 'menu', lang);
    await page.getByTestId('menu-capabilities').click();
    await expect(page.locator('dialog[open]')).toBeVisible();
    await gate(page, 'capabilities', lang);
  });

  test(`axe (${lang}): problem report dialog (protected builds only)`, async ({ page }) => {
    await home(page, lang);
    await openBlink(page);
    await page.getByTestId('app-menu-button').click();
    test.skip((await page.getByTestId('menu-report-problem').count()) === 0, 'no reports here');
    await page.getByTestId('menu-report-problem').click();
    await expect(page.getByTestId('report-dialog')).toBeVisible();
    await gate(page, 'report-dialog', lang);
  });
}

// ---- Scripted keyboard regressions (what works today must keep working) ----

test('keyboard: the code editor is not a trap (Escape, then Tab leaves it)', async ({ page }) => {
  await home(page, 'en');
  await openBlink(page);
  await page.getByTestId('view-code').click();
  const area = page.getByTestId('code-text');
  await area.focus();
  const before = await area.inputValue();
  await page.keyboard.press('Tab');
  await expect(area).toBeFocused(); // Tab indents inside the editor
  expect((await area.inputValue()).length).toBe(before.length + 2);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect(area).not.toBeFocused();
  await area.focus();
  await page.keyboard.press('Shift+Tab'); // Shift+Tab always leaves
  await expect(area).not.toBeFocused();
});

test('keyboard: view tabs by arrow keys; application menu opens and Escape returns focus', async ({
  page,
}) => {
  await home(page, 'en');
  await openBlink(page);
  await page.getByTestId('view-circuit').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('view-schematic')).toBeFocused();
  await expect(page.getByTestId('view-schematic')).toHaveAttribute('aria-selected', 'true');
  const menu = page.getByTestId('app-menu-button');
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('app-menu')).toBeVisible();
  await expect(page.locator('[role="menuitem"]').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('app-menu')).toBeHidden();
  await expect(menu).toBeFocused();
});

test('keyboard: Build and Run by keyboard; the build phase is a polite live region', async ({
  page,
}) => {
  await home(page, 'en');
  await openBlink(page);
  await page.getByTestId('toolbar-build').focus();
  await page.keyboard.press('Enter');
  const state = page.getByTestId('toolbar-build-state');
  await expect(state).toHaveAttribute('role', 'status');
  await expect(state).toHaveAttribute('data-phase', 'current', { timeout: 20_000 });
  await page.getByTestId('sim-run').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('mcu-serial-output')).toHaveAttribute('role', 'log');
  await page.getByTestId('sim-stop').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('sim-status')).not.toHaveAttribute('data-status', 'running', {
    timeout: 20_000,
  });
});
