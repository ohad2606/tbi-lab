/**
 * BETA-G3/G4 texts: the longer "What is sent" disclosure and the welcome window stay readable and
 * operable at 320 CSS px and at 200% zoom (a 640 x 360 viewport): no sideways scrolling, the
 * dialog scrolls, its actions are reachable by keyboard, and the disclosure is made of lists.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openAppMenu } from './helpers.js';

const ENABLED = 'http://127.0.0.1:4174';
const SIZES = [
  { name: '320px', width: 320, height: 568 },
  { name: '200% zoom', width: 640, height: 360 },
];

async function fits(page: Page, dialog: Locator) {
  const box = (await dialog.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height + 0.5);
  expect(await dialog.evaluate((d) => d.scrollWidth - d.clientWidth)).toBeLessThanOrEqual(0);
}

for (const locale of ['en', 'he'])
  for (const size of SIZES) {
    test(`report disclosure, ${locale}, ${size.name}`, async ({ page }) => {
      await page.goto(`${ENABLED}/`);
      await page.getByTestId('language-select').selectOption(locale);
      await page.getByTestId('open-example-led-current').click();
      await openAppMenu(page);
      await page.getByTestId('menu-report-problem').click();
      await page.setViewportSize(size);
      const dialog = page.getByTestId('report-dialog');
      await expect(dialog).toBeVisible();
      await fits(page, dialog);
      const disclosure = page.getByRole('region', {
        name: locale === 'he' ? 'מה נשלח' : 'What is sent',
      });
      const lists = disclosure.getByRole('list');
      await expect(lists).toHaveCount(2);
      await expect(lists.nth(0).getByRole('listitem')).toHaveCount(4);
      await expect(lists.nth(1).getByRole('listitem')).toHaveCount(2);
      await expect(disclosure).toContainText(locale === 'he' ? 'מזהה ההרצה' : 'run ID');
      await expect(disclosure).toContainText(locale === 'he' ? 'קוד השגיאה' : 'error code');
      // Reading order: what the app sends (the optional details included), then what the server
      // adds. Each list follows its intro paragraph and is not named a second time.
      const order = await disclosure.evaluate((el) =>
        [...el.children].map((c) => c.tagName.toLowerCase()),
      );
      expect(order).toEqual(['h3', 'p', 'ul', 'p', 'p', 'ul', 'p', 'p']);
      await expect(disclosure.locator(':scope > p').nth(1)).toContainText(
        locale === 'he' ? 'צירוף פרטים טכניים' : 'Include technical details',
      );
      for (const list of await lists.all()) await expect(list).toHaveAccessibleName('');
      // The dialog scrolls: the whole text can be read, and focus brings Send into view.
      expect(await dialog.evaluate((d) => d.scrollHeight > d.clientHeight)).toBe(true);
      const last = disclosure.locator('p').last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      await page.getByTestId('report-context').focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('report-send')).toBeFocused();
      await expect(page.getByTestId('report-send')).toBeInViewport();
      await fits(page, dialog);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    });

    test.describe(() => {
      // The welcome opens only on a new device: no stored flag (as first-run.spec.ts).
      test.use({ storageState: { cookies: [], origins: [] } });

      test(`welcome window, ${locale}, ${size.name}`, async ({ page }) => {
        await page.goto('/');
        const dialog = page.getByTestId('first-run-dialog');
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await page.getByTestId('language-select').selectOption(locale);
        await page.setViewportSize(size);
        await page.reload();
        await expect(dialog).toBeVisible();
        await fits(page, dialog);
        await expect(page.getByTestId('first-run-step-3')).toContainText(
          locale === 'he' ? 'נקודת מדידה' : 'probe',
        );
        const start = page.getByTestId('first-run-start');
        await start.focus();
        await expect(start).toBeInViewport();
        await page.getByTestId('first-run-step-1').scrollIntoViewIfNeeded();
        await expect(page.getByTestId('first-run-step-1')).toBeInViewport();
      });
    });
  }
