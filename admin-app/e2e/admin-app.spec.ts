/**
 * TBI Admin (admin app design §3), on a desktop and on a phone (the two Playwright projects):
 * the owner can do every action; a tester and a stranger see "no access" and get no data; no
 * sideways scrolling on the phone; Hebrew right to left by default. The services are real (the
 * admin service, the Session Host's owner routes); the root helper and the ops side's files are
 * the fake of app/e2e/fixtures/fake-admin.ts. Synthetic identities only (example.invalid).
 * Screenshots: TBI_SHOTS=dir.
 */
import { createHash } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const APP = 'http://127.0.0.1:4176';
const FAKE = 'http://127.0.0.1:7499';

const target = (email: string) =>
  `t_${createHash('sha256').update(`account|${email}`).digest('base64url').slice(0, 16)}`;
const ALEX = target('tester.one@example.invalid');
const FORMER = target('former@example.invalid');

const as = (context: BrowserContext, subject: string) =>
  context.addCookies([{ name: 'tbi_test_user', value: subject, url: APP }]);
const english = (context: BrowserContext) =>
  context.addInitScript(() => localStorage.setItem('tbi-admin.locale', 'en'));

const shot = async (page: Page, name: string) => {
  if (process.env.TBI_SHOTS)
    await page.screenshot({
      path: `${process.env.TBI_SHOTS}/${name}-${test.info().project.name}.png`,
      fullPage: true,
    });
};

/** The page never scrolls sideways, and every control is a comfortable touch target. */
async function layoutOk(page: Page) {
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(inner);
  const small = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        'button, a.button, .nav a, input:not([type=radio]), .item-link, .back, .more',
      ),
    ]
      .filter((e) => e.offsetParent !== null && !e.classList.contains('visually-hidden'))
      .map((e) => ({
        what: e.dataset.testid ?? e.textContent,
        h: e.getBoundingClientRect().height,
      }))
      .filter((x) => x.h < 43.5),
  );
  expect(small).toEqual([]);
  const fonts = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLInputElement>('input:not([type=radio])')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => parseFloat(getComputedStyle(e).fontSize))
      .filter((s) => s < 16),
  );
  expect(fonts).toEqual([]);
}

