/**
 * TBI-022 slice D, the "Open sign-up requests" screen (#/signups): keyboard-only decisions, the
 * focus after each outcome, the polite live region, reflow at 320 px, language/direction and the
 * LTR isolation of emails. Most tests mock the sign-up endpoints in the browser (synthetic data,
 * example.com only); the "real list" tests use the REAL admin service routes and store (fake
 * helper and mail sender, app/e2e/fixtures/fake-admin.ts) so a reload shows what the server keeps.
 * Everything else is the usual test gate. No axe: @axe-core/playwright is not a
 * dependency of this repository, so structure (headings, names, landmarks) is asserted directly.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const as = (context: BrowserContext, subject: string, url: string) =>
  context.addCookies([{ name: 'tbi_test_user', value: subject, url }]);

const row = (id: string, name: string, email: string, createdAt: string) => ({
  id,
  name,
  email,
  role: 'Teacher',
  lang: 'en',
  status: 'pending',
  accountAdded: false,
  emailAttempts: 0,
  lastError: null,
  createdAt,
});

const LONG = `${'long-address-part-'.repeat(5)}@subdomain.example.com`;
const ROWS = () => [
  row('r1', 'Dana Levi', 'dana@example.com', '2026-11-01T10:00:00Z'),
  row('r2', 'Omer Cohen', LONG, '2026-11-02T10:00:00Z'),
  row('r3', 'Noa Bar', 'noa@example.com', '2026-11-03T10:00:00Z'),
];

type Mode = 'list' | 'empty' | 'error';
type Auto = { status: number; json: unknown };
const AUTO_ON = {
  enabled: true,
  running: true,
  day: '2026-11-23',
  dailyCap: 20,
  count: 3,
  capReached: false,
  paused: false,
  stateDir: 'ok',
  cutoff: '2026-11-20T00:00:00.000Z',
  waitingBacklog: 4,
};
async function mock(
  page: Page,
  mode: Mode,
  actions: Record<string, unknown> = {},
  auto: Auto = { status: 200, json: { enabled: false } },
) {
  let rows = mode === 'list' ? ROWS() : [];
  const calls: string[] = [];
  await page.route('**/admin-api/signups/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auto-approve')) return route.fulfill(auto);
    if (url.pathname.endsWith('/open')) {
      if (mode === 'error') return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      return route.fulfill({ json: { signups: rows } });
    }
    const [, , , id, action] = url.pathname.split('/');
    calls.push(`${id}/${action}`);
    const custom = actions[`${id}/${action}`] as { status: number; json: unknown } | undefined;
    if (custom) return route.fulfill(custom);
    rows = rows.filter((r) => r.id !== id);
    return route.fulfill({ json: { record: null } });
  });
  return calls;
}

async function open(page: Page, context: BrowserContext, baseURL: string, lang: 'he' | 'en') {
  await as(context, 'e2e-owner', baseURL);
  await context.addInitScript((l) => localStorage.setItem('tbi-admin.locale', l), lang);
  await page.goto('/#/signups');
}

/** Press Tab until the focused element matches, like a keyboard user (bounded). */
async function tabTo(page: Page, testid: string, within?: string) {
  // Let the list render and settle first: Tabbing during hydration/re-render
  // loses the focus position and can walk past the target.
  const target = within
    ? page.locator(`[data-signup-id="${within}"]`).getByTestId(testid)
    : page.getByTestId(testid).first();
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate(
      ([id, scope]) => {
        const a = document.activeElement as HTMLElement | null;
        return a?.dataset.testid === id && (!scope || !!a.closest(`[data-signup-id="${scope}"]`));
      },
      [testid, within ?? ''] as const,
    );
    if (hit) return;
  }
  throw new Error(`could not Tab to ${testid}`);
}
const focusedId = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return `${a?.dataset.testid ?? a?.tagName}@${a?.closest('[data-signup-id]')?.getAttribute('data-signup-id') ?? ''}`;
  });

