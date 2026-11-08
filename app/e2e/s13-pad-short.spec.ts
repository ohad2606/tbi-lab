/**
 * Sprint 13 P2/P3 in the product: an ESP32 output wired straight to GND. The board's code is the
 * TbiGpioProof sketch (built by the CI build service to its stand-in image, which the CI Session
 * Host runs as the scripted gpio-proof MCU on the REAL engine): it drives GPIO2 HIGH and LOW. While HIGH, the warning names the short to GND, but the current is shown as NOT
 * KNOWN (beyond the characterized range): the driver model's 0.2 A extrapolation is never shown
 * as a value (and before P3 the pad reported 0 A). Localized (Hebrew).
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  addComponent,
  addWire,
  createProject,
  setProgramText,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { buildProgram, openImported } from './helpers.js';

const SKETCH = readFileSync(
  new URL('../../runtime/firmware/arduino/TbiGpioProof/TbiGpioProof.ino', import.meta.url),
  'utf8',
);

function shortedPad(): ProjectDocument {
  let doc = createProject({
    projectId: 'prj_s13short',
    deviceId: 'd',
    name: 'GPIO2 to GND',
    appVersion: '0',
  });
  const board = addComponent(doc, 'board.esp32_devkitc_wroom32', { x: 400, y: 400 });
  if (!board.ok) throw new Error('board');
  doc = board.doc;
  const gnd = addComponent(doc, 'component.ground', { x: 700, y: 700 });
  if (!gnd.ok) throw new Error('gnd');
  doc = gnd.doc;
  for (const t of ['gnd', 'gpio2']) {
    const w = addWire(
      doc,
      { kind: 'terminal', component: board.id, terminal: t },
      { kind: 'terminal', component: gnd.id, terminal: 'ref' },
    );
    if (!w.ok) throw new Error(t);
    doc = w.doc;
  }
  const r = setProgramText(doc, board.id, SKETCH);
  if (!r.ok) throw new Error('program');
  return r.doc;
}

for (const lang of ['en', 'he'])
  test(`GPIO2 HIGH on GND: the short is named, its current is not shown as a value (${lang})`, async ({
    page,
  }) => {
    await openImported(page, shortedPad());
    if (lang !== 'en') await page.getByTestId('language-select').selectOption(lang);
    await page.getByTestId('view-code').click();
    await buildProgram(page);
    await page.getByTestId('view-circuit').click();
    await page.getByTestId('sim-run').click();
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running', {
      timeout: 60_000,
    });
    const row = page.locator('[data-code="gpio_short_ground"]');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveAttribute('data-unreliable', 'true');
    const text = (await row.textContent()) ?? '';
    expect(text).toContain('IO2');
    expect(text).toContain(lang === 'en' ? 'current not known' : 'זרם לא ידוע');
    // Neither the extrapolated 200 mA nor a false 0 A appears as the current.
    expect(text).not.toMatch(/\b200\s?mA|0[.,]2\s?A|\b0\s?A\b/);
    await expect(page.getByTestId('unrated-note')).toBeVisible();
    await page.getByTestId('sim-stop').click();
    if (lang !== 'en') await page.getByTestId('language-select').selectOption('en');
  });
