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
  // SW1 closed, SW2 open: A HIGH at 3 V, B LOW at 0 V, Y LOW; row HL.
  await expect(page.getByTestId('logic-level-a')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-volts-a')).toHaveText('3 V');
  await expect(page.getByTestId('logic-why-a')).toContainText('3 V ≥ V_IH 2 V');
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
  await expect(page.getByTestId('logic-why-a')).toContainText('3 V ≥ V_IH 2 V');
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
  await expect(err).toContainText(/input\W+B\W+is not connected/);
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

test('B: the package gate selector; 1Y → 2A inside the package and 2Y → OR across packages; save/reopen', async ({
  page,
}) => {
  await openExample(page, 'logic-cascade');
  await run(page);
  await inspect(page, 'U1');
  // All switches open: every gate LL → L (gate 2's 2A is 1Y = L).
  await expect(page.getByTestId('logic-truth-gates-LL')).toHaveText('1, 2, 3, 4');
  await expect(page.getByTestId('logic-truth-gates-LH')).toHaveText('');
  // A and B closed from the panel (gate 1's inputs).
  await page.getByTestId('logic-control-SW1').click();
  await page.getByTestId('logic-control-SW2').click();
  await expect(page.getByTestId('logic-level-y1')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-gate-2')).toContainText('H·L→L');
  // Gate 2: 2A = 1Y (inside the package), 2B = switch C.
  await page.getByTestId('logic-gate-2').click();
  await expect(page.getByTestId('logic-level-a2')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-level-b2')).toHaveText('LOW');
  await page.getByTestId('logic-control-SW3').click();
  await expect(page.getByTestId('logic-level-y2')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-truth-HH')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('logic-truth-gates-HH')).toHaveText('1, 2');
  await shot(page, 's20l-B-package-en');
  // Across packages: the OR gate sees 2Y on A; the LED is lit.
  await inspect(page, 'U2');
  await expect(page.getByTestId('logic-level-a')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-level-b')).toHaveText('LOW');
  await expect(page.getByTestId('logic-level-y')).toHaveText('HIGH');
  await expect(page.getByTestId('probe-reading-D1')).toContainText('mA');
  // D (override) alone: open A again, close D.
  await inspect(page, 'U1');
  await page.getByTestId('logic-control-SW1').click();
  await inspect(page, 'U2');
  await expect(page.getByTestId('logic-level-y')).toHaveText('LOW');
  await page.getByTestId('logic-control-SW4').click();
  await expect(page.getByTestId('logic-level-y')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-truth-LH')).toHaveAttribute('aria-current', 'true');
  await shot(page, 's20l-B-or-en');
  await page.getByTestId('language-select').selectOption('he');
  await shot(page, 's20l-B-or-he');
  await page.getByTestId('language-select').selectOption('en');
  await page.getByTestId('sim-stop').click();
  await waitSaved(page);
  await goToProjects(page);
  await reopenFromLibrary(page);
  await run(page);
  await inspect(page, 'U2');
  await expect(page.getByTestId('logic-truth-LH')).toHaveAttribute('aria-current', 'true');
  await page.getByTestId('sim-stop').click();
});

test('D: ESP32 + manual switch + OR gate; the firmware blinks A and reads Y back; the switch overrides it; save/reopen', async ({
  page,
  request,
}) => {
  await request.post(`${FAKE}/__test/capacity?n=4096`);
  await openExample(page, 'esp32-logic-override');
  await buildProgram(page);
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
  await expect(status(page)).toHaveAttribute('data-engine', 'mcu');
  await inspect(page, 'U2');
  await expect(page.getByTestId('logic-mcu-a')).toContainText('GPIO18');
  // The firmware toggles GPIO18 every second: both rows LL and HL are visited.
  await expect(page.getByTestId('logic-truth-HL')).toHaveAttribute('aria-current', 'true', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('logic-truth-LL')).toHaveAttribute('aria-current', 'true', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('mcu-serial-output')).toContainText('A=1 Y=1');
  await expect(page.getByTestId('mcu-serial-output')).toContainText('A=0 Y=0');
  await shot(page, 's20l-D-blink-en');
  // Close the switch from the panel (a live mirror into the session): Y stays HIGH.
  await page.getByTestId('logic-control-SW1').click();
  await expect(page.getByTestId('logic-level-b')).toHaveText('HIGH');
  await expect(page.getByTestId('logic-truth-LH')).toHaveAttribute('aria-current', 'true', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('mcu-serial-output')).toContainText('A=0 Y=1 (switch override)', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('logic-level-y')).toHaveText('HIGH');
  await shot(page, 's20l-D-override-en');
  await page.getByTestId('language-select').selectOption('he');
  await shot(page, 's20l-D-override-he');
  await page.getByTestId('language-select').selectOption('en');
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 20_000 });
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
