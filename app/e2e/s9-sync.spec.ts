/**
 * Sprint 9 (S9-M2/M3): the three views stay synchronized with the one project document — edits,
 * value changes, project switches, imports, old projects, export round trips and simulation —
 * with no refresh, no stale topology and no write caused by viewing.
 */
import { expect, test, type Page } from '@playwright/test';
import { CANONICALIZATION, canonicalJson, sha256Utf8, type ProjectDocument } from '@tbi-lab/domain';
import {
  component,
  exportFromMenu,
  goToProjects,
  openImported,
  storedProjects,
} from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

async function openExample(page: Page, id: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
}

const tab = (page: Page, v: string) => page.getByTestId(`view-${v}`);
const attr = (page: Page, sel: string, name: string) =>
  page
    .locator(sel)
    .getAttribute(name)
    .then((s) => (s ?? '').split(' ').filter(Boolean).sort());
const schematicParts = (page: Page) => attr(page, '.schematic', 'data-parts');
const sceneParts = (page: Page) => attr(page, '[data-testid=view3d]', 'data-components');
/** An example's document as the app stored it when opened (the most recently updated project). */
async function exampleDoc(page: Page, id: string): Promise<ProjectDocument> {
  await openExample(page, id);
  await expect.poll(async () => (await storedProjects(page)).length).toBeGreaterThan(0);
  const all = await storedProjects(page);
  all.sort((a, b) => b.revision.updatedAt.localeCompare(a.revision.updatedAt));
  return JSON.parse(JSON.stringify(all[0])) as ProjectDocument;
}
/** Every placed part of a document as the schematic lists it (grounds are marks, not parts). */
const drawnParts = (doc: ProjectDocument) =>
  doc.components
    .filter((c) => c.type !== 'component.ground' && c.type !== 'board.esp32_devkitc_wroom32')
    .map((c) => c.id)
    .sort();

async function show3d(page: Page) {
  await tab(page, '3d').click();
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready');
}

test('switching projects never shows the previous project in a generated view', async ({
  page,
}) => {
  await openExample(page, 'esp32-input-echo');
  await tab(page, 'schematic').click();
  await expect.poll(() => schematicParts(page)).toContain('SW2');
  await show3d(page);
  expect(await sceneParts(page)).toContain('U1');
  // Another project opens on its Circuit view; its Schematic and 3D hold only its own parts.
  await openExample(page, 'voltage-divider');
  await expect(tab(page, 'circuit')).toHaveAttribute('aria-selected', 'true');
  await tab(page, 'schematic').click();
  await expect.poll(() => schematicParts(page)).toEqual(['PSU1', 'R1', 'R2']);
  await show3d(page);
  await expect.poll(() => sceneParts(page)).toEqual(['GND1', 'GND2', 'PSU1', 'R1', 'R2']);
});

test('a value change shows in the schematic at once; the 3D scene is rebuilt from it', async ({
  page,
}) => {
  await openExample(page, 'voltage-divider');
  await tab(page, 'schematic').click();
  await expect(page.locator('[data-part="R1"] .sch-value')).toHaveText('10 kΩ');
  await page.locator('[data-part="R1"] .sch-hit').click();
  const field = page.getByTestId('param-R1-resistance');
  await field.fill('4.7k');
  await field.press('Enter');
  await expect(page.locator('[data-part="R1"] .sch-value')).toHaveText('4.7 kΩ');
  await show3d(page);
  expect(await sceneParts(page)).toContain('R1');
  // A rewire in the circuit (delete R2) is gone from both generated views without a refresh.
  await tab(page, 'circuit').click();
  await component(page, 'R2').locator('.component-hit').click();
  await page.keyboard.press('Delete');
  await tab(page, 'schematic').click();
  await expect.poll(() => schematicParts(page)).toEqual(['PSU1', 'R1']);
  await show3d(page);
  await expect.poll(() => sceneParts(page)).not.toContain('R2');
});

