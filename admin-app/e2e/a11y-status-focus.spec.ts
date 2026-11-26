/**
 * Gate G3, TBI Lab Admin: the loading state is spoken by one persistent polite status region
 * (WCAG 4.1.3), and focus is not dropped to <body> when a reload fails and replaces the content
 * that held it (WCAG 2.4.3). It is not moved on a first load, or while it is still somewhere
 * valid. Structure and DOM focus only: what a screen reader actually says needs a manual check.
 * After a SUCCESSFUL action that replaces or removes the focused control, focus goes to the
 * control that took its place on the same tester (or row).
 * The services are the same fakes as admin-app.spec.ts; the sign-up requests are mocked in the
 * page. Synthetic identities only.
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
  he: {
    loading: 'טוען…',
    tester: 'בודק/ת',
    testers: 'בודקים',
    add: 'הוספת בודק/ת',
    today: 'היום',
    badName: "יש להשתמש ב־1–60 אותיות, רווחים ו־. ' - בלבד, ולהתחיל באות.",
  },
  en: {
    loading: 'Loading…',
    tester: 'Tester',
    testers: 'Testers',
    add: 'Add tester',
    today: 'Today',
    badName: "Use 1–60 letters, spaces and . ' - only, starting with a letter.",
  },
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
const button = (page: Page, id: string) => page.getByTestId(`tester-${id}`);

/**
 * The confirmation's action. The confirmation focuses Cancel in the task that renders it (a
 * layout effect); waiting for that first keeps an Enter meant for the action off Cancel.
 */
async function confirmOk(page: Page, how: 'Enter' | 'click' = 'Enter') {
  await expect(page.getByTestId('confirm-cancel')).toBeFocused();
  const ok = page.getByTestId('confirm-ok');
  if (how === 'click') await ok.click();
  else await ok.press('Enter');
}

/** Opens the rename editor by keyboard, and waits for its deferred focus on the field. */
async function openRename(page: Page) {
  await button(page, 'rename').press('Enter');
  await expect(page.getByTestId('rename-input')).toBeFocused();
}

/** Opens the tester and confirms Disable by keyboard. */
async function disable(page: Page) {
  await button(page, 'disable').press('Enter');
  await confirmOk(page);
}

/** Two open sign-up requests, held in the page: an action removes its row. */
async function mockSignups(page: Page) {
  let rows = ['r1', 'r2'].map((id) => ({
    id,
    name: `Test ${id}`,
    email: `${id}@example.invalid`,
    role: 'Teacher',
    lang: 'en',
    status: 'pending',
    accountAdded: false,
    emailAttempts: 0,
    lastError: null,
    createdAt: '2026-11-01T10:00:00Z',
  }));
  await page.route('**/admin-api/signups/**', async (route) => {
    const [, , , id] = new URL(route.request().url()).pathname.split('/');
    if (id === 'open') return route.fulfill({ json: { signups: rows } });
    rows = rows.filter((r) => r.id !== id);
    return route.fulfill({ json: { record: null } });
  });
}

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
  await confirmOk(page, 'click');
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
    // The visible text is not live, but can be found by reading the page.
    await expect(page.getByTestId('loading')).toHaveText(text.loading);
    await expect(page.getByRole('main').getByRole('paragraph')).toHaveText(text.loading);
    const node = await region(page).elementHandle();
    // The app's own loader gives way to the screen's several loaders.
    accounts('continue');
    await expect(page.getByTestId('today-metrics')).toHaveCount(0);
    await expect(page.getByTestId('today-testers')).toContainText('2 / 30');
    await expect.poll(() => page.getByTestId('loading').count()).toBeGreaterThan(1);
    for (const l of await page.getByTestId('loading').all()) {
      await expect(l).not.toHaveAttribute('aria-hidden');
      await expect(l).not.toHaveAttribute('aria-live');
      await expect(l).not.toHaveRole('status');
    }
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
    await confirmOk(page);
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
    await expect(h1(page)).toBeFocused();
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

  test(`(${lang}) disable, then enable: focus goes to the button that took its place`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    await open(page, `#/testers/${ALEX}`);
    await disable(page);
    await expect(button(page, 'reactivate')).toBeFocused();
    await button(page, 'reactivate').press('Enter');
    await confirmOk(page);
    await expect(button(page, 'disable')).toBeFocused();
  });

  test(`(${lang}) an invalid new name: an alert, which describes the invalid field`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    await open(page, `#/testers/${ALEX}`);
    await openRename(page);
    const field = page.getByTestId('rename-input');
    await expect(field).toHaveAttribute('aria-invalid', 'false');
    await expect(field).not.toHaveAttribute('aria-describedby');
    await field.fill('R2-D2');
    await field.press('Enter');
    const problem = page.getByTestId('rename-problem');
    await expect(problem).toHaveRole('alert');
    await expect(problem).toHaveText(text.badName);
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveAttribute('aria-describedby', 'rename-problem');
    await expect(field).toHaveAccessibleDescription(text.badName);
    await field.fill('Test R.');
    await expect(problem).toHaveCount(0);
    await expect(field).toHaveAttribute('aria-invalid', 'false');
    await expect(field).not.toHaveAttribute('aria-describedby');
  });

  test(`(${lang}) a pending disable's later reload removes the focused row: heading`, async ({
    page,
    context,
    request,
  }) => {
    await signIn(context, lang);
    await disablePending(page, request);
    await page.getByTestId('nav-testers').click();
    // The new screen's deferred focus on its heading first, or it can take the row's.
    await expect(h1(page)).toBeFocused();
    const row = page.getByTestId(`tester-open-${ALEX}`);
    await row.focus();
    // The answer arrives (the "check again" button goes) before the reloaded list does.
    const accounts = await hold(page, '**/admin-api/accounts');
    await request.post(`${FAKE}/__test/admin-hold?on=0`);
    await expect(page.getByTestId('pending-check')).toHaveCount(0, { timeout: 15_000 });
    await settled(page);
    await expect(row).toBeFocused();
    accounts('continue');
    await expect(row).toHaveCount(0);
    await expect(h1(page)).toHaveText(text.testers);
    await expect(h1(page)).toBeFocused();
  });

  for (const clicked of [false, true])
    test(`(${lang}) focused content gone, ${clicked ? 'then a click on the page: a later failure leaves focus' : 'no click: a later failure moves focus to the heading'}`, async ({
      page,
      context,
    }) => {
      await signIn(context, lang);
      await open(page, '#/testers');
      await expect(page.getByTestId('tester-row')).toHaveCount(3);
      // A focused control that goes away with nothing to rescue it yet (synthetic).
      await page.evaluate(() => {
        const b = document.body.appendChild(document.createElement('button'));
        b.focus();
        b.remove();
      });
      // A blank part of the page, outside <main> (which takes focus itself): the top bar's middle.
      if (clicked) await page.locator('header.top').click();
      expect(await focused(page)).toBe('BODY');
      await page.route('**/admin-api/accounts', (r) => fail(r));
      // Neither a pointer press nor a focus change, unlike a user's own refresh.
      await page.getByTestId('refresh').evaluate((b: HTMLElement) => b.click());
      await expect(page.getByTestId('problem')).toBeVisible();
      await settled(page);
      if (clicked) expect(await focused(page)).toBe('BODY');
      else await expect(h1(page)).toBeFocused();
    });

  for (const how of ['Enter in the field', 'the Save button', 'Cancel'] as const)
    test(`(${lang}) rename closed by ${how}: focus returns to Rename`, async ({
      page,
      context,
    }) => {
      await signIn(context, lang);
      await open(page, `#/testers/${ALEX}`);
      await openRename(page);
      const field = page.getByTestId('rename-input');
      await field.fill('Test R.');
      if (how === 'Enter in the field') await field.press('Enter');
      else if (how === 'the Save button') await page.getByTestId('rename-save').press('Enter');
      else await page.locator('form .actions button[type="button"]').press('Enter');
      await expect(field).toHaveCount(0);
      if (how !== 'Cancel') await expect(page.getByTestId('tester-title')).toHaveText('Test R.');
      await expect(button(page, 'rename')).toBeFocused();
    });

  // Regression guard only: it exercises no new code. The same DOM node becomes the Enable button,
  // so focus never leaves it and no rescue runs.
  test(`(${lang}) regression guard: a pending disable that succeeds keeps focus on the reused button`, async ({
    page,
    context,
    request,
  }) => {
    await signIn(context, lang);
    await disablePending(page, request);
    await button(page, 'disable').focus();
    await request.post(`${FAKE}/__test/admin-hold?on=0`);
    await expect(button(page, 'reactivate')).toBeVisible({ timeout: 15_000 });
    await expect(button(page, 'reactivate')).toBeFocused();
  });

  for (const action of ['disable', 'rename'] as const) {
    const act = async (page: Page) => {
      await open(page, `#/testers/${ALEX}`);
      await expect(button(page, action)).toBeVisible();
      const accounts = await hold(page, '**/admin-api/accounts');
      if (action === 'disable') await disable(page);
      else {
        await openRename(page);
        await page.getByTestId('rename-input').fill('Test R.');
        await page.getByTestId('rename-input').press('Enter');
      }
      return accounts;
    };
    const done = (page: Page) =>
      action === 'disable'
        ? expect(button(page, 'reactivate')).toBeVisible()
        : expect(button(page, 'rename')).toBeVisible();

    test(`(${lang}) ${action}: focus moved elsewhere during the reload stays there`, async ({
      page,
      context,
    }) => {
      await signIn(context, lang);
      const accounts = await act(page);
      await page.getByTestId('refresh').focus();
      accounts('continue');
      await done(page);
      await settled(page);
      await expect(page.getByTestId('refresh')).toBeFocused();
    });

    test(`(${lang}) ${action}: focus given up during the reload is not taken back`, async ({
      page,
      context,
    }) => {
      await signIn(context, lang);
      const accounts = await act(page);
      await page.getByTestId('refresh').focus();
      await page.getByTestId('refresh').blur();
      accounts('continue');
      await done(page);
      await settled(page);
      expect(await focused(page)).toBe('BODY');
    });
  }

  for (const action of ['approve', 'reject'] as const)
    test(`(${lang}) sign-up ${action} succeeds: focus goes to the next row's action`, async ({
      page,
      context,
    }) => {
      await signIn(context, lang);
      await mockSignups(page);
      await open(page, '#/signups');
      const rows = page.getByTestId('signup-row');
      await expect(rows).toHaveCount(2);
      for (const left of [1, 0]) {
        const primary = rows.first().locator('button[data-primary]');
        if (action === 'approve') await primary.press('Enter');
        else {
          await rows.first().locator('button[data-act="reject"]').press('Enter');
          await confirmOk(page);
        }
        await expect(rows).toHaveCount(left);
        await expect(
          left ? rows.first().locator('button[data-primary]') : page.getByTestId('signups-refresh'),
        ).toBeFocused();
      }
    });
}

/**
 * A deferred focus rescue (focus-rescue.ts) can run right after a confirmation replaced its
 * opener, while focus is on <body>. The observer stands in for it at that exact moment: the
 * confirmation must already hold focus, so its opener is never mistaken for the heading.
 */
test('a rescue right after a confirmation opens does not take over its opener', async ({
  page,
  context,
}) => {
  await signIn(context, 'en');
  await open(page, `#/testers/${ALEX}`);
  await button(page, 'disable').focus();
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector('[data-testid="confirm"]')) return;
      observer.disconnect();
      if (document.activeElement !== document.body) return;
      const heading = document.querySelector<HTMLElement>('main h1')!;
      heading.tabIndex = -1;
      heading.focus();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('confirm-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('confirm')).toHaveCount(0);
  await expect(button(page, 'disable')).toBeFocused();
});
