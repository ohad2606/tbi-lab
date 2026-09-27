/**
 * Preview sign-out (deployment configuration). The routine build has no VITE_SIGN_OUT_URL and
 * shows no control; a second production build of the same source with
 * VITE_SIGN_OUT_URL=/oauth2/sign_out is served on :4174 (playwright.app.config.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { openAppMenu, storedProjects, waitSaved } from './helpers.js';

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

test('configured: Sign out on Projects and in the editor menu, localized, keyboard reachable', async ({
  page,
}) => {
  await page.goto(`${SIGNED}/`);
  await page.getByTestId('language-select').selectOption('en');
  await expect(page.getByTestId('example-list')).toBeVisible();
  // Projects screen: a visible link beside the language selector.
  const link = page.getByRole('link', { name: 'Sign out', exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/oauth2/sign_out');
  await link.focus();
  await expect(link).toBeFocused();

  // Editor: the last item of the application menu, not beside Run/Stop.
  await page.getByTestId('open-example-led-current').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(signOut(page)).toHaveCount(0);
  await openAppMenu(page);
  const item = page.getByRole('menuitem', { name: 'Sign out', exact: true });
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute('href', '/oauth2/sign_out');
  await page.keyboard.press('End');
  await expect(item).toBeFocused();
  await page.keyboard.press('Escape');

  // The header does not move when the simulation state changes.
  const x = async () => (await page.getByTestId('app-menu-button').boundingBox())!.x;
  const stoppedAt = await x();
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  expect(await x()).toBe(stoppedAt);
  await page.getByTestId('sim-stop').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'stopped');
  expect(await x()).toBe(stoppedAt);

  await page.getByTestId('language-select').selectOption('he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await openAppMenu(page);
  await expect(page.getByRole('menuitem', { name: 'יציאה', exact: true })).toBeVisible();
  await page.getByTestId('menu-projects').click();
  await expect(page.getByTestId('example-list')).toBeVisible();
  await expect(page.getByRole('link', { name: 'יציאה', exact: true })).toBeVisible();
  await page.getByTestId('language-select').selectOption('en');
});

test('Sign out is a top-level navigation and leaves no auth state in projects', async ({
  page,
}) => {
  await openExample(page, SIGNED, 'esp32-blink');
  await openAppMenu(page);
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
