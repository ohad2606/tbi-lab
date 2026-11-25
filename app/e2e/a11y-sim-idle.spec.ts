/**
 * K3-3: "Still there?", EN and HE (RTL), keyboard only, against the fake Session Host (`/__test/idle`
 * makes new sessions report an idle limit; the warning shows one minute before it).
 *
 * - modal alertdialog with a name and a description; focus on "Keep running"; Tab stays inside;
 * - only an explicit answer closes it (Tab does not); Esc and the buttons work; focus returns;
 * - a refused "keep running" is said in the dialog and "Stop now" still works;
 * - the idle end closes it, focus goes to Run, and a calm status offers "Try again";
 * - no axe violations; no overflow at 320 CSS px.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { buildProgram, goToProjects, waitSaved } from './helpers.js';

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);
async function axe(page: Page, selector: string) {
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
/** The warning shows this long after the run starts (the lead is the app's fixed 60 s). */
const LEAD_MS = 8_000;
const IDLE_MS = 60_000 + LEAD_MS;
const TEXT = {
  en: {
    title: 'Still there?',
    body: 'the run will stop in about a minute',
    keep: 'Keep running',
    stop: 'Stop now',
    failed: 'We could not confirm',
    ended: 'stopped after a minute without activity',
    retry: 'Try again',
    dir: 'ltr',
  },
  he: {
    title: 'עדיין כאן?',
    body: 'ההרצה תיעצר בעוד כדקה',
    keep: 'להמשיך בהרצה',
    stop: 'לעצור עכשיו',
    failed: 'לא הצלחנו לאשר',
    ended: 'נעצרה אחרי דקה ללא פעילות',
    retry: 'נסו שוב',
    dir: 'rtl',
  },
} as const;

const idle = (request: APIRequestContext, query = '') =>
  request.post(`${FAKE}/__test/idle${query}`);
const presences = async (request: APIRequestContext): Promise<number> =>
  (await (await request.get(`${FAKE}/__test/idle-state`)).json()).presences;
const status = (page: Page) => page.getByTestId('sim-status');

/** An ESP32 run started from the keyboard, with focus then parked on the circuit view tab. */
async function run(page: Page, locale: 'en' | 'he') {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(locale);
  await page.getByTestId('open-example-esp32-blink').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  await buildProgram(page);
  await page.getByTestId('sim-run').focus();
  await page.keyboard.press('Enter');
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
  await page.getByTestId('view-circuit').focus();
}

async function warned(page: Page) {
  await expect(page.getByTestId('idle-dialog')).toBeVisible({ timeout: LEAD_MS + 10_000 });
  await expect(page.getByTestId('idle-keep')).toBeFocused();
}

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/end-all?reason=terminated`);
  await request.post(`${FAKE}/__test/queue`);
  await idle(request, `?ms=${IDLE_MS}`);
});
test.afterEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/end-all?reason=terminated`);
  await idle(request);
});

/** Record each change of the end notice's live region, relative to the dialog leaving the DOM. */
const watchEndNotice = (page: Page) =>
  page.evaluate(() => {
    const seen: { dialog: boolean; closedInSameBatch: boolean }[] = [];
    (window as any).__endNotice = seen;
    let last = '';
    new MutationObserver((records) => {
      const text = document.querySelector('[data-testid="limit-status"]')?.textContent ?? '';
      if (text === last) return;
      last = text;
      const closedInSameBatch = records.some((r) =>
        [...r.removedNodes].some(
          (n) => n instanceof Element && n.matches('[data-testid="idle-dialog"]'),
        ),
      );
      const dialog = !!document.querySelector('[data-testid="idle-dialog"]');
      seen.push({ dialog, closedInSameBatch });
    }).observe(document.body, { childList: true, characterData: true, subtree: true });
  });

