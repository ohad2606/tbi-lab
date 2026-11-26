/**
 * K12: "Stored requests and deletion" on the sign-up screen, in Hebrew and English: the modal
 * confirmation (focus, Tab, Escape), the focus after each outcome, the live region, the account
 * warnings, and that the typed filter never leaves the page. The REAL admin service routes and
 * store for the delete itself; mocked answers for the failures. Synthetic data only.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const FAKE = 'http://127.0.0.1:7499';
type Lang = 'he' | 'en';

const id = (n: number) => `01JD000000000000000000000${n}`;
const address = (who: string) => [who, 'example.invalid'].join('@');
const row = (n: number, who: string, status = 'pending', accountAdded = false) => ({
  id: id(n),
  name: `Sample ${who}`,
  email: address(who),
  role: 'Teacher',
  lang: 'en',
  status,
  accountAdded,
  emailAttempts: 0,
  lastError: null,
  createdAt: `2026-11-0${n}T10:00:00Z`,
});
const ROWS = () => [
  row(1, 'alpha'),
  row(2, 'bravo', 'approved'),
  row(3, 'charlie', 'email_sent', true),
];

interface Mock {
  /** Every request to the sign-up routes: "METHOD /path?query" and the body. */
  calls: string[];
  /** Answer of the next deletes; the default deletes the row. */
  answer: { status: number; json: unknown } | null;
  /** Holds each delete until resolved. */
  hold: Promise<void> | null;
  listStatus: number;
}
async function mock(page: Page): Promise<Mock> {
  const m: Mock = { calls: [], answer: null, hold: null, listStatus: 200 };
  let rows = ROWS();
  await page.route('**/admin-api/signups**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/admin-api/signups', '');
    m.calls.push(`${req.method()} ${path}${url.search} ${req.postData() ?? ''}`.trim());
    if (path === '/auto-approve') return route.fulfill({ json: { enabled: false } });
    if (path === '/open') return route.fulfill({ json: { signups: [] } });
    if (req.method() === 'GET')
      return route.fulfill({ status: m.listStatus, json: { signups: rows } });
    await m.hold;
    if (m.answer) return route.fulfill(m.answer);
    rows = rows.filter((r) => `/${r.id}` !== path);
    return route.fulfill({ json: { deleted: true } });
  });
  return m;
}
const deletes = (m: Mock) => m.calls.filter((c) => c.startsWith('DELETE'));

async function open(page: Page, context: BrowserContext, baseURL: string, lang: Lang) {
  await context.addCookies([{ name: 'tbi_test_user', value: 'e2e-owner', url: baseURL }]);
  await context.addInitScript((l) => localStorage.setItem('tbi-admin.locale', l), lang);
  await page.goto('/#/signups');
  await page.getByTestId('stored-toggle').click();
}
const rowOf = (page: Page, n: number) => page.locator(`[data-stored-id="${id(n)}"]`);
const del = (page: Page, n: number) => rowOf(page, n).getByTestId('stored-delete');
const live = (page: Page) => page.getByTestId('signups-live');

