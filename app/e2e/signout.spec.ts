/**
 * Preview sign-out (deployment configuration). The routine build has no VITE_SIGN_OUT_URL and
 * shows no control; a second production build of the same source with
 * VITE_SIGN_OUT_URL=/oauth2/sign_out is served on :4174 (playwright.app.config.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { storedProjects, waitSaved } from './helpers.js';

const SIGNED = 'http://127.0.0.1:4174';
const signOut = (page: Page) => page.getByTestId('sign-out');

async function openExample(page: Page, base: string, id: string) {
  await page.goto(`${base}/`);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}

test('without a configured sign-out URL there is no sign-out control', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('example-list')).toBeVisible();
  await expect(signOut(page)).toHaveCount(0);
  await page.getByTestId('open-example-led-current').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(signOut(page)).toHaveCount(0);
});

test('configured: Sign out on Projects and in the editor, localized, keyboard reachable', async ({
  page,
}) => {
  await page.goto(`${SIGNED}/`);
  await page.getByTestId('language-select').selectOption('en');
  await expect(page.getByTestId('example-list')).toBeVisible();
  const link = page.getByRole('link', { name: 'Sign out', exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/oauth2/sign_out');

  await page.getByTestId('open-example-led-current').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(link).toBeVisible();

  // The control sits with the settings, and does not move when the simulation state changes.
  const x = async () => (await signOut(page).boundingBox())!.x;
  const stoppedAt = await x();
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  expect(await x()).toBe(stoppedAt);
  await page.getByTestId('sim-stop').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'stopped');
  expect(await x()).toBe(stoppedAt);

  await page.getByTestId('language-select').selectOption('he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const he = page.getByRole('link', { name: 'יציאה', exact: true });
  await expect(he).toBeVisible();
  await he.focus();
  await expect(he).toBeFocused();
  await page.getByRole('button', { name: /^‹?\s*פרויקטים$/ }).click();
  await expect(page.getByTestId('example-list')).toBeVisible();
  await expect(he).toBeVisible();
  await page.getByTestId('language-select').selectOption('en');
});

test('Sign out is a top-level navigation and leaves no auth state in projects', async ({
  page,
}) => {
  await openExample(page, SIGNED, 'esp32-blink');
  const before = await storedProjects(page);
  const prefsBefore = await page.evaluate(() => Object.keys(localStorage).sort());
  const nav = page.waitForRequest(
    (r) => r.isNavigationRequest() && new URL(r.url()).pathname === '/oauth2/sign_out',
  );
  // Keyboard activation of the link (Enter), like any link.
  await signOut(page).focus();
  await page.keyboard.press('Enter');
  const request = await nav;
  expect(request.method()).toBe('GET');
  expect(request.resourceType()).toBe('document');
  expect(request.frame()).toBe(page.mainFrame());
  await page.waitForURL(`${SIGNED}/oauth2/sign_out`);

  // (This test server has no proxy: its SPA fallback serves the app again.) Nothing about
  // signing out, sessions or the runtime was written into the projects or the preferences.
  await page.goto(`${SIGNED}/`);
  await expect(page.getByTestId('example-list').or(page.getByTestId('canvas'))).toBeVisible();
  const after = await storedProjects(page);
  expect(after).toEqual(before);
  expect(JSON.stringify(after)).not.toMatch(/sign_?out|oauth|session|token|cookie/i);
  expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual(prefsBefore);
});
