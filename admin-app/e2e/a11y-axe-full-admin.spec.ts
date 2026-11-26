/**
 * Gate G3, AXE-FULL for TBI Lab Admin: page-level automated axe-core scan of every screen and its
 * main dialog, confirmation, form-error, empty and unavailable states, in Hebrew (RTL) and English,
 * on the desktop and phone projects; and a 320 CSS px reflow check of the same states (plus the
 * narrowest table layout, 900 px).
 * Every violation of the listed tags fails, whatever its impact. Automated rules catch only part of
 * the possible problems; this spec does not establish conformance with any standard. Manual and
 * screen-reader checks stay separate. Any remaining violation must be listed in EXCEPTIONS.
 * The services are the same fakes as admin-app.spec.ts. Synthetic identities only.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);

/** Known, reported violations (rule, selector substring, reason). Empty: none are accepted. */
const EXCEPTIONS: { rule: string; selector: string; reason: string }[] = [];

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const APP = 'http://127.0.0.1:4176';
const FAKE = 'http://127.0.0.1:7499';

const target = (email: string) =>
  `t_${createHash('sha256').update(`account|${email}`).digest('base64url').slice(0, 16)}`;
const ALEX = target('tester.one@example.invalid');
const FORMER = target('former@example.invalid');

type Lang = 'he' | 'en';
/** Run on every state once it has rendered. */
type Check = (state: string) => Promise<void>;

async function scan(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  const all: { id: string; impact: string; target: string }[] = await page.evaluate(
    async (tags) => {
      const r = await (window as any).axe.run(document, { runOnly: { type: 'tag', values: tags } });
      return r.violations.flatMap((v: any) =>
        v.nodes.map((n: any) => ({ id: v.id, impact: v.impact, target: n.target.join(' ') })),
      );
    },
    TAGS,
  );
  return all
    .filter((f) => !EXCEPTIONS.some((e) => e.rule === f.id && f.target.includes(e.selector)))
    .map((f) => `${f.id} (${f.impact}) ${f.target}`);
}

/**
 * No page-level horizontal scroll, nothing outside the window or cut off. Content may scroll
 * sideways only inside a region that is focusable and has a name (a wide data table).
 */
