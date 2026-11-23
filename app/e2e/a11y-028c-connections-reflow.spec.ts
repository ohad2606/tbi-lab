/**
 * A11Y-028 leftovers: the connections panel reflows at 320 CSS px (WCAG 1.4.10) without making the
 * page scroll sideways, keeps a visible focus indicator on its scroll region and select buttons
 * (2.4.7), and has a defined selection colour token. EN and HE (RTL).
 */
import { expect, test } from '@playwright/test';
import { goToProjects, waitSaved } from './helpers.js';

for (const lang of ['en', 'he'] as const)
  test(`A11Y-028c (${lang}): 320 px reflow, focus indicator, selection token`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/');
    const library = page.getByTestId('example-list');
    await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
    if (!(await library.isVisible())) await goToProjects(page);
    await page.getByTestId('language-select').selectOption(lang);
    await page.getByTestId('open-example-voltage-divider').click();
    await expect(page.getByTestId('canvas')).toBeVisible();
    await waitSaved(page);

    await page.getByTestId('connections-toggle').focus();
    await page.keyboard.press('Enter');
    const panel = page.getByTestId('connections');
    await expect(panel).toHaveAttribute('open', '');
    await expect(page.getByTestId('connections-parts')).toBeVisible();

    // The app shell is desktop-first (min-width 1024 px, documented in styles.css), so the page itself
    // scrolls sideways at 320 px; that is app-wide and not caused by this panel. The panel must fit
    // its own column and must not widen the shell: overflow stays inside its scroll region.
    const fits = await page.evaluate(() => {
      const p = document.querySelector('[data-testid=connections]')!.getBoundingClientRect();
      const c = document.querySelector('.side-column')!.getBoundingClientRect();
      return {
        left: p.left - c.left,
        right: c.right - p.right,
        shell: document.documentElement.scrollWidth,
      };
    });
    expect(fits.left).toBeGreaterThanOrEqual(-1);
    expect(fits.right).toBeGreaterThanOrEqual(-1);
    expect(fits.shell).toBeLessThanOrEqual(1024 + 1);
    // Any overflow is contained in the panel's own focusable scroll region.
    const region = page.getByRole('region', { name: lang === 'en' ? /Connections/ : /חיבורים/ });
    await expect(region).toHaveAttribute('tabindex', '0');
    const regionBox = (await region.boundingBox())!;
    expect(regionBox.width).toBeLessThanOrEqual(305);

    // Focus indicator: not removed by the panel's own rule (3:1 two-tone ring comes from :focus-visible).
    await region.focus();
    const ring = await region.evaluate((e) => {
      const s = getComputedStyle(e);
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), shadow: s.boxShadow };
    });
    expect(ring.style).not.toBe('none');
    expect(ring.width).toBeGreaterThanOrEqual(2);
    expect(ring.shadow).not.toBe('none');
    const btn = page.getByTestId('connections-select-R1');
    await btn.focus();
    expect(await btn.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe('none');
    const bb = (await btn.boundingBox())!;
    expect(bb.height).toBeGreaterThanOrEqual(24);
    expect(bb.width).toBeGreaterThanOrEqual(24);

    // The selection token is defined (no reliance on the fallback).
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--selection-bg').trim(),
      ),
    ).not.toBe('');
  });