for (const lang of ['he', 'en'] as const) {
  const word = (en: RegExp, he: RegExp) => (lang === 'he' ? he : en);

  test(`stored (${lang}): closed by default; opening lists every status with masked names`, async ({
    page,
    context,
    baseURL,
  }) => {
    const m = await mock(page);
    await context.addCookies([{ name: 'tbi_test_user', value: 'e2e-owner', url: baseURL! }]);
    await context.addInitScript((l) => localStorage.setItem('tbi-admin.locale', l), lang);
    await page.goto('/#/signups');
    const toggle = page.getByTestId('stored-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('signups-empty')).toBeVisible();
    expect(m.calls.some((c) => c === 'GET')).toBe(false);
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('stored-row')).toHaveCount(3);
    await expect(live(page)).toContainText('3');
    const name = (await del(page, 1).getAttribute('aria-label'))!;
    expect(name).toContain((await del(page, 1).textContent())!);
    expect(name).toContain(id(1));
    expect(name).toContain('al***@example.invalid');
    expect(name).not.toContain(address('alpha'));
    for (const e of await page.getByTestId('stored-email').all())
      await expect(e).toHaveAttribute('dir', 'ltr');
    for (const b of await page.getByTestId('stored-delete').all()) {
      const box = (await b.boundingBox())!;
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
    }
    await toggle.click();
    await expect(page.getByTestId('stored-row')).toHaveCount(0);
  });

  test(`stored (${lang}): the filter is local: no request, URL or storage holds it`, async ({
    page,
    context,
    baseURL,
  }) => {
    const m = await mock(page);
    const logs: string[] = [];
    page.on('console', (c) => logs.push(c.text()));
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('stored-row')).toHaveCount(3);
    const urls: string[] = [];
    page.on('request', (r) => urls.push(`${r.url()} ${r.postData() ?? ''}`));
    const before = m.calls.length;
    const filter = page.getByTestId('stored-filter');
    await expect(filter).toHaveAttribute('autocomplete', 'off');
    await expect(filter).toHaveAttribute('spellcheck', 'false');
    await filter.pressSequentially('  BRAVO@');
    await expect(page.getByTestId('stored-row')).toHaveCount(1);
    await expect(live(page)).toContainText(/1.*3/);
    await expect(live(page)).not.toContainText(/bravo/i);
    await filter.fill('nobody');
    await expect(page.getByTestId('stored-empty')).toBeVisible();
    await filter.press('Enter');
    expect(m.calls).toHaveLength(before);
    expect(urls).toEqual([]);
    expect(page.url()).toMatch(/#\/signups$/);
    const stored = await page.evaluate(
      () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    );
    expect(stored).not.toMatch(/example\.invalid|nobody/);
    expect(logs.join('\n')).not.toMatch(/example\.invalid|Sample/);
  });

  test(`stored (${lang}): modal dialog: Cancel focused, Tab stays, Escape and Cancel return`, async ({
    page,
    context,
    baseURL,
  }) => {
    const m = await mock(page);
    await open(page, context, baseURL!, lang);
    await del(page, 1).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((d) => d.matches(':modal'))).toBe(true);
    await expect(dialog).toHaveAccessibleName(word(/Delete this request/, /למחוק את הבקשה/));
    await expect(dialog).toContainText(id(1));
    await expect(dialog).toContainText('al***@example.invalid');
    await expect(dialog.getByTestId('delete-warning')).toHaveCount(0);
    const cancel = page.getByTestId('delete-cancel');
    const ok = page.getByTestId('delete-ok');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(ok).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(ok).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(del(page, 1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(del(page, 1)).toBeFocused();
    expect(deletes(m)).toEqual([]);
  });

  test(`stored (${lang}): account warnings: still in flight, and an account that stays`, async ({
    page,
    context,
    baseURL,
  }) => {
    const m = await mock(page);
    await open(page, context, baseURL!, lang);
    await del(page, 2).click();
    const warning = page.getByTestId('delete-warning');
    await expect(warning).toHaveAttribute('data-warning', 'inFlight');
    await expect(warning).toContainText(word(/may still complete/, /עדיין עשויה להסתיים/));
    await page.keyboard.press('Escape');
    await del(page, 3).click();
    await expect(warning).toHaveAttribute('data-warning', 'account');
    await expect(warning).toContainText(word(/it stays/, /הוא נשאר/));
    await expect(page.getByTestId('delete-cancel')).toBeFocused();
    const link = page.getByTestId('delete-testers');
    await expect(link).toHaveAttribute('href', '#/testers');
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(24);
    await link.click();
    await expect(page).toHaveURL(/#\/testers$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    // Nothing was deleted or disabled on the way.
    expect(m.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  test(`stored (${lang}): an approve answered account_pending warns on that row`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page);
    // The open list offers Approve for row 1, whose account step then does not finish.
    await page.route('**/admin-api/signups/open', (r) =>
      r.fulfill({ json: { signups: [row(1, 'alpha')] } }),
    );
    await page.route('**/admin-api/signups/*/approve', (r) =>
      r.fulfill({ status: 202, json: { error: 'account_pending' } }),
    );
    await open(page, context, baseURL!, lang);
    await page.getByTestId('signup-approve').click();
    await expect(page.getByTestId('signup-message')).toBeVisible();
    await del(page, 1).click();
    await expect(page.getByTestId('delete-warning')).toHaveAttribute('data-warning', 'inFlight');
  });

  test(`stored (${lang}): confirm sends one DELETE, busy row, outcome and focus move on`, async ({
    page,
    context,
    baseURL,
  }) => {
    const m = await mock(page);
    let release!: () => void;
    m.hold = new Promise<void>((r) => (release = r));
    await open(page, context, baseURL!, lang);
    await del(page, 1).click();
    await expect(page.getByTestId('delete-cancel')).toBeFocused();
    // Two activations in the same tick: only one request.
    await page.getByTestId('delete-ok').evaluate((b: HTMLElement) => {
      b.click();
      b.click();
    });
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(del(page, 1)).toHaveAttribute('aria-disabled', 'true');
    await expect(del(page, 1)).toBeFocused();
    await page.keyboard.press('Enter');
    await del(page, 2).click({ force: true });
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(deletes(m)).toEqual([`DELETE /${id(1)}`]);
    const lists = m.calls.filter((c) => c === 'GET').length;
    release();
    await expect(page.getByTestId('stored-row')).toHaveCount(2);
    expect(m.calls.filter((c) => c === 'GET').length).toBe(lists + 1);
    await expect(page.getByTestId('delete-result')).toContainText(id(1));
    await expect(page.getByTestId('delete-result')).toContainText(word(/deleted/, /נמחקה/));
    await expect(live(page)).toContainText(id(1));
    await expect(live(page)).not.toContainText(/alpha/);
    await expect(del(page, 2)).toBeFocused();
  });

  test(`stored (${lang}): the second click of a double click does not confirm`, async ({
    page,
    context,
    baseURL,
  }) => {
    const m = await mock(page);
    await open(page, context, baseURL!, lang);
    await del(page, 1).click();
    await page.getByTestId('delete-ok').dispatchEvent('click', { detail: 2 });
    await expect(page.getByRole('alertdialog')).toBeVisible();
    expect(deletes(m)).toEqual([]);
  });

  for (const [what, answer, text] of [
    ['500', { status: 500, json: { error: 'internal' } }, word(/is kept/, /הרשומה נשמרה/)],
    [
      '429',
      { status: 429, json: { error: 'rate_limited', retryAfterS: 42 } },
      word(/Seconds to wait: 42/, /שניות להמתנה: .?42/),
    ],
    ['403', { status: 403, json: { error: 'csrf' } }, word(/refused/, /דחה/)],
  ] as const)
    test(`stored (${lang}): ${what} keeps the row, says so and keeps focus; retry works`, async ({
      page,
      context,
      baseURL,
    }) => {
      const m = await mock(page);
      m.answer = answer;
      await open(page, context, baseURL!, lang);
      for (let attempt = 1; attempt <= 2; attempt++) {
        await del(page, 2).click();
        await page.getByTestId('delete-ok').click();
        await expect(rowOf(page, 2).getByTestId('delete-result')).toContainText(text);
        await expect(live(page)).toContainText(text);
        await expect(del(page, 2)).toBeFocused();
        await expect(del(page, 2)).not.toHaveAttribute('aria-disabled', 'true');
        expect(deletes(m)).toHaveLength(attempt);
      }
      m.answer = null;
      await del(page, 2).click();
      await page.getByTestId('delete-ok').click();
      await expect(page.getByTestId('stored-row')).toHaveCount(2);
      await expect(del(page, 3)).toBeFocused();
    });

  for (const [what, answer] of [
    ['404', { status: 404, json: { error: 'not_found' } }],
    ['already deleted', { status: 200, json: { deleted: true, note: 'already_deleted' } }],
  ] as const)
    test(`stored (${lang}): ${what} reads "already gone" and the list is reloaded`, async ({
      page,
      context,
      baseURL,
    }) => {
      const m = await mock(page);
      m.answer = answer;
      await open(page, context, baseURL!, lang);
      await del(page, 3).click();
      await page.getByTestId('delete-ok').click();
      await expect(page.getByTestId('delete-result')).toContainText(
        word(/already gone/, /כבר לא קיימת/),
      );
      await expect(rowOf(page, 3)).toHaveCount(0);
      await expect(del(page, 2)).toBeFocused();
      // Opening the list, opening the confirmation, and after the answer.
      expect(m.calls.filter((c) => c === 'GET')).toHaveLength(3);
    });

  test(`stored (${lang}): sign-up admin off: "unavailable", no filter and no Delete`, async ({
    page,
    context,
    baseURL,
  }) => {
    const m = await mock(page);
    m.listStatus = 404;
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('stored-problem')).toHaveAttribute('data-error', 'unavailable');
    await expect(page.getByTestId('stored-delete')).toHaveCount(0);
    await expect(page.getByTestId('stored-filter')).toHaveCount(0);
    expect(m.calls.filter((c) => c.startsWith('GET /') && c.includes('pending'))).toEqual([]);
  });
}

for (const lang of ['he', 'en'] as const) {
  const word = (en: RegExp, he: RegExp) => (lang === 'he' ? he : en);
  const stale = word(/may be out of date/, /לא מעודכנת/);

  test(`stored (${lang}): an approve answered late does not bring a deleted request back`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page);
    let open2 = [row(1, 'alpha'), row(2, 'bravo')];
    await page.route('**/admin-api/signups/open', (r) => r.fulfill({ json: { signups: open2 } }));
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    await page.route('**/admin-api/signups/*/approve', async (r) => {
      await hold;
      await r.fulfill({ json: { record: row(2, 'bravo', 'email_sent', true) } });
    });
    await open(page, context, baseURL!, lang);
    await page
      .locator(`[data-signup-id="${id(2)}"]`)
      .getByTestId('signup-approve')
      .click();
    open2 = [row(2, 'bravo')];
    await del(page, 1).click();
    await page.getByTestId('delete-ok').click();
    await expect(page.getByTestId('signup-row')).toHaveCount(1);
    release();
    // The approved row leaves; the deleted one stays gone.
    await expect(page.getByTestId('signups-empty')).toBeVisible();
    await expect(page.locator(`[data-signup-id="${id(1)}"]`)).toHaveCount(0);
  });

  test(`stored (${lang}): a failed reload after a delete is announced with the outcome`, async ({
    page,
    context,
    baseURL,
  }) => {
    const m = await mock(page);
    await open(page, context, baseURL!, lang);
    await del(page, 1).click();
    await expect(page.getByTestId('delete-cancel')).toBeFocused();
    await expect.poll(() => m.calls.filter((c) => c === 'GET').length).toBe(2);
    m.listStatus = 500;
    await page.getByTestId('delete-ok').click();
    await expect(page.getByTestId('stored-stale')).toBeVisible();
    await expect(live(page)).toContainText(id(1));
    await expect(live(page)).toContainText(stale);
    // Refresh: the open list's count never replaces the stale notice.
    await page.getByTestId('signups-refresh').click();
    await expect(live(page)).toContainText(stale);
    await page.waitForTimeout(500);
    await expect(live(page)).toContainText(stale);
  });

  test(`stored (${lang}): a warning that appears in the open dialog is announced there`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page);
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('stored-row')).toHaveCount(3);
    await page.route('**/admin-api/signups', (r) =>
      r.fulfill({ json: { signups: [row(1, 'alpha', 'email_sent', true)] } }),
    );
    await del(page, 1).click();
    await expect(page.getByTestId('delete-warning')).toHaveAttribute('data-warning', 'account');
    await expect(page.getByTestId('delete-dialog-live')).toContainText(
      word(/it stays/, /הוא נשאר/),
    );
    await expect(page.getByTestId('delete-cancel')).toBeFocused();
  });

  test(`stored (${lang}): a row gone while confirming closes the dialog, says so`, async ({
    page,
    context,
    baseURL,
  }) => {
    const m = await mock(page);
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('stored-row')).toHaveCount(3);
    await page.route('**/admin-api/signups', (r) =>
      r.fulfill({ json: { signups: [row(2, 'bravo')] } }),
    );
    await del(page, 1).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(live(page)).toContainText(word(/already gone/, /כבר לא קיימת/));
    await expect(page.getByTestId('delete-result')).toContainText(id(1));
    await expect(page.getByTestId('stored-filter')).toBeFocused();
    expect(deletes(m)).toEqual([]);
  });

  test(`stored (${lang}): a list that fails while confirming closes the dialog, says so`, async ({
    page,
    context,
    baseURL,
  }) => {
    const m = await mock(page);
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('stored-row')).toHaveCount(3);
    m.listStatus = 404;
    await del(page, 1).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByTestId('stored-problem')).toBeVisible();
    await expect(live(page)).toContainText(word(/not available/, /אינן זמינות/));
    await expect(page.getByTestId('stored-toggle')).toBeFocused();
    expect(deletes(m)).toEqual([]);
  });

  test(`stored (${lang}): on a phone a focused row Delete is above the tab bar`, async ({
    page,
    context,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 375, height: 560 });
    await mock(page);
    await open(page, context, baseURL!, lang);
    await page.getByTestId('stored-filter').focus();
    const bar = page.getByTestId('tabbar');
    for (let n = 1; n <= 3; n++) {
      // Park the button just under the tab bar's top edge, then reach it with the keyboard.
      await page.keyboard.press('Tab');
      await expect(del(page, n)).toBeFocused();
      await del(page, n).evaluate((b: HTMLElement) => {
        b.blur();
        window.scrollBy(0, b.getBoundingClientRect().bottom - window.innerHeight);
        b.focus();
      });
      const box = (await del(page, n).boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual((await bar.boundingBox())!.y);
    }
  });
}

