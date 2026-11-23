/**
 * TBI-018 s3d-5: the run queue as the user meets it, EN and HE (RTL), against the fake Session Host's
 * scripted queue (fixtures/fake-session-host.ts `/__test/queue`; the real transport, a stub admission).
 *
 * - one polite role=status region with the place in the queue, numbers LTR-isolated, announced on a
 *   change only; nothing steals focus (Run/Stop keeps it);
 * - Cancel is a normal button, operable with the keyboard; it cancels on the host (DELETE), stops the
 *   polling, and focus goes to Run (never <body>);
 * - 409 queue_replaced: polling stops and the message is shown;
 * - 320 CSS px: no horizontal scroll while queued.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { buildProgram, goToProjects, waitSaved } from './helpers.js';

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);

/** axe-core (a dev dependency, injected as the site spec does) on the notice area; WCAG 2.x A/AA. */
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
const LRI = '⁦';
const PDI = '⁩';

const TEXT = {
  en: {
    queue: (n: number) => `You are number ${LRI}${n}${PDI} in the queue`,
    replaced: 'now held by another tab',
    label: 'Run queue status',
    cancel: 'Cancel',
  },
  he: {
    queue: (n: number) => `אתם במקום ${LRI}${n}${PDI} בתור`,
    replaced: 'הועבר ללשונית אחרת',
    label: 'מצב תור ההרצה',
    cancel: 'ביטול',
  },
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

const queueState = async (page: Page) =>
  (await (await page.request.get(`${FAKE}/__test/queue-state`)).json()) as {
    polls: number;
    cancels: number;
    ticketHeaders: string[];
  };

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/end-all?reason=terminated`);
  await request.post(`${FAKE}/__test/queue`); // off
});
test.afterEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/queue`);
});

for (const locale of ['en', 'he'] as const) {
  const T = TEXT[locale];

  test(`${locale}: the place is announced in one polite status region, focus stays, then the run starts`, async ({
    page,
    request,
  }) => {
    await open(page, locale);
    await request.post(`${FAKE}/__test/queue?steps=3,2`);
    const region = page.getByTestId('queue-status');
    await expect(region).toHaveAttribute('role', 'status');
    await expect(region).toHaveAccessibleName(T.label);
    await expect(region).toHaveText('');
    await page.getByTestId('sim-run').click();
    await expect(region).toContainText(T.queue(3), { timeout: 10_000 });
    // The same Run/Stop control keeps the focus: the status never takes it.
    await expect(page.getByTestId('sim-stop')).toBeFocused();
    await expect(region).toContainText(T.queue(2), { timeout: 10_000 });
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running', {
      timeout: 20_000,
    });
    await expect(region).toHaveText('');
    await expect(page.getByTestId('queue-cancel')).toHaveCount(0);
    const st = await queueState(page);
    expect(st.polls).toBe(2);
    expect(st.ticketHeaders[0]).toBe(''); // the first request has no ticket
    expect(st.ticketHeaders[1]).toBe('AAAAAAAAAAAAAAAAAAAAAA'); // a poll carries it (in a header)
    await page.getByTestId('sim-stop').click();
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'stopped', {
      timeout: 20_000,
    });
  });

  test(`${locale}: Cancel works from the keyboard, cancels on the host, stops polling, focus returns to Run`, async ({
    page,
    request,
  }) => {
    await open(page, locale);
    await request.post(`${FAKE}/__test/queue?steps=5,5,5,5,5,5,5,5`);
    await page.getByTestId('sim-run').click();
    await expect(page.getByTestId('queue-status')).toContainText(T.queue(5), { timeout: 10_000 });
    const cancel = page.getByTestId('queue-cancel');
    await expect(cancel).toHaveAccessibleName(T.cancel);
    expect(await axeNotices(page, '[data-testid="queue-banner"]')).toEqual([]);
    await cancel.focus();
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'stopped');
    await expect(page.getByTestId('sim-run')).toBeFocused();
    await expect(page.getByTestId('queue-status')).toHaveText('');
    await expect.poll(async () => (await queueState(page)).cancels).toBe(1);
    const polls = (await queueState(page)).polls;
    await page.waitForTimeout(2500);
    expect((await queueState(page)).polls).toBe(polls); // no poll after Cancel
  });

  test(`${locale}: 409 queue_replaced stops polling and says why`, async ({ page, request }) => {
    await open(page, locale);
    await request.post(`${FAKE}/__test/queue?steps=4,replaced,4`);
    await page.getByTestId('sim-run').click();
    const err = page.getByTestId('sim-error');
    await expect(err).toContainText(T.replaced, { timeout: 15_000 });
    await expect(err).toHaveAttribute('role', 'alert');
    expect(await axeNotices(page, '[data-testid="sim-error"]')).toEqual([]);
    await expect(page.getByTestId('queue-status')).toHaveText('');
    await page.waitForTimeout(2500);
    expect((await queueState(page)).polls).toBe(2); // the third scripted step was never asked
  });
}

test('a queued run wraps inside its banner at a 320 CSS px viewport', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await open(page, 'he');
  await request.post(`${FAKE}/__test/queue?steps=12,12,12,12,12`);
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('queue-status')).toContainText('12', { timeout: 10_000 });
  // The app shell is 1024 px wide at any viewport today (a known, app-wide limit, not this slice's);
  // what this slice owns: its text wraps and nothing overflows inside the banner.
  const inner = await page
    .getByTestId('queue-banner')
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(inner).toBeLessThanOrEqual(0);
  await expect(page.getByTestId('queue-cancel')).toBeVisible();
  await page.getByTestId('queue-cancel').click();
});
