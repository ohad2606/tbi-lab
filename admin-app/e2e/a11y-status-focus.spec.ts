/**
 * Gate G3, TBI Lab Admin: the loading state is spoken by one persistent polite status region
 * (WCAG 4.1.3), and focus is not dropped to <body> when a reload fails and replaces the content
 * that held it (WCAG 2.4.3). It is not moved on a first load, or while it is still somewhere
 * valid. Structure and DOM focus only: what a screen reader actually says needs a manual check.
 * The services are the same fakes as admin-app.spec.ts. Synthetic identities only.
 */
import { createHash } from 'node:crypto';
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test';

const APP = 'http://127.0.0.1:4176';
const FAKE = 'http://127.0.0.1:7499';
const ALEX = `t_${createHash('sha256').update('account|tester.one@example.invalid').digest('base64url').slice(0, 16)}`;

const TEXT = {
  he: { loading: 'טוען…', tester: 'בודק/ת', add: 'הוספת בודק/ת', today: 'היום' },
  en: { loading: 'Loading…', tester: 'Tester', add: 'Add tester', today: 'Today' },
};
type Lang = keyof typeof TEXT;

async function signIn(context: BrowserContext, lang: Lang) {
  await context.addCookies([{ name: 'tbi_test_user', value: 'e2e-owner', url: APP }]);
  await context.addInitScript((l) => localStorage.setItem('tbi-admin.locale', l), lang);
}
const open = (page: Page, hash: string) => page.goto(`${APP}/${hash}`);
const fail = (route: Route, status = 503) =>
  route.fulfill({ status, contentType: 'application/json', body: '{"error":"x"}' });

/** Requests for a URL wait here until released (then they reach the service, or fail). */
async function hold(page: Page, url: string | RegExp) {
  let release!: (how: 'continue' | 'fail') => void;
  const held = new Promise<'continue' | 'fail'>((r) => (release = r));
  await page.route(url, async (route) => {
    if ((await held) === 'continue') await route.continue();
    else await fail(route);
  });
  return release;
}

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const region = (page: Page) => page.getByTestId('loading-status');
const focused = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return a?.dataset.testid ?? a?.tagName ?? '';
  });
/** Long enough for any deferred focus move or announcement to have happened. */
const settled = (page: Page) => page.waitForTimeout(500);

/** Every change of the status region's text, from the moment it is in the page. */
const record = (context: BrowserContext) =>
  context.addInitScript(() => {
    const w = window as unknown as { said: string[] };
    w.said = [];
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid="loading-status"]');
      if (el && w.said.at(-1) !== el.textContent) w.said.push(el.textContent!);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
const said = (page: Page) => page.evaluate(() => (window as unknown as { said: string[] }).said);

/** A request that stays pending: the app shows its notice and checks again on its own. */
async function disablePending(page: Page, request: APIRequestContext) {
  await open(page, `#/testers/${ALEX}`);
  await page.getByTestId('tester-disable').click();
  await request.post(`${FAKE}/__test/admin-hold?on=1`);
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('pending-check')).toBeVisible();
}

const reset = async (request: APIRequestContext) => {
  await request.post(`${FAKE}/__test/reset-admin`);
  await request.post(`${FAKE}/__test/reset-reports`);
};
test.beforeEach(({ request }) => reset(request));
// Other specs share the fake services: leave them clean.
test.afterAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  await reset(request);
  await request.dispose();
});

