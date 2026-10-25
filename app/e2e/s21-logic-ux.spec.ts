/**
 * Sprint 21 Phase 4 (logic truth-table experience) in the browser, at desktop (1366×768,
 * 1920×1080) and tablet (1024×768, 768×1024) sizes, in English and Hebrew (RTL):
 *
 * - the truth table is discoverable from the Inspector (a logic part selected → the panel, its
 *   truth table and the input controls are on screen without hunting);
 * - the highlighted row follows circuit changes (switches toggled from the panel, by keyboard);
 * - logic level vs simulated voltage are separate columns; an output states its datasheet
 *   guarantee apart from the model's voltage;
 * - a floating / not-guaranteed input is identified by pin, and "No row" says why;
 * - in an ESP32 project the panel's controls are never under the ESP32 terminal;
 * - while running, the canvas readouts of the logic examples do not overlap another part's body
 *   (the logic part, the board) or the Inspector;
 * - accessibility: the tables are labelled (aria-labelledby), the controls are buttons with
 *   aria-pressed, operable from the keyboard.
 *
 * Screenshots: TBI_S21L_SHOTS (a directory) when set, one per size × locale × scene.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  addComponent,
  addWire,
  createProject,
  setParam,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { buildProgram, component, goToProjects, openImported, waitSaved } from './helpers.js';

const FAKE = 'http://127.0.0.1:7499';
const SHOTS = process.env.TBI_S21L_SHOTS;
const SIZES = [
  { name: 'desktop-1366x768', width: 1366, height: 768 },
  { name: 'desktop-1920x1080', width: 1920, height: 1080 },
  { name: 'tablet-1024x768', width: 1024, height: 768 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
] as const;
const LOCALES = ['en', 'he'] as const;

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

const status = (page: Page) => page.getByTestId('sim-status');
async function inspect(page: Page, id: string) {
  await component(page, id).locator('.component-hit').click({ force: true });
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
async function locale(page: Page, code: 'en' | 'he') {
  await page.getByTestId('language-select').selectOption(code);
  await expect(page.locator('html')).toHaveAttribute('dir', code === 'he' ? 'rtl' : 'ltr');
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}-page.png` });
  await page.getByTestId('inspector').screenshot({ path: `${SHOTS}/${name}-inspector.png` });
}
type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  if (!b) throw new Error('no box');
  return b;
}
/** The element is inside the Inspector's visible (scrolled) area. */
async function onScreenIn(page: Page, l: Locator) {
  const i = await box(page.getByTestId('inspector'));
  const b = await box(l);
  expect(b.y, 'top inside the Inspector').toBeGreaterThanOrEqual(i.y - 1);
  expect(b.y + b.height, 'bottom inside the Inspector').toBeLessThanOrEqual(i.y + i.height + 1);
}

/**
 * Every canvas readout clear of the OTHER parts' bodies and of the Inspector. Measured in ONE
 * snapshot inside the page (review of the 768×1024 failure): while an ESP32 sketch runs, the
 * readouts re-render every time the firmware changes a pin, so locating them one by one could
 * catch a label between two renders (no box). Only the canvas's runtime labels are readouts (the
 * Inspector's own `result-*` rows are not); at least one must be present (the selected part's).
 */
async function readoutsClear(page: Page, parts: string[]) {
  // While a sketch runs the operating point changes (an ESP32 example may also pass through a
  // refused state, where no readout is shown): the check is polled until one snapshot has the
  // readouts (at least one: the selected part's) and then must find no overlap in it.
  const snapshot = () =>
    page.evaluate((ids) => {
      const r = (e: Element) => {
        const b = e.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      };
      const inspector = document.querySelector('[data-testid="inspector"]');
      // Only what the canvas shows counts: a label scrolled past its edge is clipped there.
      const canvas = document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect();
      const clip = (b: { x: number; y: number; width: number; height: number }) => {
        const x = Math.max(b.x, canvas.x);
        const y = Math.max(b.y, canvas.y);
        const w = Math.min(b.x + b.width, canvas.x + canvas.width) - x;
        const h = Math.min(b.y + b.height, canvas.y + canvas.height) - y;
        return { x, y, width: Math.max(0, w), height: Math.max(0, h) };
      };
      const labels = [
        ...document.querySelectorAll(
          '[data-testid="canvas"] text.runtime-label[data-testid^="result-"]',
        ),
      ]
        .map((e) => ({ id: e.getAttribute('data-testid')!.slice(7), box: clip(r(e)) }))
        .filter((l) => l.box.width > 0 && l.box.height > 0);
      const partBoxes = ids.map((id) => {
        const e = document.querySelector(`[data-hit="component"][data-id="${id}"] .component-hit`);
        return { id, box: e ? r(e) : null };
      });
      return { inspector: inspector ? r(inspector) : null, labels, partBoxes };
    }, parts);
  let last: Awaited<ReturnType<typeof snapshot>> | null = null;
  await expect
    .poll(
      async () => {
        last = await snapshot();
        return last.labels.length;
      },
      { message: 'canvas readouts while running', timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  const found = last!;
  expect(found.inspector, 'the Inspector').not.toBeNull();
  for (const p of found.partBoxes) expect(p.box, `${p.id} is drawn`).not.toBeNull();
  for (const l of found.labels) {
    expect(overlap(l.box, found.inspector!), `readout of ${l.id} vs the Inspector`).toBe(false);
    for (const p of found.partBoxes)
      if (p.id !== l.id)
        expect(overlap(l.box, p.box!), `readout of ${l.id} vs ${p.id}`).toBe(false);
  }
}

for (const size of SIZES)
  test.describe(`${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test(`A: truth table discoverable, active row follows the circuit, level vs voltage, keyboard (${size.name})`, async ({
      page,
    }) => {
      await openExample(page, 'logic-and-switches');
      for (const lc of LOCALES) {
        await locale(page, lc);
        await inspect(page, 'U1');
        const view = page.getByTestId('logic-state');
        await expect(view).toBeVisible();
        // The panel's tables are labelled for assistive technology.
        await expect(page.getByTestId('logic-truth')).toHaveAttribute('aria-labelledby', /.+/);
        await expect(page.getByTestId('logic-pins')).toHaveAttribute('aria-labelledby', /.+/);
        // Discoverable: the controls and the truth table come before the per-pin details.
        await page.getByTestId('logic-truth').scrollIntoViewIfNeeded();
        await onScreenIn(page, page.getByTestId('logic-truth'));
        await shot(page, `s21l-${size.name}-${lc}-A-idle`);
        await page.getByTestId('sim-run').click();
        await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
        await inspect(page, 'U1');
        // SW1 closed, SW2 open (as shipped): row HL.
        await expect(page.getByTestId('logic-truth-HL')).toHaveAttribute('aria-current', 'true');
        // Level and simulated voltage are separate columns; the output states its guarantee.
        await expect(page.getByTestId('logic-level-a')).toHaveText('HIGH');
        await expect(page.getByTestId('logic-volts-a')).toHaveText('5.5 V');
        await expect(page.getByTestId('logic-volts-a')).toHaveAttribute('dir', 'ltr');
        await expect(page.getByTestId('logic-why-y')).toContainText(/V_OL ≤ \W*100 mV/);
        // Keyboard: focus SW2's control and press Space: the row follows (HH), the LED lights.
        const sw2 = page.getByTestId('logic-control-SW2');
        await sw2.focus();
        await expect(sw2).toBeFocused();
        await page.keyboard.press('Space');
        await expect(sw2).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByTestId('logic-truth-HH')).toHaveAttribute('aria-current', 'true');
        await expect(page.getByTestId('logic-truth-HL')).not.toHaveAttribute(
          'aria-current',
          'true',
        );
        await expect(page.getByTestId('logic-why-y')).toContainText(/V_OH ≥ \W*2\.4 V/);
        await expect(page.getByTestId('logic-why-y')).toContainText(/16 mA/);
        await page.getByTestId('logic-truth').scrollIntoViewIfNeeded();
        await onScreenIn(page, page.getByTestId('logic-truth'));
        await shot(page, `s21l-${size.name}-${lc}-A-run-HH`);
        await readoutsClear(page, [
          'U1',
          'SW1',
          'SW2',
          'R1',
          'R2',
          'R3',
          'D1',
          'PSU1',
          'PSU2',
          'R4',
        ]);
        // Back to the shipped state for the next locale.
        await sw2.focus();
        await page.keyboard.press('Space');
        await expect(page.getByTestId('logic-truth-HL')).toHaveAttribute('aria-current', 'true');
        await page.getByTestId('sim-stop').click();
        await expect(status(page)).toHaveAttribute('data-status', 'stopped');
      }
      await locale(page, 'en');
    });

    test(`A without R2: a floating input is identified by pin; "No row" says why (${size.name})`, async ({
      page,
    }) => {
      await openExample(page, 'logic-and-switches');
      await inspect(page, 'R2');
      await page.getByTestId('inspector-delete').click();
      await waitSaved(page);
      for (const lc of LOCALES) {
        await locale(page, lc);
        await page.getByTestId('sim-run').click();
        await expect(page.getByTestId('sim-error')).toBeVisible();
        await inspect(page, 'U1');
        await expect(page.getByTestId('logic-pin-b')).toHaveAttribute('data-level', 'floating');
        await expect(page.getByTestId('logic-no-row')).toBeVisible();
        await shot(page, `s21l-${size.name}-${lc}-A-floating`);
      }
      await locale(page, 'en');
    });

    test(`D (ESP32): the logic controls are never under the ESP32 terminal; the refusal is explained (${size.name})`, async ({
      page,
      request,
    }) => {
      await request.post(`${FAKE}/__test/capacity?n=4096`);
      await openExample(page, 'esp32-logic-override');
      await buildProgram(page);
      for (const lc of LOCALES) {
        await locale(page, lc);
        await inspect(page, 'U2');
        const controls = page.getByTestId('logic-controls');
        const terminal = page.getByTestId('mcu-terminal');
        await expect(controls).toBeVisible();
        await expect(terminal).toBeVisible();
        await controls.scrollIntoViewIfNeeded();
        expect(overlap(await box(controls), await box(terminal)), 'controls vs terminal').toBe(
          false,
        );
        await onScreenIn(page, controls);
        // A real click on the switch control lands on it (not on the terminal).
        await page.getByTestId('logic-control-SW1').click();
        await expect(page.getByTestId('logic-control-SW1')).toHaveAttribute('aria-pressed', 'true');
        await page.getByTestId('logic-control-SW1').click();
        await expect(page.getByTestId('logic-control-SW1')).toHaveAttribute(
          'aria-pressed',
          'false',
        );
        // Run (Sprint 22 Q1 strict): before setup() GPIO18 is an input and A sits on its 10 kΩ
        // pull-down, ≈ 50 mV off GND (I_I × R) — not the I_CC test condition (5.5 V or GND), so the
        // supply's current limit is refused by name at once (deterministic: the first solve).
        await page.getByTestId('sim-run').click();
        await expect(page.getByTestId('sim-error')).toHaveAttribute(
          'data-code',
          'logic_supply_current_uncharacterized',
          { timeout: 20_000 },
        );
        await expect(page.getByTestId('sim-error')).toContainText(
          lc === 'en' ? 'current limit' : 'מגבלת הזרם',
        );
        await inspect(page, 'U2');
        await expect(page.getByTestId('logic-pin-y')).toHaveAttribute(
          'data-level',
          'not_simulated',
        );
        await controls.scrollIntoViewIfNeeded();
        expect(
          overlap(await box(controls), await box(terminal)),
          'after Run: controls vs terminal',
        ).toBe(false);
        await shot(page, `s21l-${size.name}-${lc}-D-refused`);
        // A refused session shows no canvas readout at all (nothing to overlap).
        await expect(page.locator('[data-testid="canvas"] text.runtime-label')).toHaveCount(0);
      }
      await locale(page, 'en');
    });

    test(`the owner's circuit: as drawn no reference / unpowered gate; corrected at 5 V refused by Q1, at 5.5 V HIGH with V_OH ≥ 5.4 V (${size.name})`, async ({
      page,
    }) => {
      // Exactly as drawn: PSU− unconnected → no ground reference at all: refused, nothing shown.
      const drawn = ownerCircuit('PSU1.positive', false, 'prj_s21lOwnerDrawn');
      await openImported(page, drawn.doc);
      await waitSaved(page);
      for (const lc of LOCALES) {
        await locale(page, lc);
        await page.getByTestId('sim-run').click();
        await expect(page.getByTestId('sim-error')).toHaveAttribute('data-code', 'no_ground');
        await inspect(page, drawn.u);
        await expect(page.getByTestId('logic-pin-y')).toHaveAttribute(
          'data-level',
          'not_simulated',
        );
        await shot(page, `s21l-${size.name}-${lc}-owner-as-drawn`);
      }
      // GND wire still on PSU+, but a reference on PSU−: V_CC − GND = 0 V → unpowered. This is
      // the DEV-Lab acceptance fixture (owner-shot-as-drawn.json): before Run, the circuit
      // checks say the gate's supply pins share a net and nothing is across the supply.
      const off = ownerCircuit('PSU1.positive', true, 'prj_s21lOwnerOff');
      await openImported(page, off.doc);
      await waitSaved(page);
      for (const lc of LOCALES) {
        await locale(page, lc);
        const checks = page.getByTestId('circuit-checks');
        await expect(checks.getByTestId('check-supply_pins_shorted')).toContainText(off.u);
        await expect(checks.getByTestId('check-supply_pins_shorted')).toContainText(
          lc === 'en' ? 'V_CC and GND are wired to the same net' : 'מחוברים לאותה רשת',
        );
        await expect(checks.getByTestId('check-psu_no_load')).toContainText('PSU1');
        await expect(page.getByTestId(`check-marker-${off.u}.gnd`)).toBeVisible();
        await shot(page, `s21l-${size.name}-${lc}-owner-checks`);
        await page.getByTestId('sim-run').click();
        await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
        await inspect(page, off.u);
        await expect(page.getByTestId('logic-pin-y')).toHaveAttribute('data-level', 'off');
        await expect(page.getByTestId('logic-pin-a')).toHaveAttribute('data-level', 'off');
        await expect(page.getByTestId('logic-no-row')).toBeVisible();
        await shot(page, `s21l-${size.name}-${lc}-owner-unpowered`);
        await page.getByTestId('sim-stop').click();
      }
      // Corrected (GND on PSU−) at 5 V: A and B at 5 V are not the I_CC test voltage (V_I = 5.5 V
      // or GND, §5.5): Sprint 22 Q1 (strict) refuses the supply's current limit by name.
      const fixed = ownerCircuit('PSU1.negative', true, 'prj_s21lOwnerFixed');
      await openImported(page, fixed.doc);
      await waitSaved(page);
      await expect(page.getByTestId('check-supply_pins_shorted')).toHaveCount(0);
      await expect(page.getByTestId('check-psu_no_load')).toHaveCount(0);
      for (const lc of LOCALES) {
        await locale(page, lc);
        await page.getByTestId('sim-run').click();
        const err = page.getByTestId('sim-error');
        await expect(err).toHaveAttribute('data-code', 'logic_supply_current_uncharacterized');
        await expect(err).toContainText(lc === 'en' ? 'current limit' : 'מגבלת הזרם');
        await expect(err).toContainText('5.5');
        await shot(page, `s21l-${size.name}-${lc}-owner-fixed-5v`);
      }
      // The same circuit at 5.5 V (V_CC and both inputs at 5.5 V: the test condition): runs.
      // (With a 10 kΩ bleeder: unloaded, PSU1 could otherwise have to sink the inputs' leakage.)
      const fixed55 = ownerCircuit('PSU1.negative', true, 'prj_s21lOwnerFixed55', 5.5, true);
      await openImported(page, fixed55.doc);
      await waitSaved(page);
      for (const lc of LOCALES) {
        await locale(page, lc);
        await page.getByTestId('sim-run').click();
        await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
        await inspect(page, fixed55.u);
        await expect(page.getByTestId('logic-level-y')).toHaveText('HIGH');
        await expect(page.getByTestId('logic-volts-y')).toHaveText('5.5 V');
        await expect(page.getByTestId('logic-why-y')).toContainText(/V_OH ≥ \W*5\.4 V/);
        await expect(page.getByTestId('logic-why-y')).toContainText(/100 µA/);
        await expect(page.getByTestId('logic-truth-HH')).toHaveAttribute('aria-current', 'true');
        await shot(page, `s21l-${size.name}-${lc}-owner-fixed`);
        await page.getByTestId('sim-stop').click();
      }
      await locale(page, 'en');
    });
  });

