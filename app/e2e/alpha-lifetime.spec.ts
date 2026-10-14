/**
 * Alpha (Phase D): the session lifetime as the user meets it, against the fake Session Host (real
 * R2 transport and engine; app/e2e/fixtures), which reports and enforces a maximum lifetime like
 * the real host (30 minutes under the Alpha policy; seconds here).
 *  - no warning while the session is young; about a minute before the end, an amber notice (EN/HE)
 *    that says when and why, and that the project is saved;
 *  - at the end, the existing final message (`session_expired`); nothing extends the session;
 *  - Run again starts a fresh session; the stored project is unchanged throughout.
 */
import { expect, test, type Page } from '@playwright/test';
import { buildProgram, goToProjects, storedProject, waitSaved } from './helpers.js';

const FAKE = 'http://127.0.0.1:7499';
const status = (page: Page) => page.getByTestId('sim-status');
const banner = (page: Page) => page.getByTestId('session-expiring');

async function openBlink(page: Page) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('open-example-esp32-blink').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  await buildProgram(page);
}
async function runAndWait(page: Page) {
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
}

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/end-all?reason=terminated`);
});
test.afterEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/lifetime`); // back to unbounded for the other specs
});

test('a minute before the maximum lifetime: a notice; then session_expired; Run again is fresh; the project is unchanged', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await request.post(`${FAKE}/__test/lifetime?ms=66000`); // warning due at ~6 s, end at 66 s
  await openBlink(page);
  const before = await storedProject(page);
  await runAndWait(page);
  const t0 = Date.now();
  await page.waitForTimeout(2_500);
  await expect(banner(page)).toHaveCount(0); // young session: no warning
  await expect(banner(page)).toBeVisible({ timeout: 15_000 });
  const shownAfterS = (Date.now() - t0) / 1000;
  expect(shownAfterS).toBeGreaterThan(4);
  expect(shownAfterS).toBeLessThan(15);
  await expect(banner(page)).toHaveAttribute('role', 'status');
  await expect(banner(page)).toContainText('will end within a minute');
  await expect(banner(page)).toContainText(/at most \u2066?2\u2069? min/); // the host's value (66 s, rounded up), not a constant
  await expect(status(page)).toHaveAttribute('data-status', 'running'); // still running
  // The end: the host ends it; the existing final message, and the notice is gone.
  await expect(page.getByTestId('sim-error')).toHaveAttribute('data-code', 'session_expired', {
    timeout: 80_000,
  });
  const endedAfterS = (Date.now() - t0) / 1000;
  expect(endedAfterS).toBeGreaterThan(60); // never cut short
  expect(endedAfterS).toBeLessThan(75); // never extended
  await expect(page.getByTestId('sim-error')).toContainText('maximum duration');
  await expect(banner(page)).toHaveCount(0);
  expect(await storedProject(page)).toEqual(before);
  // Restart: a fresh session with the same lifetime and its own clock: no notice at its start.
  await runAndWait(page);
  await page.waitForTimeout(3_000);
  await expect(banner(page)).toHaveCount(0);
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 20_000 });
  expect(await storedProject(page)).toEqual(before);
});

test('Hebrew: the notice and the final message are translated; RTL', async ({ page, request }) => {
  await request.post(`${FAKE}/__test/lifetime?ms=4000`); // under a minute: the notice at once
  await openBlink(page);
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await runAndWait(page);
  await expect(banner(page)).toBeVisible({ timeout: 5_000 });
  await expect(banner(page)).toContainText('יסתיים בתוך דקה');
  await expect(banner(page)).toContainText(/\u2066?1\u2069? דק׳/); // under a minute: never "0"
  await expect(page.getByTestId('sim-error')).toHaveAttribute('data-code', 'session_expired', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('sim-error')).toContainText('המרבי שלו');
  await page.getByTestId('language-select').selectOption('en');
});
