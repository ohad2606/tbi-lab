/**
 * Sprint 13 staging acceptance (B3/B4), on the real stack (real build service, Session Host and
 * QEMU Runtime v2 through TBI_RUNTIME_PROXY / TBI_BUILD_PROXY):
 * - OS-09: the LCD example with the module's VCC and SDA wires swapped: the module stays dark and
 *   the runtime names the miswiring (GPIO21, SDA, the module's VCC pin); the LCD's SDA input above
 *   its published absolute maximum is a rating row;
 * - P4: a sketch selecting the pad drive strength is reported by the real build as unsupported,
 *   and Run is refused naming it.
 * Skipped unless TBI_S12_REAL=1.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  addWire,
  deleteSelection,
  emptySelection,
  setProgramText,
  type ProjectDocument,
  type WireTarget,
} from '@tbi-lab/domain';
import { buildProgram, openImported } from './helpers.js';

test.skip(!process.env.TBI_S12_REAL, 'heavy: needs the real Session Host + QEMU (TBI_S12_REAL=1)');
test.describe.configure({ mode: 'serial' });

const status = (page: Page) => page.getByTestId('sim-status');
const lcdExample = () =>
  JSON.parse(
    readFileSync(new URL('../src/examples/data/esp32-lcd-hello.json', import.meta.url), 'utf8'),
  ) as ProjectDocument;
const at = (component: string, terminal: string): WireTarget => ({
  kind: 'terminal',
  component,
  terminal,
});

/** The example with DS1's VCC and SDA wires exchanged (supply on SDA, SDA line on VCC). */
function vccSdaSwapped(): ProjectDocument {
  let doc = lcdExample();
  const ends = (w: ProjectDocument['layout']['wires'][number], c: string, t: string) =>
    [w.from, w.to].some((e) => e.kind === 'terminal' && e.component === c && e.terminal === t);
  const supply = doc.layout.wires.find((w) => ends(w, 'DS1', 'vcc'))!;
  const line = doc.layout.wires.find((w) => ends(w, 'DS1', 'sda'))!;
  const del = deleteSelection(doc, { ...emptySelection(), wires: [supply.id, line.id] });
  if (!del.ok) throw new Error(del.error);
  doc = del.doc;
  for (const [from, to] of [
    [at('PSU1', 'positive'), at('DS1', 'sda')],
    // The SDA line (GPIO21, its pull-up R1) to the module's VCC pin: R1.b is on that line.
    [at('R1', 'b'), at('DS1', 'vcc')],
  ] as const) {
    const r = addWire(doc, from, to);
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
  }
  return { ...doc, name: 'LCD VCC/SDA swapped' };
}

async function buildAndRun(page: Page) {
  await page.getByTestId('view-code').click();
  await buildProgram(page, 180_000);
  await page.getByTestId('view-circuit').click();
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 90_000 });
}

test('OS-09 on staging: LCD VCC and SDA swapped — dark, the miswiring named, SDA above its absolute maximum', async ({
  page,
}) => {
  await openImported(page, vccSdaSwapped());
  await buildAndRun(page);
  await page.locator('[data-hit="component"][data-id="U1"]').focus();
  const warning = page.getByTestId('mcu-warnings').locator('li[data-code="i2c_wiring"]');
  await expect(warning).toBeVisible({ timeout: 60_000 });
  const text = (await warning.textContent()) ?? '';
  for (const token of ['DS1', 'GPIO21', 'SDA', 'VCC']) expect(text).toContain(token);
  // The LCD's rating row: SDA input above V_DD + 0.5 V (PCF8574 limiting value).
  const row = page.getByTestId('rating-DS1').locator('li[data-code="voltage"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText('SDA input');
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 60_000 });
});

test('P4 on staging: a sketch selecting the pad drive strength is reported unsupported; Run refused', async ({
  page,
}) => {
  const base = lcdExample();
  const r = setProgramText(
    base,
    'U1',
    '#include "driver/gpio.h"\nvoid setup() {\n  pinMode(5, OUTPUT);\n  gpio_set_drive_capability(GPIO_NUM_5, GPIO_DRIVE_CAP_3);\n  digitalWrite(5, HIGH);\n}\nvoid loop() { delay(1000); }\n',
  );
  if (!r.ok) throw new Error(r.error);
  await openImported(page, { ...r.doc, name: 'Drive strength' });
  await buildProgram(page, 180_000);
  await page.getByTestId('view-code').click();
  await expect(
    page.getByTestId('build-features').locator('li[data-feature="drive_strength"]'),
  ).toBeVisible();
  await page.getByTestId('view-circuit').click();
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-error')).toHaveAttribute(
    'data-code',
    'mcu_unsupported_features',
  );
  await expect(page.getByTestId('sim-error')).toContainText('pin drive strength selection');
});
