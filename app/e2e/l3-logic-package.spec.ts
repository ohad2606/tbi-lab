/**
 * Exploration Foundation L3 (packaged logic) and L2 (state inspection) in the browser.
 *
 * - local simulation: an SN74LVC08A at 3.0 V, gate 1 from two closed switches lighting an LED,
 *   gate 2 LOW, and a single SN74LVC1G08 whose A is held at exactly V_IH (2.0 V) by a divider; the
 *   Inspector's logic panel shows each pin's level, measured voltage and why, a gate selector, and
 *   marks the truth-table rows the gates are in;
 * - the package's own input in the undefined band refuses the Run by name; in Hebrew the table follows RTL while pin names,
 *   voltages and H/L stay LTR;
 * - an unused gate left open refuses the Run, naming the pin and the datasheet requirement;
 * - the `esp32-logic-quad-and` example through the real R2 client against the fake Session Host:
 *   Sprint 21, refused at 3.0 V by name (the SN74LVC08A input leakage is specified only at
 *   3.6 V, owner question S21-Q2), the panel marking 1A "not guaranteed";
 * - the package in the schematic (datasheet pin names, wired pins drawn) and in 3D.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  addComponent,
  addWire,
  createProject,
  setParam,
  type ComponentTypeId,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { buildProgram, component, goToProjects, openImported, waitSaved } from './helpers.js';

const FAKE = 'http://127.0.0.1:7499';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

/**
 * PSU1 3.0 V → U1 (SN74LVC08A). Gate 1 from two closed switches → LED; gate 2: 2A HIGH, 2B LOW;
 * gates 3/4 to GND. A 10 kΩ / 20 kΩ divider (2.0 V = V_IH) drives input A of a single
 * SN74LVC1G08 (B HIGH), or, with `undefinedA2`, a 10 kΩ / 10 kΩ one (1.5 V) the package's 2A.
 * `openGate3` leaves 3A/3B unconnected.
 */
function quadCircuit(id: string, variant: 'ok' | 'openGate3' | 'undefinedA2' = 'ok') {
  const openGate3 = variant === 'openGate3';
  let doc: ProjectDocument = createProject({
    projectId: id,
    deviceId: 'dev_l3',
    name: id,
    appVersion: '0',
  });
  let x = 0;
  const add = (type: ComponentTypeId, dx = 160, y = 0) => {
    x += dx;
    const r = addComponent(doc, type, { x, y });
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
    return r.id;
  };
  const wire = (p: string, q: string) => {
    const [pc, pt] = p.split('.') as [string, string];
    const [qc, qt] = q.split('.') as [string, string];
    const r = addWire(
      doc,
      { kind: 'terminal', component: pc, terminal: pt },
      { kind: 'terminal', component: qc, terminal: qt },
    );
    if (!r.ok) throw new Error(`${p}->${q}: ${r.error}`);
    doc = r.doc;
  };
  const set = (c: string, k: string, v: Parameters<typeof setParam>[3]) => {
    const r = setParam(doc, c, k, v);
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
  };
  set('PSU1', 'setpointVoltage', { value: 3, unit: 'volt' });
  set('PSU1', 'currentLimit', { value: 0.1, unit: 'ampere' });
  set('PSU1', 'outputEnabled', true);
  wire('PSU1.negative', 'GND1.ref');
  const u = add('logic.quad_and', 400, 0);
  wire('PSU1.positive', `${u}.vcc`);
  wire(`${u}.gnd`, 'GND1.ref');
  // Gate 1: two closed switches with 10 kΩ pull-downs.
  for (const [pin, y] of [
    ['a1', -300],
    ['b1', -500],
  ] as const) {
    const s = add('component.toggle_switch', 0, y);
    const r = add('component.resistor', 160, y);
    set(s, 'closed', true);
    set(r, 'resistance', { value: 10_000, unit: 'ohm' });
    wire('PSU1.positive', `${s}.a`);
    wire(`${s}.b`, `${u}.${pin}`);
    wire(`${u}.${pin}`, `${r}.a`);
    wire(`${r}.b`, 'GND1.ref');
  }
  // The 1.5 V divider: into the single gate's A (its B HIGH), or into the package's 2A.
  const g = add('logic.gate_and', 0, 600);
  wire('PSU1.positive', `${g}.vcc`);
  wire(`${g}.gnd`, 'GND1.ref');
  wire(`${g}.b`, 'PSU1.positive');
  const target = variant === 'undefinedA2' ? `${u}.a2` : `${g}.a`;
  const top = add('component.resistor', 0, 300);
  const bottom = add('component.resistor', 160, 300);
  set(top, 'resistance', { value: 10_000, unit: 'ohm' });
  // Into the package's 2A, 1.5 V (between V_IL and V_IH: refused). Into the single gate,
  // Sprint 21: 3.0 · 30k/40k = 2.25 V, a HIGH that stays above V_IH 2.0 V within the input
  // leakage bound (±5 µA × 7.5 kΩ = ±37.5 mV); exactly 2.0 V from a divider is not guaranteed.
  set(bottom, 'resistance', { value: variant === 'undefinedA2' ? 10_000 : 30_000, unit: 'ohm' });
  wire('PSU1.positive', `${top}.a`);
  wire(`${top}.b`, target);
  wire(target, `${bottom}.a`);
  wire(`${bottom}.b`, 'GND1.ref');
  if (variant === 'undefinedA2') wire(`${g}.a`, 'GND1.ref');
  else wire(`${u}.a2`, 'PSU1.positive');
  wire(`${u}.b2`, 'GND1.ref');
  // Gates 3 and 4: inputs to GND (unless the test leaves gate 3 open).
  for (const pin of [...(openGate3 ? [] : ['a3', 'b3']), 'a4', 'b4'])
    wire(`${u}.${pin}`, 'GND1.ref');
  // 1Y → 220 Ω → LED → GND.
  const r = add('component.resistor', 200, 0);
  const d = add('component.led', 160, 0);
  set(r, 'resistance', { value: 220, unit: 'ohm' });
  wire(`${u}.y1`, `${r}.a`);
  wire(`${r}.b`, `${d}.anode`);
  wire(`${d}.cathode`, 'GND1.ref');
  return { doc, u, led: d, gate: g };
}

