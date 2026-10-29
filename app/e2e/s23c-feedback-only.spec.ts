/**
 * Sprint 23C: the feedback-only release (`rc4-s23-feedback`), EN and HE. The :4175 build is made
 * with VITE_ADMIN_UI=reports and VITE_PROBLEM_REPORTS=1; its `/runtime` goes to the fake Session
 * Host's reports-mode listener (fixtures/fake-session-host.ts), whose `/admin` is the REAL
 * reports mode: the owner (`e2e-owner`) from an owner reference file, report routes only, every
 * account path 404. A tester (`e2e-user`, the default) sends feedback with the form; the owner
 * reads and deletes it in an administration that has the Feedback tab only, and the page never
 * calls an account endpoint. Screenshots: set TBI_SHOTS to a directory.
 */
import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';

const FEEDBACK = 'http://127.0.0.1:4175';
const FAKE = 'http://127.0.0.1:7499';
const ID_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

const asOwner = (context: BrowserContext) =>
  context.addCookies([{ name: 'tbi_test_user', value: 'e2e-owner', url: FEEDBACK }]);

const shot = async (page: Page, name: string, testId: string) => {
  if (process.env.TBI_SHOTS)
    await page.getByTestId(testId).screenshot({ path: `${process.env.TBI_SHOTS}/${name}.png` });
};

