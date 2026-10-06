/**
 * Build identity in the running app (Sprint 10): the status line shows the identity compiled
 * into this build, the same as /version.json; technical tokens stay left-to-right in Hebrew; a
 * normal build never shows a preview label.
 */
import { expect, test } from '@playwright/test';

test('the visible version is the build that serves /version.json (EN/HE); no preview label', async ({
  page,
  request,
}) => {
  const v = await (await request.get('/version.json')).json();
  expect(v.product).toBe('TBI Lab');
  expect(v.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(v.shortCommit).toBe(v.commit.slice(0, 7));
  const res = await request.get('/version.json');
  expect(res.headers()['content-type']).toContain('application/json');
  await page.goto('/');
  const badge = page.getByTestId('app-version');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText(`v${v.version} · ${v.shortCommit}${v.dirty ? '+' : ''}`);
  await expect(badge).toHaveAttribute('data-commit', v.commit);
  // Details on focus: the full commit, environment and build time.
  await badge.focus();
  const details = page.getByTestId('app-version-details');
  await expect(details).toBeVisible();
  await expect(details).toContainText(v.commit);
  await expect(details).toContainText(v.environment);
  await expect(details).toContainText(v.builtAt);
  // Hebrew: the same tokens, left-to-right, in an RTL page.
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(badge).toHaveText(`v${v.version} · ${v.shortCommit}${v.dirty ? '+' : ''}`);
  expect(await badge.locator('bdi').evaluate((e) => getComputedStyle(e).direction)).toBe('ltr');
  await badge.focus();
  expect(
    await details
      .locator('dd', { hasText: v.commit })
      .evaluate((e) => getComputedStyle(e).direction),
  ).toBe('ltr');
  await page.getByTestId('language-select').selectOption('en');
  // A normal build: no preview strip, no preview title.
  await expect(page.getByTestId('preview-badge')).toHaveCount(0);
  expect(await page.title()).not.toMatch(/preview/i);
});

test('a newer deployed build shows "A new version is available" (EN/HE, LTR commit); reload is the user\'s choice', async ({
  page,
  request,
}) => {
  const v = await (await request.get('/version.json')).json();
  const newer = { ...v, commit: 'f'.repeat(40), shortCommit: 'fffffff', dirty: false };
  await page.route('**/version.json', (route) => route.fulfill({ json: newer }));
  await page.goto('/');
  await page.getByTestId('open-example-led-current').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  // A marker that only survives as long as the page is not reloaded.
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const banner = page.getByTestId('update-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('A new version is available');
  await expect(page.getByTestId('update-version')).toHaveText(`v${v.version} · fffffff`);
  // Never reloads by itself.
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
  // Hebrew: translated, the version token left-to-right.
  await page.getByTestId('language-select').selectOption('he');
  await expect(banner).toContainText('גרסה חדשה זמינה');
  expect(
    await page.getByTestId('update-version').evaluate((e) => getComputedStyle(e).direction),
  ).toBe('ltr');
  await page.getByTestId('language-select').selectOption('en');
  // A running simulation is not interrupted: Reload waits until it is stopped.
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('update-reload')).toBeDisabled();
  await expect(page.getByTestId('update-busy')).toHaveText('Stop the simulation to reload.');
  await page.getByTestId('sim-stop').click();
  await expect(page.getByTestId('sim-status')).not.toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('update-reload')).toBeEnabled();
  // "Later" hides it for this build.
  await page.getByTestId('update-later').click();
  await expect(banner).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(500);
  await expect(banner).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
});

test('the same build as served: no new-version banner', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app-version')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('update-banner')).toHaveCount(0);
});

test('Reload in the banner reloads the page into the served build', async ({ page, request }) => {
  const v = await (await request.get('/version.json')).json();
  let newer = true;
  await page.route('**/version.json', (route) =>
    newer
      ? route.fulfill({ json: { ...v, commit: 'e'.repeat(40), shortCommit: 'eeeeeee' } })
      : route.continue(),
  );
  await page.goto('/');
  await expect(page.getByTestId('app-version')).toBeVisible(); // the app is up
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByTestId('update-reload')).toBeEnabled();
  newer = false;
  await page.getByTestId('update-reload').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { marker?: number }).marker))
    .toBeUndefined();
  await expect(page.getByTestId('app-version')).toBeVisible();
});
