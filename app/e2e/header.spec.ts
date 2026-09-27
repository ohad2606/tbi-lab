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
  waitForStoredProject,
  waitSaved,
} from './helpers.js';

const menu = (page: Page) => page.getByTestId('app-menu');
const menuButton = (page: Page) => page.getByTestId('app-menu-button');

async function box(page: Page, testId: string) {
  return (await page.getByTestId(testId).boundingBox())!;
}

test('the top bar uses the regular TBI logo for light surfaces: no tile, never the round mark', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('example-list')).toBeVisible();
  for (const screen of ['projects', 'editor']) {
    if (screen === 'editor') {
      await page.getByTestId('open-example-led-current').click();
      await expect(page.getByTestId('canvas')).toBeVisible();
    }
    const logo = page.getByTestId('brand-logo');
    await expect(logo).toBeVisible();
    expect(await logo.getAttribute('src')).toMatch(/tbi-logo-light/);
    // Aspect ratio kept (204 x 120 asset), compact toolbar height, real transparency.
    const info = await logo.evaluate((img: HTMLImageElement) => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const r = img.getBoundingClientRect();
      // Nothing painted behind the logo: its container and itself are transparent.
      const bg = (el: Element) => getComputedStyle(el).backgroundColor;
      return {
        natural: [img.naturalWidth, img.naturalHeight],
        w: r.width,
        h: r.height,
        corner: g.getImageData(0, 0, 1, 1).data[3],
        backgrounds: [bg(img), bg(img.parentElement!)],
      };
    });
    expect(info.natural).toEqual([204, 120]);
    expect(info.h).toBeLessThanOrEqual(40);
    expect(info.w / info.h).toBeCloseTo(204 / 120, 1);
    expect(info.corner).toBe(0);
    expect(info.backgrounds).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
    await expect(page.locator('.brand-logo-tile')).toHaveCount(0);
    const srcs = await page
      .locator('img')
      .evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
    expect(srcs.filter((s) => /tbi-mark/.test(s))).toEqual([]);
  }
  // Nothing the product renders or declares refers to the round mark, favicon metadata
  // included: the tab icon is the approved light logo.
  const icons = await page
    .locator('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')
    .evaluateAll((links) => links.map((l) => (l as HTMLLinkElement).href));
  expect(icons).toHaveLength(1);
  expect(icons[0]).toMatch(/tbi-logo-light/);
  const icon = await page.request.get(icons[0]!);
  expect(icon.headers()['content-type']).toBe('image/png');
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  expect(html).not.toMatch(/tbi-mark|favicon\.png/);
  const styles = await page.evaluate(() =>
    [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules].map((r) => r.cssText))
      .join('\n'),
  );
  expect(styles).not.toMatch(/tbi-mark/);
  // The large Projects hero logo is unchanged.
  await goToProjects(page);
  expect(await page.locator('.brand-hero-logo').getAttribute('src')).toMatch(/tbi-logo-[^l]/);
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

for (const width of [1366, 1600, 1920]) {
  test(`editor header at ${width} px: menu and logo on the exact physical edges, groups between, no overflow`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 860 });
    await page.goto('/');
    await page.getByTestId('open-example-led-current').click();
    await expect(page.getByTestId('canvas')).toBeVisible();
    await waitSaved(page);
    const xs = async () => {
      const ids = [
        'app-menu-button',
        'project-name',
        'save-state',
        'undo',
        'sim-status',
        'language-select',
        'brand-logo',
      ];
      return Promise.all(ids.map(async (id) => (await box(page, id)).x));
    };
    const header = (await page.locator('header.topbar').boundingBox())!;
    for (const lang of ['en', 'he']) {
      await page.getByTestId('language-select').selectOption(lang);
      const menuBox = await box(page, 'app-menu-button');
      const logoBox = await box(page, 'brand-logo');
      if (lang === 'en') {
        // English: menu on the far LEFT, logo on the far RIGHT.
        expect(menuBox.x).toBeLessThan(40);
        expect(width - (logoBox.x + logoBox.width)).toBeLessThan(40);
        const x = await xs();
        expect([...x].sort((a, b) => a - b)).toEqual(x);
      } else {
        // Hebrew: menu on the far RIGHT, logo on the far LEFT.
        expect(width - (menuBox.x + menuBox.width)).toBeLessThan(40);
        expect(logoBox.x).toBeLessThan(40);
        const x = await xs();
        expect([...x].sort((a, b) => b - a)).toEqual(x);
      }
      // Nothing is clipped by the single-row header.
      expect(
        await page.locator('header.topbar').evaluate((h) => h.scrollWidth <= h.clientWidth),
      ).toBe(true);
      expect(header.height).toBeLessThan(70);
    }
    await page.getByTestId('language-select').selectOption('en');
  });
}

