/**
 * BETA-G1, sign-up screen rows: focus stays with a row that moves between the main list and the
 * "not confirmed yet" group, the badge after `unbound_state`, and the texts of an email held by
 * the mail limit. The sign-up endpoints are mocked (synthetic data, example.com only).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const web = (id: string, state: string, day: number, extra: object = {}) => ({
  id,
  name: `Tester ${id}`,
  email: `${id}@example.com`,
  role: 'Teacher',
  lang: 'en',
  status: 'pending',
  accountAdded: false,
  emailAttempts: 0,
  lastError: null,
  origin: 'web',
  createdAt: `2026-11-0${day}T10:00:00Z`,
  verification: { state, ...(state === 'sent' ? { sentAt: '2026-11-23T10:00:00.000Z' } : {}) },
  ...extra,
});

/** `list.rows` is what the next load returns; `list.hold()` delays loads until released. */
async function mock(
  page: Page,
  rows: object[],
  actions: Record<string, { status: number; json: unknown }> = {},
) {
  let gate: Promise<void> = Promise.resolve();
  const list = {
    rows,
    hold() {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return release;
    },
  };
  await page.route('**/admin-api/signups/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auto-approve')) return route.fulfill({ json: { enabled: false } });
    if (path.endsWith('/open')) {
      await gate;
      return route.fulfill({ json: { signups: list.rows, rowStates: 1 } });
    }
    const [, , , id, action] = path.split('/');
    return route.fulfill(actions[`${id}/${action}`] ?? { json: { record: null } });
  });
  return list;
}

async function open(page: Page, context: BrowserContext, baseURL: string, lang: 'he' | 'en') {
  await context.addCookies([{ name: 'tbi_test_user', value: 'e2e-owner', url: baseURL }]);
  await context.addInitScript((l) => localStorage.setItem('tbi-admin.locale', l), lang);
  await page.goto('/#/signups');
}

const T = {
  en: {
    unbound: 'Account not confirmed',
    autoWait: 'Waiting for automatic approval',
    own: 'Waiting for your decision',
    queuedLine: 'Email confirmed, waiting for the automatic approval',
    confirmedLine: 'Email confirmed',
    counts: {
      loaded: '3 requests waiting for you. 2 requests are waiting for automatic approval',
      failed: '4 requests waiting for you. 1 request is waiting for automatic approval',
      onlyAuto: 'No requests need your action. 1 request is waiting for automatic approval',
      withQueued:
        'No requests need your action. Scheduled emails: 1. 2 requests are waiting for automatic approval',
      oneEach: '1 request waiting for you. 1 request is waiting for automatic approval',
    },
    capStatus: 'Account added. The email is waiting because of the email limit',
    capHelp: 'If it stays waiting, check the server log',
    quiet: 'quiet hours',
  },
  he: {
    unbound: 'אין אישור שהחשבון נוסף',
    autoWait: 'ממתינה לאישור אוטומטי',
    own: 'ממתינה להחלטה שלך',
    queuedLine: 'כתובת המייל אומתה, ממתינה לאישור האוטומטי',
    confirmedLine: 'כתובת המייל אומתה',
    counts: {
      loaded: '3 בקשות ממתינות לך. 2 בקשות ממתינות לאישור אוטומטי',
      failed: '4 בקשות ממתינות לך. בקשה אחת ממתינה לאישור אוטומטי',
      onlyAuto: 'אין בקשות שדורשות פעולה ממך. בקשה אחת ממתינה לאישור אוטומטי',
      withQueued: 'אין בקשות שדורשות פעולה ממך. מיילים מתוזמנים: 1. 2 בקשות ממתינות לאישור אוטומטי',
      oneEach: 'בקשה אחת ממתינה לך. בקשה אחת ממתינה לאישור אוטומטי',
    },
    capStatus: 'החשבון נוסף. המייל ממתין בגלל מגבלת המיילים',
    capHelp: 'אם הוא נשאר ממתין',
    quiet: 'שעות השקט',
  },
} as const;