test('an imported project and an old (schema v2, package v1) project open in every view', async ({
  page,
}) => {
  // A current package.
  const current = await exampleDoc(page, 'diode-polarity');
  current.projectId = 'prj_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
  current.name = 'Imported diode polarity';
  await openImported(page, current);
  await tab(page, 'schematic').click();
  await expect.poll(() => schematicParts(page)).toEqual(drawnParts(current));
  await show3d(page);
  expect(await sceneParts(page)).toEqual(current.components.map((c) => c.id).sort());

  // An old package: format 1 carrying a schema v2 project (before programs), migrated on import.
  const v2 = (await exampleDoc(page, 'esp32-blink')) as unknown as Record<string, unknown> & {
    components: { id: string; type: string; params: Record<string, unknown> }[];
  };
  delete v2.programs;
  v2.schemaVersion = 2;
  v2.projectId = 'prj_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
  v2.name = 'Old blink';
  v2.components.find((c) => c.type === 'board.esp32_devkitc_wroom32')!.params.firmware = 'none';
  const v1 = {
    format: 'tbi-lab.package',
    formatVersion: 1,
    project: v2,
    source: null,
    firmware: null,
    toolchain: null,
    integrity: {
      algorithm: 'sha256',
      canonicalization: CANONICALIZATION,
      project: sha256Utf8(canonicalJson(v2)),
    },
    exported: { app: 'tbi-lab', appVersion: '0.1.0', exportedAt: '2026-09-26T00:00:00.000Z' },
  };
  await goToProjects(page);
  await page.getByTestId('import-file').setInputFiles({
    name: 'old.tbilab',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(v1), 'utf8'),
  });
  await expect(page.getByTestId('canvas')).toBeVisible();
  await tab(page, 'schematic').click();
  await expect.poll(() => attr(page, '.schematic', 'data-modules')).toEqual(['U1']);
  await expect(page.locator('.sch-pin-name')).toContainText(['IO2']);
  await show3d(page);
  expect(await sceneParts(page)).toEqual(v2.components.map((c) => c.id).sort());
  const stored = (await storedProjects(page)).find(
    (d) => d.projectId === 'prj_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
  )!;
  expect(stored.schemaVersion).toBe(3);
});

test('viewing Schematic and 3D changes nothing that export carries; the export re-imports alike', async ({
  page,
}) => {
  await openExample(page, 'push-button');
  const before = await (await exportFromMenu(page)).path().then((p) => readText(p));
  await tab(page, 'schematic').click();
  await page.locator('[data-part="R1"] .sch-hit').click();
  await show3d(page);
  await page.getByTestId('view3d-rotate-left').click();
  await page.getByTestId('view3d-fit').click();
  await tab(page, 'circuit').click();
  const after = await (await exportFromMenu(page)).path().then((p) => readText(p));
  const project = (t: string) => JSON.parse(t).project as ProjectDocument;
  expect(project(after)).toEqual(project(before));
  // Round trip: the exported package opens with the same generated views.
  const doc = project(after);
  doc.projectId = 'prj_c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
  await openImported(page, doc);
  await tab(page, 'schematic').click();
  await expect.poll(() => schematicParts(page)).toEqual(drawnParts(doc));
});

test('LED glow follows the run across view switches; Stop returns it to dark', async ({ page }) => {
  await openExample(page, 'led-current');
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  await show3d(page);
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-lit', 'D1');
  // Leave and return while running: a new renderer, the same live state.
  await tab(page, 'schematic').click();
  await tab(page, 'circuit').click();
  await show3d(page);
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-lit', 'D1');
  // Stop while the 3D view is open: dark again, at once.
  await page.getByTestId('sim-stop').click();
  await expect(page.getByTestId('sim-status')).not.toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-lit', '');
  // And a fresh 3D view after the stop is dark too.
  await tab(page, 'circuit').click();
  await show3d(page);
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-lit', '');
});

test('Circuit → Schematic → 3D → Code → Circuit, in English and Hebrew, keeps code and identifiers LTR', async ({
  page,
}) => {
  await openExample(page, 'esp32-input-echo');
  for (const locale of ['en', 'he']) {
    await page.getByTestId('language-select').selectOption(locale);
    await tab(page, 'schematic').click();
    await expect(page.getByTestId('schematic-view')).toHaveAttribute('dir', 'ltr');
    await show3d(page);
    await tab(page, 'code').click();
    const code = page.getByTestId('code-text');
    await expect(code).toBeVisible();
    expect(await code.evaluate((e) => getComputedStyle(e).direction)).toBe('ltr');
    expect(await code.inputValue()).toMatch(/void\s+setup/);
    await tab(page, 'circuit').click();
    await expect(page.getByTestId('canvas')).toBeVisible();
  }
  // Hebrew UI, technical identifiers untouched.
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await tab(page, 'schematic').click();
  await expect(page.locator('.sch-pin-name')).toContainText(['IO34', 'IO4']);
  for (const v of await page.locator('.sch-value').allTextContents())
    expect(v).toMatch(/^[\d.]+ (k?Ω|V)$/); // numbers and units, never mirrored
});

async function readText(path: string | null): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path!, 'utf8');
}