const nav = async (page: Page, s: string) => {
  await page.getByTestId(`nav-${s}`).click();
  await expect(page.getByTestId(`nav-${s}`)).toHaveAttribute('aria-current', 'page');
};

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/reset-admin`);
  await request.post(`${FAKE}/__test/reset-reports`);
});

test('Hebrew by default, right to left: Today shows the daily summary live', async ({
  page,
  context,
  request,
}) => {
  // A tester sends one report (through the Session Host, as the gate would pass it).
  expect(
    (
      await request.post(`${FAKE}/reports`, {
        headers: { 'x-forwarded-user': 'e2e-user' },
        data: {
          description: 'The LED never lights.',
          category: 'simulation',
          blocking: true,
          locale: 'en',
          view: 'home',
          kind: 'bug',
        },
      })
    ).status(),
  ).toBe(201);
  await as(context, 'e2e-owner');
  await page.goto(`${APP}/`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('היום');
  await expect(page.getByTestId('today-testers')).toContainText('2 / 30');
  await expect(page.getByTestId('today-capacity')).toContainText(/\d+ \/ \d+/);
  await expect(page.getByTestId('today-active')).toContainText('2');
  // Today: Alex (2 sign-ins, 4 builds, 1 prebuilt, 5 runs, 900 s, 1 refusal), tester two
  // (1 sign-in, 2 runs, 120 s), unmatched (2 refusals).
  const metric = (m: string) => page.getByTestId(`today-metric-${m}`).locator('dd');
  await expect(metric('signIns')).toHaveText('3');
  await expect(metric('builds')).toHaveText('4');
  await expect(metric('prebuilt')).toHaveText('1');
  await expect(metric('runs')).toHaveText('7');
  await expect(metric('simSeconds')).toHaveText('17');
  await expect(metric('refusals')).toHaveText('3');
  await expect(page.getByText('כולל פעילות של חשבונות שאינם ברשימה.')).toBeVisible();
  await expect(page.getByTestId('today-feedback')).toContainText('1 חדשים מתוך 1');
  const changes = page.getByTestId('today-changes');
  await expect(changes.getByTestId('activity-row')).toHaveCount(2);
  // The disabled tester's change carries the owner's name for the record, not an address.
  await expect(changes.getByTestId('activity-row').first()).toContainText('בודקת ל.');
  expect(await page.locator('body').textContent()).not.toMatch(/[a-z.]+@example\.invalid/);
  await layoutOk(page);
  if (test.info().project.name === 'desktop') {
    // Side navigation at the inline start: the right in Hebrew.
    const navBox = await page.locator('nav.nav').boundingBox();
    const mainBox = await page.locator('main').boundingBox();
    expect(navBox!.x).toBeGreaterThan(mainBox!.x);
  }
  await shot(page, 'today-he');
});

test('testers: search, filters, last activity first; the detail page has 30 days of usage', async ({
  page,
  context,
}) => {
  await as(context, 'e2e-owner');
  await english(context);
  await page.goto(`${APP}/#/testers`);
  const rows = page.getByTestId('tester-row');
  // Active: Alex (activity an hour ago), tester two (two hours ago), the owner (no usage).
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-target', ALEX);
  await page.getByTestId('testers-search').fill('alex');
  await expect(rows).toHaveCount(1);
  await page.getByTestId('testers-search').fill('te***@');
  await expect(rows).toHaveCount(2);
  await page.getByTestId('testers-search').fill('');
  await page.getByTestId('filter-disabled').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-target', FORMER);
  await page.getByTestId('filter-all').click();
  await expect(rows).toHaveCount(4);
  await layoutOk(page);
  await shot(page, 'testers-en');

  await page.getByTestId(`tester-open-${ALEX}`).click();
  await expect(page).toHaveURL(new RegExp(`#/testers/${ALEX}$`));
  const detail = page.getByTestId('tester-detail');
  await expect(page.getByTestId('tester-title')).toHaveText('Alex T.');
  await expect(page.getByTestId('tester-masked')).toHaveText('te***@example.invalid');
  await expect(page.getByTestId('tester-signins')).toHaveText('7');
  // 15 days at 3 runs (every other day from 28 days ago, today replaced by 5): 14 * 3 + 5 = 47.
  await expect(page.getByTestId('tester-metric-runs').locator('dd')).toHaveText('47');
  const chart = page.getByTestId('tester-chart');
  await expect(chart.locator('rect')).toHaveCount(30);
  await expect(chart).toHaveAttribute('aria-label', /Runs per day, last 30 days: 47 in total/);
  await page.getByTestId('chart-metric-simSeconds').click();
  // 14 days x 10 min + 15 min today.
  await expect(chart).toHaveAttribute('aria-label', /Simulation minutes .*: 155 in total/);
  await expect(detail).not.toContainText('tester.one@');
  await layoutOk(page);
  await shot(page, 'tester-detail-en');
});