/** The #127 follow-ups: what is announced, and that a late answer never moves focus. */
for (const lang of ['he', 'en'] as const) {
  const word = (en: RegExp, he: RegExp) => (lang === 'he' ? he : en);
  const stale = word(/may be out of date/, /לא מעודכנת/);
  const count = word(/2 requests waiting/, /2 בקשות ממתינות/);
  const noStatus = word(/status is unavailable/, /סטטוס האישור האוטומטי אינו זמין/);
  const failure = { status: 500, json: { error: 'internal' } };
  /** A promise and the function that resolves it. */
  const gate = () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    return { held, release };
  };
  const openList = (page: Page, rows: () => unknown[]) =>
    page.route('**/admin-api/signups/open', (r) => r.fulfill({ json: { signups: rows() } }));

  test(`stored (${lang}): Refresh with a stale stored list still announces the open count`, async ({
    page,
    context,
    baseURL,
  }) => {
    const m = await mock(page);
    await openList(page, () => [row(1, 'alpha'), row(2, 'bravo')]);
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('stored-row')).toHaveCount(3);
    // The open list answers after the stored list has already failed.
    m.listStatus = 500;
    await page.route('**/admin-api/signups/open', async (r) => {
      await new Promise((done) => setTimeout(done, 500));
      await r.fulfill({ json: { signups: [row(1, 'alpha'), row(2, 'bravo')] } });
    });
    await page.getByTestId('signups-refresh').click();
    await expect(live(page)).toContainText(stale);
    await expect(live(page)).toContainText(count);
    await expect(live(page)).toContainText(stale);
  });

  for (const [what, answer] of [
    ['leaves the list', { json: { record: row(2, 'bravo', 'email_sent', true) } }],
    ['keeps its row', { status: 202, json: { error: 'account_pending' } }],
  ] as const)
    test(`stored (${lang}): a late approve of a deleted row (${what}) leaves focus alone`, async ({
      page,
      context,
      baseURL,
    }) => {
      await mock(page);
      let rows = [row(1, 'alpha'), row(2, 'bravo')];
      await openList(page, () => rows);
      const approve = gate();
      await page.route('**/admin-api/signups/*/approve', async (r) => {
        await approve.held;
        await r.fulfill(answer);
      });
      await open(page, context, baseURL!, lang);
      await page
        .locator(`[data-signup-id="${id(2)}"]`)
        .getByTestId('signup-approve')
        .click();
      rows = [row(1, 'alpha')];
      await del(page, 2).click();
      await page.getByTestId('delete-ok').click();
      await expect(page.getByTestId('signup-row')).toHaveCount(1);
      await expect(del(page, 3)).toBeFocused();
      // Focus nowhere in particular: a background answer must not claim it.
      await del(page, 3).evaluate((b: HTMLElement) => b.blur());
      const answered = page.waitForResponse('**/approve');
      approve.release();
      await answered;
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
      await expect(page.locator(`[data-signup-id="${id(2)}"]`)).toHaveCount(0);
    });

  test(`stored (${lang}): an approve answered while focus is elsewhere does not move it`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page);
    await openList(page, () => [row(1, 'alpha'), row(2, 'bravo')]);
    const approve = gate();
    await page.route('**/admin-api/signups/*/approve', async (r) => {
      await approve.held;
      await r.fulfill({ json: { record: row(1, 'alpha', 'email_sent', true) } });
    });
    await open(page, context, baseURL!, lang);
    await page
      .locator(`[data-signup-id="${id(1)}"]`)
      .getByTestId('signup-approve')
      .click();
    await page.getByTestId('stored-filter').focus();
    approve.release();
    await expect(page.getByTestId('signup-row')).toHaveCount(1);
    await page.waitForTimeout(300);
    await expect(page.getByTestId('stored-filter')).toBeFocused();
  });

  test(`stored (${lang}): a warning that no longer applies is said once, focus stays inside`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page);
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('stored-row')).toHaveCount(3);
    const reload = gate();
    await page.route('**/admin-api/signups', async (r) => {
      await reload.held;
      await r.fulfill({ json: { signups: [row(3, 'charlie')] } });
    });
    await del(page, 3).click();
    const said = page.getByTestId('delete-dialog-live');
    await expect(page.getByTestId('delete-warning')).toBeVisible();
    await expect(said).toHaveText('');
    // Focus is on the link that goes away with the warning.
    await page.getByTestId('delete-testers').focus();
    reload.release();
    await expect(page.getByTestId('delete-warning')).toHaveCount(0);
    await expect(said).toHaveText(
      word(
        /^The account warning no longer applies to this request\.$/,
        /^אזהרת החשבון כבר לא רלוונטית לבקשה הזאת\.$/,
      ),
    );
    await expect(page.getByTestId('delete-cancel')).toBeFocused();
  });

  test(`stored (${lang}): no warning at all: nothing is said about one`, async ({
    page,
    context,
    baseURL,
  }) => {
    const m = await mock(page);
    await open(page, context, baseURL!, lang);
    await del(page, 1).click();
    await expect.poll(() => m.calls.filter((c) => c === 'GET').length).toBe(2);
    await page.waitForTimeout(300);
    await expect(page.getByTestId('delete-dialog-live')).toHaveText('');
  });

  test(`stored (${lang}): the open list says when it could not be reloaded, until it is`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page);
    let down = false;
    await page.route('**/admin-api/signups/open', (r) =>
      r.fulfill(down ? failure : { json: { signups: [row(1, 'alpha'), row(2, 'bravo')] } }),
    );
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('signup-row')).toHaveCount(2);
    // The live region is in the page before it has anything to say.
    const region = page.getByTestId('signups-open-status');
    await expect(region).toHaveAttribute('role', 'status');
    await expect(region).toHaveText('');
    down = true;
    await del(page, 1).click();
    await page.getByTestId('delete-ok').click();
    await expect(region).toContainText(stale);
    await expect(page.getByTestId('signups-open-stale')).toBeVisible();
    await expect(page.getByTestId('signup-row')).toHaveCount(1);
    await expect(del(page, 2)).toBeFocused();
    down = false;
    await page.getByTestId('signups-refresh').click();
    await expect(page.getByTestId('signup-row')).toHaveCount(2);
    await expect(region).toHaveText('');
  });

  test(`stored (${lang}): a late status failure is announced after a newer announcement`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page);
    await openList(page, () => [row(1, 'alpha'), row(2, 'bravo')]);
    const status = gate();
    await page.route('**/admin-api/signups/auto-approve', async (r) => {
      await status.held;
      await r.fulfill(failure);
    });
    await context.addCookies([{ name: 'tbi_test_user', value: 'e2e-owner', url: baseURL! }]);
    await context.addInitScript((l) => localStorage.setItem('tbi-admin.locale', l), lang);
    await page.goto('/#/signups');
    // The count is spoken without the status once the wait is over.
    await expect(live(page)).toContainText(count, { timeout: 6000 });
    await page.getByTestId('stored-toggle').click();
    await expect(live(page)).toContainText(/3.*3/);
    await page.getByTestId('stored-filter').fill('bravo');
    await expect(live(page)).toContainText(/1.*3/);
    status.release();
    await expect(live(page)).toContainText(noStatus);
    await expect(live(page)).toContainText(/1.*3/);
    await expect(page.getByTestId('stored-filter')).toBeFocused();
  });

  test(`stored (${lang}): a status failure is announced also when the open list failed`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page);
    await page.route('**/admin-api/signups/open', (r) => r.fulfill(failure));
    await page.route('**/admin-api/signups/auto-approve', async (r) => {
      await new Promise((done) => setTimeout(done, 300));
      await r.fulfill(failure);
    });
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('signups-problem')).toBeVisible();
    await expect(live(page)).toContainText(noStatus);
  });
}