test('one simulation action; its status is plain, non-interactive text that never moves', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('open-example-led-current').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  const status = page.getByTestId('sim-status');
  await expect(page.locator('.sim-controls button')).toHaveCount(1);
  await expect(page.locator('.sim-controls a, .sim-controls [tabindex]')).toHaveCount(0);
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  const look = await status.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      tabIndex: (el as HTMLElement).tabIndex,
      cursor: cs.cursor,
      border: cs.borderTopWidth,
      background: cs.backgroundColor,
    };
  });
  expect(look).toEqual({
    tag: 'SPAN',
    tabIndex: -1,
    cursor: 'default',
    border: '0px',
    background: 'rgba(0, 0, 0, 0)',
  });
  const text = async () => (await status.innerText()).replace(/\s+/g, ' ').trim();
  expect(await text()).toBe('Status: Stopped');
  const stopped = await box(page, 'sim-status');
  await page.getByTestId('sim-run').click();
  await expect(status).toHaveAttribute('data-status', 'running');
  expect(await text()).toBe('Status: Running');
  await expect(page.locator('.sim-controls button')).toHaveCount(1);
  expect(await box(page, 'sim-status')).toEqual(stopped);
  // Keyboard: Tab from the one control never lands on the status.
  await page.getByTestId('sim-stop').focus();
  await page.keyboard.press('Tab');
  expect(
    await page.evaluate(() => document.activeElement?.closest('[data-testid="sim-status"]')),
  ).toBeNull();
  await page.getByTestId('sim-stop').click();
  await expect(status).toHaveAttribute('data-status', 'stopped');
  expect(await box(page, 'sim-status')).toEqual(stopped);
  await page.getByTestId('language-select').selectOption('he');
  expect(await text()).toBe('מצב: עצור');
  await page.getByTestId('sim-run').click();
  await expect(status).toHaveAttribute('data-status', 'running');
  expect(await text()).toBe('מצב: רץ');
  await page.getByTestId('sim-stop').click();
  await page.getByTestId('language-select').selectOption('en');
});

test('the project name is a labelled, editable field that renames through the existing path', async ({
  page,
}) => {
  await createProject(page, 'Name field');
  const field = page.getByTestId('project-name');
  // A visible label, associated with the field.
  await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();
  await expect(page.locator('.project-name-label')).toHaveText('Project name');
  const look = await field.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { align: cs.textAlign, border: cs.borderTopWidth, cursor: cs.cursor };
  });
  expect(look).toEqual({ align: 'left', border: '1px', cursor: 'text' });
  // Keyboard editing: focus, type, Enter commits through the store's rename.
  await field.focus();
  const focusRing = await field.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(focusRing).not.toBe('none');
  await field.fill('Renamed by keyboard');
  await page.keyboard.press('Enter');
  await expect(field).not.toBeFocused();
  const doc = await waitForStoredProject(page, (d) => d.name === 'Renamed by keyboard', 'renamed');
  expect(doc.name).toBe('Renamed by keyboard');
  // Escape restores; nothing is stored.
  await field.focus();
  await field.fill('Discarded');
  await page.keyboard.press('Escape');
  await expect(field).toHaveValue('Renamed by keyboard');
  // Hebrew: label translated, text aligned right, user text exact.
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.getByRole('textbox', { name: 'שם הפרויקט' })).toHaveValue(
    'Renamed by keyboard',
  );
  expect(await field.evaluate((el) => getComputedStyle(el).textAlign)).toBe('right');
  await field.fill('פרויקט בדיקה');
  await field.blur();
  await waitForStoredProject(page, (d) => d.name === 'פרויקט בדיקה', 'hebrew name');
  await page.getByTestId('language-select').selectOption('en');
  await expect(field).toHaveValue('פרויקט בדיקה');
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
    // Aligned to the button's leading edge: left in English, right in Hebrew.
    if (lang === 'en') expect(Math.abs(m.x - b.x)).toBeLessThan(2);
    else expect(Math.abs(m.x + m.width - (b.x + b.width))).toBeLessThan(2);
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