/**
 * The owner's screenshot circuit (d855acf4): PSU1 5 V / 100 mA; U1 (logic.gate_and, SN74LVC1G08)
 * with V_CC, A and B on PSU+; its GND wire on `gnd`. `ground`: GND1 wired to PSU− (as drawn it is
 * not: PSU− is unconnected, so the circuit has no reference at all).
 */
function ownerCircuit(
  gnd: string,
  ground = true,
  id = 'prj_s21lOwner',
  volts = 5,
  bleeder = false,
) {
  let doc: ProjectDocument = createProject({
    projectId: id,
    deviceId: 'dev_s21l',
    name: id,
    appVersion: '0',
  });
  const r = addComponent(doc, 'logic.gate_and', { x: -280, y: 0 });
  if (!r.ok) throw new Error(r.error);
  doc = r.doc;
  const u = r.id;
  const wire = (p: string, q: string) => {
    const [pc, pt] = p.split('.') as [string, string];
    const [qc, qt] = q.split('.') as [string, string];
    const w = addWire(
      doc,
      { kind: 'terminal', component: pc, terminal: pt },
      { kind: 'terminal', component: qc, terminal: qt },
    );
    if (!w.ok) throw new Error(`${p}->${q}: ${w.error}`);
    doc = w.doc;
  };
  const set = (c: string, k: string, v: Parameters<typeof setParam>[3]) => {
    const x = setParam(doc, c, k, v);
    if (!x.ok) throw new Error(x.error);
    doc = x.doc;
  };
  set('PSU1', 'setpointVoltage', { value: volts, unit: 'volt' });
  set('PSU1', 'currentLimit', { value: 0.1, unit: 'ampere' });
  set('PSU1', 'outputEnabled', true);
  if (ground) wire('PSU1.negative', 'GND1.ref');
  wire(`${u}.vcc`, 'PSU1.positive');
  wire(`${u}.a`, 'PSU1.positive');
  wire(`${u}.b`, 'PSU1.positive');
  wire(`${u}.gnd`, gnd);
  if (bleeder) {
    // Sprint 22 review 3: keeps PSU1 delivering (no sinking model; input leakage could return).
    const r = addComponent(doc, 'component.resistor', { x: -280, y: 240 });
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
    set(r.id, 'resistance', { value: 10_000, unit: 'ohm' });
    wire('PSU1.positive', `${r.id}.a`);
    wire(`${r.id}.b`, ground ? 'GND1.ref' : 'PSU1.negative');
  }
  return { doc, u };
}

