/**
 * Sprint 2 acceptance: schematic editing in the real product, in real Chromium.
 * The persisted document is read back from the real IndexedDB and validated by the same
 * domain validator the product uses (A4: structurally valid after every operation).
 */
import { expect, test, type Page } from '@playwright/test';
import { validateProject, type ProjectDocument } from '@tbi-lab/domain';
import {
  clickWorld,
  component,
  createProject,
  goToProjects,
  place,
  reopenFromLibrary,
  storedProject,
  terminal,
  toScreen,
  waitForStoredProject,
  waitSaved,
  wire,
} from './helpers.js';

/**
 * Wait until the operation just performed has reached IndexedDB (described by `persisted`),
 * then assert the stored document is structurally valid (A4).
 */
async function savedValid(
  page: Page,
  persisted: (doc: ProjectDocument) => boolean,
  what: string,
): Promise<ProjectDocument> {
  const doc = await waitForStoredProject(page, persisted, what);
  expect(validateProject(doc)).toEqual([]);
  return doc;
}

const has = (id: string) => (doc: ProjectDocument) => doc.components.some((c) => c.id === id);

const netOf = (doc: ProjectDocument, c: string, t: string) =>
  doc.connections.find((x) => x.component === c && x.terminal === t)?.net;

test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

test('A1: a project named in Hebrew is created and appears in the recent list', async ({
  page,
}) => {
  await createProject(page, 'מעגל ראשון');
  await expect(page.getByTestId('project-name')).toHaveValue('מעגל ראשון');
  const doc = await savedValid(page, (d) => d.name === 'מעגל ראשון', 'named project');
  expect(doc.name).toBe('מעגל ראשון');
  expect(doc.components.map((c) => c.id)).toEqual(['PSU1', 'GND1']);
  await goToProjects(page);
  await expect(page.getByTestId('project-list')).toContainText('מעגל ראשון');
});

test('A2-A4: place, wire, junction, crossing, delete — valid after every operation', async ({
  page,
}) => {
  await createProject(page, 'Bench');
  // R1 at (0,0): a=(-40,0) b=(40,0). R2 at (0,100): a=(-40,100) b=(40,100).
  // R3 at (140,60): a=(100,60). R4 at (-40,60): b=(0,60).
  await place(page, 'component.resistor', { x: 0, y: 0 });
  await savedValid(page, has('R1'), 'R1 placed');
  await place(page, 'component.resistor', { x: 0, y: 100 });
  await place(page, 'component.resistor', { x: 140, y: 60 });
  await place(page, 'component.resistor', { x: -40, y: 60 });
  let doc = await savedValid(page, has('R4'), 'R4 placed');
  expect(doc.components.map((c) => c.id)).toEqual(['PSU1', 'GND1', 'R1', 'R2', 'R3', 'R4']);
  expect(doc.layout.components.R3).toEqual({ x: 140, y: 60, rotation: 0 });

  // Terminal to terminal.
  await wire(page, ['PSU1', 'positive'], ['R1', 'a']);
  doc = await savedValid(page, (d) => netOf(d, 'R1', 'a') !== undefined, 'PSU1+ to R1.a wired');
  expect(netOf(doc, 'PSU1', 'positive')).toBeDefined();
  expect(netOf(doc, 'PSU1', 'positive')).toBe(netOf(doc, 'R1', 'a'));

  await wire(page, ['PSU1', 'negative'], ['GND1', 'ref']);
  doc = await savedValid(page, (d) => netOf(d, 'GND1', 'ref') !== undefined, 'GND wired');
  expect(doc.nets.find((n) => n.id === netOf(doc, 'GND1', 'ref'))!.role).toBe('ground');

  // End a wire on the middle of an existing wire: a junction forms and the nets join.
  // PSU1.positive (-80,-20) -> R1.a (-40,0) routes via (-40,-20); (-60,-20) lies on it.
  await terminal(page, 'R2', 'a').locator('.terminal-hit').click();
  await clickWorld(page, { x: -60, y: -20 });
  doc = await savedValid(page, (d) => d.layout.junctions.length === 1, 'junction created');
  expect(doc.layout.junctions).toHaveLength(1);
  expect(doc.layout.junctions[0]).toMatchObject({ x: -60, y: -20 });
  expect(netOf(doc, 'R2', 'a')).toBe(netOf(doc, 'R1', 'a'));
  await expect(page.locator('.junctions .junction-dot')).toHaveCount(1);

  // Two wires that geometrically cross at (40,60) are NOT connected.
  await wire(page, ['R1', 'b'], ['R2', 'b']);
  await wire(page, ['R4', 'b'], ['R3', 'a']);
  doc = await savedValid(
    page,
    (d) => netOf(d, 'R1', 'b') !== undefined && netOf(d, 'R4', 'b') !== undefined,
    'both crossing wires stored',
  );
  expect(doc.layout.junctions).toHaveLength(1);
  expect(netOf(doc, 'R1', 'b')).toBe(netOf(doc, 'R2', 'b'));
  expect(netOf(doc, 'R4', 'b')).toBe(netOf(doc, 'R3', 'a'));
  expect(netOf(doc, 'R1', 'b')).not.toBe(netOf(doc, 'R4', 'b'));

  // Delete R2: its wires go, the junction dissolves, no dangling reference remains.
  await component(page, 'R2').locator('.component-hit').click();
  await expect(component(page, 'R2')).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('Delete');
  doc = await savedValid(page, (d) => !has('R2')(d), 'R2 deleted');
  expect(doc.components.some((c) => c.id === 'R2')).toBe(false);
  expect(doc.connections.some((c) => c.component === 'R2')).toBe(false);
  expect(doc.layout.junctions).toEqual([]);
  expect(JSON.stringify(doc.layout.wires)).not.toContain('"R2"');
  await expect(page.locator('.junctions .junction-dot')).toHaveCount(0);

  // A deleted reference is never reused.
  await place(page, 'component.resistor', { x: 0, y: 200 });
  doc = await savedValid(page, (d) => d.components.length === 6, 'fifth resistor placed');
  expect(doc.components.at(-1)!.id).toBe('R5');
});