test('menu: up to three recent projects, most recent first, never the open one; opens the chosen project safely', async ({
  page,
}) => {
  const long = 'A very long project name that keeps going and going well past the menu width';
  for (const n of ['Oldest', 'Second', long, 'מחלק מתח', 'Newest']) await createProject(page, n);
  // Newest is open: the section lists the three most recently changed others, in order.
  await openAppMenu(page);
  const recent = page.getByTestId('menu-recent');
  await expect(recent.getByRole('menuitem')).toHaveText(['מחלק מתח', long, 'Second']);
  await expect(recent).toContainText('Recent projects');
  // A long name is cut with an ellipsis; the menu stays compact; full name stays available.
  const longItem = recent.getByRole('menuitem', { name: `Open ${long}` });
  await expect(longItem).toHaveAttribute('title', long);
  expect((await menu(page).boundingBox())!.width).toBeLessThanOrEqual(20 * 15 + 1);
  expect(await longItem.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');

  // Start a run in the open project, then switch through the menu with the keyboard.
  const target = (await storedProjects(page)).find((p) => p.name === 'Second')!;
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', /running|failed/);
  await menuButton(page).focus();
  await page.keyboard.press('Enter');
  const item = page.getByTestId(`menu-recent-${target.projectId}`);
  while (!(await item.evaluate((el) => el === document.activeElement)))
    await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(menu(page)).toHaveCount(0);
  await expect(page.getByTestId('project-name')).toHaveValue('Second');
  // The run did not carry over; nothing was copied or changed.
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'stopped');
  const all = await storedProjects(page);
  expect(all).toHaveLength(5);
  expect(all.find((p) => p.projectId === target.projectId)).toEqual(target);
  expect(JSON.stringify(all)).not.toMatch(/"(sessionId|token|runtime|serial)"/);

  // Hebrew: translated label (the Projects screen's term), user names exact, open one excluded.
  await page.getByTestId('language-select').selectOption('he');
  await openAppMenu(page);
  await expect(recent).toContainText('פרויקטים אחרונים');
  await expect(recent.getByRole('menuitem')).toHaveText(['Newest', 'מחלק מתח', long]);
  // Mouse selection closes the menu too.
  await recent.getByRole('menuitem', { name: /Newest/ }).click();
  await expect(menu(page)).toHaveCount(0);
  await expect(page.getByTestId('project-name')).toHaveValue('Newest');
  await page.getByTestId('language-select').selectOption('en');
});

test('one light header surface on Projects and in the editor, distinct from white', async ({
  page,
}) => {
  const surface = () =>
    page.locator('header.topbar').evaluate((h) => getComputedStyle(h).backgroundColor);
  await page.goto('/');
  await expect(page.getByTestId('example-list')).toBeVisible();
  const projects = await surface();
  await page.getByTestId('open-example-led-current').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  const editor = await surface();
  expect(editor).toBe(projects);
  expect(projects).toBe('rgb(221, 228, 238)');
  // The large dark hero is not affected.
  await goToProjects(page);
  expect(
    await page.locator('.brand-hero').evaluate((h) => getComputedStyle(h).backgroundColor),
  ).toBe('rgb(10, 26, 51)');
});