for (const lang of ['he', 'en'] as const) {
  test(`signups (${lang}): lang, dir, headings, names; emails are LTR`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page, 'list');
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('signup-row')).toHaveCount(3);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    // Every control has an accessible name that contains its visible text (2.5.3).
    for (const b of await page.getByTestId('signup-approve').all()) {
      const [name, text] = await b.evaluate((e) => [
        e.getAttribute('aria-label') ?? '',
        e.textContent ?? '',
      ]);
      expect(name.length).toBeGreaterThan(text.length);
      expect(name).toContain(text);
    }
    for (const e of await page.getByTestId('signup-email').all()) {
      expect(await e.evaluate((n) => getComputedStyle(n).direction)).toBe('ltr');
      expect(await e.evaluate((n) => n.getAttribute('dir'))).toBe('ltr');
    }
    await expect(page.getByTestId('signups-live')).toHaveAttribute('aria-live', 'polite');
  });

  test(`signups (${lang}): empty and error states are text, in a labelled section`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page, 'empty');
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('signups-empty')).toBeVisible();
    await expect(page.locator('section[aria-labelledby="signups-h"]')).toBeVisible();
    await expect(page.getByTestId('signups-live')).not.toBeEmpty();
    await page.unroute('**/admin-api/signups/**');
    await mock(page, 'error');
    await page.getByTestId('signups-refresh').click();
    await expect(page.getByTestId('signups-problem')).toBeVisible();
  });
}

for (const lang of ['he', 'en'] as const) {
  test(`signups (${lang}): web-form badge and "how they heard" are plain text; absent shows nothing`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page, 'list');
    await page.unroute('**/admin-api/signups/**');
    const web = {
      ...row('r1', 'Dana Levi', 'dana@example.com', '2026-11-01T10:00:00Z'),
      origin: 'web',
      heardFrom: '<a href="https://evil.example">a friend</a> שלום',
    };
    const old = row('r2', 'Omer Cohen', 'omer@example.com', '2026-11-02T10:00:00Z');
    await page.route('**/admin-api/signups/open', (route) =>
      route.fulfill({ json: { signups: [web, old] } }),
    );
    await open(page, context, baseURL!, lang);
    const r1 = page.locator('[data-signup-id="r1"]');
    await expect(r1.getByTestId('signup-origin-web')).toHaveText(
      lang === 'he' ? 'טופס אינטרנט' : 'Web form',
    );
    const heard = r1.getByTestId('signup-heard-from');
    await expect(heard).toContainText(lang === 'he' ? 'איך שמעו עלינו' : 'How they heard about us');
    await expect(heard).toContainText('<a href="https://evil.example">a friend</a>');
    await expect(heard.locator('a')).toHaveCount(0);
    const r2 = page.locator('[data-signup-id="r2"]');
    await expect(r2.getByTestId('signup-origin-web')).toHaveCount(0);
    await expect(r2.getByTestId('signup-heard-from')).toHaveCount(0);
    expect(await r2.evaluate((e) => (e as HTMLElement).innerText)).not.toContain('undefined');
  });
}

for (const lang of ['he', 'en'] as const) {
  test(`signups (${lang}): "approved automatically" badge is text in the row, with enough contrast`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page, 'list');
    // Replace the first mocked list: r1 was approved by the automatic approver, r2 by nobody yet.
    await page.unroute('**/admin-api/signups/**');
    const auto = {
      ...row('r1', 'Dana Levi', 'dana@example.com', '2026-11-01T10:00:00Z'),
      status: 'approved',
      accountAdded: true,
      autoApprovedAt: '2026-11-23T10:00:00.000Z',
    };
    const manual = row('r2', 'Omer Cohen', 'omer@example.com', '2026-11-02T10:00:00Z');
    await page.route('**/admin-api/signups/open', (route) =>
      route.fulfill({ json: { signups: [auto, manual] } }),
    );
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('signup-row')).toHaveCount(2);
    const text = lang === 'he' ? 'אושרה אוטומטית' : 'Approved automatically';
    const r1 = page.locator('[data-signup-id="r1"]');
    const badge = r1.getByTestId('signup-auto-approved');
    await expect(badge).toHaveText(text);
    await expect(badge).toBeVisible();
    // Part of the row's own text (so a screen reader reads it with the row), not an icon or colour.
    expect(await r1.evaluate((e) => (e as HTMLElement).innerText)).toContain(text);
    await expect(
      page.locator('[data-signup-id="r2"]').getByTestId('signup-auto-approved'),
    ).toHaveCount(0);
    // Contrast of the badge text on its background: at least 4.5:1 (WCAG 1.4.3).
    const ratio = await badge.evaluate((e) => {
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
      };
      const cs = getComputedStyle(e);
      const a = lum(rgb(cs.color));
      const b = lum(rgb(cs.backgroundColor));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    // It stays inside the viewport at 320 px (reflow), in both directions.
    await page.setViewportSize({ width: 320, height: 700 });
    const box = await badge.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  });
}

