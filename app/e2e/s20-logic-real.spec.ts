/**
 * Sprint 20 (logic) HEAVY acceptance (staging gate, run by the integrator): the ESP32 logic
 * examples in the product UI through a REAL build service, Session Host and QEMU runtime, with
 * TBI_RUNTIME_PROXY / TBI_BUILD_PROXY pointing at the real backends (setup as
 * s15-r4-real.spec.ts / s19b-real.spec.ts). Skipped unless TBI_S20L_REAL=1 (routine CI has no
 * QEMU; this file was NOT run by the logic agent).
 *
 * - C `esp32-logic-quad-and`: Sprint 21, refused by name at 3.0 V (the SN74LVC08A input leakage
 *   is specified only at 3.6 V; owner question S21-Q2); the panel marks 1A "not guaranteed";
 * - D `esp32-logic-override`: Sprint 22 (owner decision Q1, strict) — refused by name at once: input
 *   A is never at 5.5 V or exactly GND (the I_CC test condition, SCES217AA §5.5), so the supply's
 *   current limit is not guaranteed (logic_supply_current_uncharacterized);
 * - D with the gate supply at 4.5 V: likewise refused at once (before setup() A is ≈ 50 mV off GND).
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { setParam, type ProjectDocument } from '@tbi-lab/domain';
import { buildProgram, component, goToProjects, openImported, waitSaved } from './helpers.js';

test.setTimeout(420_000);
test.skip(!process.env.TBI_S20L_REAL, 'heavy: needs the real stack (TBI_S20L_REAL=1)');
test.describe.configure({ mode: 'serial' });

const select = (page: Page, id: string) =>
  component(page, id).locator('.component-hit').click({ force: true });

async function openExample(page: Page, id: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}

test('C on the real runtime (Sprint 21): refused by name at 3.0 V — SN74LVC08A input leakage specified only at 3.6 V', async ({
  page,
}, info) => {
  await openExample(page, 'esp32-logic-quad-and');
  await buildProgram(page, 300_000);
  await page.getByTestId('sim-run').click();
  // The session starts with every pad an input: 1A is held by its 10 kΩ pull-down, a non-zero
  // resistance, and at 3.0 V the 08A's I_I has no datasheet bound (owner question S21-Q2).
  const err = page.getByTestId('sim-error');
  await expect(err).toContainText(/input\W+1A\W+is held through a resistance/, { timeout: 90_000 });
  await expect(err).toContainText('V_CC = 3.6 V');
  await select(page, 'U2');
  await expect(page.getByTestId('logic-level-a1')).toHaveText('not guaranteed');
  await page.screenshot({ path: info.outputPath('s21l-real-c-refused.png') });
});

test('D on the real runtime (Sprint 22 Q1 strict): refused by name at once — input A is never at 5.5 V or exactly GND, so the supply current limit is not guaranteed', async ({
  page,
}, info) => {
  await openExample(page, 'esp32-logic-override');
  await buildProgram(page, 300_000);
  await page.getByTestId('sim-run').click();
  // Before setup() GPIO18 is an input: A sits on its 10 kΩ pull-down, ≈ 50 mV off GND (I_I × R);
  // afterwards GPIO18's LOW is guaranteed only ≤ 0.33 V and its HIGH never reaches 5.5 V.
  const err = page.getByTestId('sim-error');
  await expect(err).toHaveAttribute('data-code', 'logic_supply_current_uncharacterized', {
    timeout: 120_000,
  });
  await expect(err).toContainText('current limit');
  await expect(err).toContainText('V_I = 5.5 V or GND');
  await select(page, 'U2');
  await expect(page.getByTestId('logic-level-y')).toHaveText('not simulated');
  await page.screenshot({ path: info.outputPath('s21l-real-d-refused.png') });
});

/** Example D with the gate supply at 4.5 V (V_IH = 0.7 × 4.5 = 3.15 V > the ESP32's 2.64 V). */
function overrideAt45(): ProjectDocument {
  const d = JSON.parse(
    readFileSync(
      new URL('../src/examples/data/esp32-logic-override.json', import.meta.url),
      'utf8',
    ),
  ) as ProjectDocument;
  const r = setParam(
    { ...d, projectId: 'prj_s21lOverride45', name: 'Override 4.5 V' },
    'PSU1',
    'setpointVoltage',
    { value: 4.5, unit: 'volt' },
  );
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

test('D with the gate at 4.5 V on the real runtime (Sprint 22 Q1 strict): refused at once by the supply current limit (input A ≈ 50 mV off GND before setup())', async ({
  page,
}, info) => {
  await openImported(page, overrideAt45());
  await waitSaved(page);
  await buildProgram(page, 300_000);
  await page.getByTestId('sim-run').click();
  const err = page.getByTestId('sim-error');
  await expect(err).toHaveAttribute('data-code', 'logic_supply_current_uncharacterized', {
    timeout: 120_000,
  });
  await expect(err).toContainText('current limit');
  await page.screenshot({ path: info.outputPath('s21l-real-d45-refused.png') });
});
