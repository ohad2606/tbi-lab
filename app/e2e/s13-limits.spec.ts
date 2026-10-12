/**
 * Sprint 13 H2 (Component Failure Framework) in the product: a part beyond its specified
 * OPERATING range (no published absolute maximum) gets the "outside specified operating
 * conditions" notice and the unreliable-result note, never the "may be damaged" warning or the
 * canvas damage marking. Localized (Hebrew).
 */
import { expect, test } from '@playwright/test';
import {
  addComponent,
  addWire,
  createProject,
  setParam,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { component, openImported } from './helpers.js';

/** PSU (7 V) → buzzer → GND: above the CEM-1205's 3-6 V operating range. */
function buzzerAt(volts: number): ProjectDocument {
  let doc = createProject({
    projectId: 'prj_s13limits',
    deviceId: 'd',
    name: 'Buzzer 7 V',
    appVersion: '0',
  });
  const add = (type: Parameters<typeof addComponent>[1], x: number, y: number) => {
    const r = addComponent(doc, type, { x, y });
    if (!r.ok) throw new Error(type);
    doc = r.doc;
    return r.id;
  };
  const psu = add('instrument.lab_psu', 100, 200);
  const bz = add('component.buzzer', 400, 200);
  const gnd = add('component.ground', 400, 400);
  for (const [a, at, b, bt] of [
    [psu, 'positive', bz, 'positive'],
    [bz, 'negative', gnd, 'ref'],
    [psu, 'negative', gnd, 'ref'],
  ] as const) {
    const w = addWire(
      doc,
      { kind: 'terminal', component: a, terminal: at },
      { kind: 'terminal', component: b, terminal: bt },
    );
    if (!w.ok) throw new Error(`${a}.${at}`);
    doc = w.doc;
  }
  for (const [key, value] of [
    ['setpointVoltage', { value: volts, unit: 'volt' }],
    ['outputEnabled', true],
  ] as const) {
    const r = setParam(doc, psu, key, value);
    if (!r.ok) throw new Error(key);
    doc = r.doc;
  }
  return doc;
}

test('above the operating range: an operating notice and an unreliable result, no damage warning', async ({
  page,
}) => {
  await openImported(page, buzzerAt(7));
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  const notice = page.getByTestId('operating-warning');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Outside specified operating conditions');
  await expect(notice).toContainText('specified operating maximum');
  await expect(page.getByTestId('rating-warning')).toHaveCount(0); // no damage claim
  const bz = component(page, 'BZ1');
  await expect(bz).not.toHaveAttribute('data-overstressed', 'true');
  await bz.locator('.component-hit').click({ force: true });
  await expect(page.getByTestId('result-rating').locator('[data-kind="operating"]')).toBeVisible();
  await expect(page.getByTestId('result-outside-model')).toBeVisible();

  await page.getByTestId('language-select').selectOption('he');
  await expect(notice).toContainText('מחוץ לתנאי ההפעלה המוגדרים');
  await page.getByTestId('language-select').selectOption('en');
});

test('inside the operating range: no notice at all', async ({ page }) => {
  await openImported(page, buzzerAt(5));
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('operating-warning')).toHaveCount(0);
  await expect(page.getByTestId('rating-warning')).toHaveCount(0);
});
