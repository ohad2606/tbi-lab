/**
 * Sprint 8 Phase 2, browser level: two users of the same deployment (the test gate asserts the
 * user named by the `tbi_test_user` cookie). A private build is never visible to another user —
 * not even for byte-identical source — while builds of the curated examples are shared.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { waitSaved } from './helpers.js';

const FAKE = 'http://127.0.0.1:7499';
const phase = (page: Page) => page.getByTestId('build-phase');
const code = (page: Page) => page.getByTestId('code-text');

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/end-all?reason=terminated`);
  await request.post(`${FAKE}/__test/reset-builds`);
});

async function asUser(browser: Browser, user: string, baseURL: string) {
  const context = await browser.newContext({ baseURL });
  await context.addCookies([{ name: 'tbi_test_user', value: user, url: baseURL }]);
  return { context, page: await context.newPage() };
}

async function openBlink(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('example-list')).toBeVisible();
  await page.getByTestId('language-select').selectOption('en');
  await page.getByTestId('open-example-esp32-blink').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  await page.getByTestId('view-code').click();
}

test('a private build stays private (even for identical source); curated examples are shared', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const a = await asUser(browser, 'user-a', baseURL!);
  const b = await asUser(browser, 'user-b', baseURL!);
  try {
    // A builds the unmodified example: a shared system record.
    await openBlink(a.page);
    await a.page.getByTestId('build-button').click();
    await expect(phase(a.page)).toHaveAttribute('data-phase', 'current');
    // B opens the same example: its build is found at once (shared), nothing is compiled.
    const builds: string[] = [];
    b.page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/build/v1/builds')
        builds.push(r.url());
    });
    await openBlink(b.page);
    await expect(phase(b.page)).toHaveAttribute('data-phase', 'current');
    expect(builds).toEqual([]);

    // A makes the sketch their own and builds it: a private record.
    const edit = '\n// private change by one user';
    for (const p of [a.page, b.page]) await code(p).press('Control+End');
    await code(a.page).type(edit);
    await a.page.getByTestId('build-button').click();
    await expect(phase(a.page)).toHaveAttribute('data-phase', 'current');
    // B types exactly the same text: nothing of A's build is visible; B must build (compile).
    await code(b.page).type(edit);
    await expect(phase(b.page)).toHaveAttribute('data-phase', 'required');
    await b.page.getByTestId('build-button').click();
    await expect(phase(b.page)).toHaveAttribute('data-phase', 'building');
    await expect(phase(b.page)).toHaveAttribute('data-phase', 'current');
    expect(builds).toHaveLength(1);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
