/**
 * Captures the landing-page screenshots from built-in example projects (static, not running).
 * Usage (take the pipeline lock first):
 *   npm run build --workspace @tbi-lab/app
 *   npx vite preview --config app/vite.config.ts ... (or any server) then
 *   node site/scripts/capture-screenshots.mjs http://127.0.0.1:4173
 * For the capability-aware palette, serve the app with TBI_RUNTIME_PROXY pointing at the fake session host
 * (app/e2e/fixtures/fake-session-host.ts, PORT=7499) and TBI_TEST_GATE=1, as playwright.app.config.ts does.
 * Output: site/images/*.png (1280x800). No sign-in, no tester data: examples are bundled in the app.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:4173';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'images');
mkdirSync(out, { recursive: true });

const SHOTS = [
  { example: 'esp32-distance-alarm', view: 'circuit', file: 'distance-alarm-circuit.png' },
  { example: 'esp32-lcd-hello', view: 'view-schematic', file: 'lcd-hello-schematic.png' },
  { example: 'esp32-distance-alarm', view: 'view-3d', file: 'distance-alarm-3d.png' },
];

const browser = await chromium.launch();
for (const lang of ['en']) {
  for (const s of SHOTS) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: lang,
    });
    const page = await ctx.newPage();
    await page.goto(base + '/');
    const library = page.getByTestId('example-list');
    const canvas = page.getByTestId('canvas');
    await library.or(canvas).first().waitFor();
    if (!(await library.isVisible())) {
      await page.getByTestId('app-menu-button').click();
      await page.getByTestId('menu-projects').click();
    }
    await page.getByTestId(`open-example-${s.example}`).click();
    await canvas.waitFor();
    if (s.view !== 'circuit') await page.getByTestId(s.view).click();
    if (s.view === 'view-3d')
      await page
        .getByTestId('view3d')
        .and(page.locator('[data-status="ready"]'))
        .waitFor({ timeout: 60_000 });
    // The capture server has no runtime, so the palette shows 'runtime not available' notes that do not
    // describe the product. Hide only those notes (disclosed in the slice report).
    await page.addStyleTag({ content: '.palette-unavailable{display:none!important}' });
    await page.waitForTimeout(800);
    // Crop the 24px page footer (credits, contact, build id): not part of the product view.
    await page.screenshot({
      path: join(out, s.file),
      clip: { x: 0, y: 0, width: 1280, height: 776 },
    });
    console.log('wrote', s.file);
    await ctx.close();
  }
}
await browser.close();