// ------------------------------------------------ the auto-approve status block (BETA-G1 s6)

const T = {
  en: {
    heading: 'Auto-approve status',
    off: 'Auto-approve is off.',
    today: (n: string, c: string) => `Auto-approved today: ${n} of ${c}`,
    running: 'Running',
    paused: 'Paused (kill switch)',
    notRunning: 'Not running',
    unknown: 'Unknown',
    unavailable: 'Auto-approve status is unavailable right now.',
    unknownWord: 'unknown',
    backlog: (n: string) => `Older requests waiting for you: ${n}`,
  },
  he: {
    heading: 'סטטוס אישור אוטומטי',
    off: 'האישור האוטומטי כבוי.',
    today: (n: string, c: string) => `אישורים אוטומטיים היום: ${n} מתוך ${c}`,
    running: 'פעיל',
    paused: 'מושהה (מתג עצירה)',
    notRunning: 'לא פועל',
    unknown: 'לא ידוע',
    unavailable: 'סטטוס האישור האוטומטי אינו זמין כרגע.',
    unknownWord: 'לא ידוע',
    backlog: (n: string) => `בקשות ישנות שממתינות לך: ${n}`,
  },
} as const;

const contrast = (loc: ReturnType<Page['getByTestId']>) =>
  loc.evaluate((e) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    let bg: Element | null = e;
    let bgc = 'rgba(0, 0, 0, 0)';
    while (bg && /rgba\(.*, 0\)|transparent/.test((bgc = getComputedStyle(bg).backgroundColor)))
      bg = bg.parentElement;
    const a = lum(rgb(getComputedStyle(e).color));
    const b = lum(rgb(bgc));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });

for (const lang of ['he', 'en'] as const) {
  const x = T[lang];
  test(`signups (${lang}): auto-approve block is a named region; off is a text line`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page, 'list');
    await open(page, context, baseURL!, lang);
    const block = page.getByTestId('auto-status');
    await expect(block.getByTestId('auto-off')).toHaveText(x.off);
    await expect(page.getByRole('region', { name: x.heading })).toBeVisible();
    await expect(block.getByRole('heading', { level: 2, name: x.heading })).toBeVisible();
    // Updated only on load and Refresh: not a live region of its own, and nothing writable.
    await expect(block.locator('[aria-live], [role=status], button, input, a')).toHaveCount(0);
  });

  test(`signups (${lang}): on and running shows today's count against the cap, LTR numbers`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(
      page,
      'list',
      {},
      { status: 200, json: { ...AUTO_ON, count: 20, capReached: true } },
    );
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('auto-today')).toHaveText(x.today('20', '20'));
    await expect(page.getByTestId('auto-state')).toHaveText(x.running);
    await expect(page.getByTestId('auto-cap-reached')).toBeVisible();
    await expect(page.getByTestId('auto-backlog')).toHaveText(x.backlog('4'));
    for (const b of await page.getByTestId('auto-today').locator('bdi').all())
      expect(await b.evaluate((n) => getComputedStyle(n).direction)).toBe('ltr');
    expect(await contrast(page.getByTestId('auto-state'))).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(page.getByTestId('auto-today'))).toBeGreaterThanOrEqual(4.5);
  });

  test(`signups (${lang}): paused, not running (wins over paused), unsafe directory reason`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page, 'list', {}, { status: 200, json: { ...AUTO_ON, paused: true } });
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('auto-state')).toHaveText(x.paused);
    await expect(page.getByTestId('auto-state')).toHaveAttribute('data-state', 'paused');
    expect(await contrast(page.getByTestId('auto-state'))).toBeGreaterThanOrEqual(4.5);

    await page.unroute('**/admin-api/signups/**');
    await mock(
      page,
      'list',
      {},
      {
        status: 200,
        json: { ...AUTO_ON, paused: true, stateDir: 'unsafe', stateDirReason: 'ancestor_mode' },
      },
    );
    await page.getByTestId('signups-refresh').click();
    await expect(page.getByTestId('auto-state')).toHaveText(x.notRunning);
    const reason = page.getByTestId('auto-reason').locator('bdi');
    await expect(reason).toHaveText('ancestor_mode');
    expect(await reason.evaluate((n) => getComputedStyle(n).direction)).toBe('ltr');
    expect(await contrast(page.getByTestId('auto-state'))).toBeGreaterThanOrEqual(4.5);

    await page.unroute('**/admin-api/signups/**');
    await mock(
      page,
      'list',
      {},
      { status: 200, json: { ...AUTO_ON, running: false, paused: true } },
    );
    await page.getByTestId('signups-refresh').click();
    await expect(page.getByTestId('auto-state')).toHaveText(x.notRunning);
  });

  test(`signups (${lang}): unknown values are the word "unknown", never 0`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(
      page,
      'list',
      {},
      {
        status: 200,
        json: {
          ...AUTO_ON,
          count: 'unknown',
          waitingBacklog: 'unknown',
          running: 'unknown',
          capReached: 'unknown',
        },
      },
    );
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('auto-today')).toHaveText(x.today(x.unknownWord, '20'));
    await expect(page.getByTestId('auto-state')).toHaveText(x.unknown);
    await expect(page.getByTestId('auto-backlog')).toHaveText(x.backlog(x.unknownWord));
    await expect(page.getByTestId('auto-cap-reached')).toHaveCount(0);
  });

  test(`signups (${lang}): a failed status fetch says so, the list still works; Refresh retries`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page, 'list', {}, { status: 500, json: { error: 'x' } });
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('auto-unavailable')).toHaveText(x.unavailable);
    await expect(page.getByTestId('signup-row')).toHaveCount(3);
    await page.unroute('**/admin-api/signups/**');
    await mock(page, 'list', {}, { status: 200, json: AUTO_ON });
    await page.getByTestId('signups-refresh').click();
    await expect(page.getByTestId('auto-today')).toHaveText(x.today('3', '20'));
    await expect(page.getByTestId('auto-unavailable')).toHaveCount(0);
  });

  test(`signups (${lang}): Refresh announces the count and the unavailable status together`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page, 'list', {}, { status: 200, json: AUTO_ON });
    await open(page, context, baseURL!, lang);
    const live = page.getByTestId('signups-live');
    const count = lang === 'he' ? '3 בקשות ממתינות לך' : '3 requests waiting for you';
    await expect(live).toHaveText(count);
    await page.unroute('**/admin-api/signups/**');
    await mock(page, 'list', {}, { status: 500, json: { error: 'x' } });
    // The status answers after the list: the one announcement still carries both sentences.
    await page.route('**/admin-api/signups/auto-approve', async (r) => {
      await new Promise((done) => setTimeout(done, 400));
      await r.fulfill({ status: 500, json: { error: 'x' } });
    });
    await page.getByTestId('signups-refresh').click();
    await expect(live).toHaveText(`${count}. ${x.unavailable}`);
    await expect(page.getByTestId('signups-refresh')).toBeFocused();
  });

  test(`signups (${lang}): a status failure after the wait is still announced, after the count`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page, 'list', {}, { status: 200, json: AUTO_ON });
    await open(page, context, baseURL!, lang);
    const live = page.getByTestId('signups-live');
    const count = lang === 'he' ? '3 בקשות ממתינות לך' : '3 requests waiting for you';
    await expect(live).toHaveText(count);
    await page.unroute('**/admin-api/signups/**');
    await mock(page, 'list', {}, { status: 500, json: { error: 'x' } });
    await page.route('**/admin-api/signups/auto-approve', async (r) => {
      await new Promise((done) => setTimeout(done, 4500)); // longer than the 3 s wait
      await r.fulfill({ status: 500, json: { error: 'x' } });
    });
    await page.getByTestId('signups-refresh').click();
    await expect(live).toHaveText(count, { timeout: 4000 });
    await expect(live).toHaveText(x.unavailable, { timeout: 6000 });
    await expect(page.getByTestId('auto-unavailable')).toHaveText(x.unavailable);
  });

  const checking =
    lang === 'he' ? 'בודקים את סטטוס האישור האוטומטי…' : 'Checking the auto-approve status…';

  /** Holds every later status request until released, then answers it with a failure. */
  async function holdStatus(page: Page) {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/admin-api/signups/auto-approve', async (r) => {
      await held;
      await r.fulfill({ status: 500, json: { error: 'x' } });
    });
    return release;
  }

  test(`signups (${lang}): a slow status on Refresh is shown and said as pending, then settles`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page, 'list', {}, { status: 200, json: AUTO_ON });
    await open(page, context, baseURL!, lang);
    const live = page.getByTestId('signups-live');
    const count = lang === 'he' ? '3 בקשות ממתינות לך' : '3 requests waiting for you';
    await expect(live).toHaveText(count);
    // The region is in the page, empty, before it has anything to say.
    const region = page.getByTestId('auto-pending-status');
    await expect(region).toHaveAttribute('role', 'status');
    await expect(region).toHaveText('');
    const release = await holdStatus(page);
    await page.getByTestId('signups-refresh').click();
    await expect(region).toHaveText(checking, { timeout: 2500 });
    await expect(page.getByTestId('auto-pending')).toBeVisible();
    await expect(page.getByTestId('signups-refresh')).toBeFocused();
    // Past the count's 3 s wait: the count alone, without the pending sentence.
    await page.waitForTimeout(2800);
    await expect(live).toHaveText(count);
    release();
    await expect(live).toHaveText(x.unavailable);
    await expect(region).toHaveText('');
    await expect(page.getByTestId('signups-refresh')).toBeFocused();
  });

  test(`signups (${lang}): a quick Refresh never says pending`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page, 'list', {}, { status: 200, json: AUTO_ON });
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('auto-today')).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { pendingSeen: boolean };
      w.pendingSeen = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="auto-pending"]')) w.pendingSeen = true;
      }).observe(document.body, { subtree: true, childList: true });
    });
    await page.getByTestId('signups-refresh').click();
    await page.waitForTimeout(1600);
    expect(
      await page.evaluate(() => (window as unknown as { pendingSeen: boolean }).pendingSeen),
    ).toBe(false);
  });

  test(`signups (${lang}): a slow first load says only "loading", no second pending line`, async ({
    page,
    context,
    baseURL,
  }) => {
    await mock(page, 'list');
    const release = await holdStatus(page);
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('signup-row')).toHaveCount(3);
    await page.waitForTimeout(1600);
    await expect(page.getByTestId('auto-status')).toContainText(lang === 'he' ? 'טוען' : 'Loading');
    await expect(page.getByTestId('auto-pending')).toHaveCount(0);
    release();
    await expect(page.getByTestId('signups-live')).toContainText(x.unavailable);
  });

  test(`signups (${lang}): a late status failure is said after a queued outcome took focus`, async ({
    page,
    context,
    baseURL,
  }) => {
    const queued = {
      ...ROWS()[0],
      status: 'email_queued',
      accountAdded: true,
      emailSendAfter: '2026-11-28T06:00:00Z',
    };
    await mock(
      page,
      'list',
      { 'r1/approve': { status: 200, json: { record: queued, note: 'email_queued' } } },
      { status: 200, json: AUTO_ON },
    );
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('auto-today')).toBeVisible();
    const release = await holdStatus(page);
    await page.getByTestId('signups-refresh').click();
    await expect(page.getByTestId('auto-pending')).toBeVisible({ timeout: 2500 });
    const first = page.locator('[data-signup-id="r1"]');
    await first.getByTestId('signup-approve').click();
    const message = first.getByTestId('signup-message');
    await expect(message).toBeFocused();
    // The focused sentence is read by focus: the live region stays empty past the count's wait.
    await page.waitForTimeout(3500);
    await expect(page.getByTestId('signups-live')).toHaveText('');
    release();
    await expect(page.getByTestId('signups-live')).toHaveText(x.unavailable);
    await expect(message).toBeFocused();
  });

  test(`signups (${lang}): 320 px, the status block does not overflow`, async ({
    page,
    context,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await mock(
      page,
      'list',
      {},
      {
        status: 200,
        json: { ...AUTO_ON, stateDir: 'unsafe', stateDirReason: 'ancestor_mode', paused: true },
      },
    );
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('auto-state')).toBeVisible();
    const m = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
      wide: [...document.querySelectorAll<HTMLElement>('[data-testid=auto-status] *')].filter(
        (e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && (r.right > window.innerWidth + 0.5 || r.left < -0.5);
        },
      ).length,
    }));
    expect(m.wide).toBe(0);
    expect(m.scroll).toBeLessThanOrEqual(m.inner);
  });
}