test.describe('stored: the real routes and store', () => {
  test.beforeEach(async ({ request }) => {
    await request.post(`${FAKE}/__test/reset-admin`);
    await request.post(`${FAKE}/__test/admin-signups?seed=1&mailFail=0`);
  });
  test.afterEach(async ({ request }) => {
    await request.post(`${FAKE}/__test/admin-signups?seed=0&mailFail=0`);
  });

  for (const lang of ['he', 'en'] as const)
    test(`(${lang}) a sent request is found by address, deleted and stays deleted`, async ({
      page,
      context,
      baseURL,
    }) => {
      await open(page, context, baseURL!, lang);
      await expect(page.getByTestId('stored-row')).toHaveCount(6);
      await page.getByTestId('stored-filter').fill('signup-email-sent');
      await expect(page.getByTestId('stored-row')).toHaveCount(1);
      await page.getByTestId('stored-delete').click();
      await page.getByTestId('delete-ok').click();
      await expect(page.getByTestId('stored-empty')).toBeVisible();
      await expect(page.getByTestId('delete-result')).toHaveAttribute(
        'data-key',
        'console.signups.delete.done',
      );
      await expect(page.getByTestId('stored-filter')).toBeFocused();
      await page.reload();
      await page.getByTestId('stored-toggle').click();
      await expect(page.getByTestId('stored-row')).toHaveCount(5);
    });
});