async function reflowProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const iw = document.documentElement.clientWidth;
    const out: string[] = [];
    const what = (e: Element) =>
      `${e.tagName.toLowerCase()}.${e.getAttribute('class') ?? ''} "${e.textContent?.slice(0, 30)}"`;
    if (document.documentElement.scrollWidth > iw)
      out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${iw}`);
    const scrollsX = (e: Element) => /auto|scroll/.test(getComputedStyle(e).overflowX);
    const goodRegion = (e: Element) =>
      e.getAttribute('role') === 'region' &&
      (e as HTMLElement).tabIndex >= 0 &&
      !!(e.getAttribute('aria-label') || e.getAttribute('aria-labelledby'));
    for (const e of document.querySelectorAll<HTMLElement>('body *')) {
      if (e.closest('.visually-hidden, svg, .skip')) continue;
      const r = e.getBoundingClientRect();
      if (!r.width) continue;
      let scroller: Element | null = e.parentElement;
      while (scroller && !scrollsX(scroller)) scroller = scroller.parentElement;
      if (!scroller && (r.right > iw + 0.5 || r.left < -0.5)) out.push(`outside: ${what(e)}`);
      // Text fields scroll their own value; every other box must show its content.
      if (e.matches('input, textarea')) continue;
      if (e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0) {
        if (scrollsX(e)) {
          if (!goodRegion(e)) out.push(`unnamed or unfocusable scroller: ${what(e)}`);
        } else if (getComputedStyle(e).overflowX !== 'visible') out.push(`cut off: ${what(e)}`);
      }
    }
    return out.slice(0, 8);
  });
}

async function signIn(context: BrowserContext, lang: Lang, subject = 'e2e-owner') {
  await context.addCookies([{ name: 'tbi_test_user', value: subject, url: APP }]);
  await context.addInitScript((l) => localStorage.setItem('tbi-admin.locale', l), lang);
}

async function report(request: APIRequestContext, description: string, blocking = false) {
  const r = await request.post(`${FAKE}/reports`, {
    headers: { 'x-forwarded-user': 'e2e-user' },
    data: {
      description,
      category: 'simulation',
      blocking,
      locale: 'he',
      view: 'home',
      kind: 'bug',
    },
  });
  expect(r.status()).toBe(201);
}

/** A hash route in a freshly loaded document (so earlier state never carries over). */
async function open(page: Page, hash: string) {
  await page.goto('about:blank');
  await page.goto(`${APP}/${hash}`);
}

const visible = async (page: Page, ...ids: string[]) => {
  for (const id of ids) await expect(page.getByTestId(id).first()).toBeVisible();
};

/** Language, direction, one h1, and nothing still loading: the screen really rendered. */
async function rendered(page: Page, lang: Lang) {
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/\S/);
  await expect(page.getByText(lang === 'he' ? /^טוען/ : /^Loading/)).toHaveCount(0);
}

/** Screens that must show data: no error panel on them. */
const noProblem = (page: Page) => expect(page.locator('.problem')).toHaveCount(0);

/** The headings that tell otherwise similar (error) states apart. */
const TITLES = {
  testers: { he: 'בודקים', en: 'Testers' },
  tester: { he: 'בודק/ת', en: 'Tester' },
  add: { he: 'הוספת בודק/ת', en: 'Add tester' },
  report: { he: 'דיווח', en: 'Report' },
  feedback: { he: 'משוב', en: 'Feedback' },
};
const LOADING = { he: /^טוען/, en: /^Loading/ };
const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const titled = async (page: Page, lang: Lang, screen: keyof typeof TITLES) =>
  expect(h1(page)).toHaveText(TITLES[screen][lang]);

type Walk = (page: Page, request: APIRequestContext, check: Check, lang: Lang) => Promise<void>;

const WALKS: Record<string, { subject?: string; walk: Walk }> = {
  'today, activity, settings, more': {
    walk: async (page, request, check) => {
      await report(request, 'The LED never lights.', true);
      await open(page, '#/today');
      await visible(page, 'today-metrics', 'today-changes', 'today-capacity');
      await expect(page.getByTestId('today-testers')).toContainText('2 / 30');
      await noProblem(page);
      await check('today');
      await open(page, '#/activity');
      await visible(page, 'activity-list', 'activity-row');
      await noProblem(page);
      await check('activity');
      await open(page, '#/settings');
      await visible(page, 'language-he', 'language-en', 'sign-out-link');
      await check('settings');
      await open(page, '#/more');
      await visible(page, 'more-menu', 'more-signups', 'more-sign-out');
      await check('more');
    },
  },
  'testers and a tester: filters, rename, confirmations, pending, missing': {
    walk: async (page, request, check, lang) => {
      await open(page, '#/testers');
      await expect(page.getByTestId('tester-row')).toHaveCount(3);
      await noProblem(page);
      await check('testers');
      await page.getByTestId('filter-all').click();
      await expect(page.getByTestId('tester-row')).toHaveCount(4);
      await check('testers, all (a disabled record)');
      await page.getByTestId('testers-search').fill('no-such-tester');
      await visible(page, 'testers-none');
      await check('testers, nothing found');

      await open(page, `#/testers/${ALEX}`);
      await visible(page, 'tester-detail', 'tester-chart', 'tester-totals', 'tester-disable');
      await noProblem(page);
      await check('tester detail');
      await page.getByTestId('tester-rename').click();
      await expect(page.getByTestId('rename-input')).toBeFocused();
      await check('rename editor');
      await page.getByTestId('rename-input').fill('R2-D2');
      await page.getByTestId('rename-save').click();
      await visible(page, 'rename-problem');
      await check('rename, invalid name');

      await open(page, `#/testers/${ALEX}`);
      await page.getByTestId('tester-disable').click();
      await visible(page, 'confirm', 'confirm-ok');
      await check('confirm disable');
      await request.post(`${FAKE}/__test/admin-hold?on=1`);
      await page.getByTestId('confirm-ok').click();
      await visible(page, 'notice', 'pending-check');
      await check('pending request notice');
      await request.post(`${FAKE}/__test/admin-hold?on=0`);
      await expect(page.getByTestId('pending-check')).toHaveCount(0, { timeout: 15_000 });
      await visible(page, 'notice', 'tester-reactivate');
      await check('disabled tester with the result notice');

      await open(page, `#/testers/${FORMER}`);
      await page.getByTestId('tester-reactivate').click();
      await visible(page, 'confirm', 'confirm-ok');
      await check('confirm reactivate');

      await open(page, `#/testers/t_${'A'.repeat(16)}`);
      await visible(page, 'tester-missing');
      await titled(page, lang, 'tester');
      await check('tester not found');
    },
  },
  'add a tester: form, errors, success, cap full': {
    walk: async (page, request, check) => {
      await open(page, '#/add');
      await visible(page, 'add-form', 'add-submit');
      await noProblem(page);
      await check('add');
      await page.getByTestId('add-email').fill('not-an-address');
      await page.getByTestId('add-submit').click();
      await visible(page, 'add-problem');
      await check('add, invalid address');
      await page.getByTestId('add-name').fill('R2-D2');
      await page.getByTestId('add-submit').click();
      await expect(page.getByTestId('add-name')).toHaveAttribute('aria-invalid', 'true');
      await check('add, invalid name');
      await page.getByTestId('add-name').fill('Test B.');
      await page.getByTestId('add-email').fill('new.person@example.invalid');
      await page.getByTestId('add-submit').click();
      await visible(page, 'notice', 'add-last');
      await check('add, done');
      await request.post(`${FAKE}/__test/admin-fill?n=30`);
      await open(page, '#/add');
      await visible(page, 'add-cap-full');
      await check('add, no free place');
    },
  },
  'feedback: empty, list, report, delete confirmations': {
    walk: async (page, request, check, lang) => {
      await open(page, '#/feedback');
      await visible(page, 'feedback-empty');
      await check('feedback empty');
      await report(request, 'First report.');
      await report(request, `שורה ראשונה\nhttps://lab.example.invalid/${'x'.repeat(120)}`, true);
      await open(page, '#/feedback');
      await expect(page.getByTestId('report-row')).toHaveCount(2);
      await noProblem(page);
      await check('feedback list');
      // Each link is named by what the row shows, including the report's own short ID.
      for (const row of await page.getByTestId('report-row').all()) {
        const id = (await row.getAttribute('data-id'))!.slice(0, 9);
        await expect(row.getByRole('link')).toHaveAccessibleName(
          new RegExp(`${TITLES.report[lang]} ${id}`),
        );
        await expect(row.locator('bdi[dir="ltr"]', { hasText: id })).toBeVisible();
      }
      await page.getByTestId('report-row').first().locator('a').click();
      await visible(page, 'report-detail', 'report-text', 'report-delete');
      await check('report');
      await page.getByTestId('report-delete').click();
      await visible(page, 'confirm');
      await check('confirm delete report');
      await page.getByTestId('confirm-cancel').click();
      await page.getByTestId('report-delete-tester').click();
      await visible(page, 'confirm');
      await check('confirm delete all of a tester');
      await page.getByTestId('confirm-ok').click();
      await visible(page, 'notice', 'feedback-empty');
      await check('feedback after delete, with notice');
    },
  },
  'sign-up requests: list, confirmation, outcome, empty': {
    walk: async (page, request, check) => {
      await request.post(`${FAKE}/__test/admin-signups?seed=1&mailFail=1`);
      await open(page, '#/signups');
      await expect(page.getByTestId('signup-row')).toHaveCount(4);
      await noProblem(page);
      await check('sign-ups list');
      await page.getByTestId('signup-reject').first().click();
      await visible(page, 'confirm');
      await check('sign-ups, confirm reject');
      await page.getByTestId('confirm-cancel').click();
      // The last row is the failed email: sending fails again and the row says so.
      await page.getByTestId('signup-resend').last().click();
      await visible(page, 'signup-message');
      await check('sign-ups, failed outcome');
      await request.post(`${FAKE}/__test/admin-signups?seed=0&mailFail=0`);
      await open(page, '#/signups');
      await visible(page, 'signups-empty');
      await check('sign-ups empty');
    },
  },
  'unavailable data': {
    walk: async (page, request, check, lang) => {
      await request.post(`${FAKE}/__test/admin-history?usage=0&audit=0`);
      const unavailable = { status: 503, contentType: 'application/json', body: '{"error":"x"}' };
      await page.route('**/admin-api/signups/**', (r) => r.fulfill(unavailable));
      await open(page, '#/today');
      await visible(page, 'usage-problem', 'audit-problem');
      await check('today, history unavailable');
      await open(page, '#/activity');
      await visible(page, 'audit-problem');
      await check('activity unavailable');
      await open(page, `#/testers/${ALEX}`);
      await visible(page, 'tester-detail', 'usage-problem');
      await check('tester, usage unavailable');
      await open(page, '#/signups');
      await visible(page, 'signups-problem');
      await check('sign-ups unavailable');
      await page.route('**/admin-api/accounts', (r) => r.fulfill(unavailable));
      await page.route('**/admin-api/sessions', (r) => r.fulfill(unavailable));
      await open(page, '#/today');
      await visible(page, 'testers-problem', 'capacity-problem');
      await check('today, accounts and capacity unavailable');
      await open(page, '#/testers');
      await visible(page, 'problem');
      await titled(page, lang, 'testers');
      await check('testers unavailable');
      await open(page, '#/add');
      await visible(page, 'problem', 'add-back');
      await titled(page, lang, 'add');
      await check('add unavailable');
      await open(page, `#/testers/${ALEX}`);
      await visible(page, 'problem', 'tester-back');
      await titled(page, lang, 'tester');
      await check('tester, accounts unavailable');
      await open(page, '#/feedback/AAAA-BBBB-CCCC');
      await visible(page, 'problem', 'report-back');
      await titled(page, lang, 'report');
      await check('report that cannot be loaded');
    },
  },
  'long data (30 testers, 300 log lines)': {
    walk: async (page, request, check) => {
      expect((await request.post(`${FAKE}/__test/admin-rich`)).status()).toBe(200);
      await open(page, '#/testers');
      await page.getByTestId('filter-all').click();
      await expect(page.getByTestId('tester-row')).toHaveCount(32);
      await check('long testers list');
      await page.getByTestId('tester-row').filter({ hasText: 'אלכסנדרה' }).locator('a').click();
      await visible(page, 'tester-detail', 'tester-chart');
      await check('tester with the longest name');
      await page.getByTestId('tester-disable').click();
      await visible(page, 'confirm');
      await check('confirm with the longest name');
      await open(page, '#/activity');
      await expect(page.getByTestId('activity-row')).toHaveCount(300);
      await check('long activity log');
      await open(page, '#/today');
      await visible(page, 'today-changes', 'today-metrics');
      await check('today with long names');
    },
  },
  'no access': {
    subject: 'e2e-stranger',
    walk: async (page, _request, check) => {
      await open(page, '#/today');
      await visible(page, 'access-forbidden', 'sign-out-link');
      await check('no access');
    },
  },
  'signed out': {
    walk: async (page, _request, check) => {
      await page.route('**/admin-api/**', (r) =>
        r.fulfill({
          status: 401,
          contentType: 'application/json',
          body: '{"error":"identity_required"}',
        }),
      );
      await open(page, '#/today');
      await visible(page, 'access-signed-out', 'sign-in-link');
      await check('signed out');
    },
  },
};

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
  // Two reports alike in everything the list shows except their IDs.
  test(`(${lang}) identical reports have different link names`, async ({
    page,
    context,
    request,
  }) => {
    await signIn(context, lang);
    await report(request, 'Same report.');
    await report(request, 'Same report.');
    await open(page, '#/feedback');
    const links = page.getByTestId('report-row').getByRole('link');
    await expect(links).toHaveCount(2);
    const names: string[] = [];
    for (const row of await page.getByTestId('report-row').all()) {
      const name = `${TITLES.report[lang]} ${(await row.getAttribute('data-id'))!.slice(0, 9)}`;
      await expect(row.getByRole('link')).toHaveAccessibleName(new RegExp(name));
      names.push(name);
    }
    expect(new Set(names).size).toBe(2);
  });

  // The heading takes the route focus while the report loads, and keeps it: one focus, one node.
  for (const outcome of ['loaded', 'unavailable'] as const)
    test(`(${lang}) report loading then ${outcome}: the heading keeps focus`, async ({
      page,
      context,
      request,
    }) => {
      await signIn(context, lang);
      await report(request, 'Held report.');
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      await page.route(/\/reports\/[0-9A-Z-]{14}$/, async (r) => {
        await held;
        if (outcome === 'loaded') await r.continue();
        else await r.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      });
      await open(page, '#/feedback');
      const row = page.getByTestId('report-row');
      const id = (await row.getAttribute('data-id'))!;
      await page.evaluate(() => {
        const w = window as unknown as { h1Focus: number };
        w.h1Focus = 0;
        document.addEventListener('focusin', (e) => {
          if ((e.target as Element).tagName === 'H1') w.h1Focus++;
        });
      });
      await row.getByRole('link').click();
      await titled(page, lang, 'report');
      await expect(h1(page)).toBeFocused();
      await expect(page.getByTestId('loading')).toHaveText(LOADING[lang]);
      const node = await h1(page).elementHandle();
      release();
      if (outcome === 'loaded') {
        await visible(page, 'report-detail', 'report-text');
        await expect(h1(page)).toHaveText(id);
      } else {
        await visible(page, 'problem');
        await titled(page, lang, 'report');
      }
      await expect(h1(page)).toBeFocused();
      expect(await node!.evaluate((e) => e === document.activeElement)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { h1Focus: number }).h1Focus)).toBe(1);
    });

  // Loading and error states keep one h1 and the screen's way back (G3).
  for (const outcome of ['loaded', 'unavailable'] as const)
    test(`(${lang}) feedback list loading then ${outcome}: one heading, which keeps focus`, async ({
      page,
      context,
    }) => {
      await signIn(context, lang);
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      await page.route(/\/admin\/reports$/, async (r) => {
        await held;
        if (outcome === 'loaded') await r.continue();
        else await r.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      });
      await open(page, '#/today');
      await page.getByTestId('nav-feedback').click();
      await expect(page.getByTestId('loading')).toHaveText(LOADING[lang]);
      await expect(h1(page)).toHaveCount(1);
      await titled(page, lang, 'feedback');
      await expect(h1(page)).toBeFocused();
      expect(await scan(page)).toEqual([]);
      const node = await h1(page).elementHandle();
      release();
      await visible(page, outcome === 'loaded' ? 'feedback-empty' : 'problem');
      await titled(page, lang, 'feedback');
      expect(await node!.evaluate((e) => e === document.activeElement)).toBe(true);
    });

  test(`(${lang}) first load: the waiting page has a heading`, async ({ page, context }) => {
    await signIn(context, lang);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/admin-api/accounts', async (r) => {
      await held;
      await r.continue();
    });
    await open(page, '#/add');
    await expect(page.getByTestId('loading')).toHaveText(LOADING[lang]);
    await expect(h1(page)).toHaveCount(1);
    await expect(h1(page)).toHaveText('TBI Lab Admin');
    expect(await scan(page)).toEqual([]);
    release();
    await visible(page, 'add-form');
    await titled(page, lang, 'add');
  });

  test(`(${lang}) add unavailable: Back leads to the testers heading`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    await page.route('**/admin-api/accounts', (r) =>
      r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
    );
    await open(page, '#/add');
    await visible(page, 'problem');
    const back = page.getByTestId('add-back');
    await expect(back).toHaveAccessibleName(lang === 'he' ? 'חזור' : 'Back');
    await back.focus();
    await page.keyboard.press('Enter');
    await titled(page, lang, 'testers');
    await expect(h1(page)).toBeFocused();
  });

  for (const [name, { subject, walk }] of Object.entries(WALKS)) {
    test(`axe (${lang}) ${name}`, async ({ page, context, request }) => {
      test.setTimeout(120_000);
      await signIn(context, lang, subject);
      const found: string[] = [];
      const check: Check = async (state) => {
        await rendered(page, lang);
        found.push(...(await scan(page)).map((f) => `${state}: ${f}`));
      };
      await walk(page, request, check, lang);
      expect(found).toEqual([]);
    });

    // 320: the WCAG reflow width (phone layout); 900: the narrowest layout with data tables.
    for (const width of [320, 900])
      test(`reflow ${width} px (${lang}) ${name}`, async ({ page, context, request }) => {
        test.skip(test.info().project.name !== 'desktop', 'the width is set here: one project');
        test.setTimeout(120_000);
        await page.setViewportSize({ width, height: 700 });
        await signIn(context, lang, subject);
        const found: string[] = [];
        const check: Check = async (state) => {
          await rendered(page, lang);
          found.push(...(await reflowProblems(page)).map((f) => `${state}: ${f}`));
        };
        await walk(page, request, check, lang);
        expect(found).toEqual([]);
      });
  }
}
