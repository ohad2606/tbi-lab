/**
 * AXE-FULL: page-level automated axe-core scan of the main screens, HE and EN.
 * Only serious/critical impact is asserted; moderate/minor findings are not reported here.
 * Automated rules catch only part of the possible problems; this spec does not establish
 * conformance with any standard. Manual and screen-reader checks stay separate.
 *
 * Screens: Projects home (getting-started panel open / closed), the editor, the editor with the
 * application menu open, the guide dialog, and the editor with a simulation running.
 * Any remaining violation must be listed in EXCEPTIONS (rule, selector, reason).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { buildProgram, goToProjects, openAppMenu, waitSaved } from './helpers.js';

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);

/** Known, reported violations. Empty when a scan is clean. Selector is matched as a substring. */
const EXCEPTIONS: { rule: string; selector: string; reason: string }[] = [
  {
    rule: 'label-content-name-mismatch',
    selector: 'g[data-id=',
    reason:
      'Canvas part (role=button): aria-label "R1, Resistor, 220 Ω" vs visible text "R1220 Ω" (SVG text, pin labels); axe string match, product decision, not fixed.',
  },
];

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface Found {
  id: string;
  impact: string;
  target: string;
}

async function scan(page: Page): Promise<Found[]> {
  await page.evaluate(axeSource);
  const all: Found[] = await page.evaluate(async (tags) => {
    const r = await (window as any).axe.run(document, { runOnly: { type: 'tag', values: tags } });
    return r.violations.flatMap((v: any) =>
      v.nodes.map((n: any) => ({ id: v.id, impact: v.impact, target: n.target.join(' ') })),
    );
  }, TAGS);
  return all.filter(
    (f) =>
      (f.impact === 'serious' || f.impact === 'critical') &&
      !EXCEPTIONS.some((e) => e.rule === f.id && f.target.includes(e.selector)),
  );
}

async function toHome(page: Page, locale: 'en' | 'he') {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(locale);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

for (const locale of ['en', 'he'] as const) {
  test.describe(locale, () => {
    test('Projects home: getting-started panel open, then closed', async ({ page }) => {
      await toHome(page, locale);
      if (!(await page.getByTestId('getting-started').isVisible())) {
        await page.getByTestId('onboarding-show').click();
      }
      await expect(page.getByTestId('getting-started')).toBeVisible();
      expect(await scan(page), 'panel open').toEqual([]);
      await page.getByTestId('onboarding-dismiss').click();
      await expect(page.getByTestId('onboarding-show')).toBeVisible();
      expect(await scan(page), 'panel closed').toEqual([]);
    });

    test('Editor, application menu and guide dialog', async ({ page }) => {
      await toHome(page, locale);
      await page.getByTestId('open-example-esp32-blink').click();
      await expect(page.getByTestId('canvas')).toBeVisible();
      await waitSaved(page);
      expect(await scan(page), 'editor').toEqual([]);
      await openAppMenu(page);
      expect(await scan(page), 'app menu open').toEqual([]);
      await page.getByTestId('menu-guide').click();
      await expect(page.getByTestId('guide-dialog')).toBeVisible();
      expect(await scan(page), 'guide dialog').toEqual([]);
    });

    test('Editor with a simulation running', async ({ page, request }) => {
      await request.post('http://127.0.0.1:7499/__test/end-all?reason=terminated');
      await toHome(page, locale);
      await page.getByTestId('open-example-esp32-blink').click();
      await expect(page.getByTestId('canvas')).toBeVisible();
      await waitSaved(page);
      await buildProgram(page);
      await page.getByTestId('sim-run').click();
      await expect(page.getByTestId('sim-stop')).toBeVisible({ timeout: 30_000 });
      expect(await scan(page), 'simulation started').toEqual([]);
    });
  });
}