test('signups: keyboard only, Approve then the outcome, focus goes to the next row', async ({
  page,
  context,
  baseURL,
}) => {
  const calls = await mock(page, 'list');
  await open(page, context, baseURL!, 'en');
  await expect(page.getByTestId('signup-row')).toHaveCount(3);
  await tabTo(page, 'signup-approve', 'r1');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('signup-row')).toHaveCount(2);
  expect(calls).toEqual(['r1/approve']);
  await expect.poll(() => focusedId(page)).toBe('signup-approve@r2');
  // The outcome is announced politely.
  await expect(page.getByTestId('signups-live')).toContainText(/Approved/);
});

test('signups: Reject asks first; Esc cancels and returns to Reject; confirm then outcome', async ({
  page,
  context,
  baseURL,
}) => {
  const calls = await mock(page, 'list');
  await open(page, context, baseURL!, 'en');
  await expect(page.getByTestId('signup-row')).toHaveCount(3);
  await tabTo(page, 'signup-reject', 'r1');
  await page.keyboard.press('Enter');
  const confirm = page.getByTestId('confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveAttribute('role', 'alertdialog');
  await expect.poll(() => focusedId(page)).toBe('confirm-cancel@r1');
  // Heading order: the confirmation title is an h2 under the page's h1.
  await expect(confirm.getByRole('heading', { level: 2 })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  expect(calls).toEqual([]);
  await expect.poll(() => focusedId(page)).toBe('signup-reject@r1');
  // Again, and this time confirm with the keyboard.
  await page.keyboard.press('Enter');
  await expect.poll(() => focusedId(page)).toBe('confirm-cancel@r1');
  await page.keyboard.press('Tab');
  await expect.poll(() => focusedId(page)).toBe('confirm-ok@r1');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('signup-row')).toHaveCount(2);
  expect(calls).toEqual(['r1/reject']);
  await expect(page.getByTestId('signups-live')).toContainText(/Rejected/);
  await expect.poll(() => focusedId(page)).toBe('signup-approve@r2');
});

test('signups: a failed outcome keeps the row, shows text and keeps focus on its action', async ({
  page,
  context,
  baseURL,
}) => {
  await mock(page, 'list', {
    'r1/approve': { status: 409, json: { error: 'bad_state', record: null } },
  });
  await open(page, context, baseURL!, 'en');
  await tabTo(page, 'signup-approve', 'r1');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('signup-message').first()).toContainText(/already handled/);
  await expect(page.getByTestId('signups-live')).toContainText(/already handled/);
  await expect.poll(() => focusedId(page)).toBe('signup-approve@r1');
  // Same failure again: the live region is re-announced (cleared, then set).
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('signups-live')).toContainText(/already handled/);
});

