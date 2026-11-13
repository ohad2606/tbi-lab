/**
 * Accessibility GATE for the Admin app (a11y-audit branch): axe-core at WCAG 2.0/2.1/2.2 A and AA
 * tags on every screen, Hebrew (default, RTL) and English, on the desktop and phone projects of
 * playwright.admin.config.ts (and the admin project of playwright.a11y.config.ts). Violations not
 * in app/e2e/a11y-baseline.json (screen keys prefixed "admin-") fail. Plus keyboard regressions.
 * NOT a conformance claim (see app/e2e/a11y-helpers.ts).
 */
import { createHash } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { scan, unbaselined, writeJson } from '../../app/e2e/a11y-helpers.js';

const FAKE = 'http://127.0.0.1:7499';
const ALEX = `t_${createHash('sha256').update('account|tester.one@example.invalid').digest('base64url').slice(0, 16)}`;

const owner = async (context: BrowserContext, lang: 'he' | 'en') => {
  await context.addCookies([
    { name: 'tbi_test_user', value: 'e2e-owner', url: test.info().project.use.baseURL! },
  ]);
  await context.addInitScript((l) => localStorage.setItem('tbi-admin.locale', l), lang);
};

async function gate(page: Page, screen: string, lang: string) {
  const violations = await scan(page);
  writeJson(`gate/admin-${test.info().project.name}-${lang}-${screen}.json`, violations);
  expect(unbaselined(`admin-${screen}`, violations), `new axe violations on ${screen}`).toEqual([]);
}

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/reset-admin`);
  await request.post(`${FAKE}/__test/reset-reports`);
});

for (const lang of ['he', 'en'] as const)
  test(`axe (${lang}): every screen`, async ({ page, context }) => {
    test.setTimeout(120_000);
    await owner(context, lang);
    const phone = (page.viewportSize()?.width ?? 1280) < 700;
    for (const [screen, hash] of [
      ['today', 'today'],
      ['testers', 'testers'],
      ['tester', `testers/${ALEX}`],
      ['add', 'add'],
      ['feedback', 'feedback'],
      ['activity', 'activity'],
      [phone ? 'more' : 'settings', phone ? 'more' : 'settings'],
    ] as const) {
      await page.goto(`/#/${hash}`);
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
      await page.waitForLoadState('networkidle');
      await gate(page, screen, lang);
    }
    await page.goto('/#/add');
    await page.getByTestId('add-email').fill('not-an-address');
    await page.getByTestId('add-submit').click();
    await expect(page.getByTestId('add-problem')).toBeVisible();
    await gate(page, 'add-invalid', lang);
  });

test('keyboard: a route change moves focus to the new heading; the skip link works', async ({
  page,
  context,
}) => {
  await owner(context, 'en');
  await page.goto('/#/today');
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Tab');
  await expect(page.locator('a.skip')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await page.getByTestId('nav-testers').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('main h1').first()).toBeFocused();
});

test('keyboard: an invalid address is announced, marked invalid and focused', async ({
  page,
  context,
}) => {
  await owner(context, 'en');
  await page.goto('/#/add');
  await page.getByTestId('add-email').fill('not-an-address');
  await page.getByTestId('add-submit').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('add-problem')).toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('add-email')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('add-email')).toBeFocused();
});
