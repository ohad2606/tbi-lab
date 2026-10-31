/**
 * Sprint 26 in the browser (fake build service: the real builder transport and queue with a
 * scripted provider): program files as tabs (create, name rules, rename, delete, undo), per-file
 * diagnostics that open their file, the Managed libraries list following the parts and the code,
 * reload and export/import keeping every file, the multi-file examples, Hebrew and tablet layouts.
 */
import { expect, test, type Page } from '@playwright/test';
import { parsePackage } from '@tbi-lab/domain';
import {
  exportFromMenu,
  openImported,
  reopenFromLibrary,
  storedProject,
  waitForStoredProject,
  waitSaved,
} from './helpers.js';

const FAKE = 'http://127.0.0.1:7499';
const code = (page: Page) => page.getByTestId('code-text');
const tab = (page: Page, path: string) => page.getByTestId(`code-file-${path}`);

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/end-all?reason=terminated`);
  await request.post(`${FAKE}/__test/reset-builds`);
});

async function openExample(page: Page, id: string, lang: 'en' | 'he' = 'en') {
  await page.goto('/');
  await expect(page.getByTestId('example-list')).toBeVisible();
  await page.getByTestId('language-select').selectOption(lang);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}

async function newFile(page: Page, name: string) {
  await page.getByTestId('code-file-new').click();
  await page.getByTestId('code-file-name').fill(name);
  await page.getByTestId('code-file-create').click();
}

test('files: create with name rules, edit, rename, delete with confirmation, undo; the main file is fixed', async ({
  page,
}) => {
  await openExample(page, 'esp32-blink');
  await page.getByTestId('view-code').click();
  await expect(tab(page, 'sketch.ino')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('code-file-main')).toBeVisible();
  // The entry file has no rename or delete.
  await expect(page.getByTestId('code-file-rename')).toHaveCount(0);
  // Refused names, explained before anything is created.
  for (const [name, text] of [
    ['../evil.h', /no “\.” or “\.\.”/],
    ['notes.txt', /does not build files of this type/],
    ['sketch.ino', /main file/],
  ] as const) {
    await page.getByTestId('code-file-new').click();
    await page.getByTestId('code-file-name').fill(name);
    await page.getByTestId('code-file-create').click();
    await expect(page.getByTestId('code-file-error')).toContainText(text);
  }
  await page.getByTestId('code-file-name').fill('helpers.h');
  await page.getByTestId('code-file-create').click();
  await expect(tab(page, 'helpers.h')).toHaveAttribute('aria-selected', 'true');
  await expect(code(page)).toHaveAttribute('data-file', 'helpers.h');
  await code(page).fill('#pragma once\nint helper();\n');
  let doc = await waitForStoredProject(
    page,
    (d) => d.programs.U1?.files?.[0]?.text === '#pragma once\nint helper();\n',
    'helpers.h stored',
  );
  expect(doc.programs.U1!.files).toEqual([
    { path: 'helpers.h', text: '#pragma once\nint helper();\n' },
  ]);
  expect(doc.schemaVersion).toBe(6);
  // A duplicate differing only in case.
  await page.getByTestId('code-file-new').click();
  await page.getByTestId('code-file-name').fill('Helpers.h');
  await page.getByTestId('code-file-create').click();
  await expect(page.getByTestId('code-file-error')).toContainText('already exists');
  await page.keyboard.press('Escape');
  // Rename into src/ (a .h may live there).
  await tab(page, 'helpers.h').click();
  await page.getByTestId('code-file-rename').click();
  await page.getByTestId('code-file-name').fill('src/helpers.h');
  await page.getByTestId('code-file-create').click();
  await expect(tab(page, 'src/helpers.h')).toHaveAttribute('aria-selected', 'true');
  // Delete with confirmation; undo brings the file back, exactly.
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('code-file-delete').click();
  await expect(tab(page, 'src/helpers.h')).toHaveCount(0);
  await expect(tab(page, 'sketch.ino')).toHaveAttribute('aria-selected', 'true');
  await waitForStoredProject(page, (d) => !d.programs.U1?.files, 'file deleted');
  await page.keyboard.press('Control+z');
  doc = await waitForStoredProject(page, (d) => d.programs.U1?.files?.length === 1, 'undone');
  expect(doc.programs.U1!.files).toEqual([
    { path: 'src/helpers.h', text: '#pragma once\nint helper();\n' },
  ]);
});

test('a build error in another file names it and its line; the diagnostic opens that file at the line', async ({
  page,
}) => {
  await openExample(page, 'esp32-blink');
  await page.getByTestId('view-code').click();
  await newFile(page, 'broken.h');
  await code(page).fill('#pragma once\nBROKEN thing;\n');
  await waitSaved(page);
  await tab(page, 'sketch.ino').click();
  await page.getByTestId('build-button').click();
  await expect(page.getByTestId('build-phase')).toHaveAttribute('data-phase', 'failed', {
    timeout: 60_000,
  });
  const d = page.getByTestId('diagnostic').first();
  await expect(d).toHaveAttribute('data-file', 'broken.h');
  await expect(d).toContainText('broken.h:2:1');
  await d.click();
  await expect(code(page)).toHaveAttribute('data-file', 'broken.h');
  await expect(page.getByTestId('code-position')).toContainText('2');
  // The gutter marks the line in that file only.
  await expect(page.locator('.gutter-line.mark-error')).toHaveText('2');
  await tab(page, 'sketch.ino').click();
  await expect(page.locator('.gutter-line.mark-error')).toHaveCount(0);
});

test('managed libraries follow the parts and the code; the user’s code is never edited', async ({
  page,
}) => {
  await openExample(page, 'esp32-lcd-library');
  await page.getByTestId('view-code').click();
  // Three files, the main one first.
  await expect(page.getByTestId('code-files').getByRole('tab')).toHaveText([
    /sketch\.ino/,
    /display\.cpp/,
    /display\.h/,
  ]);
  const lib = page.getByTestId('library-arduino.liquidcrystal-pcf8574');
  await expect(lib).toContainText('LiquidCrystal_PCF8574');
  await expect(lib.getByTestId('library-version')).toHaveText('2.2.0');
  await expect(lib).toContainText('BSD-3-Clause');
  await expect(lib).toContainText('needs it');
  await expect(lib).toContainText('the code uses it');
  await expect(lib.getByTestId('library-validated')).toContainText('setCursor');
  const before = (await storedProject(page)).programs.U1!;
  expect(before.libraries).toEqual([{ id: 'arduino.liquidcrystal-pcf8574', version: '2.2.0' }]);
  // Build sends every file and the pinned library (the scripted build succeeds).
  const sent: unknown[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/build\/v1\/builds$/.test(new URL(r.url()).pathname))
      sent.push(r.postDataJSON());
  });
  await page.getByTestId('build-button').click();
  await expect(page.getByTestId('build-phase')).toHaveAttribute('data-phase', 'current', {
    timeout: 60_000,
  });
  expect(sent[0]).toMatchObject({
    files: [{ name: 'sketch.ino' }, { name: 'display.cpp' }, { name: 'display.h' }],
    libraries: [{ id: 'arduino.liquidcrystal-pcf8574', version: '2.2.0' }],
  });
  // Remove the include: the library stays while the display is placed (a part needs it).
  await tab(page, 'display.cpp').click();
  const text = before.files!.find((f) => f.path === 'display.cpp')!.text;
  await code(page).fill(text.replace('#include <LiquidCrystal_PCF8574.h>\n', ''));
  await expect(lib).toBeVisible();
  await expect(lib).not.toContainText('the code uses it');
  // Not used by the code any more: the user may remove it; it stays removed.
  await lib.getByTestId('library-unpin').click();
  await expect(lib).toHaveCount(0);
  await expect(page.getByTestId('code-libraries-count')).toHaveText(/0/);
});

test('reload and export/import keep every file and library exactly; Hebrew keeps file names left-to-right', async ({
  page,
}) => {
  await openExample(page, 'mpy-lcd-library');
  const doc = await storedProject(page);
  expect(doc.programs.U1!.files!.map((f) => f.path)).toEqual(['display.py']);
  await page.reload();
  await reopenFromLibrary(page, doc.projectId);
  expect((await storedProject(page)).programs).toEqual(doc.programs);
  const download = await exportFromMenu(page);
  const text = await (
    await download.createReadStream()
  )
    .toArray()
    .then((c) => Buffer.concat(c).toString('utf8'));
  const pkg = parsePackage(text);
  expect(pkg.ok).toBe(true);
  if (!pkg.ok) return;
  expect(pkg.doc.programs).toEqual(doc.programs);
  await openImported(page, pkg.doc);
  await page.getByTestId('language-select').selectOption('he');
  await page.getByTestId('view-code').click();
  await expect(tab(page, 'display.py').locator('span').first()).toHaveAttribute('dir', 'ltr');
  await expect(page.getByTestId('code-libraries')).toContainText('ספריות מנוהלות');
  await expect(page.getByTestId('library-micropython.python-lcd')).toContainText('MIT');
  await page.screenshot({ path: test.info().outputPath('s26-he-libraries.png') });
});

test('tablet width: the file tabs and the libraries list stay usable', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openExample(page, 'esp32-lcd-library');
  await page.getByTestId('view-code').click();
  for (const p of ['sketch.ino', 'display.cpp', 'display.h'])
    await expect(tab(page, p)).toBeVisible();
  await tab(page, 'display.h').click();
  await expect(code(page)).toHaveAttribute('data-file', 'display.h');
  const box = await page.getByTestId('code-files').boundingBox();
  expect(box!.width).toBeLessThanOrEqual(1024);
  await page.screenshot({ path: test.info().outputPath('s26-tablet.png') });
});
