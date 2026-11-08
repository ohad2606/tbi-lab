/**
 * Sprint 23B: the Feedback button and the extended form (kinds, component name, technical
 * context), EN and HE, desktop and tablet. The protected-preview build on :4174 enables it
 * (playwright.app.config.ts); reports reach the REAL report store in the fake Session Host.
 * Screenshots: set TBI_SHOTS to a directory.
 */
import { expect, test, type Page } from '@playwright/test';

const ENABLED = 'http://127.0.0.1:4174';
const FAKE = 'http://127.0.0.1:7499';
const ID_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const SIZES = {
  desktop: { width: 1400, height: 860 },
  tablet: { width: 1024, height: 768 },
} as const;

interface Stored {
  id: string;
  kind?: string;
  category: string;
  blocking: boolean;
  description: string;
  component?: string | null;
  context?: { runtime?: string; device?: string; projectId?: string } | null;
  locale: string;
}
const stored = async (page: Page): Promise<Stored[]> =>
  (await page.request.get(`${FAKE}/__test/reports`)).json() as Promise<Stored[]>;

const shot = async (page: Page, name: string, testId = 'report-dialog') => {
  if (process.env.TBI_SHOTS)
    await page.getByTestId(testId).screenshot({ path: `${process.env.TBI_SHOTS}/${name}.png` });
};
const fullShot = async (page: Page, name: string) => {
  if (process.env.TBI_SHOTS)
    await page.screenshot({ path: `${process.env.TBI_SHOTS}/${name}.png` });
};

