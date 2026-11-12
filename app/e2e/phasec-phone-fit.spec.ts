/**
 * Admin app design §6 (owner D4): the in-app administration on a real phone. The Lab is desktop
 * first (`.app { min-width: 1024px }`), and mobile Chrome and Edge shrink such a page to fit the
 * screen, so the dialog (100vw of the unscaled viewport) showed at about 40% of the width. While
 * the dialog is open on a narrow screen the minimum is dropped.
 *
 * Chromium's mobile emulation (isMobile) reproduces the shrink-to-fit: the layout viewport grows
 * to the 1024 px page (window.innerWidth 1024 on a 412 px phone). With the dialog open the
 * document must not be wider than the viewport, the layout viewport is the phone's width, and
 * the dialog fills it. The real-phone check stays part of the owner's acceptance.
 */
import { devices, expect, test } from '@playwright/test';

const ENABLED = 'http://127.0.0.1:4174';
const FAKE = 'http://127.0.0.1:7499';

const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7'];
test.use(pixel7);

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/reset-admin`);
});

for (const locale of ['en', 'he'] as const)
  test(`Pixel 7 ${locale.toUpperCase()}: with the dialog open the page fits the phone width`, async ({
    page,
    context,
  }) => {
    await context.addCookies([{ name: 'tbi_test_user', value: 'e2e-owner', url: ENABLED }]);
    await page.goto(`${ENABLED}/`);
    await page.getByTestId('language-select').selectOption(locale);
    // Without the dialog the Lab keeps its desktop minimum (unchanged behaviour).
    const closed = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    const phone = page.viewportSize()!.width;
    expect(phone).toBeLessThan(1024);
    expect(closed.scroll).toBeGreaterThanOrEqual(1024);
    expect(closed.inner).toBeGreaterThan(phone); // the shrink-to-fit the fix removes

    await page.goto(`${ENABLED}/#admin`);
    await page.reload();
    const dialog = page.getByTestId('admin-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('admin-accounts')).toBeVisible();
    const open = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(open.scroll).toBeLessThanOrEqual(open.inner);
    expect(open.inner).toBe(phone); // not shrunk to fit a 1024 px page
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.width - phone)).toBeLessThanOrEqual(1);
    expect(box!.x).toBeGreaterThanOrEqual(-0.5);

    // Closing the dialog restores the desktop layout.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    const after = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(after).toBeGreaterThanOrEqual(1024);
  });