for (const locale of ['en', 'he'] as const) {
  const T = TEXT[locale];

  test(`${locale}: modal alertdialog; Tab stays inside; Esc and Keep running extend; focus returns`, async ({
    page,
    request,
  }) => {
    await run(page, locale);
    await warned(page);
    const dialog = page.getByRole('alertdialog', { name: T.title });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAttribute('dir', T.dir);
    await expect(dialog).toHaveAccessibleDescription(new RegExp(T.body));
    expect(await dialog.evaluate((el) => el.matches(':modal'))).toBe(true);
    const keep = dialog.getByRole('button', { name: T.keep });
    const stop = dialog.getByRole('button', { name: T.stop });
    await expect(keep).toBeFocused();
    for (const [key, target] of [
      ['Tab', stop],
      ['Tab', keep],
      ['Shift+Tab', stop],
      ['Shift+Tab', keep],
    ] as const) {
      await page.keyboard.press(key);
      await expect(target).toBeFocused();
    }
    // Passive input neither dismissed it nor told the host anything.
    await expect(dialog).toBeVisible();
    expect(await presences(request)).toBe(0);
    expect(await axe(page, '[data-testid="idle-dialog"]')).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('view-circuit')).toBeFocused();
    expect(await presences(request)).toBe(1);
    await expect(status(page)).toHaveAttribute('data-status', 'running');

    // It returns; the same answer by keyboard activation of the button.
    await warned(page);
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('view-circuit')).toBeFocused();
    expect(await presences(request)).toBe(2);

    // A click without any key or pointer event, as assistive technology may send it.
    await warned(page);
    await keep.dispatchEvent('click');
    await expect(dialog).toHaveCount(0);
    expect(await presences(request)).toBe(3);
  });

  test(`${locale}: a held Enter or Space does not decide; a browser re-open keeps focus on Keep running`, async ({
    page,
    request,
  }) => {
    await run(page, locale);
    // Held down before the prompt: what reaches the dialog afterwards is auto-repeat.
    await page.keyboard.down('Enter');
    await page.keyboard.down('Space');
    await warned(page);
    // The first keydown, before the prompt, was ordinary activity; count from here.
    const before = await presences(request);
    await page.keyboard.down('Enter');
    await page.keyboard.down('Space');
    await page.keyboard.up('Space');
    await page.keyboard.up('Enter');
    const dialog = page.getByTestId('idle-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('idle-keep')).toBeFocused();
    expect(await presences(request)).toBe(before);

    // Closed by the browser while the warning stands: modal again, focus on Keep running.
    await dialog.evaluate((el: HTMLDialogElement) => el.close());
    await expect.poll(() => dialog.evaluate((el) => el.matches(':modal'))).toBe(true);
    await expect(page.getByTestId('idle-keep')).toBeFocused();
    expect(await presences(request)).toBe(before);

    // A fresh press still decides.
    await page.keyboard.press('Space');
    await expect(dialog).toHaveCount(0);
    expect(await presences(request)).toBe(before + 1);
  });

  test(`${locale}: Stop now ends the run and leaves focus on Run`, async ({ page, request }) => {
    await run(page, locale);
    await warned(page);
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('idle-stop')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('idle-dialog')).toHaveCount(0);
    await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 20_000 });
    await expect(page.getByTestId('sim-run')).toBeFocused();
    expect(await presences(request)).toBe(0);
    await expect(page.getByTestId('limit-status')).toHaveText('');
  });

  test(`${locale}: a refused Keep running is said in the dialog; Stop now still works by pointer`, async ({
    page,
    request,
  }) => {
    await idle(request, `?ms=${IDLE_MS}&fail=1`);
    await run(page, locale);
    await warned(page);
    const failed = page.getByTestId('idle-failed');
    await expect(failed).toHaveAttribute('role', 'status');
    await expect(failed).toHaveText('');
    await page.keyboard.press('Enter');
    await expect(failed).toContainText(T.failed);
    await expect(page.getByTestId('idle-dialog')).toBeVisible();
    await expect(page.getByTestId('idle-keep')).toBeFocused();
    expect(await axe(page, '[data-testid="idle-dialog"]')).toEqual([]);
    // A second Esc must not close it behind the user's back (it asks again).
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect.poll(() => presences(request)).toBeGreaterThanOrEqual(2);
    await expect(failed).toContainText(T.failed);
    await expect(page.getByTestId('idle-dialog')).toBeVisible();
    await page.getByTestId('idle-stop').click();
    await expect(page.getByTestId('idle-dialog')).toHaveCount(0);
    await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 20_000 });
    await expect(page.getByTestId('sim-run')).toBeFocused();
  });

  test(`${locale}: the idle end closes the dialog; a calm status offers Try again`, async ({
    page,
    request,
  }) => {
    await run(page, locale);
    await warned(page);
    await watchEndNotice(page);
    await request.post(`${FAKE}/__test/end-all?reason=idle_timeout`);
    await expect(page.getByTestId('idle-dialog')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId('sim-run')).toBeFocused();
    const region = page.getByTestId('limit-status');
    await expect(region).toHaveAttribute('role', 'status');
    await expect(region).toContainText(T.ended);
    // 4.1.3: one text insertion, after the modal is gone (not in the same DOM update).
    expect(await page.evaluate(() => (window as any).__endNotice)).toEqual([
      { dialog: false, closedInSameBatch: false },
    ]);
    await expect(page.getByTestId('sim-error')).toHaveCount(0); // not a red alert
    expect(await axe(page, '[data-testid="limit-notice"]')).toEqual([]);
    const retry = page.getByTestId('limit-retry');
    await expect(retry).toHaveAccessibleName(T.retry);
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
    await expect(page.getByTestId('sim-stop')).toBeFocused();
    await expect(region).toHaveText('');
  });
}

