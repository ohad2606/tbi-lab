/**
 * A11Y-001 in the TBI Lab Admin app: the two-tone focus ring (navy + white band) contrasts ≥ 3:1
 * with the surface next to it on the tab bar / navigation, buttons, inputs (also in the error state
 * of the Add form), in Hebrew (default, RTL) and English; forced colours use the system highlight.
 */
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';

const APP = 'http://127.0.0.1:4176';
const as = (context: BrowserContext, subject: string) =>
  context.addCookies([{ name: 'tbi_test_user', value: subject, url: APP }]);

const rgb = (c: string) => (/(\d+),\s*(\d+),\s*(\d+)/.exec(c) ?? []).slice(1, 4).map(Number);
const lum = (c: string) => {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v! / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

async function check(page: Page, name: string, t: Locator) {
  await page.keyboard.press('Shift');
  await t.focus();
  await expect(t).toBeFocused();
  const r = await t.evaluate((el) => {
    const cs = getComputedStyle(el);
    let node: Element | null = el.parentElement;
    let surface = 'rgb(255, 255, 255)';
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== 'transparent' && !/,\s*0\)$/.test(bg)) {
        surface = bg;
        break;
      }
      node = node.parentElement;
    }
    return {
      width: parseFloat(cs.outlineWidth) || 0,
      style: cs.outlineStyle,
      ring: cs.outlineColor,
      halo: /(rgb\([^)]*\))/.exec(cs.boxShadow)?.[1] ?? null,
      surface,
    };
  });
  expect(r.style, name).toBe('solid');
  expect(r.width, name).toBeGreaterThanOrEqual(3);
  const best = Math.max(contrast(r.ring, r.surface), r.halo ? contrast(r.halo, r.surface) : 0);
  expect(best, `${name}: ${r.ring} / ${r.halo} vs ${r.surface}`).toBeGreaterThanOrEqual(3);
  if (r.halo) expect(contrast(r.ring, r.halo), name).toBeGreaterThanOrEqual(3);
}

for (const lang of ['he', 'en'] as const)
  test(`A11Y-001 admin (${lang}): navigation, buttons and inputs (error state too)`, async ({
    page,
    context,
  }) => {
    await as(context, 'e2e-owner');
    if (lang === 'en')
      await context.addInitScript(() => localStorage.setItem('tbi-admin.locale', 'en'));
    await page.goto(`${APP}/#/add`);
    await expect(page.getByTestId('add-email')).toBeVisible();
    const nav = page.locator('nav a, nav button').first();
    await check(page, 'navigation', nav);
    await check(page, 'add-email', page.getByTestId('add-email'));
    await check(page, 'add-submit', page.getByTestId('add-submit'));
    // Error state: an invalid address.
    await page.getByTestId('add-email').fill('not-an-address');
    await page.getByTestId('add-submit').click();
    await expect(page.getByTestId('add-problem')).toBeVisible();
    await check(page, 'add-email-invalid', page.getByTestId('add-email'));
    if (process.env.TBI_SHOTS)
      await page.screenshot({
        path: `${process.env.TBI_SHOTS}/admin-focus-${lang}-${test.info().project.name}.png`,
      });
  });

test('A11Y-001 admin: forced colours use the system highlight', async ({ page, context }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await as(context, 'e2e-owner');
  await page.goto(`${APP}/#/add`);
  await expect(page.getByTestId('add-email')).toBeVisible();
  await check(page, 'add-email', page.getByTestId('add-email'));
});