/**
 * Sprint 22 (P5): the examples' probe labels ("V(U2.y) = …", "I(D1) = …") never sit on a part's
 * reference or value label, nor on another part's body — measured in one in-page snapshot.
 */
async function probeLabelsClear(page: Page) {
  const found = await page.evaluate(() => {
    const r = (e: Element) => {
      const b = e.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    const canvas = document.querySelector('[data-testid="canvas"]')!;
    const probes = [...canvas.querySelectorAll('text.probe-label')].map((e) => ({
      text: e.textContent ?? '',
      box: r(e),
    }));
    const labels = [...canvas.querySelectorAll('text.ref-label, text.value-label')].map((e) => ({
      text: e.textContent ?? '',
      box: r(e),
    }));
    return { probes, labels };
  });
  const hit = (a: Box, b: Box) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  expect(found.probes.length, 'probe labels').toBeGreaterThan(0);
  for (const p of found.probes)
    for (const l of found.labels)
      expect(hit(p.box, l.box), `probe "${p.text}" vs label "${l.text}"`).toBe(false);
}

for (const size of SIZES.slice(0, 2))
  test.describe(`${size.name} probe labels`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    for (const id of ['logic-and-switches', 'esp32-logic-override'])
      test(`${id}: probe labels clear of the reference and value labels, idle and running (${size.name})`, async ({
        page,
      }) => {
        await openExample(page, id);
        for (const lc of LOCALES) {
          await locale(page, lc);
          await probeLabelsClear(page);
          if (id === 'logic-and-switches') {
            await page.getByTestId('sim-run').click();
            await expect(status(page)).toHaveAttribute('data-status', 'running', {
              timeout: 30_000,
            });
            await probeLabelsClear(page);
            if (SHOTS)
              await page.screenshot({ path: `${SHOTS}/s22l-${size.name}-${lc}-${id}-probes.png` });
            await page.getByTestId('sim-stop').click();
          } else if (SHOTS)
            await page.screenshot({ path: `${SHOTS}/s22l-${size.name}-${lc}-${id}-probes.png` });
        }
      });
  });
