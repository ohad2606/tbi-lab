/**
 * Sprint 14: in-app "Report a problem". The routine build (no VITE_PROBLEM_REPORTS) shows no
 * action; the protected-preview build on :4174 enables it (playwright.app.config.ts). Reports go
 * through the preview's gate proxy to the fake Session Host, which stores them with the REAL
 * report store (runtime/host/reports.ts); test controls inject failures and delays.
 * Screenshots: set TBI_SHOTS to a directory.
 */
import { expect, test, type Page } from '@playwright/test';
import { openAppMenu } from './helpers.js';

const ENABLED = 'http://127.0.0.1:4174';
const FAKE = 'http://127.0.0.1:7499';
const ID_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

interface Stored {
  id: string;
  description: string;
  category: string;
  blocking: boolean;
  locale: string;
  view: string;
  principal: string;
  appSim: unknown;
  browser: { family: string; major: number | null; os: string };
}

const shot = async (page: Page, name: string) => {
  if (process.env.TBI_SHOTS)
    await page
      .getByTestId('report-dialog')
      .screenshot({ path: `${process.env.TBI_SHOTS}/${name}.png` });
};

async function openEditor(page: Page, base: string, locale = 'en') {
  await page.goto(`${base}/`);
  await page.getByTestId('language-select').selectOption(locale);
  await page.getByTestId('open-example-led-current').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
}

/** Keyboard only: focus the menu button, open the menu, move to the item, activate it. */
async function openWithKeyboard(page: Page) {
  await page.getByTestId('app-menu-button').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('app-menu')).toBeVisible();
  await page.keyboard.press('End'); // sign-out, the last item
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('menu-report-problem')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('report-dialog')).toBeVisible();
}

