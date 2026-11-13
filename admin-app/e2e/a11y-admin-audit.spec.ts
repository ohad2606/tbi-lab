/**
 * Accessibility AUDIT of the Admin app (evidence for the WCAG 2.2 AA assessment). Not a gate:
 * skipped unless TBI_A11Y_AUDIT=1. Writes axe JSON, accessibility-tree snapshots, keyboard walks
 * and screenshots under TBI_A11Y_OUT/admin. The gate is a11y-admin.spec.ts.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { scan } from '../../app/e2e/a11y-helpers.js';

const OUT = join(process.env.TBI_A11Y_OUT ?? 'test-results/a11y-audit', 'admin');
const FAKE = 'http://127.0.0.1:7499';
test.skip(process.env.TBI_A11Y_AUDIT !== '1', 'audit only (TBI_A11Y_AUDIT=1)');

const target = (email: string) =>
  `t_${createHash('sha256').update(`account|${email}`).digest('base64url').slice(0, 16)}`;
const ALEX = target('tester.one@example.invalid');

function save(name: string, value: unknown) {
  const f = join(OUT, name);
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value, null, 1));
}
async function capture(page: Page, name: string) {
  save(`axe/${name}.json`, await scan(page));
  save(`tree/${name}.yaml`, await page.locator('body').ariaSnapshot());
  mkdirSync(join(OUT, 'shots'), { recursive: true });
  await page.screenshot({ path: join(OUT, 'shots', `${name}.png`), fullPage: true });
}
const owner = async (context: BrowserContext, lang: 'he' | 'en') => {
  await context.addCookies([
    { name: 'tbi_test_user', value: 'e2e-owner', url: test.info().project.use.baseURL! },
  ]);
  await context.addInitScript((l) => localStorage.setItem('tbi-admin.locale', l), lang);
};
async function focusInfo(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { tag: 'body' };
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const inView = cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight;
    const top = inView ? document.elementFromPoint(cx, cy) : null;
    const covered = inView && top !== null && top !== el && !el.contains(top) && !top.contains(el);
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      testid: el.dataset.testid,
      text: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 50),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
      inView,
      covered: covered
        ? `${(top as HTMLElement).tagName}.${(top as HTMLElement).className}`
        : false,
    };
  });
}
async function smallTargets(page: Page) {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, summary, [role="button"], [tabindex="0"]',
      ),
    ]
      .map((el) => ({ el, r: el.getBoundingClientRect(), cs: getComputedStyle(el) }))
      .filter(
        ({ el, r, cs }) =>
          r.width > 0 &&
          (r.width < 24 || r.height < 24) &&
          !(el.tagName === 'A' && cs.display === 'inline'),
      )
      .map(({ el, r }) => ({
        testid: el.dataset.testid,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? '').trim().slice(0, 30),
        w: Math.round(r.width),
        h: Math.round(r.height),
      })),
  );
}

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/reset-admin`);
  await request.post(`${FAKE}/__test/reset-reports`);
});

for (const [label, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['phone', { width: 390, height: 844 }],
] as const)
  for (const lang of ['he', 'en'] as const)
    test(`screens ${label} ${lang}`, async ({ page, context, request }) => {
      test.setTimeout(180_000);
      await page.setViewportSize(viewport);
      await owner(context, lang);
      await request.post(`${FAKE}/reports`, {
        headers: { 'x-forwarded-user': 'e2e-user' },
        data: {
          description: 'שורה ראשונה\nFirst report line: GPIO2 at 3.3 V',
          category: 'other',
          blocking: false,
          locale: 'he',
          view: 'home',
          kind: 'general',
        },
      });
      const routes = ['today', 'testers', `testers/${ALEX}`, 'add', 'feedback', 'activity'];
      routes.push(label === 'phone' ? 'more' : 'settings');
      for (const r of routes) {
        await page.goto(`/#/${r}`);
        await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(600);
        const name = `${label}-${lang}-${r.replace(/\/.*/, '-detail')}`;
        await capture(page, name);
        save(`targets/${name}.json`, await smallTargets(page));
      }
      // Add form: invalid submit (error handling, 3.3.1/3.3.3).
      await page.goto('/#/add');
      await page.getByTestId('add-email').fill('not-an-address');
      await page.getByTestId('add-submit').click();
      await expect(page.getByTestId('add-problem')).toBeVisible();
      save(`forms/${label}-${lang}-add-invalid.json`, {
        focus: await focusInfo(page),
        email: await page.getByTestId('add-email').evaluate((e) => ({
          invalid: e.getAttribute('aria-invalid'),
          describedby: e.getAttribute('aria-describedby'),
          errorId: document.querySelector('[data-testid="add-problem"]')?.id || null,
        })),
      });
      await capture(page, `${label}-${lang}-add-invalid`);
      // Confirmation (alertdialog) on disable.
      await page.goto(`/#/testers/${ALEX}`);
      await page.getByTestId('tester-disable').click();
      await expect(page.getByTestId('confirm')).toBeVisible();
      const confirmFocus = await focusInfo(page);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      save(`forms/${label}-${lang}-confirm.json`, {
        focusOnOpen: confirmFocus,
        afterEscape: {
          stillOpen: await page.getByTestId('confirm').isVisible(),
          focus: await focusInfo(page),
        },
      });
      // Signed-out page.
      await page.route('**/admin-api/**', (r) =>
        r.fulfill({
          status: 401,
          contentType: 'application/json',
          body: '{"error":"identity_required"}',
        }),
      );
      await page.goto('/');
      await expect(page.getByTestId('access-signed-out')).toBeVisible();
      await capture(page, `${label}-${lang}-signed-out`);
      await page.unroute('**/admin-api/**');
    });

test('keyboard walks: desktop and phone, route change focus, obscuring by the tab bar', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  await owner(context, 'en');
  for (const [label, viewport] of [
    ['desktop', { width: 1280, height: 800 }],
    ['phone', { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    await page.goto('/#/testers');
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
    const stops = [];
    for (let i = 0; i < 45; i++) {
      await page.keyboard.press('Tab');
      stops.push(await focusInfo(page));
    }
    save(`keyboard/${label}-testers-tab.json`, stops);
    // Route change: activate a nav link by keyboard and see where focus lands.
    await page.goto('/#/today');
    await expect(page.locator('h1').first()).toBeVisible();
    await page.getByTestId('nav-testers').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    save(`keyboard/${label}-route-change.json`, {
      focus: await focusInfo(page),
      title: await page.title(),
    });
  }
});
