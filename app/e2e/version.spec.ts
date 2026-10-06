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
