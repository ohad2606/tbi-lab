/**
 * BETA-G1 small fixes (i) and (d): a queued email speaks of quiet hours only when that is why it
 * waits, and a failed email says what the owner can actually do, chosen from a fixed allow-list
 * of error classes (never the raw value). The outcome sentence is the row's visible message and
 * is spoken by the polite live region. Mocked endpoints, synthetic data, example.com only.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const row = (id: string, extra: object = {}) => ({
  id,
  name: `Tester ${id}`,
  email: `${id}@example.com`,
  role: 'Teacher',
  lang: 'en',
  status: 'email_failed',
  accountAdded: true,
  emailAttempts: 1,
  lastError: null,
  origin: 'web',
  createdAt: '2026-11-01T10:00:00Z',
  ...extra,
});

async function mock(
  page: Page,
  rows: object[],
  actions: Record<string, { status: number; json: unknown }> = {},
) {
  await page.route('**/admin-api/signups/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auto-approve')) return route.fulfill({ json: { enabled: false } });
    if (path.endsWith('/open')) return route.fulfill({ json: { signups: rows, rowStates: 1 } });
    const [, , , id, action] = path.split('/');
    return route.fulfill(actions[`${id}/${action}`] ?? { json: { record: null } });
  });
}

async function open(page: Page, context: BrowserContext, baseURL: string, lang: 'he' | 'en') {
  await context.addCookies([{ name: 'tbi_test_user', value: 'e2e-owner', url: baseURL }]);
  await context.addInitScript((l) => localStorage.setItem('tbi-admin.locale', l), lang);
  await page.goto('/#/signups');
}

const T = {
  en: {
    mismatchRow: 'the address on the request is not the one the account was added for',
    mismatchMsg: 'Resend will not help',
    generic: 'Account added, but the email was not sent. Use Resend.',
    quiet: /quiet hours/,
    waitMsg: 'is queued and will be sent automatically.',
    capMsg: 'waits because of the email limit',
  },
  he: {
    mismatchRow: 'הכתובת בבקשה אינה הכתובת שעבורה נוסף החשבון',
    mismatchMsg: 'שליחה חוזרת לא תעזור',
    generic: 'החשבון נוסף, אבל המייל לא נשלח. אפשר לשלוח שוב.',
    quiet: /שעות השקט/,
    waitMsg: 'בתור ויישלח אוטומטית.',
    capMsg: 'ממתין בגלל מגבלת המיילים',
  },
} as const;

const RAW = 'raw-failure-detail-from-intake';

for (const lang of ['he', 'en'] as const) {
  test(`signup mail reasons (${lang}): a mismatch says Resend will not help; the refusal is announced`, async ({
    page,
    context,
    baseURL,
  }) => {
    const failed = row('v1', { lastError: 'mail_addr_changed' });
    await mock(page, [failed, row('v2', { lastError: RAW })], {
      'v1/resend': { status: 502, json: { error: 'email_failed', record: failed } },
    });
    await open(page, context, baseURL!, lang);
    const v1 = page.locator('[data-signup-id="v1"]');
    await expect(v1.getByTestId('signup-status')).toContainText(T[lang].mismatchRow);
    // An unknown class: the generic text, and the raw value is nowhere in the page.
    await expect(page.locator('[data-signup-id="v2"]').getByTestId('signup-status')).toHaveText(
      T[lang].generic,
    );
    expect(await page.content()).not.toContain(RAW);
    expect(await page.content()).not.toContain('mail_addr_changed');
    await v1.getByTestId('signup-resend').click();
    await expect(v1.getByTestId('signup-message')).toContainText(T[lang].mismatchMsg);
    await expect(page.getByTestId('signups-live')).toContainText(T[lang].mismatchMsg);
    await expect(page.getByTestId('signups-live')).toContainText('Tester v1');
    // Focus stays on the control that was used (the row is still there).
    await expect(v1.getByTestId('signup-resend')).toBeFocused();
  });

  for (const [what, lastError, sendAfter] of [
    ['pause hold', null, '2026-11-01T10:00:00.000Z'],
    ['mail limit', 'mail_cap', '2099-01-01T10:00:00.000Z'],
  ] as const)
    test(`signup mail reasons (${lang}): a ${what} never says "quiet hours"`, async ({
      page,
      context,
      baseURL,
    }) => {
      const queued = row('v1', { status: 'email_queued', lastError, emailSendAfter: sendAfter });
      await mock(page, [row('v1')], {
        'v1/resend': { status: 200, json: { record: queued, note: 'email_queued' } },
      });
      await open(page, context, baseURL!, lang);
      const v1 = page.locator('[data-signup-id="v1"]');
      await v1.getByTestId('signup-resend').click();
      const message = v1.getByTestId('signup-message');
      await expect(message).toContainText(lastError ? T[lang].capMsg : T[lang].waitMsg);
      await expect(message).not.toContainText(T[lang].quiet);
      await expect(v1.getByTestId('signup-status')).not.toContainText(T[lang].quiet);
      // A row that stays without an action: focus goes to its outcome sentence (read on focus).
      await expect(message).toBeFocused();
    });
}