const stored = async (page: Page): Promise<Stored[]> =>
  (await page.request.get(`${FAKE}/__test/reports`)).json() as Promise<Stored[]>;

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/reset-reports`);
});

test('the action is absent when the deployment does not enable reports', async ({ page }) => {
  await openEditor(page, '');
  await openAppMenu(page);
  await expect(page.getByTestId('menu-capabilities')).toBeVisible();
  await expect(page.getByTestId('menu-report-problem')).toHaveCount(0);
  await expect(page.getByTestId('report-dialog')).toHaveCount(0);
});

test('keyboard: focus on open, Tab stays inside, Escape closes and returns focus; draft kept', async ({
  page,
}) => {
  await openEditor(page, ENABLED);
  await openWithKeyboard(page);
  const dialog = page.getByTestId('report-dialog');
  const field = page.getByTestId('report-description');
  await expect(field).toBeFocused();
  await expect(dialog).toHaveAttribute('aria-labelledby', 'report-title');
  await expect(page.getByRole('dialog', { name: 'Report a problem' })).toBeVisible();
  await expect(field).toHaveAttribute('dir', 'auto');
  // The disclosure says what is and is not sent.
  const disclosure = page.getByTestId('report-disclosure');
  await expect(disclosure).toContainText('browser name, version and operating system');
  await expect(disclosure).toContainText(
    'Your project, circuit, code and screenshots are not sent',
  );

  // Focus trap: Shift+Tab from the first control wraps to the last, Tab wraps back. Sprint 23B:
  // the kind selector (a radio group, focused on its checked kind) now comes before the text.
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('report-kind-bug')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('report-send')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('report-kind-bug')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(field).toBeFocused();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }

  await field.focus();
  await page.keyboard.type('Run does nothing');
  await expect(page.getByTestId('report-counter')).toContainText('16 / 1000');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('app-menu-button')).toBeFocused();
  // Reopened: the text is still there (nothing was sent).
  await openWithKeyboard(page);
  await expect(page.getByTestId('report-description')).toHaveValue('Run does nothing');
  expect(await stored(page)).toEqual([]);
});

test('validation: a description and an area are required; the counter caps the length', async ({
  page,
}) => {
  await openEditor(page, ENABLED);
  await openWithKeyboard(page);
  await page.getByTestId('report-send').click();
  await expect(page.getByTestId('report-problem-description')).toHaveText('Describe the problem.');
  await expect(page.getByTestId('report-problem-category')).toHaveText('Choose an area.');
  await expect(page.getByTestId('report-description')).toBeFocused();
  await expect(page.getByTestId('report-description')).toHaveAttribute('aria-invalid', 'true');

  await page.getByTestId('report-description').fill('x'.repeat(1001));
  const counter = page.getByTestId('report-counter');
  await expect(counter).toContainText('1001 / 1000');
  await expect(counter).toHaveClass(/report-counter-over/);
  await expect(page.getByTestId('report-problem-description')).toHaveText(
    'Shorten the description to 1000 characters or fewer.',
  );
  await page.getByTestId('report-category-editor').check();
  await page.getByTestId('report-send').click();
  await expect(page.getByTestId('report-status')).toHaveText('');
  expect(await stored(page)).toEqual([]);
  await page.getByTestId('report-description').press('Backspace');
  await expect(counter).toContainText('1000 / 1000');
  await expect(page.getByTestId('report-problem-description')).toHaveCount(0);
});

test('the confirmation and its id appear only after the server stored the report', async ({
  page,
}) => {
  await openEditor(page, ENABLED);
  await openWithKeyboard(page);
  await page.getByTestId('report-description').fill('The LED stays dark.\nSecond line.');
  await page.getByTestId('report-category-simulation').check();
  await page.getByTestId('report-blocking').check();
  await shot(page, 'report-problem-en');
  await page.request.post(`${FAKE}/__test/hold-reports?ms=1500`);
  await page.getByTestId('report-send').click();
  // In flight: "Sending…", no confirmation, nothing stored yet, the text cannot change.
  await expect(page.getByTestId('report-status')).toHaveText('Sending…');
  await expect(page.getByTestId('report-send')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('report-id')).toHaveCount(0);
  expect(await stored(page)).toEqual([]);
  // Escape does not abandon a send in flight.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('report-dialog')).toBeVisible();

  const id = page.getByTestId('report-id');
  await expect(id).toBeVisible();
  const text = (await id.textContent())!;
  expect(text).toMatch(ID_RE);
  await expect(page.getByTestId('report-sent')).toContainText('Report received');
  await expect(page.getByTestId('report-close')).toBeFocused();
  await shot(page, 'report-problem-sent-en');

  const [r] = await stored(page);
  expect(r).toMatchObject({
    id: text,
    description: 'The LED stays dark.\nSecond line.',
    category: 'simulation',
    blocking: true,
    locale: 'en',
    view: 'editor',
    appSim: { status: 'stopped' },
    browser: { family: 'Chrome' },
  });
  expect(r!.principal).toMatch(/^p_/);
  // Nothing of the project is sent: exactly these fields are stored.
  expect(Object.keys(r!).sort()).toEqual(
    [
      'app',
      'appSim',
      'blocking',
      'browser',
      'category',
      // Sprint 23B: the kind, a component name (none) and the optional technical context.
      'component',
      'context',
      'description',
      'id',
      'kind',
      'locale',
      'principal',
      'receivedAt',
      'release',
      'session',
      'v',
      'view',
    ].sort(),
  );

  // The context names the project by id only (no contents).
  const ctx = (r as unknown as { context: Record<string, unknown> }).context;
  expect(Object.keys(ctx).every((k) => ['runtime', 'device', 'projectId'].includes(k))).toBe(true);
  expect(ctx.projectId).toMatch(/^prj_[A-Za-z0-9]+$/);

  await page.getByTestId('report-close').click();
  await expect(page.getByTestId('report-dialog')).toHaveCount(0);
  await expect(page.getByTestId('app-menu-button')).toBeFocused();
  // A sent report leaves an empty form for the next one.
  await openWithKeyboard(page);
  await expect(page.getByTestId('report-description')).toHaveValue('');
});

test('a server error keeps the text and says so; retry sends it', async ({ page }) => {
  await openEditor(page, ENABLED);
  await openWithKeyboard(page);
  await page.getByTestId('report-description').fill('Build hangs at 90 %');
  await page.getByTestId('report-category-build').check();

  await page.request.post(`${FAKE}/__test/fail-next-report?status=503`);
  await page.getByTestId('report-send').click();
  const error = page.getByTestId('report-error');
  await expect(error).toHaveAttribute('data-code', 'unavailable');
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(error).toContainText('Your text is kept here');
  await expect(page.getByTestId('report-id')).toHaveCount(0);
  await expect(page.getByTestId('report-description')).toHaveValue('Build hangs at 90 %');
  await expect(page.getByTestId('report-category-build')).toBeChecked();
  expect(await stored(page)).toEqual([]);

  await page.request.post(`${FAKE}/__test/fail-next-report?status=429`);
  await page.getByTestId('report-send').click();
  await expect(error).toHaveAttribute('data-code', 'rate_limited');
  await expect(error).toContainText('try again in 2 min');

  await page.getByTestId('report-send').click(); // retry
  await expect(page.getByTestId('report-id')).toHaveText(ID_RE);
  const all = await stored(page);
  expect(all).toHaveLength(1);
  expect(all[0]!.description).toBe('Build hangs at 90 %');
});

test('Hebrew: right-to-left dialog, the tester’s text kept as written, confirmation', async ({
  page,
}) => {
  await openEditor(page, ENABLED, 'he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await openWithKeyboard(page);
  const dialog = page.getByRole('dialog', { name: 'דיווח על בעיה' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('report-description')).toBeFocused();
  // Mixed-direction user text, exactly as typed.
  const text = 'הנורה לא נדלקת אחרי Run ב־GPIO 2';
  await page.getByTestId('report-description').fill(text);
  await page.getByTestId('report-category-simulation').check();
  await expect(page.getByTestId('report-disclosure')).toContainText('אינם נשלחים');

  // Layout: inside the viewport; actions at the inline end (left in RTL), Send before Cancel.
  const box = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  const send = (await page.getByTestId('report-send').boundingBox())!;
  const cancel = (await page.getByTestId('report-cancel').boundingBox())!;
  expect(send.x).toBeLessThan(cancel.x);
  const counter = (await page.getByTestId('report-counter').locator('span').first().boundingBox())!;
  const field = (await page.getByTestId('report-description').boundingBox())!;
  expect(counter.x).toBeLessThan(field.x + field.width / 2); // the counter sits at the left (end)
  await shot(page, 'report-problem-he');

  await page.getByTestId('report-send').click();
  await expect(page.getByTestId('report-id')).toHaveText(ID_RE);
  await expect(page.getByTestId('report-id')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByTestId('report-sent')).toContainText('הדיווח התקבל');
  await shot(page, 'report-problem-sent-he');
  const [r] = await stored(page);
  expect(r).toMatchObject({ description: text, locale: 'he' });

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('report-dialog')).toHaveCount(0);
  await expect(page.getByTestId('app-menu-button')).toBeFocused();
  await page.getByTestId('language-select').selectOption('en');
});