for (const lang of ['he', 'en'] as const) {
  const text = TEXT[lang];

  test(`(${lang}) first load: one status region, empty first, then the loading text once`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    await record(context);
    const accounts = await hold(page, '**/admin-api/accounts');
    const usage = await hold(page, '**/admin-api/usage*');
    const audit = await hold(page, '**/admin-api/audit*');
    await open(page, '#/today');
    await expect(region(page)).toHaveText(text.loading);
    await expect(region(page)).toHaveRole('status');
    await expect(region(page)).toHaveAttribute('aria-live', 'polite');
    // The visible copies are hidden from assistive technology: the region alone says it.
    await expect(page.getByTestId('loading')).toBeVisible();
    await expect(page.getByTestId('loading')).toHaveAttribute('aria-hidden', 'true');
    const node = await region(page).elementHandle();
    // The app's own loader gives way to the screen's several loaders.
    accounts('continue');
    await expect(page.getByTestId('today-metrics')).toHaveCount(0);
    await expect(page.getByTestId('today-testers')).toContainText('2 / 30');
    await expect.poll(() => page.getByTestId('loading').count()).toBeGreaterThan(1);
    for (const l of await page.getByTestId('loading').all())
      await expect(l).toHaveAttribute('aria-hidden', 'true');
    // One of them ending does not clear the others' message.
    usage('continue');
    await expect(page.getByTestId('today-metrics')).toBeVisible();
    await settled(page);
    await expect(region(page)).toHaveText(text.loading);
    audit('continue');
    await expect(page.getByTestId('today-changes')).toBeVisible();
    await expect(region(page)).toHaveText('');
    expect(await node!.evaluate((e) => e.isConnected)).toBe(true);
    await expect(region(page)).toHaveCount(1);
    expect(await said(page)).toEqual(['', text.loading, '']);
  });

  test(`(${lang}) a refresh of shown data is not announced as loading`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    await record(context);
    await open(page, '#/today');
    await expect(page.getByTestId('today-metrics')).toBeVisible();
    await expect(region(page)).toHaveText('');
    await settled(page);
    const before = await said(page);
    const accounts = await hold(page, '**/admin-api/accounts');
    await page.getByTestId('refresh').click();
    await settled(page);
    accounts('continue');
    await settled(page);
    expect(await said(page)).toEqual(before);
  });

  test(`(${lang}) a screen's own loading (a report) is announced`, async ({
    page,
    context,
    request,
  }) => {
    await signIn(context, lang);
    const r = await request.post(`${FAKE}/reports`, {
      headers: { 'x-forwarded-user': 'e2e-user' },
      data: {
        description: 'Held report.',
        category: 'simulation',
        blocking: false,
        locale: 'he',
        view: 'home',
        kind: 'bug',
      },
    });
    expect(r.status()).toBe(201);
    await open(page, '#/feedback');
    await expect(page.getByTestId('report-row')).toHaveCount(1);
    await expect(region(page)).toHaveText('');
    const report = await hold(page, /\/reports\/[0-9A-Z-]{14}$/);
    await page.getByTestId('report-row').getByRole('link').click();
    await expect(region(page)).toHaveText(text.loading);
    report('fail');
    await expect(page.getByTestId('problem')).toBeVisible();
    await expect(region(page)).toHaveText('');
  });

  test(`(${lang}) disable, then the reload fails: focus moves to the heading`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    await open(page, `#/testers/${ALEX}`);
    await page.getByTestId('tester-disable').click();
    await page.route('**/admin-api/accounts', (r) => fail(r));
    await page.getByTestId('confirm-ok').press('Enter');
    await expect(page.getByTestId('problem')).toBeVisible();
    await expect(h1(page)).toHaveText(text.tester);
    await expect(h1(page)).toBeFocused();
  });

  test(`(${lang}) add, then the reload fails: focus moves to the heading`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    await open(page, '#/add');
    await page.getByTestId('add-name').fill('Test B.');
    await page.getByTestId('add-email').fill('new.person@example.invalid');
    await page.route('**/admin-api/accounts', (r) => fail(r));
    await page.getByTestId('add-submit').press('Enter');
    await expect(page.getByTestId('problem')).toBeVisible();
    await expect(h1(page)).toHaveText(text.add);
    await expect(h1(page)).toBeFocused();
  });

  test(`(${lang}) refresh finds the sign-in gone: focus moves to the new heading`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    await open(page, '#/testers');
    await expect(page.getByTestId('tester-row')).toHaveCount(3);
    await page.route('**/admin-api/**', (r) => fail(r, 401));
    await page.getByTestId('refresh').press('Enter');
    await expect(page.getByTestId('access-signed-out')).toBeVisible();
    await expect(h1(page)).toBeFocused();
  });

  test(`(${lang}) a background check's failed reload removes the focused link: heading`, async ({
    page,
    context,
    request,
  }) => {
    await signIn(context, lang);
    await disablePending(page, request);
    await page.getByTestId('nav-today').click();
    const link = page.locator('a.more');
    await expect(link).toBeVisible();
    await link.focus();
    await page.route('**/admin-api/audit*', (r) => fail(r));
    await request.post(`${FAKE}/__test/admin-hold?on=0`);
    await expect(page.getByTestId('audit-problem')).toBeVisible({ timeout: 15_000 });
    await expect(h1(page)).toHaveText(text.today);
    await expect(h1(page)).toBeFocused();
  });

  test(`(${lang}) "check again" fails and its button goes: heading`, async ({
    page,
    context,
    request,
  }) => {
    await signIn(context, lang);
    // The app's own check stays unanswered; the one the button starts fails.
    let calls = 0;
    await page.route('**/admin-api/requests/*', async (r) => {
      if (++calls > 1) await fail(r);
    });
    await disablePending(page, request);
    await expect.poll(() => calls).toBe(1);
    await page.getByTestId('pending-check').press('Enter');
    await expect(page.getByTestId('pending-check')).toHaveCount(0);
    await expect(h1(page)).toBeFocused();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test(`(${lang}) a failed refresh leaves valid focus where it is`, async ({ page, context }) => {
    await signIn(context, lang);
    await open(page, '#/testers');
    await expect(page.getByTestId('tester-row')).toHaveCount(3);
    await page.route('**/admin-api/accounts', (r) => fail(r));
    await page.getByTestId('refresh').press('Enter');
    await expect(page.getByTestId('problem')).toBeVisible();
    await settled(page);
    await expect(page.getByTestId('refresh')).toBeFocused();
  });

  test(`(${lang}) focus the user gave up is not taken back by a later failure`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    await open(page, '#/testers');
    await expect(page.getByTestId('tester-row')).toHaveCount(3);
    const accounts = await hold(page, '**/admin-api/accounts');
    await page.getByTestId('refresh').click();
    await page.getByTestId('testers-search').focus();
    // The user leaves the field for the page itself (it stays in the page).
    await page.getByTestId('testers-search').blur();
    expect(await focused(page)).toBe('BODY');
    accounts('fail');
    await expect(page.getByTestId('problem')).toBeVisible();
    await settled(page);
    expect(await focused(page)).toBe('BODY');
  });

  for (const status of [503, 401])
    test(`(${lang}) a first load that ends in ${status} does not move focus`, async ({
      page,
      context,
    }) => {
      await signIn(context, lang);
      await page.route('**/admin-api/**', (r) => fail(r, status));
      await open(page, '#/today');
      await expect(
        page.getByTestId(status === 401 ? 'access-signed-out' : 'testers-problem'),
      ).toBeVisible();
      await settled(page);
      expect(await focused(page)).toBe('BODY');
    });
}