test('owner actions: rename, disable with confirmation, reactivate; the log records them', async ({
  page,
  context,
}) => {
  await as(context, 'e2e-owner');
  await english(context);
  await page.goto(`${APP}/#/testers/${ALEX}`);
  await page.getByTestId('tester-rename').click();
  const input = page.getByTestId('rename-input');
  await expect(input).toBeFocused();
  await input.fill('R2-D2');
  await page.getByTestId('rename-save').click();
  await expect(page.getByTestId('rename-problem')).toContainText('letters');
  await input.fill('Alex Example');
  await page.getByTestId('rename-save').click();
  await expect(page.getByTestId('notice')).toHaveText('The name was saved: Alex Example.');
  await expect(page.getByTestId('tester-title')).toHaveText('Alex Example');

  await page.getByTestId('tester-disable').click();
  const confirm = page.getByTestId('confirm');
  await expect(confirm).toContainText('Alex Example (te***@example.invalid)');
  await expect(confirm).toContainText('Their running simulations are stopped.');
  await expect(page.getByTestId('confirm-cancel')).toBeFocused();
  await layoutOk(page);
  await shot(page, 'confirm-disable-en');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('notice')).toHaveText('Access for Alex Example has ended.');
  await expect(page.getByTestId('tester-status')).toHaveText('Disabled');

  await page.getByTestId('tester-reactivate').click();
  await expect(page.getByTestId('confirm')).toContainText('one of the 30 tester places');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('notice')).toHaveText('Alex Example can sign in again.');
  await expect(page.getByTestId('tester-status')).toHaveText('Active');
  // The owner record cannot be disabled from here.
  await nav(page, 'testers');
  await page.getByTestId('filter-all').click();

  await nav(page, 'activity');
  const log = page.getByTestId('activity-list').getByTestId('activity-row');
  await expect(log.nth(0)).toHaveAttribute('data-action', 'reactivate');
  await expect(log.nth(1)).toHaveAttribute('data-action', 'disable');
  await expect(log.nth(2)).toHaveAttribute('data-action', 'rename');
  await expect(log.nth(0)).toContainText('Alex Example');
  await expect(log.nth(0)).toContainText('done');
  await layoutOk(page);
  await shot(page, 'activity-en');
});

test('add a tester: validated, masked afterwards, in the list at once', async ({
  page,
  context,
}) => {
  await as(context, 'e2e-owner');
  await english(context);
  await page.goto(`${APP}/#/add`);
  await page.getByTestId('add-email').fill('not-an-address');
  await page.getByTestId('add-submit').click();
  await expect(page.getByTestId('add-problem')).toHaveText('Enter one valid email address.');
  await page.getByTestId('add-name').fill('  Test   B. ');
  await page.getByTestId('add-email').fill('New.Person@example.invalid');
  await layoutOk(page);
  await page.getByTestId('add-submit').click();
  await expect(page.getByTestId('notice')).toHaveText('Test B. was added and can sign in now.');
  await expect(page.getByTestId('add-last')).toContainText('ne***@example.invalid');
  await expect(page.getByTestId('add-email')).toHaveValue('');
  expect(await page.locator('body').textContent()).not.toContain('new.person@');
  await nav(page, 'testers');
  const added = page.getByTestId('tester-row').filter({ hasText: 'Test B.' });
  await expect(added).toContainText('Pending');
  await nav(page, 'today');
  await expect(
    page.getByTestId('today-changes').getByTestId('activity-row').first(),
  ).toHaveAttribute('data-action', 'add');
});

test('a slow helper: 202 pending, then the result arrives without asking', async ({
  page,
  context,
  request,
}) => {
  await request.post(`${FAKE}/__test/admin-hold?on=1`);
  await as(context, 'e2e-owner');
  await english(context);
  await page.goto(`${APP}/#/testers/${ALEX}`);
  await page.getByTestId('tester-disable').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('notice')).toContainText('The server is still processing');
  await expect(page.getByTestId('pending-check')).toBeVisible();
  await request.post(`${FAKE}/__test/admin-hold?on=0`);
  await expect(page.getByTestId('notice')).toHaveText('Access for Alex T. has ended.', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('tester-status')).toHaveText('Disabled');
});

test('feedback: newest first, new until opened, the full text, delete confirmed', async ({
  page,
  context,
  request,
}) => {
  for (const description of ['First report.', 'שורה ראשונה\nשורה שנייה'])
    expect(
      (
        await request.post(`${FAKE}/reports`, {
          headers: { 'x-forwarded-user': 'e2e-user' },
          data: {
            description,
            category: 'other',
            blocking: false,
            locale: 'he',
            view: 'home',
            kind: 'general',
          },
        })
      ).status(),
    ).toBe(201);
  await as(context, 'e2e-owner');
  await page.goto(`${APP}/#/feedback`);
  const items = page.getByTestId('report-row');
  await expect(items).toHaveCount(2);
  await expect(page.getByTestId('report-new')).toHaveCount(2);
  expect(await page.getByTestId('feedback-list').textContent()).not.toContain('First report');
  await layoutOk(page);
  await shot(page, 'feedback-he');
  // Newest first: the Hebrew report was sent second.
  await items.first().locator('a').click();
  await expect(page.getByTestId('report-text')).toHaveText('שורה ראשונה\nשורה שנייה');
  await layoutOk(page);
  await page.getByTestId('report-back').click();
  await expect(page.getByTestId('report-new')).toHaveCount(1);
  await items.last().locator('a').click();
  await expect(page.getByTestId('report-text')).toHaveText('First report.');
  await page.getByTestId('report-delete').click();
  await expect(page.getByTestId('confirm-cancel')).toBeFocused();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('notice')).toHaveText('הדיווח נמחק.');
  await expect(items).toHaveCount(1);
  await items.first().locator('a').click();
  await page.getByTestId('report-delete-tester').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('feedback-empty')).toBeVisible();
});

