/**
 * TBI-022 slice D, the "Pending sign-up requests" screen (#/signups): keyboard-only decisions, the
 * focus after each outcome, the polite live region, reflow at 320 px, language/direction and the
 * LTR isolation of emails. The sign-up endpoints are mocked in the browser (synthetic data,
 * example.com only); everything else is the usual test gate. No axe: @axe-core/playwright is not a
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
async function mock(page: Page, mode: Mode, actions: Record<string, unknown> = {}) {
  let rows = mode === 'list' ? ROWS() : [];
  const calls: string[] = [];
  await page.route('**/admin-api/signups/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/pending')) {
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
  for (let i = 0; i < 40; i++) {
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
    await expect(page.getByRole('region', { name: /\S/ })).toBeVisible();
    await expect(page.getByTestId('signups-live')).not.toBeEmpty();
    await page.unroute('**/admin-api/signups/**');
    await mock(page, 'error');
    await page.getByTestId('signups-refresh').click();
    await expect(page.getByTestId('signups-problem')).toBeVisible();
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
  expect(await focusedId(page)).toBe('confirm-cancel@r1');
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
  expect(await focusedId(page)).toBe('confirm-ok@r1');
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
