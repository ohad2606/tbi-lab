/**
 * BETA-G2 s3: a refused start ("try again later": 429 free_paused / queue_full from the host) as the
 * user meets it, EN and HE (RTL), against the fake Session Host's scripted answers.
 *
 * - one polite role=status region (not role=alert), calm text that carries the meaning;
 * - nothing steals focus when it appears;
 * - a keyboard-operable "Try again" button restarts the start; focus never falls to <body>;
 * - no axe violations; no horizontal overflow at 320 CSS px.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { buildProgram, goToProjects, waitSaved } from './helpers.js';

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);
async function axeNotices(page: Page, selector: string) {
  await page.evaluate(axeSource);
  return page.evaluate(async (sel) => {
    const r = await (window as any).axe.run(
      { include: [sel] },
      {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      },
    );
    return r.violations.map(
      (v: any) => `${v.id}: ${v.nodes.map((n: any) => n.target.join(' ')).join(', ')}`,
    );
  }, selector);
}

const FAKE = 'http://127.0.0.1:7499';
const TEXT = {
  en: {
    paused: 'New runs are paused right now',
    full: 'queue is full right now',
    retry: 'Try again',
  },
  he: { paused: 'הרצות חדשות מושהות כרגע', full: 'תור ההרצה מלא כרגע', retry: 'נסו שוב' },
} as const;

async function open(page: Page, locale: 'en' | 'he') {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(locale);
  await page.getByTestId('open-example-esp32-blink').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  await buildProgram(page);
}

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/end-all?reason=terminated`);
  await request.post(`${FAKE}/__test/queue`);
});
test.afterEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/queue`);
});

for (const locale of ['en', 'he'] as const) {
  const T = TEXT[locale];

  test(`${locale}: a 429 free_paused is a calm status with Try again; the keyboard restarts the run`, async ({
    page,
    request,
  }) => {
    await open(page, locale);
    await request.post(`${FAKE}/__test/queue?steps=free_paused`);
    const region = page.getByTestId('limit-status');
    await expect(region).toHaveAttribute('role', 'status');
    await expect(region).toHaveText('');
    await page.getByTestId('sim-run').click();
    await expect(region).toContainText(T.paused, { timeout: 10_000 });
    await expect(page.getByTestId('sim-error')).toHaveCount(0); // not an alert
    // Nothing stole the focus; the message is not announced by colour alone (it is text).
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
    expect(await page.getByTestId('limit-status').getAttribute('role')).toBe('status');
    const retry = page.getByTestId('limit-retry');
    await expect(retry).toHaveAccessibleName(T.retry);
    expect(await retry.evaluate((el) => !el.closest('[role="status"],[role="alert"]'))).toBe(true);
    expect(await axeNotices(page, '[data-testid="limit-notice"]')).toEqual([]);
    await retry.focus();
    await expect(retry).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running', {
      timeout: 20_000,
    });
    await expect(region).toHaveText('');
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
    await page.getByTestId('sim-stop').click();
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'stopped', {
      timeout: 20_000,
    });
  });

  test(`${locale}: queue_full is the same calm status`, async ({ page, request }) => {
    await open(page, locale);
    await request.post(`${FAKE}/__test/queue?steps=queue_full`);
    await page.getByTestId('sim-run').click();
    await expect(page.getByTestId('limit-status')).toContainText(T.full, { timeout: 10_000 });
    await expect(page.getByTestId('limit-retry')).toBeVisible();
  });
}

test('the limit notice wraps at 320 CSS px', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await open(page, 'he');
  await request.post(`${FAKE}/__test/queue?steps=free_paused`);
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('limit-status')).toContainText('מושהות', { timeout: 10_000 });
  const inner = await page
    .getByTestId('limit-notice')
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(inner).toBeLessThanOrEqual(0);
  await expect(page.getByTestId('limit-retry')).toBeVisible();
});