test('signups: an email_queued outcome is announced in the live region', async ({
  page,
  context,
  baseURL,
}) => {
  await mock(page, 'list', {
    'r1/approve': { status: 200, json: { record: null, note: 'email_queued' } },
  });
  await open(page, context, baseURL!, 'en');
  await tabTo(page, 'signup-approve', 'r1');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('signups-live')).toContainText(/Dana Levi/);
  await expect(page.getByTestId('signups-live')).toContainText(/quiet hours/i);
});

for (const lang of ['he', 'en'] as const)
  test(`signups (${lang}): 320 px reflow, no sideways scroll, long email`, async ({
    page,
    context,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await mock(page, 'list');
    await open(page, context, baseURL!, lang);
    await expect(page.getByTestId('signup-row')).toHaveCount(3);
    await tabTo(page, 'signup-reject', 'r2');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('confirm')).toBeVisible();
    const m = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
      wide: [...document.querySelectorAll<HTMLElement>('main *, section *')]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && (r.right > window.innerWidth + 0.5 || r.left < -0.5);
        })
        .map((e) => `${e.tagName}.${e.className}`)
        .slice(0, 5),
    }));
    expect(m.wide).toEqual([]);
    expect(m.scroll).toBeLessThanOrEqual(m.inner);
  });

