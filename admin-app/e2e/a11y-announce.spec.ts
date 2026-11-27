/**
 * Gate G3, TBI Lab Admin: announcements and focus that were still lost (WCAG 4.1.3, 2.4.3,
 * 3.3.1). A modal dialog makes the page's live regions inert, so the page speaks after it closes;
 * a late sentence is not preceded by an old one; a repeated error is said again. DOM structure,
 * text and focus only: what a screen reader actually says needs a manual check. Synthetic data;
 * the sign-up routes are mocked in the page.
 */
import { createHash } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const APP = 'http://127.0.0.1:4176';
const ALEX = `t_${createHash('sha256').update('account|tester.one@example.invalid').digest('base64url').slice(0, 16)}`;

const TEXT = {
  he: {
    noStatus: 'סטטוס האישור האוטומטי אינו זמין כרגע.',
    stale: 'טעינת הרשימה מחדש נכשלה וייתכן שהיא לא מעודכנת. אפשר ללחוץ על רענון הבקשות.',
    openStale: /טעינת הבקשות הפתוחות מחדש נכשלה/,
    off: (id: string) =>
      `בקשה ⁦${id}⁩: לא נמחקה. ניהול ההרשמה כבוי או לא זמין בשרת, ולכן ייתכן שהבקשה עדיין שמורה.`,
    gone: /כבר לא קיימת/,
    stays: /הוא נשאר/,
    actionOff: (name: string) =>
      `הבקשה של ${name}: לא הצלחנו לאשר מה קרה. ניהול ההרשמה אולי כבוי או לא זמין בשרת, וייתכן שהבקשה עדיין שמורה. אפשר ללחוץ על רענון הבקשות.`,
    noWarning: 'אזהרת החשבון כבר לא רלוונטית לבקשה הזאת.',
    unconfirmed: (id: string) =>
      `בקשה ⁦${id}⁩: לא הצלחנו לאשר את המחיקה. ייתכן שהבקשה עדיין שמורה.`,
  },
  en: {
    noStatus: 'Auto-approve status is unavailable right now.',
    stale: 'The list could not be reloaded and may be out of date. Use Refresh requests.',
    openStale: /open requests could not be reloaded/,
    off: (id: string) =>
      `Request ⁦${id}⁩: not deleted. Sign-up administration is off or unavailable on the server, so the request may still be stored.`,
    gone: /already gone/,
    stays: /it stays/,
    actionOff: (name: string) =>
      `Request of ${name}: we could not confirm what happened. Sign-up administration may be off or unavailable on the server, so the request may still be stored. Use Refresh requests.`,
    noWarning: 'The account warning no longer applies to this request.',
    unconfirmed: (id: string) =>
      `Request ⁦${id}⁩: we could not confirm the deletion. The request may still be stored.`,
  },
};
type Lang = keyof typeof TEXT;

const id = (n: number) => `01JD000000000000000000000${n}`;
const row = (n: number, status = 'pending', accountAdded = false) => ({
  id: id(n),
  name: `Sample ${n}`,
  email: [`s${n}`, 'example.invalid'].join('@'),
  role: 'Teacher',
  lang: 'en',
  status,
  accountAdded,
  emailAttempts: 0,
  lastError: null,
  createdAt: `2026-11-0${n}T10:00:00Z`,
});
const failure = { status: 500, json: { error: 'x' } };

function gate() {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  return { held, release };
}

async function signIn(context: BrowserContext, lang: Lang) {
  await context.addCookies([{ name: 'tbi_test_user', value: 'e2e-owner', url: APP }]);
  await context.addInitScript((l) => localStorage.setItem('tbi-admin.locale', l), lang);
}

interface Answer {
  status?: number;
  json: unknown;
}
type Handler = () => Answer | Promise<Answer>;
interface Mock {
  open: Handler;
  all: Handler;
  auto: Handler;
  remove: Handler;
  approve: Handler;
  allCalls: number;
}
/** The sign-up routes; each answer can be replaced at any time. */
async function mock(page: Page): Promise<Mock> {
  const m: Mock = {
    open: () => ({ json: { signups: [row(1), row(2)] } }),
    all: () => ({ json: { signups: [row(1), row(2), row(3, 'email_sent', true)] } }),
    auto: () => ({ json: { enabled: false } }),
    remove: () => ({ json: { deleted: true } }),
    approve: () => ({ json: { record: row(2, 'email_sent', true) } }),
    allCalls: 0,
  };
  await page.route('**/admin-api/signups**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/admin-api/signups', '');
    let h: Handler;
    if (req.method() === 'DELETE') h = m.remove;
    else if (path.endsWith('/approve')) h = m.approve;
    else if (path === '/open') h = m.open;
    else if (path === '/auto-approve') h = m.auto;
    else {
      m.allCalls++;
      h = m.all;
    }
    await route.fulfill(await h());
  });
  return m;
}

