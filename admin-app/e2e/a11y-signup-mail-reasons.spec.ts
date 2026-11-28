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
    waitMsg: 'is queued and has not been sent yet.',
    capMsg: 'waits because of the email limit',
  },
  he: {
    mismatchRow: 'הכתובת בבקשה אינה הכתובת שעבורה נוסף החשבון',
    mismatchMsg: 'שליחה חוזרת לא תעזור',
    generic: 'החשבון נוסף, אבל המייל לא נשלח. אפשר לשלוח שוב.',
    quiet: /שעות השקט/,
    waitMsg: 'בתור ועדיין לא נשלח.',
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

const HELD = {
  en: {
    held: 'held',
    notice: 'Refresh needed',
    button: '"Refresh requests"',
    no: /queued|scheduled|sent automatically/i,
  },
  he: {
    held: 'מוחזק',
    notice: 'נדרש רענון',
    button: '„רענון הבקשות”',
    no: /בתור|מתוזמן|נשלח אוטומטית/,
  },
} as const;

for (const lang of ['he', 'en'] as const) {
  test(`signup truth (${lang}): a held row is never queued or scheduled; over the limit no "later"`, async ({
    page,
    context,
    baseURL,
  }) => {
    const queued = {
      status: 'email_queued',
      lastError: 'mail_cap',
      autoApprovedAt: '2026-11-01T09:00:00Z',
      emailSendAfter: '2099-01-01T10:00:00.000Z',
      mailHeld: true,
    };
    const held = row('v2', queued);
    await mock(page, [row('v1'), held], {
      'v1/resend': { status: 409, json: { error: 'mail_cap', record: row('v1', queued) } },
    });
    await open(page, context, baseURL!, lang);
    const v2 = page.locator('[data-signup-id="v2"]');
    await expect(v2.getByTestId('signup-status')).toContainText(HELD[lang].held);
    await expect(v2.getByTestId('signup-status')).not.toContainText(HELD[lang].no);
    await expect(v2.getByTestId('signup-send-after')).toHaveCount(0);
    const v1 = page.locator('[data-signup-id="v1"]');
    await v1.getByTestId('signup-resend').click();
    const message = v1.getByTestId('signup-message');
    await expect(message).toContainText(HELD[lang].held);
    await expect(message).not.toContainText(HELD[lang].no);
    await expect(message).toBeFocused();
    await expect(v1.getByTestId('signup-send-after')).toHaveCount(0);
    await expect(page.getByTestId('signups-count')).not.toContainText(HELD[lang].no);
    // Read on focus only: the live region does not say it a second time.
    await expect(page.getByTestId('signups-live')).toHaveText('');
  });

  test(`signup truth (${lang}): an unknown outcome stays in view after its row left, said once`, async ({
    page,
    context,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await mock(page, [row('v1'), row('v2')], {
      'v1/resend': { status: 200, json: { record: null, note: 'a_newer_note' } },
    });
    await open(page, context, baseURL!, lang);
    await page.locator('[data-signup-id="v1"]').getByTestId('signup-resend').click();
    await expect(page.locator('[data-signup-id="v1"]')).toHaveCount(0);
    const notice = page.getByTestId('signups-reload-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(HELD[lang].notice);
    await expect(notice).toContainText('Tester v1');
    await expect(notice).toHaveClass(/\bwarn\b/);
    await expect(notice).not.toHaveClass(/\bok\b/);
    await expect(notice).toHaveCSS('border-top-style', 'dashed');
    // Focus goes to the next row, as for any removed row.
    await expect(page.locator('[data-signup-id="v2"]').getByTestId('signup-resend')).toBeFocused();
    // One announcement: the live region has the sentence; the visible notice is not live.
    await expect(page.getByTestId('signups-live')).toContainText('Tester v1');
    expect(
      await notice.evaluate((e) => !!e.closest('[aria-live], [role="status"], [role="alert"]')),
    ).toBe(false);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    // A Refresh that loads shows the current state: the notice goes.
    await page.getByTestId('signups-refresh').click();
    await expect(notice).toHaveCount(0);
  });
}

/**
 * Like `mock`, with a stored list and delete, and the open list held on demand: a held load
 * answers with the rows as they were when it was asked.
 */
const V1 = `${'0'.repeat(25)}1`;
const V2 = `${'0'.repeat(25)}2`;
async function mockHeld(page: Page, unknownRecord: boolean) {
  let rows = [row(V1), row(V2)];
  const m = { hold: null as Promise<void> | null, loads: 0 };
  await page.route('**/admin-api/signups**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/admin-api/signups', '');
    if (path === '/auto-approve') return route.fulfill({ json: { enabled: false } });
    if (path === '/open') {
      const asked = rows;
      const hold = m.hold;
      m.hold = null;
      m.loads++;
      await hold;
      return route.fulfill({ json: { signups: asked, rowStates: 1 } });
    }
    if (req.method() === 'GET') return route.fulfill({ json: { signups: rows } });
    if (req.method() === 'DELETE') {
      rows = rows.filter((r) => `/${r.id}` !== path);
      return route.fulfill({ json: { deleted: true } });
    }
    // The action: v1 leaves the open list unless its answer keeps the row.
    const kept = unknownRecord ? row(V1) : null;
    if (!kept) rows = rows.filter((r) => r.id !== V1);
    return route.fulfill({ json: { record: kept, note: 'a_newer_note' } });
  });
  return m;
}

for (const lang of ['he', 'en'] as const) {
  for (const kept of [false, true])
    test(`signup truth (${lang}): a Refresh in flight keeps the newer notice of a ${kept ? 'listed' : 'removed'} row`, async ({
      page,
      context,
      baseURL,
    }) => {
      const m = await mockHeld(page, kept);
      await open(page, context, baseURL!, lang);
      const v1 = page.locator(`[data-signup-id="${V1}"]`);
      await expect(v1).toBeVisible();
      let release = () => {};
      m.hold = new Promise<void>((r) => (release = r));
      const before = m.loads;
      await page.getByTestId('signups-refresh').click();
      await expect.poll(() => m.loads).toBe(before + 1);
      await v1.getByTestId('signup-resend').click();
      const notice = kept
        ? v1.getByTestId('signup-message')
        : page.getByTestId('signups-reload-notice');
      await expect(notice).toBeVisible();
      release();
      // The old list is not shown: it is loaded again, and the notice stays.
      await expect.poll(() => m.loads).toBe(before + 2);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(HELD[lang].button);
      await expect(v1).toHaveCount(kept ? 1 : 0);
      // A Refresh asked after the answer settles it.
      await page.getByTestId('signups-refresh').click();
      await expect(notice).toHaveCount(0);
    });

  test(`signup truth (${lang}): deleting another request keeps a row's unknown outcome`, async ({
    page,
    context,
    baseURL,
  }) => {
    const m = await mockHeld(page, true);
    await open(page, context, baseURL!, lang);
    const v1 = page.locator(`[data-signup-id="${V1}"]`);
    await v1.getByTestId('signup-resend').click();
    const notice = v1.getByTestId('signup-message');
    await expect(notice).toBeVisible();
    await page.getByTestId('stored-toggle').click();
    const before = m.loads;
    await page.locator(`[data-stored-id="${V2}"]`).getByTestId('stored-delete').click();
    await page.getByTestId('delete-ok').click();
    await expect.poll(() => m.loads).toBe(before + 1);
    await expect(page.locator(`[data-signup-id="${V2}"]`)).toHaveCount(0);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
    await expect(notice).toContainText(HELD[lang].button);
  });
}

for (const lang of ['he', 'en'] as const)
  test(`signup mail reasons (${lang}): long status sentences fit 320 px and describe Resend`, async ({
    page,
    context,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    const errors = [
      'mail_addr_changed',
      'mail_unbound',
      'mail_unproven',
      'mail_state_unsafe',
      'secret_not_file',
      'http_403',
      'network',
    ];
    await mock(
      page,
      errors.map((lastError, i) => row(`v${i}`, { lastError })),
    );
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('signup-status')).toHaveCount(errors.length);
    const overflow = await page.evaluate(() => {
      const bad = [...document.querySelectorAll<HTMLElement>('[data-testid="signup-status"]')]
        .filter((el) => {
          const box = el.getBoundingClientRect();
          return box.left < 0 || box.right > 320 || el.scrollWidth > el.clientWidth + 1;
        })
        .map((el) => el.id);
      return { bad, page: document.documentElement.scrollWidth - window.innerWidth };
    });
    expect(overflow.bad).toEqual([]);
    expect(overflow.page).toBeLessThanOrEqual(0);
    await expect(page.getByTestId('signup-status').first()).toHaveCSS('border-radius', '10px');
    const first = page.locator('[data-signup-id="v0"]');
    await expect(first.getByTestId('signup-resend')).toHaveAccessibleDescription(
      (await first.getByTestId('signup-status').textContent())!,
    );
  });
