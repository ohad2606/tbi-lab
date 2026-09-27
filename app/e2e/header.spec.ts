/**
 * S6 UI polish: the regular TBI logo in the top bar, the three-area Projects screen, and the
 * editor's header hierarchy with its application menu (routine build: no sign-out URL; the
 * configured build is covered in signout.spec.ts).
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createPackage, serializePackage, type ProjectDocument } from '@tbi-lab/domain';
import {
  createProject,
  exportFromMenu,
  goToProjects,
  openAppMenu,
  storedProjects,
  waitSaved,
} from './helpers.js';

const menu = (page: Page) => page.getByTestId('app-menu');
const menuButton = (page: Page) => page.getByTestId('app-menu-button');

async function box(page: Page, testId: string) {
  return (await page.getByTestId(testId).boundingBox())!;
}

test('the top bar uses the regular TBI logo, never the round profile mark', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('example-list')).toBeVisible();
  for (const screen of ['projects', 'editor']) {
    if (screen === 'editor') {
      await page.getByTestId('open-example-led-current').click();
      await expect(page.getByTestId('canvas')).toBeVisible();
    }
    const logo = page.getByTestId('brand-logo');
    await expect(logo).toBeVisible();
    expect(await logo.getAttribute('src')).toMatch(/tbi-logo/);
    // Aspect ratio kept (533 x 300 asset), compact toolbar height.
    const b = (await logo.boundingBox())!;
    expect(b.height).toBeLessThanOrEqual(40);
    expect(b.width / b.height).toBeCloseTo(533 / 300, 1);
    const srcs = await page
      .locator('img')
      .evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
    expect(srcs.filter((s) => /tbi-mark/.test(s))).toEqual([]);
  }
});

test('Projects: three separate areas that use a wide desktop and collapse on narrower windows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await createProject(page, 'Layout check');
  await goToProjects(page);
  const newBox = await box(page, 'home-new');
  const recentBox = await box(page, 'home-recent');
  const examplesBox = await box(page, 'home-examples');
  // Create and reopen share the start column, examples take the end column beside them.
  expect(recentBox.y).toBeGreaterThan(newBox.y + newBox.height - 1);
  expect(Math.abs(recentBox.x - newBox.x)).toBeLessThan(2);
  expect(examplesBox.x).toBeGreaterThan(newBox.x + newBox.width);
  expect(examplesBox.width).toBeGreaterThan(newBox.width);
  // Wider than the old 92rem column, but bounded.
  const main = (await page.locator('main.home').boundingBox())!;
  expect(main.width).toBeGreaterThan(1600);
  expect(main.width).toBeLessThanOrEqual(1792);
  // Examples are scanned in rows of several cards; every ESP32 example is listed.
  const cards = page.locator('.example');
  const tops = await cards.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  expect(tops.filter((t) => t === tops[0]).length).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId('example-esp32-blink')).toBeVisible();
  await expect(page.getByTestId('example-esp32-input-echo')).toBeVisible();
  // Import sits with "create something", not in the example or recent areas.
  await expect(page.getByTestId('home-new').getByTestId('import-project')).toBeVisible();

  // RTL mirrors the arrangement (create/recent on the right).
  await page.getByTestId('language-select').selectOption('he');
  const newHe = await box(page, 'home-new');
  const exHe = await box(page, 'home-examples');
  expect(newHe.x).toBeGreaterThan(exHe.x + exHe.width);
  await page.getByTestId('language-select').selectOption('en');

  // Narrower supported window: one column in the same order, nothing overflows.
  await page.setViewportSize({ width: 1100, height: 900 });
  const n = await box(page, 'home-new');
  const r = await box(page, 'home-recent');
  const e = await box(page, 'home-examples');
  expect(r.y).toBeGreaterThan(n.y);
  expect(e.y).toBeGreaterThan(r.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1100);
});

test('editor header: brand and project, then editing and the one simulation control, then language and menu', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 860 });
  await page.goto('/');
  await page.getByTestId('open-example-led-current').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  const order = async () => ({
    brand: await box(page, 'brand'),
    name: await box(page, 'project-name'),
    save: await box(page, 'save-state'),
    undo: await box(page, 'undo'),
    status: await box(page, 'sim-status'),
    lang: await box(page, 'language-select'),
    menu: await box(page, 'app-menu-button'),
  });
  let o = await order();
  const seq = [o.brand, o.name, o.save, o.undo, o.status, o.lang, o.menu].map((b) => b.x);
  expect([...seq].sort((a, b) => a - b)).toEqual(seq);
  // Hebrew: the same hierarchy, mirrored.
  await page.getByTestId('language-select').selectOption('he');
  o = await order();
  const rtl = [o.brand, o.name, o.save, o.undo, o.status, o.lang, o.menu].map((b) => b.x);
  expect([...rtl].sort((a, b) => b - a)).toEqual(rtl);
  await expect(menuButton(page)).toHaveAccessibleName('תפריט');
  await page.getByTestId('language-select').selectOption('en');
  await expect(menuButton(page)).toHaveAccessibleName('Menu');

  // Exactly one simulation control; nothing in the header moves when the state changes.
  await expect(page.locator('.sim-controls button')).toHaveCount(1);
  const before = [await box(page, 'sim-status'), await box(page, 'app-menu-button')];
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', /running|failed/);
  await expect(page.locator('.sim-controls button')).toHaveCount(1);
  expect([await box(page, 'sim-status'), await box(page, 'app-menu-button')]).toEqual(before);
  await page
    .getByTestId('sim-stop')
    .click()
    .catch(() => undefined);
});

test('the application menu: keyboard, Escape, click outside, Tab; contents; closes after an action', async ({
  page,
}) => {
  await createProject(page, 'Menu check');
  const button = menuButton(page);
  await expect(button).toHaveAttribute('aria-haspopup', 'menu');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(menu(page)).toHaveCount(0);

  // Keyboard: Enter opens with focus on the first item; arrows move; Escape closes to the button.
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(menu(page)).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('menu-projects')).toBeFocused();
  await expect(menu(page).getByRole('menuitem')).toHaveText([
    'Projects',
    'New project…',
    'Import project…',
    'Export project',
  ]);
  await expect(page.getByTestId('sign-out')).toHaveCount(0); // not configured in this build
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('menu-new-project')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByTestId('export-current')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('menu-projects')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(page.getByTestId('canvas')).toBeVisible(); // Escape did nothing else

  // Click outside closes; so does Tab; the button toggles.
  await button.click();
  await expect(menu(page)).toBeVisible();
  await page.getByTestId('canvas').click({ position: { x: 20, y: 20 } });
  await expect(menu(page)).toHaveCount(0);
  await button.click();
  await page.keyboard.press('Tab');
  await expect(menu(page)).toHaveCount(0);
  await button.click();
  await button.click();
  await expect(menu(page)).toHaveCount(0);

  // Only one menu instance, inside the viewport, aligned to the button's inline end (RTL too).
  for (const lang of ['en', 'he']) {
    await page.getByTestId('language-select').selectOption(lang);
    await openAppMenu(page);
    await expect(page.locator('[role="menu"]')).toHaveCount(1);
    const m = (await menu(page).boundingBox())!;
    const b = (await button.boundingBox())!;
    const vw = page.viewportSize()!.width;
    expect(m.x).toBeGreaterThanOrEqual(0);
    expect(m.x + m.width).toBeLessThanOrEqual(vw);
    if (lang === 'en') expect(Math.abs(m.x + m.width - (b.x + b.width))).toBeLessThan(2);
    else expect(Math.abs(m.x - b.x)).toBeLessThan(2);
    if (lang === 'he')
      await expect(menu(page).getByRole('menuitem')).toHaveText([
        'פרויקטים',
        'פרויקט חדש…',
        'ייבוא פרויקט…',
        'ייצוא פרויקט',
      ]);
    await page.keyboard.press('Escape');
  }
  await page.getByTestId('language-select').selectOption('en');

  // "New project" leads to the Projects screen's create form, focused; the menu is gone.
  await openAppMenu(page);
  await page.getByTestId('menu-new-project').click();
  await expect(page.getByTestId('new-project-name')).toBeFocused();
  await expect(menu(page)).toHaveCount(0);
});

test('menu Export and Import reuse the product flows; Projects navigates home', async ({
  page,
}) => {
  await createProject(page, 'Round trip');
  const download = await exportFromMenu(page);
  await expect(menu(page)).toHaveCount(0);
  const text = readFileSync((await download.path())!, 'utf8');
  expect(JSON.parse(text).project.name).toBe('Round trip');

  // Import from the editor menu: a copy opens (same flow as the Projects screen).
  const doc = JSON.parse(text).project as ProjectDocument;
  const pkg = serializePackage(
    createPackage(doc, { appVersion: '0.1.0', exportedAt: '2026-09-27T00:00:00.000Z' }),
  );
  const chooser = page.waitForEvent('filechooser');
  await openAppMenu(page);
  await page.getByTestId('menu-import').click();
  await (
    await chooser
  ).setFiles({ name: 'rt.tbilab', mimeType: 'application/json', buffer: Buffer.from(pkg) });
  await expect(page.getByTestId('notice')).toBeVisible();
  await expect(page.getByTestId('project-name')).not.toHaveValue('Round trip');
  await waitSaved(page);
  expect((await storedProjects(page)).length).toBe(2);

  await goToProjects(page);
  await expect(page.getByTestId('project-list').locator('.project-row')).toHaveCount(2);
});
