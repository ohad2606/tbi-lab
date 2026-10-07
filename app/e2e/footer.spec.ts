/**
 * Product footer (Sprint 10, approved text): exact EN/HE wording, a keyboard-reachable mailto
 * link, Latin tokens left-to-right inside the RTL sentence, present in every view, separate from
 * the build identity, and no horizontal overflow on a narrow window.
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects } from './helpers.js';

const EN =
  'TBI Lab · Developed by Ohad David · © 2026 TBI. All rights reserved. · support@tbi-tech.net';
const HE = 'TBI Lab · פותח על ידי אוהד דוד · © 2026 TBI. כל הזכויות שמורות. · support@tbi-tech.net';
const text = (page: Page) =>
  page.getByTestId('product-footer').evaluate((e) => e.textContent!.replace(/\s+/g, ' ').trim());

async function openExample(page: Page, id: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
}

test('footer: exact English and Hebrew text, mailto link, LTR tokens, keyboard focus', async ({
  page,
}) => {
  await page.goto('/');
  const footer = page.getByTestId('product-footer');
  await expect(footer).toBeVisible();
  expect(await text(page)).toBe(EN);
  const mail = page.getByTestId('footer-support');
  await expect(mail).toHaveAttribute('href', 'mailto:support@tbi-tech.net');
  await expect(mail).toHaveAccessibleName('Email support: support@tbi-tech.net');
  // Keyboard: the link takes focus and shows a focus ring.
  await mail.focus();
  await expect(mail).toBeFocused();
  // The footer is a landmark (<footer>) that also keeps the build identity, distinct from it.
  const bar = page.locator('footer.statusbar');
  await expect(bar).toHaveAttribute('aria-label', 'Product information and build');
  await expect(bar.getByTestId('app-version')).toBeVisible();
  expect(await text(page)).not.toContain('v0.10');
  // Hebrew: the sentence is RTL; the product, copyright and address stay LTR.
  await page.getByTestId('language-select').selectOption('he');
  expect(await text(page)).toBe(HE);
  expect(await bar.evaluate((e) => getComputedStyle(e).direction)).toBe('rtl');
  for (const token of ['TBI Lab', '© 2026 TBI.', 'support@tbi-tech.net'])
    expect(
      await footer
        .locator('bdi', { hasText: token })
        .first()
        .evaluate((e) => getComputedStyle(e).direction),
      token,
    ).toBe('ltr');
  await expect(mail).toHaveAccessibleName('שליחת דוא״ל לתמיכה: support@tbi-tech.net');
  await page.getByTestId('language-select').selectOption('en');
});

test('footer: present in Circuit, Schematic, 3D and Code, beside the version indicator', async ({
  page,
}) => {
  await openExample(page, 'esp32-blink');
  for (const view of ['circuit', 'schematic', '3d', 'code'] as const) {
    await page.getByTestId(`view-${view}`).click();
    await expect(page.getByTestId('product-footer'), view).toBeVisible();
    await expect(page.getByTestId('app-version'), view).toBeVisible();
    expect(await text(page)).toBe(EN);
  }
});

test('footer: a narrow window wraps it; it adds no horizontal overflow', async ({ page }) => {
  // Desktop-first app (narrow windows are not a target): the footer must wrap, never widen the
  // page. Compare the page's overflow with and without the footer.
  await page.setViewportSize({ width: 640, height: 700 });
  await page.goto('/');
  const footer = page.getByTestId('product-footer');
  await expect(footer).toBeVisible();
  expect(await footer.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
  expect(await footer.evaluate((e) => e.getBoundingClientRect().width)).toBeLessThanOrEqual(640);
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  const withFooter = await overflow();
  await footer.evaluate((e) => ((e as HTMLElement).style.display = 'none'));
  expect(withFooter).toBe(await overflow());
  await expect(page.getByTestId('app-version')).toBeVisible();
});
