/**
 * A11Y-007 and A11Y-008 (accessibility assessment), EN and HE, Arduino and MicroPython multi-file
 * examples:
 * - 007: the program-files tablist contains only tabs (the "New file" / rename / delete actions are
 *   outside it); every tab controls the code editor, which is a tabpanel labelled by the selected
 *   tab — checked in the DOM and in Chromium's accessibility tree;
 * - 008: the editor gutter's line numbers contrast ≥ 4.5:1 with the gutter background (WCAG 1.4.3).
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects, waitSaved } from './helpers.js';

async function openCode(page: Page, id: string, lang: 'en' | 'he') {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(lang);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  await page.getByTestId('view-code').click();
}

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

for (const lang of ['en', 'he'] as const)
  for (const id of ['esp32-lcd-library', 'mpy-lcd-library'])
    test(`A11Y-007/008 (${lang}, ${id}): a valid file tablist with a tabpanel; gutter numbers ≥ 4.5:1`, async ({
      page,
    }) => {
      await openCode(page, id, lang);
      const tablist = page.getByRole('tablist', { name: /./ }).filter({
        has: page.getByTestId(/^code-file-/),
      });
      // 007: only tabs inside the tablist.
      const roles = await page
        .locator('[role="tablist"]:has([data-testid^="code-file-"])')
        .evaluate((el) => [...el.children].map((c) => c.getAttribute('role')));
      expect(roles.length).toBeGreaterThanOrEqual(2);
      expect(roles.every((r) => r === 'tab')).toBe(true);
      await expect(
        page.locator(
          '[role="tablist"]:has([data-testid^="code-file-"]) [data-testid="code-file-new"]',
        ),
      ).toHaveCount(0);
      await expect(page.getByTestId('code-file-new')).toBeVisible();
      // Each tab controls the editor panel; the panel is labelled by the selected tab.
      const files = page.locator('[role="tablist"]:has([data-testid^="code-file-"])');
      const tabs = files.locator('[role="tab"]');
      const n = await tabs.count();
      for (let i = 0; i < n; i++)
        await expect(tabs.nth(i)).toHaveAttribute('aria-controls', 'code-editor-panel');
      const panel = page.locator('#code-editor-panel');
      await expect(panel).toHaveAttribute('role', 'tabpanel');
      const selectedId = await page
        .locator(
          '[role="tablist"]:has([data-testid^="code-file-"]) [role="tab"][aria-selected="true"]',
        )
        .getAttribute('id');
      await expect(panel).toHaveAttribute('aria-labelledby', selectedId!);
      // Switch to the second file: the panel follows.
      await tabs.nth(1).click();
      const second = await tabs.nth(1).getAttribute('id');
      await expect(panel).toHaveAttribute('aria-labelledby', second!);
      // The accessibility tree: a tablist whose children are tabs, and a tabpanel.
      const snap = await tablist.ariaSnapshot();
      expect(snap).toMatch(/tablist/);
      expect(snap).not.toMatch(/- button/);
      expect(await page.getByRole('tabpanel').count()).toBeGreaterThanOrEqual(1);
      // 008: the gutter numbers' contrast.
      const { color, bg } = await page
        .locator('.code-gutter .gutter-line')
        .first()
        .evaluate((el) => {
          const g = el.closest('.code-gutter')!;
          return { color: getComputedStyle(el).color, bg: getComputedStyle(g).backgroundColor };
        });
      expect(contrast(color, bg), `${color} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });
