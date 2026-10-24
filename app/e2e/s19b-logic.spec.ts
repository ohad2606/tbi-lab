/**
 * Sprint 19B (Exploration Foundation L1): single logic gates in the browser (local simulation, the
 * production engine in the worker), in every view.
 *
 * - an SN74LVC1G08 AND gate at 3.0 V from the bench supply, inputs from two toggle switches with
 *   10 kΩ pull-downs, the output lighting an LED through 220 Ω: both closed → HIGH and the LED
 *   current shown; one open → LOW, no current;
 * - an input held between V_IL and V_IH by a divider: the Run is refused by name (Sprint 20), and
 *   the Inspector explains the pin against V_IL / V_IH (never a level);
 * - a floating input refuses the Run, naming the pin (EN and HE);
 * - the schematic and 3D views draw the gate with its real supply pins.
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
import { component, openImported, waitSaved } from './helpers.js';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

/** PSU1 at 3.0 V; U1 AND gate; inputs per `a` / `b`; Y → 220 Ω → LED → GND. */
function andCircuit(
  id: string,
  a: 'closed' | 'open' | 'divider' | 'floating',
  b: 'closed' | 'open',
) {
  let doc: ProjectDocument = createProject({
    projectId: id,
    deviceId: 'dev_s19b',
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
  const g = add('logic.gate_and', 400, 0);
  wire('PSU1.positive', `${g}.vcc`);
  wire(`${g}.gnd`, 'GND1.ref');
  const input = (pin: 'a' | 'b', how: 'closed' | 'open' | 'divider' | 'floating', y: number) => {
    if (how === 'floating') return;
    const r1 = add('component.resistor', 0, y);
    set(r1, 'resistance', { value: 10_000, unit: 'ohm' });
    if (how === 'divider') {
      const r2 = add('component.resistor', 160, y);
      set(r2, 'resistance', { value: 10_000, unit: 'ohm' });
      wire('PSU1.positive', `${r2}.a`);
      wire(`${r2}.b`, `${g}.${pin}`);
    } else {
      const s = add('component.toggle_switch', 160, y);
      set(s, 'closed', how === 'closed');
      wire('PSU1.positive', `${s}.a`);
      wire(`${s}.b`, `${g}.${pin}`);
    }
    wire(`${g}.${pin}`, `${r1}.a`);
    wire(`${r1}.b`, 'GND1.ref');
  };
  input('a', a, -240);
  input('b', b, 240);
  const r = add('component.resistor', 200, 0);
  const d = add('component.led', 160, 0);
  set(r, 'resistance', { value: 220, unit: 'ohm' });
  wire(`${g}.y`, `${r}.a`);
  wire(`${r}.b`, `${d}.anode`);
  wire(`${d}.cathode`, 'GND1.ref');
  return { doc, gate: g, led: d };
}

const status = (page: Page) => page.getByTestId('sim-status');
async function run(page: Page) {
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
}
async function inspect(page: Page, id: string) {
  await component(page, id).locator('.component-hit').click({ force: true });
}

test('AND gate at 3.0 V: both inputs HIGH light the LED; one LOW does not', async ({ page }) => {
  const on = andCircuit('prj_s19bAndOn', 'closed', 'closed');
  await openImported(page, on.doc);
  await waitSaved(page);
  await run(page);
  await inspect(page, on.gate);
  await expect(page.getByTestId('result-state-gateOutput')).toHaveText('HIGH');
  await expect(page.getByTestId('result-state-outputModel')).toContainText('guaranteed');
  await inspect(page, on.led);
  await expect(page.getByTestId('result-current')).toContainText('mA');
  await page.getByTestId('sim-stop').click();

  const off = andCircuit('prj_s19bAndOff', 'closed', 'open');
  await openImported(page, off.doc);
  await waitSaved(page);
  await run(page);
  await inspect(page, off.gate);
  await expect(page.getByTestId('result-state-gateOutput')).toHaveText('LOW');
});

test('an input in the undefined band refuses the Run by name (Sprint 20: no level, no controlling-input guess)', async ({
  page,
}) => {
  const x = andCircuit('prj_s19bAndX', 'divider', 'closed');
  await openImported(page, x.doc);
  await waitSaved(page);
  await page.getByTestId('sim-run').click();
  const err = page.getByTestId('sim-error');
  await expect(err).toContainText(/input\W+A\W+is at\W+1\.5 V/);
  await expect(err).toContainText('V_IL 800 mV');
  await expect(err).toContainText('V_IH 2 V');
  // The Inspector explains the pin: its voltage, the thresholds at this supply, never a level.
  await inspect(page, x.gate);
  await expect(page.getByTestId('logic-level-a')).toHaveText('undefined (between V_IL and V_IH)');
  await expect(page.getByTestId('logic-volts-a')).toHaveText('1.5 V');
  await expect(page.getByTestId('logic-why-a')).toContainText('V_IL 800 mV');
  await expect(page.getByTestId('logic-level-y')).toHaveText('not simulated');
  await expect(page.getByTestId('logic-truth')).not.toContainText('●');
});

test('a floating input refuses the Run, naming the pin, in English and Hebrew', async ({
  page,
}) => {
  const f = andCircuit('prj_s19bAndFloat', 'floating', 'closed');
  await openImported(page, f.doc);
  await waitSaved(page);
  await page.getByTestId('sim-run').click();
  const err = page.getByTestId('sim-error');
  // The pin name is a technical token, direction-isolated inside the sentence.
  await expect(err).toContainText(/input\W+A\W+is not connected/);
  await page.getByTestId('language-select').selectOption('he');
  await expect(err).toContainText(/כניסה\W+A/);
  await page.getByTestId('language-select').selectOption('en');
});

test('the gate in the schematic (supply pins named) and in 3D (SOT-23-5 on a breakout)', async ({
  page,
}) => {
  const on = andCircuit('prj_s19bAndViews', 'closed', 'closed');
  await openImported(page, on.doc);
  await waitSaved(page);
  await page.getByTestId('view-schematic').click();
  const sch = page.getByTestId('schematic-view');
  await expect(page.locator(`[data-part="${on.gate}"] [data-glyph="logic.and"]`)).toBeVisible();
  await expect(sch).toContainText('SN74LVC1G08');
  for (const pin of ['VCC', 'GND', 'Y']) await expect(sch).toContainText(pin);
  await page.getByTestId('view-3d').click();
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready', {
    timeout: 120_000,
  });
});
