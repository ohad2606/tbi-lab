/**
 * Exploration Foundation L3 (packaged logic) and L2 (state inspection) in the browser.
 *
 * - local simulation: an SN74LVC08A at 3.0 V, gate 1 from two closed switches lighting an LED,
 *   gate 2 with 2A held in the undefined band by a divider; the Inspector's logic-state table
 *   shows each pin's level and measured voltage ("undefined" for 2A, never a guessed level) and
 *   marks the truth-table row gate 1 is in; in Hebrew the table follows RTL while pin names,
 *   voltages and H/L stay LTR;
 * - an unused gate left open refuses the Run, naming the pin and the datasheet requirement;
 * - the `esp32-logic-quad-and` example through the real R2 client against the fake Session Host
 *   (real engine; scripted MCU = the example sketch's setup(): GPIO18 and GPIO19 HIGH): D1 lit,
 *   D2 only while the button is held;
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

/** PSU1 3.0 V → U1 (SN74LVC08A); see the file comment. `openGate3`: leave 3A/3B unconnected. */
function quadCircuit(id: string, openGate3 = false) {
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
  // Gate 2: 2A at 1.5 V (10 kΩ / 10 kΩ divider, between V_IL = 0.8 V and V_IH = 2.0 V); 2B HIGH.
  const top = add('component.resistor', 0, 300);
  const bottom = add('component.resistor', 160, 300);
  set(top, 'resistance', { value: 10_000, unit: 'ohm' });
  set(bottom, 'resistance', { value: 10_000, unit: 'ohm' });
  wire('PSU1.positive', `${top}.a`);
  wire(`${top}.b`, `${u}.a2`);
  wire(`${u}.a2`, `${bottom}.a`);
  wire(`${bottom}.b`, 'GND1.ref');
  wire(`${u}.b2`, 'PSU1.positive');
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
  return { doc, u, led: d };
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
  // Gate 2: 2A at 1.5 V is undefined; its output is unknown and has no number.
  await expect(page.getByTestId('logic-level-a2')).toHaveText('undefined (between V_IL and V_IH)');
  await expect(page.getByTestId('logic-volts-a2')).toHaveText('1.5 V');
  await expect(page.getByTestId('logic-level-y2')).toHaveText('unknown (X)');
  await expect(page.getByTestId('logic-volts-y2')).toHaveText('—');
  // Gates 3 and 4 LOW.
  await expect(page.getByTestId('logic-level-y4')).toHaveText('LOW');
  // Truth table: gate 1 in HH, gates 3 and 4 in LL; gate 2 is in no row.
  await expect(page.getByTestId('logic-truth-gates-HH')).toHaveText('1');
  await expect(page.getByTestId('logic-truth-gates-LL')).toHaveText('3, 4');
  await expect(page.getByTestId('logic-truth-gates-LH')).toHaveText('');
  await expect(page.getByTestId('logic-truth-HH')).toHaveAttribute('aria-current', 'true');
  // The LED really is lit by the solve.
  await inspect(page, q.led);
  await expect(page.getByTestId('result-current')).toContainText('mA');

  // Hebrew: the labels translate; technical cells stay LTR; levels HIGH/LOW stay technical.
  await page.getByTestId('language-select').selectOption('he');
  await inspect(page, q.u);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(view).toContainText('מצב לוגי');
  await expect(page.getByTestId('logic-level-a2')).toHaveText('לא מוגדר (בין V_IL ל-V_IH)');
  await expect(page.getByTestId('logic-level-a1')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-volts-a2')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByTestId('logic-truth')).toHaveAttribute('dir', 'ltr');
  await page.getByTestId('language-select').selectOption('en');
  await page.getByTestId('sim-stop').click();
});

test('an unused gate left open refuses the Run, naming the pin and the datasheet rule (EN, HE)', async ({
  page,
}) => {
  const q = quadCircuit('prj_l3QuadFloat', true);
  await openImported(page, q.doc);
  await waitSaved(page);
  await page.getByTestId('sim-run').click();
  const err = page.getByTestId('sim-error');
  await expect(err).toContainText(/input\W+3A\W+is not connected/);
  await expect(err).toContainText('every unused input');
  await page.getByTestId('language-select').selectOption('he');
  await expect(err).toContainText(/כניסה\W+3A/);
  await expect(err).toContainText('SN74LVC08A');
  await page.getByTestId('language-select').selectOption('en');
});

test('example esp32-logic-quad-and on the board: ESP32 → SN74LVC08A → LEDs; D2 only while the button is held', async ({
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
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
  await expect(status(page)).toHaveAttribute('data-engine', 'mcu');
  await inspect(page, 'U2');
  await expect(page.getByTestId('logic-level-a1')).toHaveText('HIGH', { timeout: 15_000 });
  await expect(page.getByTestId('logic-level-b1')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-level-y1')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-level-a2')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-level-b2')).toHaveText('LOW');
  await expect(page.getByTestId('logic-level-y2')).toHaveText('LOW');
  await expect(page.getByTestId('logic-truth-gates-HH')).toHaveText('1');
  await expect(page.getByTestId('logic-truth-gates-HL')).toHaveText('2');
  await expect(page.getByTestId('probe-reading-D1')).toContainText('mA');
  await expect(page.getByTestId('probe-reading-D2')).toContainText('0 A');
  const act = page.getByTestId('actuator-SW1');
  const b = (await act.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId('logic-level-y2')).toHaveText('HIGH');
  await expect(page.getByTestId('probe-reading-D2')).toContainText('mA');
  await page.mouse.up();
  await expect(page.getByTestId('logic-level-y2')).toHaveText('LOW');
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 20_000 });
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