test('he: the dialog and the end notice fit 320 CSS px', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await idle(request, `?ms=${IDLE_MS}&fail=1`);
  await run(page, 'he');
  await warned(page);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('idle-failed')).toContainText(TEXT.he.failed);
  const dialog = page.getByTestId('idle-dialog');
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  for (const id of ['idle-keep', 'idle-stop']) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(24);
    expect(b.x).toBeGreaterThanOrEqual(box.x);
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width);
  }
  await request.post(`${FAKE}/__test/end-all?reason=idle_timeout`);
  await expect(page.getByTestId('limit-status')).toContainText(TEXT.he.ended, { timeout: 10_000 });
  const notice = page.getByTestId('limit-notice');
  expect(await notice.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});

for (const locale of ['en', 'he'] as const) {
  for (const [size, rootPx] of [
    ['100%', null],
    ['200% text', 30],
  ] as const) {
    test(`${locale}: at 1024x768, ${size}, the whole description and both buttons are reachable`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width: 1024, height: 768 });
      await idle(request, `?ms=${IDLE_MS}&fail=1`);
      await run(page, locale);
      // The app's root size is 15px and its text is in rem.
      if (rootPx) await page.addStyleTag({ content: `:root { font-size: ${rootPx}px }` });
      await warned(page);
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('idle-failed')).toContainText(TEXT[locale].failed);
      const dialog = page.getByTestId('idle-dialog');
      await expect(dialog).toHaveAttribute('aria-describedby', 'idle-body');
      await expect(dialog).toHaveAccessibleDescription(new RegExp(TEXT[locale].body));
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(1024);
      expect(box.y + box.height).toBeLessThanOrEqual(768);
      // No scrolling needed in either direction: nothing is clipped.
      const over = await dialog.evaluate((el) => [
        el.scrollWidth - el.clientWidth,
        el.scrollHeight - el.clientHeight,
      ]);
      expect(Math.max(...over)).toBeLessThanOrEqual(0);
      for (const id of ['idle-body', 'idle-failed', 'idle-stop', 'idle-keep']) {
        const part = id === 'idle-body' ? dialog.locator('#idle-body') : page.getByTestId(id);
        await expect(part).toBeInViewport({ ratio: 1 });
      }
    });
  }
}

test('without a host idle limit there is no prompt and no presence', async ({ page, request }) => {
  await idle(request);
  await run(page, 'en');
  await page.keyboard.press('Shift');
  // Longer than the lead used above: a prompt would have shown by now.
  await expect
    .poll(async () => Number(await status(page).getAttribute('data-sim-ns')), { timeout: 30_000 })
    .toBeGreaterThan(1e9);
  await expect(page.getByTestId('idle-dialog')).toHaveCount(0);
  expect(await presences(request)).toBe(0);
});
