/**
 * Alpha Convergence RC: rollback cannot silently damage a project. One browser profile on one origin
 * while the deployed frontend is swapped: Alpha line (schema v3) → this build (v7) → Alpha line →
 * this build. Projects written by this build stay byte-for-byte in IndexedDB, read-only by name
 * under the Alpha line, and the Alpha line refuses their export by name; a project this build never
 * opened stays v3 and editable there.
 *
 * Skipped unless TBI_RC6_ALPHA_DIST and TBI_RC6_RC_DIST name the two built frontends.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  component,
  createProject,
  exportFromMenu,
  goToProjects,
  reopenFromLibrary,
  storedProjects,
  waitSaved,
} from './helpers.js';

const ALPHA = process.env.TBI_RC6_ALPHA_DIST;
const RC = process.env.TBI_RC6_RC_DIST;
test.skip(!ALPHA || !RC, 'needs TBI_RC6_ALPHA_DIST and TBI_RC6_RC_DIST');
test.setTimeout(240_000);

const PORT = 4190;
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
let root = '';
let server: Server;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = normalize((req.url ?? '/').split('?')[0]!);
    let file = join(root, path);
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(path) || path.startsWith('/runtime') || path.startsWith('/build')) {
        res.writeHead(404).end();
        return;
      }
      file = join(root, 'index.html');
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
});
test.afterAll(() => server.close());

test('Alpha → RC → Alpha → RC keeps every project intact', async ({ browser }, info) => {
  const ctx = await browser.newContext({
    baseURL: `http://127.0.0.1:${PORT}`,
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const byName = async (name: string) => (await storedProjects(page)).find((d) => d.name === name)!;

  const toLibrary = async () => {
    await page.goto('/');
    const library = page.getByTestId('example-list');
    await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
    if (!(await library.isVisible())) await goToProjects(page);
  };

  // 1. The Alpha line writes two v3 projects.
  root = ALPHA!;
  await page.goto('/');
  await createProject(page, 'Kept on v3');
  await waitSaved(page);
  await goToProjects(page);
  await createProject(page, 'Moved to v7');
  await waitSaved(page);
  const keptV3 = await byName('Kept on v3');
  const moved0 = await byName('Moved to v7');
  expect(keptV3.schemaVersion).toBe(3);
  expect(moved0.schemaVersion).toBe(3);

  // 2. This build opens one and writes it (v7), and creates another (v7).
  root = RC!;
  await toLibrary();
  await reopenFromLibrary(page, moved0.projectId);
  await component(page, 'PSU1').locator('.component-hit').click();
  await page.keyboard.press('Delete');
  await expect
    .poll(async () => (await byName('Moved to v7')).schemaVersion, { timeout: 15_000 })
    .toBe(7);
  await waitSaved(page);
  const download = await exportFromMenu(page);
  const exported = info.outputPath(download.suggestedFilename());
  await download.saveAs(exported);
  await goToProjects(page);
  await createProject(page, 'Born on v7');
  await waitSaved(page);
  const snapshot = await storedProjects(page);
  const v7 = snapshot.filter((d) => d.schemaVersion === 7);
  expect(v7.map((d) => d.name).sort()).toEqual(['Born on v7', 'Moved to v7']);
  // The project this build never opened was not rewritten.
  expect(await byName('Kept on v3')).toEqual(keptV3);

  // 3. Rollback: the Alpha line lists them and opens v7 read-only; an edit changes nothing.
  root = ALPHA!;
  await toLibrary();
  for (const doc of v7) {
    await reopenFromLibrary(page, doc.projectId);
    await expect(page.getByTestId('readonly-banner')).toBeVisible();
    await expect(page.getByTestId('save-state')).toHaveCount(0);
    await expect(page.getByTestId('palette-component.resistor')).toBeDisabled();
    await page.keyboard.press('Delete');
    await page.waitForTimeout(800);
    await goToProjects(page);
  }
  expect(await storedProjects(page)).toEqual(snapshot);

  // The v7 export is refused by name and adds nothing.
  await page.getByTestId('import-file').setInputFiles({
    name: 'from-rc.tbi.json',
    mimeType: 'application/json',
    buffer: readFileSync(exported),
  });
  await expect(page.getByTestId('notice')).toHaveAttribute('data-key', 'import.error.newer');
  expect(await storedProjects(page)).toEqual(snapshot);

  // The v3 project stays editable under the Alpha line.
  await reopenFromLibrary(page, keptV3.projectId);
  await expect(page.getByTestId('readonly-banner')).toHaveCount(0);
  await expect(page.getByTestId('palette-component.resistor')).toBeEnabled();
  await goToProjects(page);

  // 4. Forward again: the v7 work is there and editable.
  root = RC!;
  await toLibrary();
  await reopenFromLibrary(page, moved0.projectId);
  await expect(page.getByTestId('readonly-banner')).toHaveCount(0);
  const back = await byName('Moved to v7');
  expect(back.components).toEqual(v7.find((d) => d.name === 'Moved to v7')!.components);
  expect(errors).toEqual([]);
  await ctx.close();
});