test('A2: move and rotate keep wires attached; rubber band selects several', async ({ page }) => {
  await createProject(page, 'Move');
  await place(page, 'component.resistor', { x: 0, y: 0 });
  await place(page, 'component.resistor', { x: 0, y: 100 });
  await wire(page, ['PSU1', 'positive'], ['R1', 'a']);
  let doc = await savedValid(page, (d) => netOf(d, 'R1', 'a') !== undefined, 'R1.a wired');
  const net = netOf(doc, 'R1', 'a');

  // Drag R1 by (+80, +40) world units.
  const from = await toScreen(page, { x: 0, y: 0 });
  const to = await toScreen(page, { x: 80, y: 40 });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  doc = await savedValid(page, (d) => d.layout.components.R1?.x === 80, 'R1 moved');
  expect(doc.layout.components.R1).toEqual({ x: 80, y: 40, rotation: 0 });
  expect(netOf(doc, 'R1', 'a')).toBe(net);
  // The drawn wire ends exactly on the moved terminal.
  // (The drawn wire is a path since Sprint 5, so crossings can carry a bridge.)
  const drawn = await page.locator('.wires .wire').first().getAttribute('d');
  expect(
    drawn!
      .trim()
      .split(/[ML ]+/)
      .filter(Boolean)
      .slice(-2)
      .join(','),
  ).toBe('40,40');

  // Rotate with the R key (physical key, layout-independent).
  await page.keyboard.press('r');
  doc = await savedValid(page, (d) => d.layout.components.R1?.rotation === 90, 'R1 rotated');
  expect(doc.layout.components.R1!.rotation).toBe(90);
  expect(netOf(doc, 'R1', 'a')).toBe(net);

  // Rubber band from empty space around both resistors.
  await page.keyboard.press('Escape');
  const a = await toScreen(page, { x: -30, y: -40 });
  const b = await toScreen(page, { x: 130, y: 140 });
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await expect(component(page, 'R1')).toHaveAttribute('data-selected', 'true');
  await expect(component(page, 'R2')).toHaveAttribute('data-selected', 'true');
  await expect(component(page, 'PSU1')).toHaveAttribute('data-selected', 'false');
  await expect(page.getByTestId('inspector')).toContainText('2 items selected');

  // Shift-click adds PSU1 to the selection.
  await component(page, 'PSU1')
    .locator('.component-hit')
    .click({ modifiers: ['Shift'] });
  await expect(component(page, 'PSU1')).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('inspector')).toContainText('3 items selected');
});

