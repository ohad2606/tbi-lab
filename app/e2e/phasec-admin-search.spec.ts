/**
 * Phase C (owner 2026-11-12): finding and managing existing testers first in the Lab's
 * administration. A search (private name or masked address, the shared matcher of
 * @tbi-lab/admin-client) next to the Active / Disabled / All filters, with the number of matches;
 * "Add tester" opens the add form on demand; a compact table on a desktop (details on request),
 * stacked cards below the Lab's 1024 px breakpoint. The services are real (admin service, owner
 * check); the root helper is fixtures/fake-admin.ts, with its realistic registry
 * (POST /__test/admin-rich: 32 accounts, long Hebrew and English names, long domains).
 * Synthetic identities only (example.invalid).
 */
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';

const ENABLED = 'http://127.0.0.1:4174';
const FAKE = 'http://127.0.0.1:7499';
const DESKTOP = { width: 1440, height: 900 };

const asOwner = (context: BrowserContext) =>
  context.addCookies([{ name: 'tbi_test_user', value: 'e2e-owner', url: ENABLED }]);

const rows = (page: Page) => page.getByTestId('admin-accounts').getByTestId(/^admin-account-t_/);
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const count = (page: Page) => page.getByTestId('admin-search-count');

async function open(page: Page, locale: 'en' | 'he', viewport = DESKTOP) {
  await page.setViewportSize(viewport);
  await page.goto(`${ENABLED}/`);
  await page.getByTestId('language-select').selectOption(locale);
  await page.goto(`${ENABLED}/#admin`);
  await page.reload();
  const dialog = page.getByTestId('admin-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('admin-accounts')).toBeVisible();
  return dialog;
}

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/reset-admin`);
});

const rich = async (request: APIRequestContext) =>
  expect((await request.post(`${FAKE}/__test/admin-rich`)).status()).toBe(200);

test('search by name or masked address, combined with the filter, with the number of matches', async ({
  page,
  context,
  request,
}) => {
  await rich(request);
  await asOwner(context);
  await open(page, 'en');
  const search = page.getByTestId('admin-search');
  // A labelled search above the list, next to the filters; the count is announced politely.
  await expect(page.getByLabel('Search testers')).toHaveAttribute('data-testid', 'admin-search');
  await expect(count(page)).toHaveAttribute('aria-live', 'polite');
  await expect(count(page)).toHaveText('Showing 31 of 32'); // Active (the default filter)
  await expect(rows(page)).toHaveCount(31);

  // The masked address (14 of the realistic records start with "ab").
  await search.fill('AB***');
  await expect(count(page)).toHaveText('Showing 14 of 32');
  await expect(rows(page)).toHaveCount(14);
  await page.getByTestId('admin-filter-all').click();
  await expect(count(page)).toHaveText('Showing 14 of 32');
  await page.getByTestId('admin-filter-disabled').click();
  await expect(count(page)).toHaveText('Showing 0 of 32');
  await expect(page.getByTestId('admin-search-empty')).toBeVisible();

  // A name, case-insensitive; a part of a domain.
  await page.getByTestId('admin-filter-active').click();
  await search.fill('konstantinos');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 'Konstantinos Papadopoulos')).toBeVisible();
  await search.fill('makers-and-tinkerers');
  await expect(count(page)).toHaveText('Showing 9 of 32');

  // Hebrew names, with the filter: the disabled tester is found in Disabled and All only.
  await search.fill('נועה');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 'נועה לוי')).toBeVisible();
  await search.fill('בודקת');
  await expect(page.getByTestId('admin-search-empty')).toBeVisible();
  await page.getByTestId('admin-filter-disabled').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 'בודקת ל.')).toHaveAttribute('data-status', 'revoked');
  await page.getByTestId('admin-filter-all').click();
  await expect(count(page)).toHaveText('Showing 1 of 32');
  // The filters keep their totals (not the search's).
  await expect(page.getByTestId('admin-filter-active')).toContainText('(31)');
  // The full address is never searched (only its masked form is known to the page).
  await search.fill('rich.tester');
  await expect(count(page)).toHaveText('Showing 0 of 32');
});

test('HE: the count and the empty state in Hebrew; "clear search" is distinct from an empty list', async ({
  page,
  context,
  request,
}) => {
  await rich(request);
  await asOwner(context);
  const dialog = await open(page, 'he');
  await expect(dialog).toHaveAttribute('dir', 'rtl');
  const search = page.getByTestId('admin-search');
  await search.fill('שירה');
  await expect(count(page)).toHaveText('מוצגים 1 מתוך 32');
  await search.fill('אין כזה');
  const empty = page.getByTestId('admin-search-empty');
  await expect(empty).toContainText('אין חשבונות שתואמים לחיפוש ברשימה הזו.');
  await expect(page.getByTestId('admin-accounts')).toHaveCount(0);
  await expect(page.getByTestId('admin-accounts-empty')).toHaveCount(0);
  await page.getByTestId('admin-search-clear').click();
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(count(page)).toHaveText('מוצגים 31 מתוך 32');
  await expect(rows(page)).toHaveCount(31);
});

test('open the add form, cancel: the search and the filter are kept, focus back on "Add tester"', async ({
  page,
  context,
  request,
}) => {
  await rich(request);
  await asOwner(context);
  await open(page, 'he');
  await page.getByTestId('admin-filter-all').click();
  await page.getByTestId('admin-search').fill('נועה');
  await expect(page.getByTestId('admin-add')).toHaveCount(0); // no form until asked for
  const add = page.getByTestId('admin-add-open');
  await expect(add).toHaveText('הוספת בודק/ת');
  await add.click();
  await expect(page.getByTestId('admin-add')).toBeVisible();
  await expect(page.getByTestId('admin-add-name')).toBeFocused();
  await expect(page.getByTestId('admin-search')).toHaveCount(0);
  await page.getByTestId('admin-add-name').fill('מישהו');
  await page.getByTestId('admin-add-cancel').click();
  await expect(page.getByTestId('admin-add')).toHaveCount(0);
  await expect(page.getByTestId('admin-search')).toHaveValue('נועה');
  await expect(page.getByTestId('admin-filter-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows(page)).toHaveCount(1);
  await expect(add).toBeFocused();
  // Nothing was sent.
  await expect(page.getByTestId('admin-notice')).toHaveText('');
});

test('add: back to the list with its search and filter; the new tester is found by search', async ({
  page,
  context,
  request,
}) => {
  await rich(request);
  await asOwner(context);
  await open(page, 'en');
  await page.getByTestId('admin-filter-all').click();
  await page.getByTestId('admin-search').fill('Kon');
  await page.getByTestId('admin-add-open').click();
  // Same validation as before.
  await page.getByTestId('admin-add-submit').click();
  await expect(page.getByTestId('admin-add-problem')).toHaveText('Enter one valid email address.');
  await page.getByTestId('admin-add-name').fill('Zed Newcomer');
  await page.getByTestId('admin-add-email').fill('zed.newcomer@example.invalid');
  await page.getByTestId('admin-add-submit').click();
  await expect(page.getByTestId('admin-notice')).toHaveText(
    'Zed Newcomer was added and can sign in now.',
  );
  await expect(page.getByTestId('admin-add')).toHaveCount(0);
  await expect(page.getByTestId('admin-search')).toHaveValue('Kon');
  await expect(page.getByTestId('admin-filter-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('admin-add-open')).toBeFocused();
  await expect(count(page)).toHaveText('Showing 1 of 33');
  await expect(page.getByTestId('admin-add-last-address')).toHaveText('ze***@example.invalid');
  await page.getByTestId('admin-search').fill('zed');
  const z = row(page, 'Zed Newcomer');
  await expect(z).toContainText('ze***@example.invalid');
  await expect(z).toContainText('Pending');
  await expect(z.getByTestId('admin-account-never')).toBeVisible();
});

test('rename, disable (confirmed) and reactivate from the table while a search and filter are active', async ({
  page,
  context,
  request,
}) => {
  await rich(request);
  await asOwner(context);
  await open(page, 'en');
  const search = page.getByTestId('admin-search');
  await search.fill('te***');
  await expect(rows(page)).toHaveCount(2); // Alex T. and the unnamed tester two
  const unnamed = row(page, 'No name');
  await unnamed.getByTestId(/^admin-rename-t_/).click();
  await expect(page.getByTestId('admin-rename-input')).toBeFocused();
  await page.getByTestId('admin-rename-input').fill('Tess Two');
  await page.getByTestId('admin-rename-save').click();
  await expect(page.getByTestId('admin-notice')).toHaveText('The name was saved: Tess Two.');
  await expect(row(page, 'Tess Two')).toBeVisible();
  await expect(row(page, 'Tess Two').getByTestId(/^admin-rename-t_/)).toBeFocused();
  await expect(search).toHaveValue('te***');

  // Disable needs the confirmation; the list keeps its search and filter.
  await row(page, 'Alex T.')
    .getByTestId(/^admin-disable-/)
    .click();
  await expect(page.getByTestId('admin-confirm')).toContainText('Alex T. (te***@example.invalid)');
  await page.getByTestId('admin-confirm-ok').click();
  await expect(page.getByTestId('admin-notice')).toHaveText('Access for Alex T. has ended.');
  await expect(search).toHaveValue('te***');
  await expect(page.getByTestId('admin-filter-active')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows(page)).toHaveCount(1);
  await expect(count(page)).toHaveText('Showing 1 of 32');
  // Its row left the Active list: focus goes to the search.
  await expect(search).toBeFocused();

  await page.getByTestId('admin-filter-disabled').click();
  const alex = row(page, 'Alex T.');
  await expect(alex).toContainText('Disabled');
  await expect(alex.getByTestId('admin-account-count')).toHaveText('7');
  // Secondary dates are in the details, on request.
  await expect(page.getByTestId('admin-account-details')).toHaveCount(0);
  const details = alex.getByTestId(/^admin-details-/);
  await expect(details).toHaveAttribute('aria-expanded', 'false');
  await details.click();
  await expect(details).toHaveAttribute('aria-expanded', 'true');
  const more = page.getByTestId('admin-account-details');
  await expect(more).toContainText('Added');
  await expect(more).toContainText('First sign-in');
  await expect(more).toContainText('Last seen');
  await expect(more.getByTestId('admin-account-disabled-at')).toBeVisible();
  await alex.getByTestId(/^admin-reactivate-/).click();
  await expect(page.getByTestId('admin-confirm')).toContainText('one of the 30 tester places');
  // Escape leaves the confirmation only; focus returns to the asking button.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('admin-confirm')).toHaveCount(0);
  await expect(alex.getByTestId(/^admin-reactivate-/)).toBeFocused();
  await alex.getByTestId(/^admin-reactivate-/).click();
  await page.getByTestId('admin-confirm-ok').click();
  await expect(page.getByTestId('admin-notice')).toHaveText('Alex T. can sign in again.');
  await expect(search).toHaveValue('te***');
  await expect(page.getByTestId('admin-filter-disabled')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('admin-search-empty')).toBeVisible();
});

test('an empty list without a search says so (not the search empty state)', async ({
  page,
  context,
}) => {
  await asOwner(context);
  await open(page, 'en');
  await page.getByTestId('admin-filter-disabled').click();
  await row(page, 'fo***@example.invalid')
    .getByTestId(/^admin-reactivate-/)
    .click();
  await page.getByTestId('admin-confirm-ok').click();
  await expect(page.getByTestId('admin-notice')).toContainText('can sign in again.');
  await expect(page.getByTestId('admin-accounts-empty')).toHaveText('No accounts in this list.');
  await expect(page.getByTestId('admin-search-empty')).toHaveCount(0);
  await expect(count(page)).toHaveText('Showing 0 of 4');
});

for (const locale of ['en', 'he'] as const)
  test(`owner row ${locale.toUpperCase()}: badge, rename only, details; first in every search`, async ({
    page,
    context,
    request,
  }) => {
    await rich(request);
    await asOwner(context);
    const dialog = await open(page, locale);
    await expect(dialog).toHaveAttribute('dir', locale === 'he' ? 'rtl' : 'ltr');
    await page.getByTestId('admin-search').fill('ow***');
    await expect(rows(page)).toHaveCount(1);
    const owner = row(page, 'ow***@example.invalid');
    await expect(owner.getByTestId('admin-account-owner')).toHaveText(
      locale === 'en' ? 'Owner' : 'בעלים',
    );
    await expect(owner.getByTestId(/^admin-(disable|reactivate)-/)).toHaveCount(0);
    await expect(owner.getByTestId(/^admin-rename-/)).toBeVisible();
    await expect(owner.getByTestId(/^admin-details-/)).toBeVisible();
    await page.getByTestId('admin-filter-all').click();
    await page.getByTestId('admin-search').fill('');
    await expect(rows(page).first()).toContainText('ow***@example.invalid');
    // The table reads in the UI direction: the account column at the inline start.
    const name = await owner.getByTestId('admin-account-name').boundingBox();
    const count_ = await owner.getByTestId('admin-account-count').boundingBox();
    if (locale === 'he') expect(name!.x).toBeGreaterThan(count_!.x);
    else expect(name!.x).toBeLessThan(count_!.x);
    // The toolbar too: the search first, "Add tester" at the inline end.
    const s = await page.getByTestId('admin-search').boundingBox();
    const add = await page.getByTestId('admin-add-open').boundingBox();
    if (locale === 'he') expect(s!.x).toBeGreaterThan(add!.x);
    else expect(s!.x).toBeLessThan(add!.x);
    // Masked only, in both directions.
    expect(await dialog.textContent()).not.toMatch(/[a-z.]+@example\.invalid/);
  });

test('keyboard only: search, filters, add, rows; visible focus; Escape still closes', async ({
  page,
  context,
  request,
}) => {
  await rich(request);
  await asOwner(context);
  await page.setViewportSize(DESKTOP);
  await page.goto(`${ENABLED}/`);
  await page.getByTestId('admin-button').click();
  await expect(page.getByTestId('admin-accounts')).toBeVisible();
  await expect(page.getByTestId('admin-tab-testers')).toBeFocused();
  const focused = () =>
    page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? null);
  // Tab order: search -> filters -> add -> the first row's actions.
  const order: (string | null)[] = [];
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('Tab');
    order.push(await focused());
  }
  expect(order.slice(0, 5)).toEqual([
    'admin-search',
    'admin-filter-active',
    'admin-filter-disabled',
    'admin-filter-all',
    'admin-add-open',
  ]);
  expect(order[5]).toMatch(/^admin-details-t_/);
  expect(order[6]).toMatch(/^admin-rename-t_/);
  // Visible focus.
  const outline = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement!);
    return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
  });
  expect(outline).toBe(true);

  // Back to the search; type; a filter with Space.
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+Tab');
  expect(await focused()).toBe('admin-search');
  await page.keyboard.type('ab***');
  await expect(count(page)).toHaveText('Showing 14 of 32');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  expect(await focused()).toBe('admin-filter-disabled');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('admin-filter-disabled')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('admin-search-empty')).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('admin-filter-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows(page)).toHaveCount(14);

  // The add form: its first field focused; Cancel by keyboard returns to "Add tester".
  await page.keyboard.press('Tab');
  expect(await focused()).toBe('admin-add-open');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('admin-add-name')).toBeFocused();
  await page.keyboard.press('Tab'); // email
  await page.keyboard.press('Tab'); // submit
  await page.keyboard.press('Tab'); // cancel
  expect(await focused()).toBe('admin-add-cancel');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('admin-add-open')).toBeFocused();
  await expect(page.getByTestId('admin-search')).toHaveValue('ab***');

  // Details open and close from the keyboard.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('admin-account-details')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('admin-account-details')).toHaveCount(0);

  // Escape closes the dialog, from the search field too, and focus returns to its button.
  await page.getByTestId('admin-search').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('admin-dialog')).toHaveCount(0);
  await expect(page.getByTestId('admin-button')).toBeFocused();
});

for (const width of [360, 390, 412, 430])
  test(`phone ${width}: stacked cards, nothing scrolls sideways, every record reachable`, async ({
    page,
    context,
    request,
  }) => {
    await rich(request);
    await asOwner(context);
    const dialog = await open(page, 'he', { width, height: 800 });
    await expect(page.locator('table[data-testid="admin-accounts"]')).toHaveCount(0);
    await expect(page.locator('li.admin-card')).toHaveCount(31);
    await page.getByTestId('admin-filter-all').click();
    const fits = async () => {
      const m = await page.evaluate(() => {
        const d = document.querySelector<HTMLElement>('[data-testid="admin-dialog"]')!;
        return {
          doc: document.documentElement.scrollWidth,
          inner: window.innerWidth,
          dialog: d.scrollWidth - d.clientWidth,
          right: Math.max(
            ...[...d.querySelectorAll<HTMLElement>('button, input, li, bdi')].map(
              (e) => e.getBoundingClientRect().right,
            ),
          ),
          left: Math.min(
            ...[...d.querySelectorAll<HTMLElement>('button, input, li, bdi')].map(
              (e) => e.getBoundingClientRect().left,
            ),
          ),
        };
      });
      expect(m.doc).toBeLessThanOrEqual(m.inner);
      expect(m.dialog).toBeLessThanOrEqual(0);
      expect(m.right).toBeLessThanOrEqual(width + 0.5);
      expect(m.left).toBeGreaterThanOrEqual(-0.5);
    };
    await fits();
    // Details and the add form fit too.
    await rows(page)
      .nth(1)
      .getByTestId(/^admin-details-/)
      .click();
    await fits();
    // The list scrolls inside the dialog; the last record is reachable.
    const last = rows(page).last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    expect(await dialog.evaluate((d) => d.scrollTop)).toBeGreaterThan(0);
    await page.getByTestId('admin-search').scrollIntoViewIfNeeded();
    await page.getByTestId('admin-add-open').click();
    await expect(page.getByTestId('admin-add-name')).toBeFocused();
    await fits();
  });

test('desktop: 30+ rows scroll inside the dialog; the search bar and the table header stay visible', async ({
  page,
  context,
  request,
}) => {
  await rich(request);
  await asOwner(context);
  const dialog = await open(page, 'en');
  await page.getByTestId('admin-filter-all').click();
  await expect(rows(page)).toHaveCount(32);
  const m = await dialog.evaluate((d) => ({
    doc: document.documentElement.scrollWidth - window.innerWidth,
    x: d.scrollWidth - d.clientWidth,
    y: d.scrollHeight - d.clientHeight,
  }));
  expect(m.doc).toBeLessThanOrEqual(0);
  expect(m.x).toBeLessThanOrEqual(0);
  expect(m.y).toBeGreaterThan(300); // the list is longer than the dialog
  await dialog.evaluate((d) => d.scrollTo(0, d.scrollHeight));
  await expect(rows(page).last()).toBeInViewport();
  const box = (await dialog.boundingBox())!;
  const bar = (await page.getByTestId('admin-toolbar').boundingBox())!;
  const th = (await page.locator('table[data-testid="admin-accounts"] th').first().boundingBox())!;
  // Stuck at the top of the dialog, the header right under the bar.
  expect(bar.y).toBeGreaterThanOrEqual(box.y - 0.5);
  expect(bar.y).toBeLessThan(box.y + 40);
  expect(th.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1.5);
  expect(th.y).toBeLessThan(bar.y + bar.height + 4);
  await expect(page.getByTestId('admin-search')).toBeInViewport();
  // The search works from there: the list shrinks back.
  await page.getByTestId('admin-search').fill('Zoë');
  await expect(rows(page)).toHaveCount(1);
});
