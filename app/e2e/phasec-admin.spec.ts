/**
 * Phase C: the owner's tester administration
 * on a phone (360×740, touch) and on a desktop, in English and Hebrew. The services are real (the
 * admin service and the Session Host's owner check); the root helper is the fake of
 * fixtures/fake-admin.ts. Synthetic identities only (example.invalid). Screenshots: TBI_SHOTS=dir.
 */
import { writeFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const ENABLED = 'http://127.0.0.1:4174';
const FAKE = 'http://127.0.0.1:7499';
const PHONE = { width: 360, height: 740 };
const DESKTOP = { width: 1400, height: 860 };

const asOwner = (context: BrowserContext) =>
  context.addCookies([{ name: 'tbi_test_user', value: 'e2e-owner', url: ENABLED }]);

/**
 * Evidence only. A phone-sized RTL page is wider than the viewport (the app under the dialog is a
 * desktop layout), and Playwright's viewport clip then lands on the scroll origin: blank images
 * while the dialog is painted correctly (verified: elementFromPoint finds the dialog's controls).
 * The compositor's own surface is what the user sees, so whole-page shots are taken from it.
 */
const shot = async (page: Page, name: string, whole = false) => {
  if (!process.env.TBI_SHOTS) return;
  const path = `${process.env.TBI_SHOTS}/${name}.png`;
  if (!whole) return void (await page.getByTestId('admin-dialog').screenshot({ path }));
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  writeFileSync(path, Buffer.from(data, 'base64'));
  await cdp.detach();
};

// A tester's record: a card on a narrow screen, a table row on a desktop (same test ids).
const card = (page: Page, text: string) =>
  page
    .getByTestId('admin-accounts')
    .getByTestId(/^admin-account-t_/)
    .filter({ hasText: text });

async function open(page: Page, locale: 'en' | 'he', viewport = PHONE) {
  await page.setViewportSize(viewport);
  // The language is chosen in the app first; the bookmarkable entry then opens the dialog.
  await page.goto(`${ENABLED}/`);
  await page.getByTestId('language-select').selectOption(locale);
  await page.goto(`${ENABLED}/#admin`);
  await page.reload();
  const dialog = page.getByTestId('admin-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('admin-accounts')).toBeVisible();
  return dialog;
}

/** Nothing scrolls sideways; every control in the dialog is a comfortable touch target. */
async function phoneLayoutOk(page: Page) {
  const box = await page.getByTestId('admin-dialog').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width + 0.5);
  const overflow = await page
    .getByTestId('admin-dialog')
    .evaluate((d) => d.scrollWidth - d.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const small = await page.getByTestId('admin-dialog').evaluate((d) =>
    [...d.querySelectorAll<HTMLElement>('button, input')]
      .filter((e) => e.offsetParent !== null && !e.classList.contains('text-button'))
      .map((e) => ({
        id: e.dataset.testid ?? e.id ?? e.textContent,
        h: e.getBoundingClientRect().height,
      }))
      .filter((x) => x.h < 43.5),
  );
  expect(small).toEqual([]);
}

test.use({ hasTouch: true });

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/reset-admin`);
});

for (const locale of ['en', 'he'] as const)
  test(`phone ${locale.toUpperCase()} 360×740: list with names and sign-in data, Israel time, no sideways scroll`, async ({
    page,
    context,
  }) => {
    await asOwner(context);
    const dialog = await open(page, locale);
    await expect(dialog).toHaveAttribute('dir', locale === 'he' ? 'rtl' : 'ltr');
    await expect(page.getByTestId('admin-capacity-testers')).toContainText('2 / 30');
    // The owner first, then by name; the disabled record is in its own list.
    const names = page.getByTestId('admin-account-name');
    await expect(names).toHaveCount(3);
    await expect(names.nth(0)).toHaveText('Owner');
    const alex = card(page, 'Alex T.');
    await expect(alex).toContainText('te***@example.invalid');
    await expect(alex.getByTestId('admin-account-count')).toHaveText('7');
    // 2026-11-02 15:07:20 UTC is 17:07 in Israel.
    await expect(alex.getByTestId('admin-account-last')).toContainText(
      locale === 'en' ? '5:07' : '17:07',
    );
    await expect(page.getByTestId('admin-account-never')).toHaveCount(1);
    await expect(page.getByTestId('admin-account-never')).toHaveText(
      locale === 'en' ? 'Never signed in' : 'עדיין לא נכנס/ה',
    );
    await expect(dialog).toContainText(locale === 'en' ? 'Israel time' : 'שעון ישראל');
    expect(await dialog.textContent()).not.toMatch(/[a-z.]+@example\.invalid/);
    await phoneLayoutOk(page);
    await shot(page, `phasec-top-${locale}-phone`, true);
    await alex.scrollIntoViewIfNeeded();
    await shot(page, `phasec-list-${locale}-phone`, true);
    await page.getByTestId('admin-filter-disabled').tap();
    await expect(card(page, 'fo***@example.invalid')).toContainText(
      locale === 'en' ? 'Disabled' : 'מושבת',
    );
    await expect(card(page, 'fo***@example.invalid')).toContainText('בודקת ל.');
    await shot(page, `phasec-disabled-${locale}-phone`, true);
  });

test('phone EN: add with a name, rename, disable (confirmed) and reactivate, all by touch', async ({
  page,
  context,
}) => {
  await asOwner(context);
  await open(page, 'en');
  // The add form opens on demand, its first field focused.
  await page.getByTestId('admin-add-open').tap();
  await expect(page.getByTestId('admin-add-name')).toBeFocused();
  // Invalid name: refused on the phone before anything is sent.
  await page.getByTestId('admin-add-name').fill('R2-D2');
  await page.getByTestId('admin-add-email').fill('new.person@example.invalid');
  await page.getByTestId('admin-add-submit').tap();
  await expect(page.getByTestId('admin-add-problem')).toContainText('letters');
  await page.getByTestId('admin-add-name').fill('  Test   B. ');
  await page.getByTestId('admin-add-submit').tap();
  await expect(page.getByTestId('admin-notice')).toHaveText(
    'Test B. was added and can sign in now.',
  );
  const named = card(page, 'Test B.');
  await expect(named).toContainText('ne***@example.invalid');
  await expect(named).toContainText('Pending');
  await expect(named.getByTestId('admin-account-never')).toBeVisible();
  await shot(page, 'phasec-added-en-phone', true);

  // Rename
  await named.getByTestId(/^admin-rename-t_/).tap();
  const input = page.getByTestId('admin-rename-input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Test B.');
  await input.fill('Test Ben-Example');
  await shot(page, 'phasec-rename-en-phone', true);
  await page.getByTestId('admin-rename-save').tap();
  await expect(page.getByTestId('admin-notice')).toHaveText(
    'The name was saved: Test Ben-Example.',
  );
  await expect(card(page, 'Test Ben-Example')).toBeVisible();
  await phoneLayoutOk(page);

  // Disable needs a confirmation that says exactly what happens.
  await card(page, 'Alex T.')
    .getByTestId(/^admin-disable-/)
    .tap();
  const confirm = page.getByTestId('admin-confirm');
  await expect(confirm).toContainText('Alex T. (te***@example.invalid)');
  await expect(confirm).toContainText('Their running simulations are stopped.');
  await expect(page.getByTestId('admin-confirm-cancel')).toBeFocused();
  await shot(page, 'phasec-confirm-disable-en-phone', true);
  await page.getByTestId('admin-confirm-ok').tap();
  await expect(page.getByTestId('admin-notice')).toHaveText('Access for Alex T. has ended.');
  await expect(page.getByTestId('admin-capacity-testers')).toContainText('1 / 30');
  await expect(card(page, 'Alex T.')).toHaveCount(0); // gone from the Active list
  await page.getByTestId('admin-filter-disabled').tap();
  const k = card(page, 'Alex T.');
  await expect(k).toContainText('Disabled');
  await expect(k.getByTestId('admin-account-count')).toHaveText('7'); // history kept
  await k.getByTestId(/^admin-reactivate-/).tap();
  await expect(page.getByTestId('admin-confirm')).toContainText('one of the 30 tester places');
  await page.getByTestId('admin-confirm-ok').tap();
  await expect(page.getByTestId('admin-notice')).toHaveText('Alex T. can sign in again.');
  await expect(page.getByTestId('admin-capacity-testers')).toContainText('2 / 30');
});

test('phone HE: add, rename and disable, right to left', async ({ page, context }) => {
  await asOwner(context);
  await open(page, 'he');
  await page.getByTestId('admin-add-open').tap();
  await page.getByTestId('admin-add-name').fill('בדיקה ד.');
  await page.getByTestId('admin-add-email').fill('named@example.invalid');
  await page.getByTestId('admin-add-submit').tap();
  await expect(page.getByTestId('admin-notice')).toContainText('בדיקה ד.');
  const named = card(page, 'בדיקה ד.');
  await expect(named).toContainText('na***@example.invalid');
  await named.getByTestId(/^admin-rename-t_/).tap();
  await page.getByTestId('admin-rename-input').fill('בדיקה דוגמה');
  await page.getByTestId('admin-rename-save').tap();
  await expect(page.getByTestId('admin-notice')).toHaveText('השם נשמר: בדיקה דוגמה.');
  await card(page, 'בדיקה דוגמה')
    .getByTestId(/^admin-disable-/)
    .tap();
  await expect(page.getByTestId('admin-confirm')).toContainText('סימולציות שרצות ייעצרו.');
  await shot(page, 'phasec-confirm-disable-he-phone', true);
  await page.getByTestId('admin-confirm-ok').tap();
  await expect(page.getByTestId('admin-notice')).toContainText('הסתיימה');
  // RTL: the card's status badge sits at the inline end (left) of the name.
  await page.getByTestId('admin-filter-disabled').tap();
  const c = card(page, 'בדיקה דוגמה');
  const name = await c.getByTestId('admin-account-name').boundingBox();
  const badge = await c.locator('.admin-status').boundingBox();
  expect(badge!.x).toBeLessThan(name!.x);
  await phoneLayoutOk(page);
  await shot(page, 'phasec-disabled-after-he-phone', true);
});

test('cap: 30 authorized testers fill every place; add is refused, a disabled tester frees one', async ({
  page,
  context,
  request,
}) => {
  await request.post(`${FAKE}/__test/admin-fill?n=30`);
  await asOwner(context);
  await open(page, 'en');
  await expect(page.getByTestId('admin-capacity-testers')).toContainText('30 / 30');
  await page.getByTestId('admin-add-open').tap();
  await expect(page.getByTestId('admin-add-cap-full')).toHaveText(
    'All tester places are taken. Disable a tester first.',
  );
  await expect(page.getByTestId('admin-add-submit')).toBeDisabled();
  // Every place taken: Cancel takes focus (the fields are disabled) and returns to the list.
  await expect(page.getByTestId('admin-add-cancel')).toBeFocused();
  await page.getByTestId('admin-add-cancel').tap();
  // Reactivating the disabled record would exceed the cap: the helper refuses, the UI says so.
  await page.getByTestId('admin-filter-disabled').tap();
  await card(page, 'fo***@example.invalid')
    .getByTestId(/^admin-reactivate-/)
    .tap();
  await page.getByTestId('admin-confirm-ok').tap();
  await expect(page.getByTestId('admin-notice')).toHaveText(
    'All tester places are taken. Disable a tester first.',
  );
  await shot(page, 'phasec-cap-full-en-phone', true);
  // Disabling one frees a place (the owner is never counted).
  await page.getByTestId('admin-filter-active').tap();
  await card(page, 'Alex T.')
    .getByTestId(/^admin-disable-/)
    .tap();
  await page.getByTestId('admin-confirm-ok').tap();
  await expect(page.getByTestId('admin-capacity-testers')).toContainText('29 / 30');
  await page.getByTestId('admin-add-open').tap();
  await expect(page.getByTestId('admin-add-cap-full')).toHaveCount(0);
  await expect(page.getByTestId('admin-add-submit')).toBeEnabled();
});

for (const locale of ['en', 'he'] as const)
  test(`desktop ${locale.toUpperCase()}: the same administration in a compact table`, async ({
    page,
    context,
  }) => {
    await asOwner(context);
    await open(page, locale, DESKTOP);
    await page.getByTestId('admin-filter-all').click();
    const table = page.locator('table[data-testid="admin-accounts"]');
    await expect(table.locator('tbody tr.admin-row')).toHaveCount(4);
    await expect(page.locator('li.admin-card')).toHaveCount(0);
    // One line per tester: the rows stack (no grid of cards).
    const tops = await table
      .locator('tbody tr.admin-row')
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(tops.length);
    await shot(page, `phasec-all-${locale}-desktop`);
  });

test('the #admin entry does nothing for a tester; names never reach a tester', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto(`${ENABLED}/#admin`);
  await expect(page.getByTestId('feedback-button')).toBeVisible();
  await expect(page.getByTestId('admin-dialog')).toHaveCount(0);
  const r = await page.request.get(`${ENABLED}/admin-api/accounts`);
  expect(r.status()).toBe(403);
  expect(await r.text()).not.toContain('Alex');
  const rename = await page.request.post(`${ENABLED}/admin-api/accounts/rename`, {
    data: { target: 't_AAAAAAAAAAAAAAAA', name: 'X' },
    headers: { origin: ENABLED },
  });
  expect(rename.status()).toBe(403);
});
