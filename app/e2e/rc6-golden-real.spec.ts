/**
 * Alpha Convergence RC: the complete tester workflow on the real stack, once per locale, against the
 * feedback build (:4176): identity from the gate → example → edit a part → Build → Run → a live
 * parameter changes the result → Stop → save and reopen → export → a run refused by name, with its
 * explanation → the exported project opened in a NEW browser profile in the OTHER locale is the same
 * project → feedback sent, stored by the real Session Host and read by the owner.
 *
 * Skipped unless TBI_RC6_REAL=1. Needs the build service and Session Host (reports mode) behind
 * TBI_BUILD_PROXY and TBI_FEEDBACK_RUNTIME_PROXY, with TBI_RC6_OWNER set to the test subject of the
 * instance's owner reference file. The gate is played by the test proxy: real Google sign-in is
 * not exercised here.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  component,
  exportFromMenu,
  goToProjects,
  reopenFromLibrary,
  storedProject,
  storedProjects,
  waitSaved,
} from './helpers.js';

test.skip(!process.env.TBI_RC6_REAL, 'heavy: needs the real stack (TBI_RC6_REAL=1)');
test.describe.configure({ mode: 'serial' });
test.setTimeout(900_000);

const BASE = 'http://127.0.0.1:4176';
const OWNER = process.env.TBI_RC6_OWNER ?? 'e2e-owner';
const T = (p: Page, id: string) => p.getByTestId(id);
const select = (p: Page, id: string) =>
  component(p, id).locator('.component-hit').click({ force: true });

async function freshPage(browser: Browser, locale: 'en' | 'he') {
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.goto('/');
  await expect(T(page, 'example-list').or(T(page, 'canvas'))).toBeVisible();
  if (!(await T(page, 'example-list').isVisible())) await goToProjects(page);
  await T(page, 'language-select').selectOption(locale);
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'he' ? 'rtl' : 'ltr');
  return { ctx, page };
}

async function buildAndRun(page: Page) {
  await T(page, 'view-code').click();
  await expect(T(page, 'code-text')).toHaveAttribute('dir', 'ltr');
  await T(page, 'build-button').click();
  await expect(T(page, 'build-phase')).toHaveAttribute('data-phase', 'current', {
    timeout: 300_000,
  });
  await T(page, 'view-circuit').click();
  await T(page, 'sim-run').click();
}

async function running(page: Page) {
  const status = T(page, 'sim-status');
  await expect(status).toHaveAttribute('data-status', 'running', { timeout: 120_000 });
  await expect(status).toHaveAttribute('data-engine', 'mcu');
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
  test(`golden path in ${locale}, reopened in ${other}`, async ({ browser }, info) => {
    const a = await freshPage(browser, locale);
    const p = a.page;

    // Example, edit, Build, Run, a supported live interaction, Stop.
    await T(p, 'open-example-esp32-distance-alarm').click();
    await expect(T(p, 'canvas')).toBeVisible();
    await select(p, 'U2');
    const distance = T(p, 'param-U2-distance');
    await distance.fill('0.3');
    await distance.press('Enter');
    await buildAndRun(p);
    await running(p);
    await select(p, 'U1');
    const serial = T(p, 'mcu-serial-output');
    await expect(serial).toContainText(/Distance: 30\.\d cm/, { timeout: 90_000 });
    expect(await serial.evaluate((e) => getComputedStyle(e).direction)).toBe('ltr');
    await expect(T(p, 'pin-level-2')).toHaveAttribute('data-level', '0');
    await select(p, 'U2');
    await distance.fill('0.1');
    await distance.press('Enter');
    await expect(T(p, 'pin-level-2')).toHaveAttribute('data-level', '1', { timeout: 30_000 });
    await p.screenshot({ path: info.outputPath(`golden-${locale}-running.png`) });
    await stop(p);

    // Save and reopen: the edit is there and nothing else moved.
    await waitSaved(p);
    const saved = await storedProject(p);
    await goToProjects(p);
    await reopenFromLibrary(p, saved.projectId);
    const reopened = (await storedProjects(p)).find((d) => d.projectId === saved.projectId)!;
    expect(reopened.components).toEqual(saved.components);
    expect(reopened.connections).toEqual(saved.connections);
    expect(reopened.programs).toEqual(saved.programs);

    // Export.
    const download = await exportFromMenu(p);
    const file = info.outputPath(download.suggestedFilename());
    await download.saveAs(file);

    // A run refused by name: the reason is on screen, in this language, naming the pin.
    await goToProjects(p);
    await T(p, 'open-example-esp32-logic-override').click();
    await expect(T(p, 'canvas')).toBeVisible();
    await waitSaved(p);
    await buildAndRun(p);
    const err = T(p, 'sim-error');
    await expect(err).toHaveAttribute('data-code', 'logic_mcu_input_not_guaranteed', {
      timeout: 180_000,
    });
    await expect(err).toContainText('GPIO19');
    expect((await err.textContent())!).not.toContain('logic_mcu_input_not_guaranteed');
    if (locale === 'he') await expect(err).toContainText(/[֐-׿]/);
    await p.screenshot({ path: info.outputPath(`golden-${locale}-refused.png`) });
    await a.ctx.close();

    // A new browser profile, the other language: the same project, the same result.
    const b = await freshPage(browser, other);
    const q = b.page;
    await T(q, 'import-file').setInputFiles({
      name: 'golden.tbilab',
      mimeType: 'application/json',
      buffer: readFileSync(file),
    });
    await expect(T(q, 'canvas')).toBeVisible();
    const copy = await storedProject(q);
    expect(copy.components).toEqual(saved.components);
    expect(copy.connections).toEqual(saved.connections);
    expect(copy.programs).toEqual(saved.programs);
    await buildAndRun(q);
    await running(q);
    await select(q, 'U1');
    await expect(T(q, 'mcu-serial-output')).toContainText(/Distance: 10\.\d cm/, {
      timeout: 90_000,
    });
    await expect(T(q, 'pin-level-2')).toHaveAttribute('data-level', '1');
    await stop(q);

    // Feedback: the form in this language, stored by the real Session Host, read by the owner.
    await T(q, 'feedback-button').click();
    await expect(T(q, 'report-dialog')).toHaveAttribute('dir', other === 'he' ? 'rtl' : 'ltr');
    await T(q, 'report-kind-feature').check();
    const text = `RC6 golden path ${other} ${info.testId}`;
    await T(q, 'report-description').fill(text);
    await T(q, 'report-send').click();
    await expect(T(q, 'report-sent')).toBeVisible({ timeout: 30_000 });
    const id = (await T(q, 'report-id').textContent())!.trim();
    await expect(T(q, 'admin-button')).toHaveCount(0);
    await b.ctx.close();

    const owner = await browser.newContext({ baseURL: BASE });
    await owner.addCookies([{ name: 'tbi_test_user', value: OWNER, url: BASE }]);
    const o = await owner.newPage();
    await o.goto('/');
    await T(o, 'admin-button').click();
    // The list shows no report text or id (by design); the newest report's detail shows this text.
    const rows = T(o, 'admin-reports').locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    await rows.first().getByRole('button').click();
    await expect(T(o, 'admin-report-text')).toHaveText(text);
    await expect(T(o, 'admin-dialog')).toContainText(id);
    await owner.close();
  });
}
