/**
 * Alpha UX-P1: Build in the main toolbar, beside Run (routine: fake build service and Session Host,
 * app/e2e/fixtures; builds take ~0.4 s there, so "Building…" is observable).
 *
 * Acceptance: Build in every view; Run without a current build offers Build directly; success and
 * failure feedback; no duplicate submission; edits invalidate the build; Build never runs and Run
 * never builds; Hebrew RTL and English LTR; keyboard and screen-reader semantics. Screenshots of
 * both locales are written to test-results/uxp1/.
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects, waitSaved } from './helpers.js';

const FAKE = 'http://127.0.0.1:7499';
const build = (page: Page) => page.getByTestId('toolbar-build');
const state = (page: Page) => page.getByTestId('toolbar-build-state');
const status = (page: Page) => page.getByTestId('sim-status');

async function openBlink(page: Page) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('open-example-esp32-blink').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}
/** POSTs of new builds, counted at the network. */
function buildSubmissions(page: Page) {
  const n = { count: 0 };
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/build/v1/builds') n.count++;
  });
  return n;
}

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/reset-builds`);
  await request.post(`${FAKE}/__test/end-all?reason=terminated`);
});

test('Build is in the toolbar in every view, next to Run, and absent without a program', async ({
  page,
}) => {
  await openBlink(page);
  for (const v of ['circuit', 'schematic', '3d', 'code']) {
    await page.getByTestId(`view-${v}`).click();
    await expect(build(page), v).toBeVisible();
    await expect(build(page)).toHaveText('Build');
  }
  // Beside Run, in the same toolbar group (DOM order: Build then Run).
  const order = await page
    .locator('.topbar-work')
    .evaluate((g) =>
      [...g.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')),
    );
  expect(order.indexOf('toolbar-build')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('toolbar-build')).toBeLessThan(order.indexOf('sim-run'));
  // A project without a program (a DC example) has no Build, as it has no Code view.
  await goToProjects(page);
  await page.getByTestId('open-example-ohms-law').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.getByTestId('sim-run')).toBeVisible();
  await expect(build(page)).toHaveCount(0);
  await expect(page.getByTestId('view-code')).toHaveCount(0);
});

test('Run without a current build offers Build; Build never runs; afterwards Run runs at once', async ({
  page,
}) => {
  await openBlink(page);
  const posts = buildSubmissions(page);
  await expect(state(page)).toHaveAttribute('data-phase', 'required');
  await expect(state(page)).toHaveText('Build required');
  // Run is aria-disabled (reachable), so a keyboard user can still activate it and is told why.
  await page.getByTestId('sim-run').focus();
  await page.keyboard.press('Enter');
  const notice = page.getByTestId('notice');
  await expect(notice).toHaveAttribute('data-key', 'run.blocked.buildRequired');
  await expect(status(page)).toHaveAttribute('data-status', 'stopped'); // Run did not build
  expect(posts.count).toBe(0);
  await page.getByTestId('notice-build').click();
  await expect(notice).toHaveCount(0);
  await expect(build(page)).toBeFocused(); // focus follows to the toolbar Build and its status
  await expect(state(page)).toHaveAttribute('data-phase', 'current', { timeout: 15_000 });
  await expect(state(page)).toHaveText('Built');
  expect(posts.count).toBe(1);
  await page.waitForTimeout(1_000);
  await expect(status(page)).toHaveAttribute('data-status', 'stopped'); // Build did not run
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
  // While the ESP32 runs, Build is unavailable (the code view's rule) and says why.
  await expect(build(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('toolbar-build-blocked')).toHaveText(
    'Build is available after Stop. The running session keeps the firmware it started with.',
  );
  await build(page).click({ force: true });
  expect(posts.count).toBe(1);
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 20_000 });
});

test('no duplicate submission while building; busy state is announced', async ({ page }) => {
  await openBlink(page);
  const posts = buildSubmissions(page);
  await build(page).click();
  await expect(build(page)).toHaveAttribute('aria-busy', 'true');
  await expect(build(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(state(page)).toHaveText('Building…');
  await build(page).click({ force: true });
  await build(page).press('Enter');
  await expect(state(page)).toHaveAttribute('data-phase', 'current', { timeout: 15_000 });
  expect(posts.count).toBe(1);
  await expect(build(page)).not.toHaveAttribute('aria-busy', 'true');
  await expect(state(page)).toHaveAttribute('role', 'status');
  await expect(state(page)).toHaveAttribute('aria-live', 'polite');
});

test('a failed build says so, Run explains it and offers the problems; an edit invalidates a build', async ({
  page,
}) => {
  await openBlink(page);
  // Success first, then an edit: the build is no longer current, Run needs a new one.
  await build(page).click();
  await expect(state(page)).toHaveAttribute('data-phase', 'current', { timeout: 15_000 });
  await page.getByTestId('view-code').click();
  await page.getByTestId('code-text').fill('// no setup here\nvoid loop() {}\n');
  await expect(state(page)).toHaveAttribute('data-phase', 'required');
  await expect(page.getByTestId('sim-run')).toHaveAttribute(
    'data-blocked',
    'run.blocked.buildRequired',
  );
  // A failing build.
  await page.getByTestId('view-circuit').click();
  await build(page).click();
  await expect(state(page)).toHaveAttribute('data-phase', 'failed', { timeout: 15_000 });
  await expect(state(page)).toHaveText('Build failed');
  // A mouse click on the aria-disabled Run (Playwright treats aria-disabled as disabled: force).
  await page.getByTestId('sim-run').click({ force: true });
  await expect(page.getByTestId('notice')).toHaveAttribute('data-key', 'run.blocked.buildFailed');
  await page.getByTestId('notice-build-problems').click();
  await expect(page.getByTestId('code-view')).toBeVisible();
  await expect(page.getByTestId('diagnostic').first()).toContainText("'setup' was not declared");
  // The toolbar's own "Show problems" does the same from another view.
  await page.getByTestId('view-3d').click();
  await page.getByTestId('toolbar-build-problems').click();
  await expect(page.getByTestId('code-view')).toBeVisible();
});

test('keyboard: Tab reaches Build, Enter builds; the accessible name is the label', async ({
  page,
}) => {
  await openBlink(page);
  await build(page).focus();
  await expect(build(page)).toBeFocused();
  await expect(build(page)).toHaveAccessibleName('Build');
  await page.keyboard.press('Enter');
  await expect(state(page)).toHaveAttribute('data-phase', 'current', { timeout: 15_000 });
  await expect(build(page)).toBeFocused(); // never lost to the page while it was busy
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('sim-run')).toBeFocused(); // Run is next: run at once
});

test('Hebrew RTL and English LTR toolbars (screenshots)', async ({ page }) => {
  await openBlink(page);
  await page.locator('.topbar').screenshot({ path: 'test-results/uxp1/toolbar-en-required.png' });
  await build(page).click();
  await expect(state(page)).toHaveAttribute('data-phase', 'current', { timeout: 15_000 });
  await page.locator('.topbar').screenshot({ path: 'test-results/uxp1/toolbar-en-built.png' });
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(build(page)).toHaveText('בנה קוד');
  await expect(state(page)).toHaveText('נבנה');
  await page.locator('.topbar').screenshot({ path: 'test-results/uxp1/toolbar-he-built.png' });
  await page.getByTestId('view-code').click();
  await page.getByTestId('code-text').fill('// no setup\nvoid loop() {}\n');
  await expect(state(page)).toHaveText('נדרשת בנייה');
  await build(page).click();
  await expect(state(page)).toHaveText('הבנייה נכשלה', { timeout: 15_000 });
  await expect(page.getByTestId('toolbar-build-problems')).toHaveText('הצגת הבעיות');
  await page.locator('.topbar').screenshot({ path: 'test-results/uxp1/toolbar-he-failed.png' });
  // The narrowest supported desktop width keeps Build visible (never in a menu).
  await page.setViewportSize({ width: 1024, height: 768 });
  const fits = () =>
    page.evaluate(() => {
      const bar = document.querySelector('.topbar') as HTMLElement;
      const vw = document.documentElement.clientWidth;
      const inside = (sel: string) => {
        const r = document.querySelector(sel)!.getBoundingClientRect();
        return r.left >= 0 && r.right <= vw;
      };
      return {
        noOverflow: bar.scrollWidth <= bar.clientWidth,
        build: inside('[data-testid="toolbar-build"]'),
        problems: inside('[data-testid="toolbar-build-problems"]'),
        run: inside('[data-testid="sim-run"]'),
        language: inside('[data-testid="language-select"]'),
        brand: inside('[data-testid="brand"]'),
      };
    });
  const all = {
    noOverflow: true,
    build: true,
    problems: true,
    run: true,
    language: true,
    brand: true,
  };
  // The failed state is the widest (it adds "Show problems"): nothing overflows, nothing hidden.
  expect(await fits()).toEqual(all);
  await expect(build(page)).toHaveAccessibleName('בנה קוד');
  await expect(state(page)).toHaveText('הבנייה נכשלה'); // visually compact, still the live text
  await page.locator('.topbar').screenshot({ path: 'test-results/uxp1/toolbar-he-1024.png' });
  await page.getByTestId('language-select').selectOption('en');
  expect(await fits()).toEqual(all);
  await expect(page.getByTestId('undo')).toHaveAccessibleName('Undo');
  await page.locator('.topbar').screenshot({ path: 'test-results/uxp1/toolbar-en-1024.png' });
});