for (const lang of ['he', 'en'] as const) {
  test(`signup rows (${lang}): a reload that moves the focused row keeps focus on it`, async ({
    page,
    context,
    baseURL,
  }) => {
    const list = await mock(page, [web('v1', 'sent', 1), web('v2', 'confirmed_review', 2)]);
    await open(page, context, baseURL!, lang);
    const v1 = page.locator('[data-signup-id="v1"]');
    const v2 = page.locator('[data-signup-id="v2"]');
    await expect(v2).toBeVisible();

    // Main list to the closed group: the group opens and the same control has focus again.
    let release = list.hold();
    await page.getByTestId('signups-refresh').click();
    await v2.getByTestId('signup-reject').focus();
    list.rows = [web('v1', 'sent', 1), web('v2', 'sent', 2)];
    release();
    await expect(page.getByTestId('signups-unconfirmed-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(v2.getByTestId('signup-reject')).toBeFocused();
    await expect(v2.getByTestId('signup-reject')).toBeInViewport();

    // Group to the main list.
    release = list.hold();
    await page.getByTestId('signups-refresh').click();
    await v1.getByTestId('signup-approve').focus();
    list.rows = [web('v1', 'confirmed_review', 1), web('v2', 'sent', 2)];
    release();
    await expect(page.getByTestId('signups-list')).toContainText('v1@example.com');
    await expect(v1.getByTestId('signup-approve')).toBeFocused();

    // The focused row is gone: focus goes to Refresh, never to the page.
    release = list.hold();
    await page.getByTestId('signups-refresh').click();
    await v1.getByTestId('signup-approve').focus();
    list.rows = [web('v2', 'sent', 2)];
    release();
    await expect(v1).toHaveCount(0);
    await expect(page.getByTestId('signups-refresh')).toBeFocused();
  });

  test(`signup rows (${lang}): a failed send moves the row out of the group with focus`, async ({
    page,
    context,
    baseURL,
  }) => {
    const failed = web('v1', 'sent', 1, { status: 'email_failed', accountAdded: true });
    await mock(page, [web('v1', 'sent', 1), web('v2', 'sent', 2)], {
      'v1/approve': { status: 502, json: { error: 'email_failed', record: failed } },
    });
    await open(page, context, baseURL!, lang);
    await page.getByTestId('signups-unconfirmed-toggle').click();
    await page.locator('[data-signup-id="v1"]').getByTestId('signup-approve').click();
    await page.getByTestId('confirm-ok').click();
    const resend = page.getByTestId('signups-list').getByTestId('signup-resend');
    await expect(resend).toBeFocused();
    await expect(page.getByTestId('signups-live')).toContainText('Tester v1');
  });

  test(`signup rows (${lang}): after unbound_state the badge says the account is not confirmed`, async ({
    page,
    context,
    baseURL,
  }) => {
    const claims = web('v1', 'confirmed_review', 1, { status: 'email_failed', accountAdded: true });
    await mock(page, [claims], {
      'v1/resend': { status: 409, json: { error: 'unbound_state', record: claims } },
    });
    await open(page, context, baseURL!, lang);
    const v1 = page.locator('[data-signup-id="v1"]');
    await expect(v1.getByTestId('signup-status')).not.toHaveText(T[lang].unbound);
    await v1.getByTestId('signup-resend').click();
    await expect(v1.getByTestId('signup-status')).toHaveText(T[lang].unbound);
    await expect(v1.getByTestId('signup-message')).toHaveAttribute(
      'data-key',
      'console.signups.err.unbound_state',
    );
    await expect(page.getByTestId('signups-live')).toContainText('Tester v1');
    await expect(v1.getByTestId('signup-resend')).toBeFocused();
  });

  test(`signup rows (${lang}): an email held by the mail limit says so and what to do`, async ({
    page,
    context,
    baseURL,
  }) => {
    const held = web('v1', 'confirmed_review', 1, {
      status: 'email_queued',
      accountAdded: true,
      lastError: 'mail_cap',
      emailSendAfter: '2026-11-28T10:00:00.000Z',
    });
    await mock(page, [web('v1', 'confirmed_review', 1)], {
      'v1/approve': { status: 409, json: { error: 'mail_cap', record: held } },
    });
    await open(page, context, baseURL!, lang);
    const v1 = page.locator('[data-signup-id="v1"]');
    await v1.getByTestId('signup-approve').click();
    await expect(v1.getByTestId('signup-status')).toContainText(T[lang].capStatus);
    await expect(v1.getByTestId('signup-status')).not.toContainText(T[lang].quiet);
    const message = v1.getByTestId('signup-message');
    await expect(message).toContainText(T[lang].capHelp);
    await expect(message).toBeFocused();
  });

  test(`signup rows (${lang}): the badge asks for a decision only when one is needed`, async ({
    page,
    context,
    baseURL,
  }) => {
    const list = await mock(
      page,
      [
        web('v1', 'confirmed_queued', 1),
        web('v2', 'confirmed_waiting_limit', 2),
        web('v3', 'confirmed_review', 3),
        web('v4', 'unknown', 4),
        // A claim mark without an added account, with verification on or off: no "approved" mark.
        web('v5', 'confirmed_review', 5, { autoApprovedAt: '2026-11-23T10:00:00.000Z' }),
      ],
      { 'v1/approve': { status: 502, json: { error: 'account_error' } } },
    );
    await open(page, context, baseURL!, lang);
    const row = (id: string) => page.locator(`[data-signup-id="${id}"]`);
    const badge = (id: string) => row(id).getByTestId('signup-status');
    for (const id of ['v1', 'v2']) {
      await expect(badge(id)).toHaveText(T[lang].autoWait);
      // The owner can still decide.
      await expect(row(id).getByTestId('signup-approve')).toBeEnabled();
      await expect(row(id).getByTestId('signup-reject')).toBeEnabled();
    }
    for (const id of ['v3', 'v4', 'v5']) await expect(badge(id)).toHaveText(T[lang].own);
    await expect(page.getByTestId('signup-auto-approved')).toHaveCount(0);
    // The count agrees with the badges, and the announcement is the visible line.
    const count = page.getByTestId('signups-count');
    const live = page.getByTestId('signups-live');
    await expect(count).toHaveText(T[lang].counts.loaded);
    await expect(live).toHaveText(T[lang].counts.loaded);
    const line = (id: string) => row(id).getByTestId('signup-verification');
    await expect(line('v1')).toHaveText(T[lang].queuedLine);
    // A failed approval is newer than the loaded state: the row needs the owner again.
    await row('v1').getByTestId('signup-approve').click();
    await expect(row('v1').getByTestId('signup-message')).toBeVisible();
    await expect(badge('v1')).toHaveText(T[lang].own);
    // The line under it no longer names the automatic approval either.
    await expect(line('v1')).toHaveText(T[lang].confirmedLine);
    await expect(page.getByTestId('signups-live')).toContainText('Tester v1');
    await expect(row('v1').getByTestId('signup-approve')).toBeFocused();
    await expect(count).toHaveText(T[lang].counts.failed);
    // Only automatic waits, with a scheduled email, and one of each: said as shown after Refresh.
    const queued = web('q1', 'confirmed_review', 4, {
      status: 'email_queued',
      accountAdded: true,
      emailSendAfter: '2026-11-28T10:00:00.000Z',
    });
    for (const [rows, text] of [
      [[web('v1', 'confirmed_queued', 1)], T[lang].counts.onlyAuto],
      [
        [web('v1', 'confirmed_queued', 1), web('v2', 'confirmed_waiting_limit', 2), queued],
        T[lang].counts.withQueued,
      ],
      [
        [web('v1', 'confirmed_queued', 1), web('v3', 'confirmed_review', 3)],
        T[lang].counts.oneEach,
      ],
    ] as const) {
      list.rows = [...rows];
      await page.getByTestId('signups-refresh').click();
      await expect(count).toHaveText(text);
      await expect(live).toHaveText(text);
    }
  });

  test(`signup rows (${lang}): with verification off a claimed row is not called approved`, async ({
    page,
    context,
    baseURL,
  }) => {
    const claimed = {
      ...web('v1', 'sent', 1, {
        status: 'approved',
        autoApprovedAt: '2026-11-23T10:00:00.000Z',
      }),
      verification: undefined,
    };
    await page.route('**/admin-api/signups/**', (route) =>
      route.fulfill({
        json: new URL(route.request().url()).pathname.endsWith('/auto-approve')
          ? { enabled: false }
          : { signups: [claimed] },
      }),
    );
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('signup-approve')).toBeVisible();
    await expect(page.getByTestId('signup-auto-approved')).toHaveCount(0);
  });

  test(`signup rows (${lang}): Refresh leaves focus that is outside the list alone`, async ({
    page,
    context,
    baseURL,
  }) => {
    const list = await mock(page, [web('v1', 'confirmed_review', 1)]);
    await open(page, context, baseURL!, lang);
    const v1 = page.locator('[data-signup-id="v1"]');
    await expect(v1).toBeVisible();
    const release = list.hold();
    await page.getByTestId('signups-refresh').click();
    const outside = page.getByTestId('stored-toggle');
    await outside.focus();
    // The list changes completely, so every focus rule of a reload has a reason to run.
    list.rows = [web('v2', 'confirmed_review', 2)];
    release();
    await expect(page.locator('[data-signup-id="v2"]')).toBeVisible();
    await expect(v1).toHaveCount(0);
    // Past the frame in which a reload would move focus.
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await expect(outside).toBeFocused();
  });
}
