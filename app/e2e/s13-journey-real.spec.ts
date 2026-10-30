/**
 * Sprint 13 H3: the alpha acceptance journey, end to end on the real stack, once per locale:
 * first visit → example → edit a part → Build → Run → a live parameter changes the result → Stop →
 * export → the project opened in a NEW browser profile in the OTHER locale is the same project and
 * gives the same result → the capability panel explains a refusal. Language never changes the
 * circuit, the firmware or a result (CLAUDE.md: one project, any language, same electrical truth).
 *
 * Skipped unless TBI_S12_REAL=1 (real build service, Session Host, Runtime v2 through
 * TBI_RUNTIME_PROXY / TBI_BUILD_PROXY, as s12-real.spec.ts).
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { component, exportFromMenu, goToProjects, openAppMenu, storedProjects } from './helpers.js';

test.skip(!process.env.TBI_S12_REAL, 'heavy: needs the real Session Host + QEMU (TBI_S12_REAL=1)');
test.describe.configure({ mode: 'serial' });

const T = (p: Page, id: string) => p.getByTestId(id);
const select = (p: Page, id: string) =>
  component(p, id).locator('.component-hit').click({ force: true });

async function freshPage(browser: Browser, locale: 'en' | 'he') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(T(page, 'example-list').or(T(page, 'canvas'))).toBeVisible();
  if (!(await T(page, 'example-list').isVisible())) await goToProjects(page);
  await T(page, 'language-select').selectOption(locale);
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'he' ? 'rtl' : 'ltr');
  return { ctx, page };
}

async function buildAndRun(page: Page) {
  await T(page, 'view-code').click();
  // Firmware source is always left-to-right, whatever the UI language.
  await expect(T(page, 'code-text')).toHaveAttribute('dir', 'ltr');
  await T(page, 'build-button').click();
  await expect(T(page, 'build-phase')).toHaveAttribute('data-phase', 'current', {
    timeout: 300_000,
  });
  await T(page, 'view-circuit').click();
  await T(page, 'sim-run').click();
  await expect(T(page, 'sim-status')).toHaveAttribute('data-status', 'running', {
    timeout: 90_000,
  });
  await expect(T(page, 'sim-status')).toHaveAttribute('data-engine', 'mcu');
}

async function stop(page: Page) {
  await T(page, 'sim-stop').click();
  await expect(T(page, 'sim-status')).toHaveAttribute('data-status', 'stopped', {
    timeout: 60_000,
  });
}

for (const [locale, other] of [
  ['en', 'he'],
  ['he', 'en'],
] as const) {
  test(`journey in ${locale}, reopened in ${other}: same project, same result`, async ({
    browser,
  }, info) => {
    // First visit, example, edit (stopped: a structural value), Build, Run.
    const a = await freshPage(browser, locale);
    const p = a.page;
    await T(p, 'open-example-esp32-distance-alarm').click();
    await expect(T(p, 'canvas')).toBeVisible();
    await select(p, 'U2');
    const distance = T(p, 'param-U2-distance');
    await distance.fill('0.3');
    await distance.press('Enter');
    await buildAndRun(p);
    await select(p, 'U1');
    const serial = T(p, 'mcu-serial-output');
    await expect(serial).toContainText(/Distance: 30\.\d cm/, { timeout: 90_000 });
    // Serial output is technical content: left-to-right in every locale.
    expect(await serial.evaluate((e) => getComputedStyle(e).direction)).toBe('ltr');
    await expect(T(p, 'pin-level-2')).toHaveAttribute('data-level', '0');
    // A live parameter changes the running result.
    await select(p, 'U2');
    await distance.fill('0.1');
    await distance.press('Enter');
    await expect(T(p, 'pin-level-2')).toHaveAttribute('data-level', '1', { timeout: 30_000 });
    await p.screenshot({ path: info.outputPath(`journey-${locale}-running.png`) });
    await stop(p);
    const [doc] = await storedProjects(p);
    // Export, then a new browser profile in the other language.
    const download = await exportFromMenu(p);
    const file = info.outputPath(download.suggestedFilename());
    await download.saveAs(file);
    await a.ctx.close();

    const b = await freshPage(browser, other);
    const q = b.page;
    await T(q, 'import-file').setInputFiles({
      name: 'journey.tbilab',
      mimeType: 'application/json',
      buffer: readFileSync(file),
    });
    await expect(T(q, 'canvas')).toBeVisible();
    const [copy] = await storedProjects(q);
    // Language-neutral project data: the same components, values, nets and firmware.
    expect(copy!.components).toEqual(doc!.components);
    expect(copy!.connections).toEqual(doc!.connections);
    expect(copy!.programs).toEqual(doc!.programs);
    // The same electrical truth in the other language: 0.1 m (as saved) lights the LED.
    await buildAndRun(q);
    await select(q, 'U1');
    await expect(T(q, 'mcu-serial-output')).toContainText(/Distance: 10\.\d cm/, {
      timeout: 90_000,
    });
    await expect(T(q, 'pin-level-2')).toHaveAttribute('data-level', '1');
    await stop(q);
    // A refusal is explained: the capacitor next to the board, and the panel's parts section.
    const note = T(q, 'palette-note-part_time_dependent');
    if (await note.count()) {
      await note.getByTestId('capabilities-link-parts').click();
      await expect(T(q, 'capabilities-dialog')).toHaveAttribute('data-section', 'parts');
      await expect(T(q, 'capabilities-dialog')).toHaveAttribute(
        'dir',
        other === 'he' ? 'rtl' : 'ltr',
      );
      await q.keyboard.press('Escape');
    } else {
      await openAppMenu(q);
      await T(q, 'menu-capabilities').click();
      await expect(T(q, 'capabilities-dialog')).toBeVisible();
      await q.keyboard.press('Escape');
    }
    await q.screenshot({ path: info.outputPath(`journey-${other}-reopened.png`) });
    await b.ctx.close();
  });
}
