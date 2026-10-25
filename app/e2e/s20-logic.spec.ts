/**
 * Sprint 20 (logic) in the browser: the Inspector's logic panel (Phase 5) and the logic examples
 * (Phase 6), local simulation in the worker and, for the ESP32 example D, the real R2 client
 * against the fake Session Host (real engine; the MCU scripted as the example sketch).
 *
 * - A `logic-and-switches`: the truth table is in the Inspector BEFORE a Run (datasheet function
 *   table and input rows); while running each pin shows level, voltage to GND and why; toggling an
 *   input from the panel moves the evaluated row; save/reopen keeps the switch state; EN and HE.
 * - refusals explained by pin: a floating input (pull-down deleted) and an input between V_IL and
 *   V_IH (a divider) — never shown as a level;
 * - B `logic-cascade`: the gate selector of the package, inside- and across-package chains;
 * - D `esp32-logic-override`: ESP32 + switch + OR gate; the firmware's read-back on the serial
 *   monitor, the manual override from the panel.
 *
 * Screenshots go to TBI_S20L_SHOTS (a directory) when set.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  addComponent,
  addWire,
  createProject,
  setParam,
  type ComponentTypeId,
  type ProjectDocument,
} from '@tbi-lab/domain';
import {
  buildProgram,
  component,
  goToProjects,
  openImported,
  reopenFromLibrary,
  waitSaved,
} from './helpers.js';

const FAKE = 'http://127.0.0.1:7499';
const SHOTS = process.env.TBI_S20L_SHOTS;

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

const status = (page: Page) => page.getByTestId('sim-status');
async function run(page: Page) {
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
}
async function inspect(page: Page, id: string) {
  await component(page, id).locator('.component-hit').click({ force: true });
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.getByTestId('inspector').screenshot({ path: `${SHOTS}/${name}-inspector.png` });
  await page.screenshot({ path: `${SHOTS}/${name}-page.png` });
}
async function openExample(page: Page, id: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}

test('A: the truth table is in the Inspector before a Run; live levels, why, and toggling from the panel; save/reopen (EN, HE)', async ({
  page,
}) => {
  await openExample(page, 'logic-and-switches');
  await inspect(page, 'U1');
  const view = page.getByTestId('logic-state');
  await expect(view).toBeVisible();
  // Not running: the datasheet's function table and input rows; no level is claimed.
  await expect(page.getByTestId('logic-thresholds')).toContainText('SN74LVC1G08');
  await expect(page.getByTestId('logic-rows')).toContainText('2 V');
  await expect(page.getByTestId('logic-truth-HH')).toContainText('H');
  await expect(page.getByTestId('logic-truth')).not.toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('logic-level-a')).toHaveText('—');
  await expect(page.getByTestId('logic-control-SW2')).toContainText('open');
  await shot(page, 's20l-A-idle-en');

  await run(page);
  await inspect(page, 'U1');
  // SW1 closed, SW2 open: A HIGH at 5.5 V (Sprint 22: the 5.5 V input rail), B LOW at 0 V, Y LOW;
  // row HL.
  await expect(page.getByTestId('logic-level-a')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-volts-a')).toHaveText('5.5 V');
  await expect(page.getByTestId('logic-why-a')).toContainText('5.5 V ≥ V_IH 2 V');
  await expect(page.getByTestId('logic-why-a')).toContainText('V_CC = 3 V');
  await expect(page.getByTestId('logic-level-b')).toHaveText('LOW');
  await expect(page.getByTestId('logic-why-b')).toContainText('0 V ≤ V_IL 800 mV');
  await expect(page.getByTestId('logic-level-y')).toHaveText('LOW');
  await expect(page.getByTestId('logic-why-y')).toContainText(
    /AND\W+of the inputs \(\W*H·L\W*\) = \W*L/,
  );
  await expect(page.getByTestId('logic-truth-HL')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('probe-reading-D1')).toContainText('0 A');
  await shot(page, 's20l-A-run-HL-en');

  // Toggle B from the panel: the row moves to HH and the LED lights, the gate stays selected.
  await page.getByTestId('logic-control-SW2').click();
  await expect(page.getByTestId('logic-level-b')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-level-y')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-truth-HH')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('logic-truth-HL')).not.toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('probe-reading-D1')).toContainText('mA');
  await expect(page.getByTestId('inspector-ref')).toHaveText('U1');
  await shot(page, 's20l-A-run-HH-en');

  // Hebrew: the panel follows RTL; pin names, voltages and the truth table stay LTR.
  await page.getByTestId('language-select').selectOption('he');
  await expect(view).toContainText('טבלת אמת');
  await expect(page.getByTestId('logic-level-y')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-volts-a')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByTestId('logic-truth')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByTestId('logic-why-a')).toContainText('5.5 V ≥ V_IH 2 V');
  await shot(page, 's20l-A-run-HH-he');
  await page.getByTestId('language-select').selectOption('en');
  await page.getByTestId('sim-stop').click();

  // Save / reopen: the toggled switch is a persistent edit.
  await waitSaved(page);
  await goToProjects(page);
  await reopenFromLibrary(page);
  await run(page);
  await inspect(page, 'U1');
  await expect(page.getByTestId('logic-level-b')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-truth-HH')).toHaveAttribute('aria-current', 'true');
  await page.getByTestId('sim-stop').click();
});

test('A without a pull-down: the open switch leaves B floating — refused, and the panel says why (EN, HE)', async ({
  page,
}) => {
  await openExample(page, 'logic-and-switches');
  await inspect(page, 'R2');
  await page.getByTestId('inspector-delete').click();
  await waitSaved(page);
  await page.getByTestId('sim-run').click();
  const err = page.getByTestId('sim-error');
  await expect(err).toContainText(/nothing drives input\W+B\W*: no resistive or source path/);
  await inspect(page, 'U1');
  await expect(page.getByTestId('logic-level-b')).toHaveText('floating (not driven)');
  await expect(page.getByTestId('logic-volts-b')).toHaveText('—');
  await expect(page.getByTestId('logic-why-b')).toContainText('Nothing drives this input');
  await expect(page.getByTestId('logic-level-a')).toHaveText('not simulated');
  await shot(page, 's20l-A-floating-en');
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.getByTestId('logic-level-b')).toHaveText('צפה (לא מוזנת)');
  await shot(page, 's20l-A-floating-he');
  await page.getByTestId('language-select').selectOption('en');
});

test('review round 2: a refusal WHILE RUNNING (opening a switch floats an input) is explained by pin (local engine)', async ({
  page,
}) => {
  // A switch with NO pull-down on input B (A tied HIGH); closed, so the Run starts.
  const doc = noPullDownCircuit('prj_s20l2Live');
  await openImported(page, doc);
  await waitSaved(page);
  await run(page);
  await inspect(page, 'U1');
  await expect(page.getByTestId('logic-level-b')).toHaveText('HIGH');
  // Open SW1 while running: the session stays running with a refused operating point.
  await page.getByTestId('logic-control-SW1').click();
  await expect(page.getByTestId('logic-level-b')).toHaveText('floating (not driven)');
  await expect(page.getByTestId('logic-why-b')).toContainText('Nothing drives this input');
  await expect(page.getByTestId('logic-level-a')).toHaveText('not simulated');
  await expect(page.getByTestId('logic-why-a')).not.toContainText('Waiting');
  await shot(page, 's20l2-A-refused-while-running-en');
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.getByTestId('logic-level-b')).toHaveText('צפה (לא מוזנת)');
  await shot(page, 's20l2-A-refused-while-running-he');
  await page.getByTestId('language-select').selectOption('en');
  // Closing it again recovers.
  await page.getByTestId('logic-control-SW1').click();
  await expect(page.getByTestId('logic-level-b')).toHaveText('HIGH');
  await page.getByTestId('sim-stop').click();
});

test('a refusal in an ESP32 session (runtime controller) is explained by pin (Sprint 21: the read-back pad)', async ({
  page,
  request,
}) => {
  // Sprint 21 review: every state of example D in which the sketch drives GPIO18 HIGH is refused
  // (the read-back pad, or GPIO18 into its pull-down), so the round-2 "float B while running"
  // scenario no longer reaches a running state; the refusal is explained by pin instead.
  await request.post(`${FAKE}/__test/capacity?n=4096`);
  await openExample(page, 'esp32-logic-override');
  await buildProgram(page);
  await page.getByTestId('sim-run').click();
  // Sprint 22 Q1 (strict): input A (GPIO18's level or its pull-down's leakage drop) is never at
  // 5.5 V or exactly GND: the gate's I_CC is unbounded and the supply's current limit is refused,
  // naming input A.
  await expect(page.getByTestId('sim-error')).toHaveAttribute(
    'data-code',
    'logic_supply_current_uncharacterized',
    { timeout: 20_000 },
  );
  await expect(page.getByTestId('sim-error')).toContainText('current limit');
  await inspect(page, 'U2');
  await expect(page.getByTestId('logic-level-y')).toHaveText('not simulated');
  await shot(page, 's21l-D-refused-by-pin-en');
});

/** PSU1 3.0 V → SN74LVC1G08 U1 (A HIGH at 5.5 V from PSU2); B from toggle switch SW1 (closed, to 5.5 V) with NO pull-down. */
function noPullDownCircuit(id: string) {
  let doc: ProjectDocument = createProject({
    projectId: id,
    deviceId: 'dev_s20l',
    name: id,
    appVersion: '0',
  });
  const add = (type: ComponentTypeId, x: number, y: number) => {
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
  const g = add('logic.gate_and', 360, 0);
  const sw = add('component.toggle_switch', 160, 120);
  const r = add('component.resistor', 520, 0);
  set(sw, 'closed', true);
  set(r, 'resistance', { value: 10_000, unit: 'ohm' });
  wire('PSU1.positive', `${g}.vcc`);
  wire(`${g}.gnd`, 'GND1.ref');
  // Sprint 22 Q1 (strict): the inputs' HIGH from a second supply at 5.5 V (the I_CC test voltage).
  const hi = add('instrument.lab_psu', 0, -200);
  set(hi, 'setpointVoltage', { value: 5.5, unit: 'volt' });
  set(hi, 'currentLimit', { value: 0.1, unit: 'ampere' });
  set(hi, 'outputEnabled', true);
  wire(`${hi}.negative`, 'GND1.ref');
  // Sprint 22 review 3: a bleeder keeps PSU2 delivering (it feeds only inputs; no sinking model).
  const bl = add('component.resistor', 0, -320);
  set(bl, 'resistance', { value: 10_000, unit: 'ohm' });
  wire(`${hi}.positive`, `${bl}.a`);
  wire(`${bl}.b`, 'GND1.ref');
  wire(`${g}.a`, `${hi}.positive`);
  wire(`${hi}.positive`, `${sw}.a`);
  wire(`${sw}.b`, `${g}.b`);
  wire(`${g}.y`, `${r}.a`);
  wire(`${r}.b`, 'GND1.ref');
  return doc;
}

/** PSU1 3.0 V → SN74LVC1G08, A from a 10 kΩ / 10 kΩ divider (1.5 V), B HIGH; Y → 220 Ω → LED. */
function undefinedCircuit(id: string) {
  let doc: ProjectDocument = createProject({
    projectId: id,
    deviceId: 'dev_s20l',
    name: id,
    appVersion: '0',
  });
  const add = (type: ComponentTypeId, x: number, y: number) => {
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
  const g = add('logic.gate_and', 360, 0);
  const top = add('component.resistor', 120, -100);
  const bot = add('component.resistor', 240, 60);
  const r = add('component.resistor', 480, 0);
  const d = add('component.led', 600, 0);
  set(top, 'resistance', { value: 10_000, unit: 'ohm' });
  set(bot, 'resistance', { value: 10_000, unit: 'ohm' });
  set(r, 'resistance', { value: 220, unit: 'ohm' });
  wire('PSU1.positive', `${g}.vcc`);
  wire(`${g}.gnd`, 'GND1.ref');
  wire(`${g}.b`, 'PSU1.positive');
  wire('PSU1.positive', `${top}.a`);
  wire(`${top}.b`, `${g}.a`);
  wire(`${g}.a`, `${bot}.a`);
  wire(`${bot}.b`, 'GND1.ref');
  wire(`${g}.y`, `${r}.a`);
  wire(`${r}.b`, `${d}.anode`);
  wire(`${d}.cathode`, 'GND1.ref');
  return { doc, gate: g };
}

test('an input between V_IL and V_IH: refused; the panel shows its voltage against V_IL/V_IH, never a level (EN, HE)', async ({
  page,
}) => {
  const u = undefinedCircuit('prj_s20lUndef');
  await openImported(page, u.doc);
  await waitSaved(page);
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-error')).toContainText(/input\W+A\W+is at\W+1\.5 V/);
  await inspect(page, u.gate);
  await expect(page.getByTestId('logic-level-a')).toHaveText('undefined (between V_IL and V_IH)');
  await expect(page.getByTestId('logic-volts-a')).toHaveText('1.5 V');
  await expect(page.getByTestId('logic-why-a')).toContainText(
    /between\W+V_IL 800 mV\W+and\W+V_IH 2 V\W+\(\W*V_CC = 3 V/,
  );
  await expect(page.getByTestId('logic-level-y')).toHaveText('not simulated');
  for (const row of ['LL', 'LH', 'HL', 'HH'])
    await expect(page.getByTestId(`logic-truth-${row}`)).not.toHaveAttribute(
      'aria-current',
      'true',
    );
  await shot(page, 's20l-undefined-en');
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.getByTestId('logic-level-a')).toHaveText('לא מוגדר (בין V_IL ל-V_IH)');
  await expect(page.getByTestId('logic-why-a')).toContainText('V_IL 800 mV');
  await shot(page, 's20l-undefined-he');
  await page.getByTestId('language-select').selectOption('en');
});

test('B as shipped (3.0 V), Sprint 21: refused by name — the SN74LVC08A input leakage is specified only at 3.6 V (EN, HE)', async ({
  page,
}) => {
  await openExample(page, 'logic-cascade');
  await page.getByTestId('sim-run').click();
  const err = page.getByTestId('sim-error');
  await expect(err).toContainText(/input\W+1A\W+is held through a resistance/);
  await expect(err).toContainText('V_CC = 3.6 V');
  await inspect(page, 'U1');
  await expect(page.getByTestId('logic-level-a1')).toHaveText('not guaranteed');
  await expect(page.getByTestId('logic-no-row')).toContainText('No row');
  await shot(page, 's21l-B-refused-en');
  await page.getByTestId('language-select').selectOption('he');
  await expect(err).toContainText(/כניסה\W+1A\W+מוחזקת דרך התנגדות/);
  await shot(page, 's21l-B-refused-he');
  await page.getByTestId('language-select').selectOption('en');
});

/** Example B with its supply at 3.6 V (where SCAS283W §5.7 specifies I_I and I_CC). */
function cascadeAt36(): ProjectDocument {
  const d = JSON.parse(
    readFileSync(new URL('../src/examples/data/logic-cascade.json', import.meta.url), 'utf8'),
  ) as ProjectDocument;
  const r = setParam(
    { ...d, projectId: 'prj_s21lCascade36', name: 'Cascade 3.6 V' },
    'PSU1',
    'setpointVoltage',
    { value: 3.6, unit: 'volt' },
  );
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

test("B at 3.6 V (Sprint 22 Q1 strict): the cascade is refused by name — a gate output is never exactly at a rail, so the next gate's I_CC is unbounded; the package gate selector still works (EN, HE)", async ({
  page,
}) => {
  await openImported(page, cascadeAt36());
  await waitSaved(page);
  await inspect(page, 'U1');
  // Not running: the package's gates are selectable and their truth table is shown.
  await page.getByTestId('logic-gate-2').click();
  await expect(page.getByTestId('logic-truth-HH')).toContainText('H');
  await page.getByTestId('sim-run').click();
  const err = page.getByTestId('sim-error');
  await expect(err).toHaveAttribute('data-code', 'logic_supply_current_uncharacterized');
  await expect(err).toContainText('current limit');
  await shot(page, 's22l-B36-refused-en');
  await page.getByTestId('language-select').selectOption('he');
  await expect(err).toContainText('מגבלת הזרם');
  await shot(page, 's22l-B36-refused-he');
  await page.getByTestId('language-select').selectOption('en');
});

test('D: ESP32 + manual switch + OR gate (Sprint 22 Q1 strict): refused by name, the supply current limit (I_CC unbounded); the switch persists (save/reopen)', async ({
  page,
  request,
}) => {
  await request.post(`${FAKE}/__test/capacity?n=4096`);
  await openExample(page, 'esp32-logic-override');
  await inspect(page, 'U2');
  await expect(page.getByTestId('logic-mcu-a')).toContainText('GPIO18');
  await buildProgram(page);
  await page.getByTestId('sim-run').click();
  // Sprint 22 Q1 (strict): input A is never at 5.5 V or exactly GND (GPIO18's level, or its
  // pull-down's leakage drop): the gate's I_CC is unbounded, the supply's current limit refused.
  const err = page.getByTestId('sim-error');
  await expect(err).toHaveAttribute('data-code', 'logic_supply_current_uncharacterized', {
    timeout: 20_000,
  });
  await expect(err).toContainText('current limit');
  await expect(err).toContainText('V_I = 5.5 V or GND');
  await shot(page, 's21l-D-refused-en');
  await page.getByTestId('language-select').selectOption('he');
  await expect(err).toContainText('מגבלת הזרם');
  await shot(page, 's21l-D-refused-he');
  await page.getByTestId('language-select').selectOption('en');
  // Close the switch from the panel (a persistent edit) and reopen: it is kept.
  await inspect(page, 'U2');
  await page.getByTestId('logic-control-SW1').click();
  await expect(page.getByTestId('logic-control-SW1')).toContainText('closed');
  await waitSaved(page);
  await goToProjects(page);
  await reopenFromLibrary(page);
  await inspect(page, 'U2');
  await expect(page.getByTestId('logic-control-SW1')).toContainText('closed');
});

test('the new examples in the schematic and 3D views', async ({ page }) => {
  for (const id of ['logic-and-switches', 'logic-cascade', 'esp32-logic-override']) {
    await openExample(page, id);
    await page.getByTestId('view-schematic').click();
    await expect(page.getByTestId('schematic-view')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/s20l-${id}-schematic.png` });
    await page.getByTestId('view-3d').click();
    await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready', {
      timeout: 120_000,
    });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/s20l-${id}-3d.png` });
    await page.getByTestId('view-circuit').click();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/s20l-${id}-circuit.png` });
  }
});
