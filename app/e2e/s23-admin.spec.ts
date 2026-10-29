/**
 * Sprint 23B: the owner's administration, EN and HE, desktop and tablet. The :4174 build enables
 * it (VITE_ADMIN_UI=full). Sprint 23C: the accounts come from the REAL admin service
 * (`/admin-api/...`), the owner check and the reports from the REAL Session Host routes
 * (`/runtime/admin/...`), with a fake root helper (fixtures/fake-admin.ts). The test gate asserts the `tbi_test_user` cookie's
 * subject (`e2e-owner` is the owner; the default `e2e-user` is a tester) and, when set, the
 * `tbi_test_email` cookie's address. Screenshots: set TBI_SHOTS to a directory.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const ENABLED = 'http://127.0.0.1:4174';
const FAKE = 'http://127.0.0.1:7499';
const SIZES = {
  desktop: { width: 1400, height: 860 },
  tablet: { width: 1024, height: 768 },
} as const;

const asOwner = (context: BrowserContext, email = false) =>
  context.addCookies([
    { name: 'tbi_test_user', value: 'e2e-owner', url: ENABLED },
    ...(email ? [{ name: 'tbi_test_email', value: 'owner@example.invalid', url: ENABLED }] : []),
  ]);

const shot = async (page: Page, name: string) => {
  if (process.env.TBI_SHOTS)
    await page
      .getByTestId('admin-dialog')
      .screenshot({ path: `${process.env.TBI_SHOTS}/${name}.png` });
};

async function openAdmin(page: Page, locale = 'en') {
  await page.goto(`${ENABLED}/`);
  await page.getByTestId('language-select').selectOption(locale);
  await page.getByTestId('admin-button').click();
  const dialog = page.getByTestId('admin-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('admin-accounts')).toBeVisible();
  return dialog;
}

const row = (page: Page, masked: string) =>
  page.getByTestId('admin-accounts').locator('tbody tr', { hasText: masked });

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/reset-admin`);
  await request.post(`${FAKE}/__test/reset-reports`);
});

test('a tester sees no administration, and the API refuses them directly', async ({ page }) => {
  await page.goto(`${ENABLED}/`);
  await expect(page.getByTestId('feedback-button')).toBeVisible();
  await expect(page.getByTestId('admin-button')).toHaveCount(0);
  // Straight to the APIs (the page's own origin, through the gate): 403, nothing listed.
  for (const path of [
    'runtime/admin/me',
    'runtime/admin/reports',
    'admin-api/accounts',
    'admin-api/sessions',
  ]) {
    const r = await page.request.get(`${ENABLED}/${path}`);
    expect(r.status(), path).toBe(403);
    expect(await r.text()).not.toContain('example.invalid');
  }
  // A forged identity header changes nothing (the gate replaces it).
  const forged = await page.request.get(`${ENABLED}/admin-api/accounts`, {
    headers: { 'x-forwarded-user': 'e2e-owner', 'x-forwarded-email': 'owner@example.invalid' },
  });
  expect(forged.status()).toBe(403);
});

test('Sprint 23C: accounts are the admin service’s; the Session Host has no account route', async ({
  page,
  context,
}) => {
  await asOwner(context);
  const calls: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (/admin/.test(path)) calls.push(`${r.method()} ${path}`);
  });
  await openAdmin(page);
  for (const path of ['accounts', 'sessions', `requests/${'0'.repeat(26)}`])
    expect((await page.request.get(`${ENABLED}/runtime/admin/${path}`)).status(), path).toBe(404);
  expect((await page.request.get(`${ENABLED}/admin-api/accounts`)).status()).toBe(200);
  expect(calls).toContain('GET /admin-api/accounts');
  expect(calls).toContain('GET /admin-api/sessions');
  expect(calls).toContain('GET /runtime/admin/reports');
  expect(calls.filter((c) => /\/runtime\/admin\/(accounts|sessions|requests)/.test(c))).toEqual([]);
});

for (const [size, viewport] of Object.entries(SIZES))
  for (const locale of ['en', 'he'])
    test(`owner ${locale.toUpperCase()} ${size}: masked testers, capacity, warnings`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize(viewport);
      await asOwner(context);
      const dialog = await openAdmin(page, locale);
      await expect(dialog).toHaveAttribute('dir', locale === 'he' ? 'rtl' : 'ltr');
      await expect(page.getByTestId('admin-capacity-testers')).toContainText('2 / 20');
      await expect(page.getByTestId('admin-capacity-sessions')).toContainText('/ 6');
      const table = page.getByTestId('admin-accounts');
      await expect(table.locator('tbody tr')).toHaveCount(4);
      // Masked only: no full address anywhere in the dialog.
      expect(await dialog.textContent()).not.toMatch(/[a-z.]+@example\.invalid/);
      await expect(row(page, 'te***@example.invalid').first()).toBeVisible();
      await expect(page.getByTestId('admin-warning')).toHaveCount(1);
      if (locale === 'en') {
        await expect(table).toContainText('Not measured');
        await expect(table).toContainText('Disabled');
        await expect(page.getByTestId('admin-warning')).toContainText(
          'A different Google account signed in',
        );
      } else {
        await expect(table).toContainText('לא נמדד');
        await expect(page.getByTestId('admin-warning')).toContainText('חשבון Google אחר');
      }
      // The owner row has no action.
      await expect(row(page, 'ow***@example.invalid').getByRole('button')).toHaveCount(0);
      await shot(page, `s23-admin-testers-${locale}-${size}`);
    });

test('add a tester: masked result, the typed address revealed only on request', async ({
  page,
  context,
}) => {
  await asOwner(context);
  await openAdmin(page);
  await page.getByTestId('admin-add-submit').click();
  await expect(page.getByTestId('admin-add-problem')).toHaveText('Enter one valid email address.');
  await page.getByTestId('admin-add-email').fill('new.tester@example.invalid');
  await page.getByTestId('admin-add-submit').click();
  await expect(page.getByTestId('admin-notice')).toHaveText(
    'ne***@example.invalid was added and can sign in now.',
  );
  await expect(page.getByTestId('admin-add-last-address')).toHaveText('ne***@example.invalid');
  await page.getByTestId('admin-add-reveal').click();
  await expect(page.getByTestId('admin-add-last-address')).toHaveText('new.tester@example.invalid');
  await expect(page.getByTestId('admin-add-reveal')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('admin-add-reveal').click();
  await expect(row(page, 'ne***@example.invalid')).toContainText('Pending');
  // The same address again: the helper's code, said plainly.
  await page.getByTestId('admin-add-email').fill('new.tester@example.invalid');
  await page.getByTestId('admin-add-submit').click();
  await expect(page.getByTestId('admin-notice')).toHaveText('This address already has an account.');
  await shot(page, 's23-admin-added-en-desktop');
});

test('disable says what happens and needs a confirmation; reactivate likewise', async ({
  page,
  context,
}) => {
  await asOwner(context);
  await openAdmin(page);
  const target = row(page, 'te***@example.invalid').filter({ hasText: 'Active' }).first();
  await target.getByRole('button', { name: /^Disable / }).click();
  const confirm = page.getByTestId('admin-confirm');
  await expect(confirm).toBeVisible();
  await expect(page.getByRole('alertdialog', { name: 'Disable this tester?' })).toBeVisible();
  for (const line of [
    'They can no longer sign in.',
    'Their current requests are refused.',
    'Their running simulations are stopped.',
  ])
    await expect(confirm).toContainText(line);
  await expect(page.getByTestId('admin-confirm-cancel')).toBeFocused();
  await shot(page, 's23-admin-confirm-disable-en-desktop');
  // Escape leaves the confirmation, not the administration.
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId('admin-dialog')).toBeVisible();
  await expect(page.getByTestId('admin-capacity-testers')).toContainText('2 / 20');

  await row(page, 'te***@example.invalid')
    .filter({ hasText: 'Active' })
    .first()
    .getByRole('button', { name: /^Disable / })
    .click();
  await page.getByTestId('admin-confirm-ok').click();
  await expect(page.getByTestId('admin-notice')).toContainText('has ended.');
  await expect(page.getByTestId('admin-capacity-testers')).toContainText('1 / 20');
  // Reactivate the former tester: the confirmation names the cap.
  await row(page, 'fo***@example.invalid')
    .getByRole('button', { name: /^Reactivate / })
    .click();
  await expect(page.getByTestId('admin-confirm')).toContainText('one of the 20 tester places');
  await page.getByTestId('admin-confirm-ok').click();
  await expect(page.getByTestId('admin-notice')).toHaveText(
    'fo***@example.invalid can sign in again.',
  );
  await expect(page.getByTestId('admin-capacity-testers')).toContainText('2 / 20');
});

test('HE: the confirmation of a revoking action, right to left', async ({ page, context }) => {
  await page.setViewportSize(SIZES.tablet);
  await asOwner(context);
  await openAdmin(page, 'he');
  await row(page, 'te***@example.invalid')
    .filter({ hasText: 'פעיל' })
    .first()
    .getByRole('button', { name: /^השבתת / })
    .click();
  const confirm = page.getByTestId('admin-confirm');
  await expect(confirm).toContainText('לא תתאפשר כניסה חדשה.');
  await expect(confirm).toContainText('סימולציות שרצות ייעצרו.');
  await shot(page, 's23-admin-confirm-disable-he-tablet');
  await page.getByTestId('admin-confirm-ok').click();
  await expect(page.getByTestId('admin-notice')).toContainText('הסתיימה');
});

test('a slow helper: 202 with the request id, then "check again" shows the result', async ({
  page,
  context,
  request,
}) => {
  await asOwner(context);
  await openAdmin(page);
  await request.post(`${FAKE}/__test/admin-hold?on=1`);
  await page.getByTestId('admin-add-email').fill('late@example.invalid');
  await page.getByTestId('admin-add-submit').click();
  await expect(page.getByTestId('admin-notice')).toContainText('still processing the request', {
    timeout: 10_000,
  });
  await expect(page.getByTestId('admin-add-check')).toBeVisible();
  await request.post(`${FAKE}/__test/admin-hold?on=0`);
  const check = page.getByTestId('admin-add-check');
  await expect(async () => {
    if (await check.isVisible()) await check.click();
    await expect(page.getByTestId('admin-notice')).toContainText(
      'la***@example.invalid was added',
      { timeout: 1000 },
    );
  }).toPass({ timeout: 15_000 });
  await expect(check).toHaveCount(0);
});

for (const locale of ['en', 'he'])
  test(`owner identity not yet recorded: a clear message (${locale.toUpperCase()})`, async ({
    page,
    context,
    request,
  }) => {
    await request.post(`${FAKE}/__test/admin-owner-unrecorded`);
    await asOwner(context, true); // recognised by the owner's email tag only
    await openAdmin(page, locale);
    await row(page, 'te***@example.invalid').first().getByRole('button').click();
    await page.getByTestId('admin-confirm-ok').click();
    await expect(page.getByTestId('admin-notice')).toHaveText(
      locale === 'en'
        ? 'Owner identity not yet recorded on the server; ask the operator to run the identity sync.'
        : 'זהות הבעלים עדיין לא נרשמה בשרת; בקשו מהמפעיל להריץ את סנכרון הזהויות.',
    );
    await shot(page, `s23-admin-owner-pending-${locale}-desktop`);
  });

for (const [size, viewport] of Object.entries(SIZES))
  for (const locale of ['en', 'he'])
    test(`feedback list and detail ${locale.toUpperCase()} ${size}: owner only, delete confirmed`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize(viewport);
      // A tester sends two reports (as e2e-user, through the gate).
      for (const description of ['The LED never lights.', 'שורה ראשונה\nשורה שנייה'])
        expect(
          (
            await page.request.post(`${ENABLED}/runtime/reports`, {
              data: {
                description,
                category: 'other',
                blocking: false,
                locale,
                view: 'home',
                kind: 'general',
              },
            })
          ).status(),
        ).toBe(201);
      await asOwner(context);
      await openAdmin(page, locale);
      await page.getByTestId('admin-tab-reports').click();
      const list = page.getByTestId('admin-reports');
      await expect(list.locator('tbody tr')).toHaveCount(2);
      // Metadata only in the list.
      expect(await list.textContent()).not.toContain('LED never lights');
      await shot(page, `s23-admin-reports-${locale}-${size}`);
      await list.locator('tbody tr').last().getByRole('button').click();
      await expect(page.getByTestId('admin-report-text')).toHaveText('The LED never lights.');
      await shot(page, `s23-admin-report-detail-${locale}-${size}`);
      await page.getByTestId('admin-report-delete').click();
      await expect(page.getByTestId('admin-confirm')).toBeVisible();
      await page.getByTestId('admin-confirm-ok').click();
      await expect(list.locator('tbody tr')).toHaveCount(1);
      // Delete all of that tester.
      await list.locator('tbody tr').first().getByRole('button').click();
      await page.getByTestId('admin-report-delete-tester').click();
      await page.getByTestId('admin-confirm-ok').click();
      await expect(page.getByTestId('admin-reports-empty')).toBeVisible();
    });

test('keyboard: the tabs move with the arrow keys; Tab stays inside; Escape closes and returns focus', async ({
  page,
  context,
}) => {
  await asOwner(context);
  await openAdmin(page);
  await expect(page.getByTestId('admin-tab-testers')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('admin-tab-reports')).toBeFocused();
  await expect(page.getByTestId('admin-tab-reports')).toHaveAttribute('aria-selected', 'true');
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    expect(
      await page.getByTestId('admin-dialog').evaluate((d) => d.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('admin-dialog')).toHaveCount(0);
  await expect(page.getByTestId('admin-button')).toBeFocused();
});