test('A5: unit-aware resistance input is stored as canonical SI', async ({ page }) => {
  await createProject(page, 'Values');
  await place(page, 'component.resistor', { x: 0, y: 0 });
  const field = page.getByTestId('param-R1-resistance');
  await expect(field).toHaveValue('1k');

  await field.fill('4k7');
  await field.press('Enter');
  let doc = await savedValid(
    page,
    (d) =>
      JSON.stringify(d.components.find((c) => c.id === 'R1')?.params.resistance) ===
      JSON.stringify({ value: 4700, unit: 'ohm' }),
    'R1 = 4.7 kΩ',
  );
  expect(doc.components.find((c) => c.id === 'R1')!.params.resistance).toEqual({
    value: 4700,
    unit: 'ohm',
  });
  await expect(page.getByTestId('value-R1')).toHaveText('4.7 kΩ');

  await field.fill('220');
  await field.press('Enter');
  doc = await savedValid(
    page,
    (d) =>
      JSON.stringify(d.components.find((c) => c.id === 'R1')?.params.resistance) ===
      JSON.stringify({ value: 220, unit: 'ohm' }),
    'R1 = 220 Ω',
  );
  expect(doc.components.find((c) => c.id === 'R1')!.params.resistance).toEqual({
    value: 220,
    unit: 'ohm',
  });

  // Invalid input is refused with a specific message and changes nothing.
  const before = doc.revision.localRevision;
  await field.fill('abc');
  await field.press('Enter');
  await expect(page.getByTestId('param-R1-resistance-error')).toContainText('Not a valid value');
  await field.fill('2G');
  await field.press('Enter');
  await expect(page.getByTestId('param-R1-resistance-error')).toContainText('must be between');
  doc = await storedProject(page);
  expect(doc.revision.localRevision).toBe(before);

  // PSU values use the same path.
  await component(page, 'PSU1').locator('.component-hit').click();
  const v = page.getByTestId('param-PSU1-setpointVoltage');
  await v.fill('3.3');
  await v.press('Enter');
  doc = await savedValid(
    page,
    (d) =>
      JSON.stringify(d.components[0]!.params.setpointVoltage) ===
      JSON.stringify({ value: 3.3, unit: 'volt' }),
    'PSU1 setpoint = 3.3 V',
  );
  expect(doc.components[0]!.params.setpointVoltage).toEqual({ value: 3.3, unit: 'volt' });
});

test('A6: autosave runs without user action and the indicator reflects reality', async ({
  page,
}) => {
  await createProject(page, 'Autosave');
  await expect(page.getByTestId('save-state')).toHaveText(/All changes saved/);
  const before = (await storedProject(page)).revision.localRevision;
  await place(page, 'component.resistor', { x: 0, y: 0 });
  // Durability of the edit itself, then the indicator must settle on "saved".
  const after = await waitForStoredProject(page, has('R1'), 'R1 placed');
  await waitSaved(page);
  expect(after.revision.localRevision).toBeGreaterThan(before);
  expect(after.components.some((c) => c.id === 'R1')).toBe(true);
});

test('A16 (supersedes Sprint 2 A13): one Run/Stop control is the only simulation control; no value exists before Run', async ({
  page,
}) => {
  await createProject(page, 'Honest');
  await expect(page.getByTestId('sim-run')).toBeEnabled();
  // Product Alpha maintenance: a single stateful control, never Run and Stop at once.
  await expect(page.getByTestId('sim-stop')).toHaveCount(0);
  await expect(page.locator('.sim-controls button')).toHaveCount(1);
  for (const name of [/pause/i, /resume/i, /step/i, /reset/i, /play/i]) {
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  }
  await expect(page.locator('.runtime-label')).toHaveCount(0);
  await expect(page.getByTestId('sim-results')).toHaveCount(0);
});

test('opening a project saved by a newer version is read-only and never written', async ({
  page,
}) => {
  await createProject(page, 'Future');
  const doc = await savedValid(page, (d) => d.name === 'Future', 'project stored');
  await page.evaluate(
    (d) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('tbi-lab');
        req.onsuccess = () => {
          const tx = req.result.transaction('projects', 'readwrite');
          tx.objectStore('projects').put({ ...d, schemaVersion: 4, futureField: { x: 1 } });
          tx.oncomplete = () => (req.result.close(), resolve());
          tx.onerror = () => reject(tx.error);
        };
      }),
    doc,
  );
  await page.reload();
  await reopenFromLibrary(page);
  await expect(page.getByTestId('readonly-banner')).toContainText('read-only');
  await expect(page.getByTestId('palette-component.resistor')).toBeDisabled();
  await expect(page.getByTestId('save-state')).toHaveCount(0);
  await component(page, 'PSU1').locator('.component-hit').click();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(600);
  const stored = await storedProject(page);
  expect(stored.schemaVersion).toBe(4);
  expect(stored.components).toHaveLength(2);
});
