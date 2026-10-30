/**
 * Sprint 13 (alpha hardening, H6 project persistence): a user-controlled backup restores a
 * project end to end on the real stack. In one browser profile: open an R2 example, change a part
 * parameter and the Arduino source, export the `.tbilab` package. In a second, empty profile (a new
 * machine): import it, check that every part, parameter and source byte is identical, Build and
 * Run on real QEMU, and get the same firmware-visible result. The restored project survives a
 * reload; a tampered package is refused with a notice, nothing written.
 *
 * Skipped unless TBI_S12_REAL=1 (needs the real build service, Session Host and Runtime v2, as
 * s12-real.spec.ts, through TBI_RUNTIME_PROXY / TBI_BUILD_PROXY).
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { parsePackage } from '@tbi-lab/domain';
import {
  component,
  exportFromMenu,
  goToProjects,
  reopenFromLibrary,
  storedProjects,
  waitSaved,
} from './helpers.js';

test.skip(!process.env.TBI_S12_REAL, 'heavy: needs the real Session Host + QEMU (TBI_S12_REAL=1)');
test.describe.configure({ mode: 'serial' });

const status = (page: Page) => page.getByTestId('sim-status');
const select = (page: Page, id: string) =>
  component(page, id).locator('.component-hit').click({ force: true });
const MARK = '// TBI-S13 backup round trip: this line must survive export and import\n';

async function buildAndRun(page: Page) {
  await page.getByTestId('view-code').click();
  await page.getByTestId('build-button').click();
  await expect(page.getByTestId('build-phase')).toHaveAttribute('data-phase', 'current', {
    timeout: 300_000,
  });
  await page.getByTestId('view-circuit').click();
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 90_000 });
  await expect(status(page)).toHaveAttribute('data-engine', 'mcu');
}

test('export, import into an empty browser, restore, build and run: identical project, same result', async ({
  browser,
}, info) => {
  // --- Machine A: edit and export ---------------------------------------------------------
  const a = await browser.newContext();
  const pa = await a.newPage();
  await pa.goto('/');
  await expect(pa.getByTestId('example-list').or(pa.getByTestId('canvas'))).toBeVisible();
  if (!(await pa.getByTestId('example-list').isVisible())) await goToProjects(pa);
  await pa.getByTestId('open-example-esp32-distance-alarm').click();
  await expect(pa.getByTestId('canvas')).toBeVisible();
  await select(pa, 'U2');
  const field = pa.getByTestId('param-U2-distance');
  await field.fill('30'); // Phase 1 units: 0.5 m shows as 50 cm; 30 cm = 0.3 m
  await field.press('Enter');
  await pa.getByTestId('view-code').click();
  const code = pa.getByTestId('code-text');
  const original = await code.inputValue();
  await code.fill(MARK + original);
  await pa.getByTestId('view-circuit').click();
  await waitSaved(pa);
  const [docA] = (await storedProjects(pa)).filter((d) => d.name.length > 0).slice(-1);
  expect(docA).toBeDefined();
  const download = await exportFromMenu(pa);
  const path = info.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  const text = readFileSync(path, 'utf8');
  const parsed = parsePackage(text);
  expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  await a.close();

  // --- Machine B: empty storage, import ---------------------------------------------------
  const b = await browser.newContext();
  const pb = await b.newPage();
  await pb.goto('/');
  await expect(pb.getByTestId('example-list').or(pb.getByTestId('canvas'))).toBeVisible();
  if (!(await pb.getByTestId('example-list').isVisible())) await goToProjects(pb);
  expect(await storedProjects(pb)).toHaveLength(0);
  await pb.getByTestId('import-file').setInputFiles(path);
  await expect(pb.getByTestId('canvas')).toBeVisible();
  await waitSaved(pb);
  const restored = await storedProjects(pb);
  expect(restored).toHaveLength(1);
  // Every engineering byte identical: components, parameters, nets, layout, programs.
  const strip = (d: Record<string, unknown>) => {
    const { revision: _r, updatedAt: _u, ...rest } = d as Record<string, unknown>;
    return rest;
  };
  expect(strip(restored[0] as unknown as Record<string, unknown>)).toEqual(
    strip(docA as unknown as Record<string, unknown>),
  );
  await pb.getByTestId('view-code').click();
  expect(await pb.getByTestId('code-text').inputValue()).toBe(MARK + original);
  await pb.getByTestId('view-circuit').click();
  await select(pb, 'U2');
  await expect(pb.getByTestId('param-U2-distance')).toHaveValue('30');

  // Same firmware-visible result: 0.3 m at 20 degC -> about 30 cm; LED off (> 20 cm).
  await buildAndRun(pb);
  await select(pb, 'U1');
  await expect(pb.getByTestId('mcu-serial-output')).toContainText(/Distance: 30\.\d cm/, {
    timeout: 90_000,
  });
  await expect(pb.getByTestId('pin-level-2')).toHaveAttribute('data-level', '0');
  await pb.screenshot({ path: info.outputPath('s13-restored-running.png') });
  await pb.getByTestId('sim-stop').click();
  await expect(status(pb)).toHaveAttribute('data-status', 'stopped', { timeout: 60_000 });

  // The restored project is durable: reload, reopen, same document.
  await pb.reload();
  await reopenFromLibrary(pb);
  expect(strip((await storedProjects(pb))[0] as unknown as Record<string, unknown>)).toEqual(
    strip(docA as unknown as Record<string, unknown>),
  );

  // A tampered package (one parameter changed, hash not) is refused; nothing is written.
  await goToProjects(pb);
  const tampered = text.replace(/"0\.3"|0\.3\b/, '0.31');
  expect(tampered).not.toBe(text);
  await pb.getByTestId('import-file').setInputFiles({
    name: 'tampered.tbilab',
    mimeType: 'application/json',
    buffer: Buffer.from(tampered),
  });
  await expect(pb.getByTestId('notice')).toBeVisible();
  expect(await storedProjects(pb)).toHaveLength(1);
  await b.close();
});