async function openEditor(page: Page, locale: string) {
  await page.goto(`${ENABLED}/`);
  await page.getByTestId('language-select').selectOption(locale);
  await page.getByTestId('open-example-led-current').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/reset-reports`);
});

test('the routine build (no flag) shows no Feedback button', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app-version')).toBeVisible();
  await expect(page.getByTestId('feedback-button')).toHaveCount(0);
  await expect(page.getByTestId('admin-button')).toHaveCount(0);
});

for (const [size, viewport] of Object.entries(SIZES)) {
  test(`EN ${size}: the button sits in the status bar, clear of the canvas; a component request`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openEditor(page, 'en');
    const button = page.getByTestId('feedback-button');
    await expect(button).toBeVisible();
    await expect(button).toHaveAccessibleName('Feedback');
    // Never over the circuit: the button is below the canvas, inside the status bar.
    const canvas = (await page.getByTestId('canvas').boundingBox())!;
    const b = (await button.boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(canvas.y + canvas.height - 1);
    expect(b.y + b.height).toBeLessThanOrEqual(viewport.height);
    if (size === 'desktop') await fullShot(page, `s23-feedback-button-en-${size}`);

    await button.click();
    const dialog = page.getByTestId('report-dialog');
    await expect(page.getByRole('dialog', { name: 'Report a problem' })).toBeVisible();
    await expect(page.getByTestId('report-description')).toBeFocused();
    // A component request: the title follows the kind, the area disappears, a name field appears.
    await page.getByTestId('report-kind-component').check();
    await expect(page.getByRole('dialog', { name: 'Request a new component' })).toBeVisible();
    await expect(page.getByTestId('report-category-simulation')).toHaveCount(0);
    await expect(page.getByTestId('report-blocking')).toHaveCount(0);
    await page.getByTestId('report-component').fill('KY-040 rotary encoder');
    await expect(page.getByTestId('report-component-counter')).toContainText('21 / 80');
    await page.getByTestId('report-description').fill('Count detents and read the push switch.');
    await expect(page.getByTestId('report-context')).toBeChecked();
    await expect(page.getByTestId('report-disclosure')).toContainText(
      'the open project’s id (not its contents)',
    );
    await shot(page, `s23-feedback-component-en-${size}`);
    await page.getByTestId('report-send').click();
    await expect(page.getByTestId('report-sent')).toBeVisible();
    const id = (await page.getByTestId('report-id').textContent())!;
    expect(id).toMatch(ID_RE);
    await shot(page, `s23-feedback-sent-en-${size}`);
    const [r] = await stored(page);
    expect(r).toMatchObject({
      id,
      kind: 'component',
      category: 'other',
      blocking: false,
      component: 'KY-040 rotary encoder',
      locale: 'en',
    });
    expect(r!.context?.projectId).toMatch(/^prj_/);
    if (size === 'desktop') expect(r!.context?.device).toBe('desktop');
    await page.getByTestId('report-close').click();
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();
  });
}

test('validation per kind; the technical context can be left out', async ({ page }) => {
  await openEditor(page, 'en');
  await page.getByTestId('feedback-button').click();
  await page.getByTestId('report-kind-feature').check();
  await expect(page.getByRole('dialog', { name: 'Suggest an improvement' })).toBeVisible();
  await page.getByTestId('report-send').click();
  await expect(page.getByTestId('report-problem-description')).toHaveText('Write your message.');
  // No area is asked for a suggestion.
  await expect(page.getByTestId('report-problem-category')).toHaveCount(0);
  await page.getByTestId('report-kind-component').check();
  await page.getByTestId('report-component').fill('x'.repeat(81));
  await expect(page.getByTestId('report-problem-component')).toHaveText(
    'Shorten the name to 80 characters or fewer.',
  );
  await expect(page.getByTestId('report-component')).toHaveAttribute('aria-invalid', 'true');
  await page.getByTestId('report-component').fill('');
  await page.getByTestId('report-kind-general').check();
  await page.getByTestId('report-description').fill('Nice tool.');
  await page.getByTestId('report-context').uncheck();
  await page.getByTestId('report-send').click();
  await expect(page.getByTestId('report-sent')).toBeVisible();
  const [r] = await stored(page);
  expect(r).toMatchObject({ kind: 'general', category: 'other', component: null, context: null });
  // Keyboard: the kind is a radio group reachable with the arrow keys.
  await page.getByTestId('report-close').click();
  await page.getByTestId('feedback-button').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('report-description')).toBeFocused(); // the dialog is ready
  await page.getByTestId('report-kind-general').focus();
  await page.keyboard.press('ArrowLeft'); // previous kind in LTR
  await expect(page.getByTestId('report-kind-feature')).toBeChecked();
});

for (const [size, viewport] of Object.entries(SIZES)) {
  test(`HE ${size}: right-to-left form, the tester's words kept as written`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openEditor(page, 'he');
    const button = page.getByTestId('feedback-button');
    await expect(button).toHaveAccessibleName('משוב');
    await button.click();
    const dialog = page.getByTestId('report-dialog');
    await expect(dialog).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('dialog', { name: 'דיווח על בעיה' })).toBeVisible();
    await page.getByTestId('report-kind-component').check();
    await expect(page.getByRole('dialog', { name: 'בקשה לרכיב חדש' })).toBeVisible();
    await page.getByTestId('report-component').fill('חיישן לחות DHT22');
    await page.getByTestId('report-description').fill('הייתי רוצה למדוד לחות בחממה.');
    await shot(page, `s23-feedback-component-he-${size}`);
    // The kind selector reads right to left.
    const bug = (await page.getByTestId('report-kind-bug').boundingBox())!;
    const general = (await page.getByTestId('report-kind-general').boundingBox())!;
    if (Math.abs(bug.y - general.y) < 4) expect(bug.x).toBeGreaterThan(general.x);
    await page.getByTestId('report-send').click();
    await expect(page.getByTestId('report-sent')).toBeVisible();
    await shot(page, `s23-feedback-sent-he-${size}`);
    const [r] = await stored(page);
    expect(r).toMatchObject({ kind: 'component', component: 'חיישן לחות DHT22', locale: 'he' });
    expect(r!.description).toBe('הייתי רוצה למדוד לחות בחממה.');
  });
}

test('the menu item still opens the RC4 bug report (default kind, area required)', async ({
  page,
}) => {
  await openEditor(page, 'en');
  await page.getByTestId('app-menu-button').click();
  await page.getByTestId('menu-report-problem').click();
  await expect(page.getByTestId('report-kind-bug')).toBeChecked();
  await page.getByTestId('report-description').fill('Run does nothing');
  await page.getByTestId('report-send').click();
  await expect(page.getByTestId('report-problem-category')).toHaveText('Choose an area.');
  await page.getByTestId('report-category-simulation').check();
  await page.getByTestId('report-send').click();
  await expect(page.getByTestId('report-sent')).toBeVisible();
  const [r] = await stored(page);
  expect(r).toMatchObject({ kind: 'bug', category: 'simulation' });
});