// ---------------------------------------------------------------- the real admin service

const FAKE = 'http://127.0.0.1:7499';
const rowOf = (page: Page, kind: string) =>
  page.locator(`[data-testid="signup-row"][data-kind="${kind}"]`);
const kinds = (page: Page) =>
  page
    .getByTestId('signup-row')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-kind')));

test.describe('signups: the real list', () => {
  test.beforeEach(async ({ request }) => {
    await request.post(`${FAKE}/__test/reset-admin`);
    await request.post(`${FAKE}/__test/admin-signups?seed=1&mailFail=1`);
  });
  test.afterEach(async ({ request }) => {
    await request.post(`${FAKE}/__test/admin-signups?seed=0&mailFail=0`);
  });

  for (const lang of ['he', 'en'] as const)
    test(`(${lang}) failed and queued emails stay listed after a reload, sent and rejected do not`, async ({
      page,
      context,
      baseURL,
    }) => {
      await open(page, context, baseURL!, lang);
      await expect(page.getByTestId('signup-row')).toHaveCount(4);
      expect(await kinds(page)).toEqual(['decide', 'resend', 'queued', 'resend']);
      await page.reload();
      await expect(page.getByTestId('signup-row')).toHaveCount(4);
      expect(await kinds(page)).toEqual(['decide', 'resend', 'queued', 'resend']);
      // Resend on each failed / unknown-outcome row, named with the person; the queued row shows
      // its send time and offers nothing to press.
      for (const b of await page.getByTestId('signup-resend').all()) {
        const [name, text] = await b.evaluate((e) => [
          e.getAttribute('aria-label') ?? '',
          e.textContent ?? '',
        ]);
        expect(name).toContain(text);
        expect(name).toMatch(/Sample/);
      }
      const queued = rowOf(page, 'queued');
      await expect(queued.getByTestId('signup-send-after')).toBeVisible();
      await expect(queued.locator('button')).toHaveCount(0);
      // Only the three rows that need the owner are counted; the queued email needs nothing.
      const count = lang === 'he' ? '3 בקשות ממתינות לך' : '3 requests waiting for you';
      await expect(page.getByTestId('signups-live')).toContainText(count);
      await expect(page.getByTestId('signups-count')).toHaveText(count);
    });

  test('Resend: a failure keeps the row and focus; a success removes it and focus moves on', async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    await open(page, context, baseURL!, 'en');
    await expect(page.getByTestId('signup-row')).toHaveCount(4);
    const failedId = await page.getByTestId('signup-row').nth(3).getAttribute('data-signup-id');
    const queuedId = await rowOf(page, 'queued').getAttribute('data-signup-id');
    await tabTo(page, 'signup-resend', failedId!);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('signups-live')).toContainText(/could not be sent/);
    await expect.poll(() => focusedId(page)).toBe(`signup-resend@${failedId}`);
    await expect(page.getByTestId('signup-row')).toHaveCount(4);

    await request.post(`${FAKE}/__test/admin-signups?seed=1&mailFail=0`).catch(() => undefined);
    // Re-seeding replaced the store; reload and press Resend on the failed row again.
    await page.reload();
    await expect(page.getByTestId('signup-row')).toHaveCount(4);
    const again = await page.getByTestId('signup-row').nth(3).getAttribute('data-signup-id');
    const queuedAgain = await rowOf(page, 'queued').getAttribute('data-signup-id');
    expect(queuedAgain).not.toBe(queuedId);
    await tabTo(page, 'signup-resend', again!);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('signup-row')).toHaveCount(3);
    await expect(page.getByTestId('signups-live')).toContainText(/was sent/);
    // The last row left: focus goes to the previous one, the queued row (no button: the row).
    await expect.poll(() => focusedId(page)).toBe(`signup-row@${queuedAgain}`);
    await page.reload();
    await expect(page.getByTestId('signup-row')).toHaveCount(3);
    expect(await kinds(page)).toEqual(['decide', 'resend', 'queued']);
  });
});