const live = (page: Page) => page.getByTestId('signups-live');
const del = (page: Page, n: number) =>
  page.locator(`[data-stored-id="${id(n)}"]`).getByTestId('stored-delete');
const signups = (page: Page) => page.goto(`${APP}/#/signups`);
async function openStored(page: Page) {
  await page.getByTestId('stored-toggle').click();
  await expect(page.getByTestId('stored-row')).toHaveCount(3);
}
/** Opens a delete confirmation and waits for the list reload it starts. */
async function askDelete(page: Page, m: Mock, n: number) {
  const before = m.allCalls;
  await del(page, n).click();
  await expect(page.getByTestId('delete-cancel')).toBeFocused();
  await expect.poll(() => m.allCalls).toBe(before + 1);
}

test.beforeEach(({ request }) => request.post('http://127.0.0.1:7499/__test/reset-admin'));
test.afterAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  await request.post('http://127.0.0.1:7499/__test/reset-admin');
  await request.dispose();
});

for (const lang of ['he', 'en'] as const) {
  const text = TEXT[lang];

  test(`announce (${lang}): an action's reload removes the focused row: heading`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    await page.goto(`${APP}/#/testers/${ALEX}`);
    await page.getByTestId('tester-disable').click();
    await expect(page.getByTestId('confirm-cancel')).toBeFocused();
    // The action is answered at once; its reload is held, then no longer holds the row.
    const reload = gate();
    let held = false;
    await page.route('**/admin-api/accounts', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      held = true;
      await reload.held;
      const res = await route.fetch();
      const json = (await res.json()) as { accounts: { target: string }[] };
      json.accounts = json.accounts.filter((a) => a.target !== ALEX);
      await route.fulfill({ json });
    });
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => held).toBe(true);
    await page.getByTestId('nav-testers').click();
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    const link = page.getByTestId(`tester-open-${ALEX}`);
    await link.focus();
    reload.release();
    await expect(link).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  });

  test(`announce (${lang}): an add that fills the last place does not drop focus`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    await page.goto(`${APP}/#/add`);
    await page.getByTestId('add-name').fill('Test B.');
    await page.getByTestId('add-email').fill('last.place@example.invalid');
    await page.route('**/admin-api/accounts', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const json = (await res.json()) as { cap: number; authorizedTesters: number };
      json.authorizedTesters = json.cap;
      await route.fulfill({ json });
    });
    await page.getByTestId('add-submit').press('Enter');
    await expect(page.getByTestId('add-cap-full')).toBeVisible();
    await expect(page.getByTestId('add-submit')).toBeDisabled();
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  });

  test(`announce (${lang}): the same invalid name saved twice is a new alert each time`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    await page.goto(`${APP}/#/testers/${ALEX}`);
    await page.getByTestId('tester-rename').press('Enter');
    const field = page.getByTestId('rename-input');
    await expect(field).toBeFocused();
    await field.fill('R2-D2');
    await field.press('Enter');
    const problem = page.getByTestId('rename-problem');
    await expect(problem).toHaveRole('alert');
    const first = (await problem.elementHandle())!;
    await field.press('Enter');
    // A screen reader speaks an alert when it arrives: the old node leaves, a new one comes.
    await expect.poll(() => first.evaluate((e) => e.isConnected)).toBe(false);
    await expect(problem).toHaveCount(1);
    await expect(problem).toHaveRole('alert');
    await expect(field).toHaveAttribute('aria-describedby', 'rename-problem');
    await expect(field).toHaveAccessibleDescription((await problem.textContent())!);
    await expect(field).toBeFocused();
  });

  test(`announce (${lang}): a status failure after a quiet reload overtook the load is spoken`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    const m = await mock(page);
    const first = gate();
    let opens = 0;
    m.open = async () => {
      if (++opens === 1) await first.held;
      return { json: { signups: [row(2)] } };
    };
    const status = gate();
    m.auto = async () => {
      await status.held;
      return failure;
    };
    await signups(page);
    await openStored(page);
    await askDelete(page, m, 1);
    await page.getByTestId('delete-ok').click();
    await expect.poll(() => opens).toBe(2);
    await expect(live(page)).toContainText(id(1));
    first.release();
    status.release();
    await expect(page.getByTestId('auto-unavailable')).toBeVisible();
    await expect(live(page)).toContainText(text.noStatus);
  });

  test(`announce (${lang}): nothing is posted behind the modal; it is spoken after it closes`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    const m = await mock(page);
    const status = gate();
    m.auto = async () => {
      await status.held;
      return failure;
    };
    await signups(page);
    await openStored(page);
    await expect(live(page)).toContainText(/3.*3/);
    await askDelete(page, m, 1);
    const behind = await live(page).textContent();
    status.release();
    await expect(page.getByTestId('auto-unavailable')).toBeAttached();
    await page.waitForTimeout(500);
    await expect(page.getByRole('alertdialog')).toBeVisible();
    expect(await live(page).textContent()).toBe(behind);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(live(page)).toHaveText(text.noStatus);
    await expect(del(page, 1)).toBeFocused();
  });

  test(`announce (${lang}): an open list that fails behind the modal is spoken after it`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    const m = await mock(page);
    await signups(page);
    await openStored(page);
    const reload = gate();
    let reloading = false;
    m.open = async () => {
      reloading = true;
      await reload.held;
      return failure;
    };
    await askDelete(page, m, 1);
    await page.getByTestId('delete-ok').click();
    await expect.poll(() => reloading).toBe(true);
    await expect(live(page)).toContainText(id(1));
    await askDelete(page, m, 2);
    reload.release();
    await expect(page.getByTestId('signups-open-stale')).toBeAttached();
    await page.keyboard.press('Escape');
    await expect(live(page)).toContainText(text.openStale);
  });

  test(`announce (${lang}): a late status failure does not re-read an old sentence`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    const m = await mock(page);
    const status = gate();
    m.auto = async () => {
      await status.held;
      return failure;
    };
    await signups(page);
    await openStored(page);
    await page.getByTestId('stored-filter').fill('s2');
    await expect(live(page)).toContainText(/1.*3/);
    await page.waitForTimeout(3500);
    status.release();
    await expect(live(page)).toHaveText(text.noStatus);
  });

  test(`announce (${lang}): a late reload failure after a delete is said alone`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    const m = await mock(page);
    await signups(page);
    await openStored(page);
    await askDelete(page, m, 1);
    const reload = gate();
    m.all = async () => {
      await reload.held;
      return failure;
    };
    await page.getByTestId('delete-ok').click();
    // The outcome is spoken alone after the wait for the reload.
    await expect(live(page)).toContainText(id(1), { timeout: 6000 });
    await page.waitForTimeout(2500);
    reload.release();
    await expect(live(page)).toHaveText(text.stale);
  });

  test(`announce (${lang}): a warning that goes and comes back is announced both times`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    const m = await mock(page);
    const approve = gate();
    m.approve = async () => {
      await approve.held;
      return { json: { record: row(2, 'email_sent', true) } };
    };
    await signups(page);
    await openStored(page);
    // An approval still running; its answer will reload the stored list under the dialog.
    await page
      .locator(`[data-signup-id="${id(2)}"]`)
      .getByTestId('signup-approve')
      .click();
    m.all = () => ({ json: { signups: [row(3, 'email_sent')] } });
    await del(page, 3).click();
    const said = page.getByTestId('delete-dialog-live');
    await expect(said).toHaveText(text.noWarning);
    m.all = () => ({ json: { signups: [row(3, 'email_sent', true)] } });
    approve.release();
    await expect(page.getByTestId('delete-warning')).toHaveAttribute('data-warning', 'account');
    await expect(said).toContainText(text.stays);
  });

  test(`announce (${lang}): delete with sign-up admin off says so, never "already gone"`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    const m = await mock(page);
    await signups(page);
    await openStored(page);
    await askDelete(page, m, 1);
    // Switched off now: the service answers every sign-up route with its own 404 not_found.
    const off = { status: 404, json: { error: 'not_found' } };
    m.all = m.open = m.remove = () => off;
    await page.getByTestId('delete-ok').click();
    await expect(page.getByTestId('stored-problem')).toHaveAttribute('data-error', 'unavailable');
    await expect(live(page)).toHaveText(text.off(id(1)));
    const result = page.getByTestId('delete-result');
    await expect(result).toHaveAttribute('data-key', 'console.signups.delete.failed.off');
    await expect(result).not.toContainText(text.gone);
    await expect(result.locator('bdi[dir="ltr"]')).toHaveText(id(1));
    await expect(page.getByTestId('stored-toggle')).toBeFocused();
  });

  test(`announce (${lang}): not_found with a failed reload is unconfirmed, the row stays`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    const m = await mock(page);
    await signups(page);
    await openStored(page);
    await askDelete(page, m, 1);
    m.remove = () => ({ status: 404, json: { error: 'not_found' } });
    m.all = () => ({ status: 429, json: { error: 'rate_limited' } });
    await page.getByTestId('delete-ok').click();
    await expect(live(page)).toHaveText(`${text.unconfirmed(id(1))} ${text.stale}`);
    const result = page.getByTestId('delete-result');
    await expect(result).toHaveAttribute('data-key', 'console.signups.delete.unconfirmed');
    await expect(result).not.toContainText(text.gone);
    await expect(page.getByTestId('stored-row')).toHaveCount(3);
    await expect(del(page, 1)).toBeFocused();
  });

  test(`announce (${lang}): a hung reload ends in "unconfirmed" and frees the row`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    const m = await mock(page);
    await signups(page);
    await openStored(page);
    await askDelete(page, m, 1);
    const reload = gate();
    m.remove = () => ({ status: 404, json: { error: 'not_found' } });
    m.all = async () => {
      await reload.held;
      return { json: { signups: [row(2), row(3)] } };
    };
    await page.getByTestId('delete-ok').click();
    await expect(del(page, 1)).toHaveAttribute('aria-disabled', 'true');
    await expect(live(page)).toHaveText(text.unconfirmed(id(1)), { timeout: 6000 });
    await expect(del(page, 1)).not.toHaveAttribute('aria-disabled');
    await expect(page.getByTestId('stored-row')).toHaveCount(3);
    await expect(del(page, 1)).toBeFocused();
    // The late list drops the focused row: focus does not fall to the page, and it settles what
    // happened: the visible and the spoken sentence follow it.
    reload.release();
    await expect(page.getByTestId('stored-row')).toHaveCount(2);
    await expect(page.getByTestId('stored-filter')).toBeFocused();
    const result = page.getByTestId('delete-result');
    await expect(result).toHaveAttribute('data-key', 'console.signups.delete.gone');
    await expect(live(page)).toContainText(text.gone);
  });

  test(`announce (${lang}): a late "off" answer replaces "unconfirmed"`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    const m = await mock(page);
    await signups(page);
    await openStored(page);
    await askDelete(page, m, 1);
    const reload = gate();
    const off = { status: 404, json: { error: 'not_found' } };
    m.remove = () => off;
    m.all = async () => {
      await reload.held;
      return off;
    };
    await page.getByTestId('delete-ok').click();
    await expect(live(page)).toHaveText(text.unconfirmed(id(1)), { timeout: 6000 });
    reload.release();
    await expect(live(page)).toHaveText(text.off(id(1)));
    await expect(page.getByTestId('delete-result')).toHaveAttribute(
      'data-key',
      'console.signups.delete.failed.off',
    );
    await expect(page.getByTestId('stored-toggle')).toBeFocused();
  });

  test(`announce (${lang}): a background reload that drops the focused row keeps focus`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    const m = await mock(page);
    const approve = gate();
    m.approve = async () => {
      await approve.held;
      return { json: { record: row(2, 'email_sent', true) } };
    };
    await signups(page);
    await openStored(page);
    await page
      .locator(`[data-signup-id="${id(2)}"]`)
      .getByTestId('signup-approve')
      .click();
    await del(page, 1).focus();
    m.all = () => ({ json: { signups: [row(2), row(3)] } });
    approve.release();
    await expect(page.getByTestId('stored-row')).toHaveCount(2);
    await expect(page.getByTestId('stored-filter')).toBeFocused();
  });

  test(`announce (${lang}): approve with sign-up admin off never says the request is gone`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    const m = await mock(page);
    await signups(page);
    const approve = page.locator(`[data-signup-id="${id(1)}"]`).getByTestId('signup-approve');
    await expect(approve).toBeVisible();
    const off = { status: 404, json: { error: 'not_found' } };
    m.approve = m.open = () => off;
    await approve.press('Enter');
    await expect(live(page)).toHaveText(text.actionOff('\u2068Sample 1\u2069'));
    await expect(page.getByTestId('signups-problem')).toBeVisible();
    await expect(page.getByTestId('signups-refresh')).toBeFocused();
    // Sighted users read it too, not only the hidden live region.
    const seen = page.getByTestId('signups-unconfirmed');
    await expect(seen).toBeVisible();
    await expect(seen).not.toHaveClass(/visually-hidden/);
    await expect(seen).toHaveText(text.actionOff('\u2068Sample 1\u2069'));
    m.open = () => ({ json: { signups: [row(1)] } });
    await page.getByTestId('signups-refresh').click();
    await expect(page.getByTestId('signup-row')).toHaveCount(1);
    await expect(seen).toHaveCount(0);
  });

  // 404: the whole list is already its problem text; 500: the row is still listed with its outcome.
  for (const status of [404, 500]) {
    test(`announce (${lang}): a failed Refresh keeps "unconfirmed" in view (check ${status})`, async ({
      page,
      context,
    }) => {
      await signIn(context, lang);
      const m = await mock(page);
      await signups(page);
      const approve = page.locator(`[data-signup-id="${id(1)}"]`).getByTestId('signup-approve');
      await expect(approve).toBeVisible();
      m.approve = () => ({ status: 404, json: { error: 'not_found' } });
      m.open = () => ({ status, json: { error: status === 404 ? 'not_found' : 'x' } });
      await approve.press('Enter');
      const sentence = text.actionOff('\u2068Sample 1\u2069');
      await expect(live(page)).toHaveText(sentence);
      m.open = () => ({ status: 500, json: { error: 'x' } });
      const seen = page.getByTestId('signups-unconfirmed');
      // Twice: a second failure keeps it too.
      for (let i = 0; i < 2; i++) {
        const answered = page.waitForResponse((r) => r.url().endsWith('/signups/open'));
        await page.getByTestId('signups-refresh').click();
        await answered;
        await expect(page.getByTestId('signups-problem')).toBeVisible();
        await expect(seen).toHaveText(sentence);
        await expect(seen).toBeVisible();
      }
      m.open = () => ({ json: { signups: [row(1)] } });
      await page.getByTestId('signups-refresh').click();
      await expect(page.getByTestId('signup-row')).toHaveCount(1);
      await expect(seen).toHaveCount(0);
    });
  }

  for (const status of [500, 404]) {
    test(`announce (${lang}): deleted while approve's check is pending, then ${status}: the deletion stands`, async ({
      page,
      context,
    }) => {
      await signIn(context, lang);
      const m = await mock(page);
      await signups(page);
      await openStored(page);
      const check = gate();
      let checking = false;
      m.approve = () => ({ status: 404, json: { error: 'not_found' } });
      // The first open list after Approve is its check; later ones no longer hold the request.
      m.open = async () => {
        if (checking) return { json: { signups: [row(2)] } };
        checking = true;
        await check.held;
        return { status, json: { error: status === 404 ? 'not_found' : 'x' } };
      };
      await page
        .locator(`[data-signup-id="${id(1)}"]`)
        .getByTestId('signup-approve')
        .click();
      await expect.poll(() => checking).toBe(true);
      await askDelete(page, m, 1);
      m.all = () => ({ json: { signups: [row(2), row(3)] } });
      await page.getByTestId('delete-ok').click();
      const result = page.getByTestId('delete-result');
      await expect(result).toHaveAttribute('data-key', 'console.signups.delete.done');
      await expect(live(page)).toContainText(id(1));
      const spoken = await live(page).textContent();
      const answered = page.waitForResponse((r) => r.url().endsWith('/signups/open'));
      check.release();
      await answered;
      await page.waitForTimeout(500);
      await expect(live(page)).toHaveText(spoken!);
      await expect(page.getByTestId('signups-problem')).toHaveCount(0);
      await expect(page.getByTestId('signups-unconfirmed')).toHaveCount(0);
      await expect(page.getByTestId('signup-row')).toHaveCount(1);
    });
  }

  test(`announce (${lang}): a Refresh overtakes approve's check: the old answer is dropped`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    const m = await mock(page);
    await signups(page);
    await expect(page.getByTestId('signup-row')).toHaveCount(2);
    const check = gate();
    let checking = false;
    m.approve = () => ({ status: 404, json: { error: 'not_found' } });
    m.open = async () => {
      if (checking) return { json: { signups: [row(1), row(2), row(3)] } };
      checking = true;
      await check.held;
      return { status: 404, json: { error: 'not_found' } };
    };
    const approve = page.locator(`[data-signup-id="${id(1)}"]`).getByTestId('signup-approve');
    await approve.click();
    await expect.poll(() => checking).toBe(true);
    await page.getByTestId('signups-refresh').click();
    await expect(page.getByTestId('signup-row')).toHaveCount(3);
    await expect(live(page)).toContainText('3');
    const spoken = await live(page).textContent();
    check.release();
    // The action has ended once the row is released.
    await expect(approve).not.toHaveAttribute('aria-disabled');
    await page.waitForTimeout(500);
    await expect(live(page)).toHaveText(spoken!);
    await expect(page.getByTestId('signups-problem')).toHaveCount(0);
    await expect(page.getByTestId('signup-message')).toHaveCount(0);
    await expect(page.getByTestId('signup-row')).toHaveCount(3);
  });

  test(`announce (${lang}): focus lost outside the stored list is not moved into its filter`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    const m = await mock(page);
    await signups(page);
    await openStored(page);
    const stored = gate();
    m.all = async () => {
      await stored.held;
      return { json: { signups: [row(2), row(3)] } };
    };
    m.open = () => ({ json: { signups: [row(2)] } });
    await page
      .locator(`[data-signup-id="${id(1)}"]`)
      .getByTestId('signup-approve')
      .focus();
    // Clicked from script: focus stays on the row that the reload removes.
    await page.getByTestId('signups-refresh').evaluate((b: HTMLButtonElement) => b.click());
    await expect(page.getByTestId('signup-row')).toHaveCount(1);
    stored.release();
    await expect(page.getByTestId('stored-row')).toHaveCount(2);
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  });

  test(`announce (${lang}): leaving while the action is being sent: focus is rescued`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    await page.goto(`${APP}/#/testers/${ALEX}`);
    await page.getByTestId('tester-disable').click();
    await expect(page.getByTestId('confirm-cancel')).toBeFocused();
    const send = gate();
    const reload = gate();
    let sending = false;
    let reloading = false;
    await page.route('**/admin-api/**', async (route) => {
      const req = route.request();
      if (req.method() !== 'GET') {
        sending = true;
        await send.held;
        return route.continue();
      }
      if (!sending || !req.url().endsWith('/admin-api/accounts')) return route.continue();
      reloading = true;
      await reload.held;
      const res = await route.fetch();
      const json = (await res.json()) as { accounts: { target: string }[] };
      json.accounts = json.accounts.filter((a) => a.target !== ALEX);
      await route.fulfill({ json });
    });
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => sending).toBe(true);
    await page.getByTestId('nav-testers').click();
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    const link = page.getByTestId(`tester-open-${ALEX}`);
    await link.focus();
    send.release();
    await expect.poll(() => reloading).toBe(true);
    reload.release();
    await expect(link).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  });

  test(`announce (${lang}): the same refused add submitted twice is a new alert each time`, async ({
    page,
    context,
  }) => {
    await signIn(context, lang);
    await page.goto(`${APP}/#/add`);
    for (const [testid, name, email] of [
      ['add-name', 'R2-D2', 'ok@example.invalid'],
      ['add-email', 'Test B.', 'not-an-address'],
    ] as const) {
      await page.getByTestId('add-name').fill(name);
      await page.getByTestId('add-email').fill(email);
      await page.getByTestId('add-submit').click();
      const field = page.getByTestId(testid);
      await expect(field).toBeFocused();
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      const problem = page.getByTestId('add-problem');
      await expect(problem).toHaveRole('alert');
      const first = (await problem.elementHandle())!;
      await field.press('Enter');
      await expect.poll(() => first.evaluate((e) => e.isConnected)).toBe(false);
      await expect(problem).toHaveCount(1);
      await expect(problem).toHaveRole('alert');
      await expect(field).toBeFocused();
    }
  });
}