/** Every administration call the page makes. */
function adminCalls(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r: Request) => {
    const path = new URL(r.url()).pathname;
    if (path.includes('/admin')) seen.push(`${r.method()} ${path}`);
  });
  return seen;
}

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/reset-reports`);
});

for (const locale of ['en', 'he'] as const)
  test(`${locale.toUpperCase()}: a tester sends feedback with the form; no administration entry`, async ({
    page,
  }) => {
    const calls = adminCalls(page);
    await page.goto(`${FEEDBACK}/`);
    await page.getByTestId('language-select').selectOption(locale);
    await page.getByTestId('open-example-led-current').click();
    await expect(page.getByTestId('canvas')).toBeVisible();
    const button = page.getByTestId('feedback-button');
    await expect(button).toHaveAccessibleName(locale === 'en' ? 'Feedback' : 'משוב');
    await expect(page.getByTestId('admin-button')).toHaveCount(0);
    await button.click();
    const dialog = page.getByTestId('report-dialog');
    await expect(dialog).toHaveAttribute('dir', locale === 'he' ? 'rtl' : 'ltr');
    await page.getByTestId('report-kind-feature').check();
    const text = locale === 'en' ? 'Please add a logic analyzer.' : 'אשמח למנתח לוגי.';
    await page.getByTestId('report-description').fill(text);
    await page.getByTestId('report-send').click();
    await expect(page.getByTestId('report-sent')).toBeVisible();
    expect(await page.getByTestId('report-id').textContent()).toMatch(ID_RE);
    await shot(page, `s23c-feedback-sent-${locale}`, 'report-dialog');
    const [r] = (await (await page.request.get(`${FAKE}/__test/reports`)).json()) as {
      kind: string;
      description: string;
      locale: string;
    }[];
    expect(r).toMatchObject({ kind: 'feature', description: text, locale });
    // The tester asked only whether it is the owner (the entry stays hidden).
    expect(calls.every((c) => c === 'GET /runtime/admin/me')).toBe(true);
  });

test('a tester: the report routes are 403, every account path is 404', async ({ page }) => {
  await page.goto(`${FEEDBACK}/`);
  for (const path of ['me', 'reports'])
    expect((await page.request.get(`${FEEDBACK}/runtime/admin/${path}`)).status(), path).toBe(403);
  for (const path of ['accounts', 'sessions', `requests/${'0'.repeat(26)}`])
    expect((await page.request.get(`${FEEDBACK}/runtime/admin/${path}`)).status(), path).toBe(404);
  // A forged identity header changes nothing (the gate replaces it).
  const forged = await page.request.get(`${FEEDBACK}/runtime/admin/reports`, {
    headers: { 'x-forwarded-user': 'e2e-owner' },
  });
  expect(forged.status()).toBe(403);
});

test('the owner: every account path is 404 too, any method', async ({ page, context }) => {
  await asOwner(context);
  await page.goto(`${FEEDBACK}/`);
  expect((await page.request.get(`${FEEDBACK}/runtime/admin/me`)).status()).toBe(200);
  for (const path of ['accounts', 'accounts/disable', 'sessions', `requests/${'0'.repeat(26)}`]) {
    expect((await page.request.get(`${FEEDBACK}/runtime/admin/${path}`)).status(), path).toBe(404);
    const post = await page.request.post(`${FEEDBACK}/runtime/admin/${path}`, {
      headers: { origin: FEEDBACK, 'sec-fetch-site': 'same-origin' },
      data: { email: 'new@example.invalid', target: 't_AAAAAAAAAAAAAAAA' },
    });
    expect(post.status(), `POST ${path}`).toBe(404);
  }
});

for (const locale of ['en', 'he'] as const)
  test(`owner ${locale.toUpperCase()}: the Feedback tab only; list, detail, confirmed delete; no account call`, async ({
    page,
    context,
  }) => {
    // Two reports from a tester (through the gate as e2e-user).
    for (const description of ['The LED never lights.', 'שורה ראשונה\nשורה שנייה'])
      expect(
        (
          await page.request.post(`${FEEDBACK}/runtime/reports`, {
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
    const calls = adminCalls(page);
    await page.goto(`${FEEDBACK}/`);
    await page.getByTestId('language-select').selectOption(locale);
    await page.getByTestId('admin-button').click();
    const dialog = page.getByTestId('admin-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('dir', locale === 'he' ? 'rtl' : 'ltr');
    // One tab, Feedback, selected and focused; no tester management anywhere.
    await expect(dialog.getByRole('tab')).toHaveCount(1);
    await expect(page.getByTestId('admin-tab-reports')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('admin-tab-reports')).toHaveText(
      locale === 'en' ? 'Feedback' : 'משוב',
    );
    await expect(page.getByTestId('admin-tab-reports')).toBeFocused();
    for (const id of [
      'admin-tab-testers',
      'admin-panel-testers',
      'admin-accounts',
      'admin-add',
      'admin-capacity',
    ])
      await expect(page.getByTestId(id)).toHaveCount(0);
    const list = page.getByTestId('admin-reports');
    await expect(list.locator('tbody tr')).toHaveCount(2);
    expect(await list.textContent()).not.toContain('LED never lights');
    if (locale === 'en')
      expect(await dialog.textContent()).not.toMatch(/Testers|Add a tester|Disable/);
    else expect(await dialog.textContent()).not.toContain('בודקים');
    await shot(page, `s23c-admin-feedback-only-${locale}`, 'admin-dialog');
    await list.locator('tbody tr').last().getByRole('button').click();
    await expect(page.getByTestId('admin-report-text')).toHaveText('The LED never lights.');
    await page.getByTestId('admin-report-delete').click();
    await expect(page.getByTestId('admin-confirm')).toBeVisible();
    await page.getByTestId('admin-confirm-ok').click();
    await expect(list.locator('tbody tr')).toHaveCount(1);
    await list.locator('tbody tr').first().getByRole('button').click();
    await page.getByTestId('admin-report-delete-tester').click();
    await page.getByTestId('admin-confirm-ok').click();
    await expect(page.getByTestId('admin-reports-empty')).toBeVisible();
    // Keyboard: arrows on the single tab go nowhere; Escape closes and returns focus.
    await page.getByTestId('admin-tab-reports').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('admin-tab-reports')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('admin-button')).toBeFocused();
    // Only the owner check and the report routes were called; never an account endpoint.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls)
      expect(c).toMatch(
        /^(GET \/runtime\/admin\/me|(GET|DELETE) \/runtime\/admin\/reports(\/[0-9A-Z-]+)?)$/,
      );
  });
