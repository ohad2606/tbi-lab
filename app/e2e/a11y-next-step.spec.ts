/**
 * TBI-014 slice 2: the next-step card after the first Run of the first-run example. Non-modal and
 * never takes focus; announced once through a polite status region; reachable by Tab; closes with
 * its button or Esc and returns focus to the simulation control; remembered per device; EN + HE
 * (right-to-left, the I(D1) token isolated left-to-right); compact at 320 px; no motion.
 * Each test uses its own browser context (a returning device: the welcome dialog stays out of the way).
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { markReturningUser } from './helpers/returningUser.js';

async function device(browser: Browser, baseURL: string | undefined, lang: 'en' | 'he') {
  const context = await browser.newContext({
    baseURL,
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 800 },
  });
  await markReturningUser(context);
  const page = await context.newPage();
  await page.goto('/');
  if (lang === 'he') await page.getByTestId('language-select').selectOption('he');
  return { context, page };
}

async function runExample(page: Page) {
  await page.getByTestId('onboarding-open-starter').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  // Before the first Run there is no card.
  await expect(page.getByTestId('next-step')).toHaveCount(0);
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-stop')).toBeVisible();
}

test('EN: appears after Run without stealing focus, Tab reaches it, Esc closes and restores focus, once per device', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await device(browser, baseURL, 'en');
  await runExample(page);
  const card = page.getByTestId('next-step');
  await expect(card).toBeVisible();
  await expect(page.getByRole('region', { name: 'It is running. What to try next' })).toBeVisible();
  await expect(card.locator('li')).toHaveCount(3);
  await expect(card).toContainText('I(D1)');
  // Non-modal, polite announcement in a persistent status region, focus not moved into the card.
  await expect(page.getByTestId('next-step-status')).toHaveText(/next steps is above/);
  expect(await page.getByTestId('next-step-status').getAttribute('role')).toBe('status');
  expect(await card.evaluate((e) => e.contains(document.activeElement))).toBe(false);
  expect(await page.locator(':modal').count()).toBe(0);
  // Only real features are named: the controls the steps point to exist.
  await expect(page.getByTestId('canvas-probe')).toBeVisible();
  // 24px target, visible focus ring, reachable by Tab.
  const dismiss = page.getByTestId('next-step-dismiss');
  const box = (await dismiss.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(24);
  expect(box.width).toBeGreaterThanOrEqual(24);
  let reached = false;
  await page.getByTestId('sim-stop').focus();
  for (let i = 0; i < 60 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await dismiss.evaluate((e) => e === document.activeElement);
  }
  expect(reached).toBe(true);
  const ring = await dismiss.evaluate((e) => {
    const s = getComputedStyle(e);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  expect(ring.style).not.toBe('none');
  expect(ring.width).toBeGreaterThan(0);
  // No motion with reduced motion; the card stays (no timer hides it).
  expect(await card.evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
  await page.waitForTimeout(1500);
  await expect(card).toBeVisible();
  // Stopping (step 2) keeps the card.
  await page.getByTestId('sim-stop').click();
  await expect(card).toBeVisible();
  // Esc from inside closes it, focus goes to the simulation control.
  await dismiss.focus();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('sim-run')).toBeFocused();
  // Once per device: not again after a Run or a reload.
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-stop')).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.reload();
  await runExample(page);
  await expect(card).toHaveCount(0);
  await context.close();
});

test('HE: translated, right-to-left, I(D1) isolated left-to-right, button closes', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await device(browser, baseURL, 'he');
  await runExample(page);
  const card = page.getByTestId('next-step');
  await expect(card).toBeVisible();
  await expect(page.getByRole('region', { name: 'זה רץ. מה לנסות עכשיו' })).toBeVisible();
  expect(await card.evaluate((e) => getComputedStyle(e).direction)).toBe('rtl');
  await expect(card).toContainText('⁦I(D1)⁩');
  await expect(page.getByTestId('next-step-status')).toContainText('הסימולציה רצה');
  await expect(page.getByTestId('next-step-dismiss')).toHaveText('הבנתי');
  await page.getByTestId('next-step-dismiss').click();
  await expect(card).toHaveCount(0);
  await context.close();
});

test('320 px: the card fills its column without overflow and its button remains a 24px target', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await device(browser, baseURL, 'en');
  await page.setViewportSize({ width: 320, height: 800 });
  await runExample(page);
  const card = page.getByTestId('next-step');
  await expect(card).toBeVisible();
  const box = (await card.boundingBox())!;
  // The editor workspace as a whole is desktop-first (not part of this slice); the card itself
  // must fit its column (the workspace's own min width) and not overflow its own box.
  const column = (await page.locator('.workspace-center').boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(column.width + 1);
  expect(await card.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  const b = (await page.getByTestId('next-step-dismiss').boundingBox())!;
  expect(b.height).toBeGreaterThanOrEqual(24);
  await context.close();
});

test('not shown for a project that did not come from the first-run example', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await device(browser, baseURL, 'en');
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('next-step')).toHaveCount(0);
  await context.close();
});