test('the history views unavailable: each panel says so, the rest works', async ({
  page,
  context,
  request,
}) => {
  await request.post(`${FAKE}/__test/admin-history?usage=0&audit=0`);
  await as(context, 'e2e-owner');
  await english(context);
  await page.goto(`${APP}/`);
  await expect(page.getByTestId('usage-problem')).toHaveText(
    'The usage history is not available right now.',
  );
  await expect(page.getByTestId('audit-problem')).toHaveText(
    'The activity log is not available right now.',
  );
  await expect(page.getByTestId('today-testers')).toContainText('2 / 30');
  await nav(page, 'testers');
  await expect(page.getByTestId('tester-row')).toHaveCount(3);
  await page.getByTestId(`tester-open-${ALEX}`).click();
  await expect(page.getByTestId('usage-problem')).toBeVisible();
  await expect(page.getByTestId('tester-disable')).toBeVisible();
  await layoutOk(page);
});

for (const subject of ['e2e-user', 'e2e-stranger'])
  test(`${subject === 'e2e-user' ? 'a tester' : 'a stranger'} sees "no access" and gets no data`, async ({
    page,
    context,
  }) => {
    await as(context, subject);
    await english(context);
    await page.goto(`${APP}/`);
    await expect(page.getByTestId('access-forbidden')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('No access');
    await expect(page.getByTestId('sign-out-link')).toHaveAttribute('href', '/oauth2/sign_out');
    await expect(page.locator('nav')).toHaveCount(0);
    await layoutOk(page);
    for (const path of [
      '/admin-api/accounts',
      '/admin-api/usage',
      '/admin-api/audit',
      '/runtime/admin/reports',
    ]) {
      const r = await page.request.get(`${APP}${path}`, {
        headers: { accept: 'application/json' },
      });
      expect(r.status(), path).toBe(403);
      expect(await r.text()).not.toMatch(/Alex|example\.invalid|t_[A-Za-z0-9_-]{16}/);
    }
  });

test('signed out: the gate’s 401 leads to signing in again', async ({ page, context }) => {
  await as(context, 'e2e-owner');
  await english(context);
  await page.route('**/admin-api/**', (r) =>
    r.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"identity_required"}',
    }),
  );
  await page.goto(`${APP}/`);
  await expect(page.getByTestId('access-signed-out')).toBeVisible();
  await expect(page.getByTestId('sign-in-link')).toHaveAttribute('href', '/oauth2/start?rd=/');
  await layoutOk(page);
});

test('settings: English, left to right, remembered; sign out', async ({ page, context }) => {
  await as(context, 'e2e-owner');
  await page.goto(`${APP}/#/settings`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByTestId('language-en').check();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByTestId('nav-today')).toHaveText('Today');
  await expect(page.getByTestId('sign-out-link')).toHaveAttribute('href', '/oauth2/sign_out');
  await layoutOk(page);
  // The web manifest and its icon are served; there is no service worker.
  const manifest = await (await page.request.get(`${APP}/manifest.webmanifest`)).json();
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(['192x192', '512x512']);
  // Behind the gate the manifest needs the session cookie: fetched with credentials.
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'crossorigin',
    'use-credentials',
  );
  expect((await page.request.get(`${APP}/icon-512.png`)).status()).toBe(200);
  expect(await page.evaluate(() => navigator.serviceWorker?.controller ?? null)).toBeNull();
});