const status = (page: Page) => page.getByTestId('sim-status');
async function run(page: Page) {
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
}
async function inspect(page: Page, id: string) {
  await component(page, id).locator('.component-hit').click({ force: true });
}

test('L2 state inspection of a packaged gate IC: levels, measured voltages, undefined band, truth table; EN and HE', async ({
  page,
}) => {
  const q = quadCircuit('prj_l3Quad');
  await openImported(page, q.doc);
  await waitSaved(page);
  await run(page);
  await inspect(page, q.u);
  const view = page.getByTestId('logic-state');
  await expect(view).toBeVisible();
  await expect(page.getByTestId('logic-thresholds')).toContainText('SN74LVC08A');
  await expect(page.getByTestId('logic-thresholds')).toContainText('2 V');
  await expect(page.getByTestId('logic-thresholds')).toContainText('800 mV');
  // Gate 1: both inputs HIGH at 3 V, the output HIGH below 3 V (it sources the LED).
  await expect(page.getByTestId('logic-level-a1')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-volts-a1')).toHaveText('3 V');
  await expect(page.getByTestId('logic-level-y1')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-volts-y1')).toContainText('V');
  // Truth table: gate 1 (selected) in HH, gate 2 in HL, gates 3 and 4 in LL.
  await expect(page.getByTestId('logic-truth-gates-HH')).toHaveText('1');
  await expect(page.getByTestId('logic-truth-gates-HL')).toHaveText('2');
  await expect(page.getByTestId('logic-truth-gates-LL')).toHaveText('3, 4');
  await expect(page.getByTestId('logic-truth-gates-LH')).toHaveText('');
  await expect(page.getByTestId('logic-truth-HH')).toHaveAttribute('aria-current', 'true');
  // Sprint 20: the gate selector shows each gate's state; gate 2: 2A HIGH, 2B LOW → LOW.
  await expect(page.getByTestId('logic-gate-2')).toContainText('H·L→L');
  await page.getByTestId('logic-gate-2').click();
  await expect(page.getByTestId('logic-level-a2')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-level-b2')).toHaveText('LOW');
  await expect(page.getByTestId('logic-level-y2')).toHaveText('LOW');
  await expect(page.getByTestId('logic-truth-HL')).toHaveAttribute('aria-current', 'true');
  await page.getByTestId('logic-gate-4').click();
  await expect(page.getByTestId('logic-level-y4')).toHaveText('LOW');
  await page.getByTestId('logic-gate-1').click();
  // The single gate (L1): A at 2.25 V from the divider, HIGH (guaranteed within the I_I bound).
  await inspect(page, q.gate);
  await expect(page.getByTestId('logic-level-a')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-volts-a')).toHaveText('2.25 V');
  await expect(page.getByTestId('logic-why-a')).toContainText('2.25 V ≥ V_IH 2 V');
  await expect(page.getByTestId('logic-level-y')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-truth-HH')).toHaveAttribute('aria-current', 'true');
  // The LED really is lit by the solve.
  await inspect(page, q.led);
  await expect(page.getByTestId('result-current')).toContainText('mA');

  // Hebrew: the labels translate; technical cells stay LTR; levels HIGH/LOW stay technical.
  await page.getByTestId('language-select').selectOption('he');
  await inspect(page, q.u);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(view).toContainText('טבלת אמת ומצב הפינים');
  await expect(page.getByTestId('logic-level-a1')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-volts-a1')).toHaveAttribute('dir', 'ltr');
  await inspect(page, q.gate);
  await expect(page.getByTestId('logic-level-a')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-truth')).toHaveAttribute('dir', 'ltr');
  await page.getByTestId('language-select').selectOption('en');
  await page.getByTestId('sim-stop').click();
});

test('an unused gate left open refuses the Run, naming the pin and the datasheet rule (EN, HE)', async ({
  page,
}) => {
  const q = quadCircuit('prj_l3QuadFloat', 'openGate3');
  await openImported(page, q.doc);
  await waitSaved(page);
  await page.getByTestId('sim-run').click();
  const err = page.getByTestId('sim-error');
  await expect(err).toContainText(/nothing drives input\W+3A\W*: no resistive or source path/);
  await expect(err).toContainText('every unused input');
  await page.getByTestId('language-select').selectOption('he');
  await expect(err).toContainText(/כניסה\W+3A/);
  await expect(err).toContainText('SN74LVC08A');
  await page.getByTestId('language-select').selectOption('en');
});

test('a package input between V_IL and V_IH refuses the Run by name (no level, no supply current)', async ({
  page,
}) => {
  const q = quadCircuit('prj_l3QuadUndef', 'undefinedA2');
  await openImported(page, q.doc);
  await waitSaved(page);
  await page.getByTestId('sim-run').click();
  const err = page.getByTestId('sim-error');
  await expect(err).toContainText(/input\W+2A\W+is at\W+1\.5 V/);
  await page.getByTestId('language-select').selectOption('he');
  await expect(err).toContainText(/כניסה\W+2A/);
  await page.getByTestId('language-select').selectOption('en');
});

test('example esp32-logic-quad-and on the board (Sprint 21): refused at 3.0 V by name — the SN74LVC08A input leakage is specified only at 3.6 V (EN, HE)', async ({
  page,
  request,
}) => {
  await request.post(`${FAKE}/__test/capacity?n=4096`);
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('open-example-esp32-logic-quad-and').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  await buildProgram(page);
  await page.getByTestId('sim-run').click();
  // Every 08A input of the example is held through a resistance (10 kΩ pull-downs, the pads'
  // driver, gate 1's output stage): no guaranteed level at 3.0 V (owner question S21-Q2).
  const err = page.getByTestId('sim-error');
  await expect(err).toContainText(/input\W+1A\W+is held through a resistance/, { timeout: 30_000 });
  await expect(err).toContainText('V_CC = 3.6 V');
  await inspect(page, 'U2');
  await expect(page.getByTestId('logic-level-a1')).toHaveText('not guaranteed');
  await expect(page.getByTestId('logic-why-a1')).toContainText('no input-leakage bound');
  await page.getByTestId('language-select').selectOption('he');
  await expect(err).toContainText(/כניסה\W+1A\W+מוחזקת דרך התנגדות/);
  await expect(page.getByTestId('logic-level-a1')).toHaveText('לא מובטח');
  await page.getByTestId('language-select').selectOption('en');
});

test('the package in the schematic (datasheet pin names, wired pins drawn) and in 3D (SOIC-14 on a breakout)', async ({
  page,
}) => {
  const q = quadCircuit('prj_l3QuadViews');
  await openImported(page, q.doc);
  await waitSaved(page);
  await page.getByTestId('view-schematic').click();
  const sch = page.getByTestId('schematic-view');
  await expect(sch).toContainText('SN74LVC08A');
  for (const pin of ['a1', 'y1', 'a2', 'b2', 'a3', 'b4', 'vcc', 'gnd'])
    await expect(page.locator(`[data-part="${q.u}"] [data-pin="${pin}"]`)).toBeVisible();
  await page.getByTestId('view-3d').click();
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready', {
    timeout: 120_000,
  });
});
