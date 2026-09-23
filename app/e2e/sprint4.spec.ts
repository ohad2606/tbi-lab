/**
 * Sprint 4 acceptance: the complete non-MCU laboratory core in real Chromium. Every displayed
 * electrical value is checked against the production engine on the same stored project.
 */
import { expect, test, type Page } from '@playwright/test';
import { createSnapshot, type ProjectDocument } from '@tbi-lab/domain';
import { EngineSession, type SolveSuccess } from '@tbi-lab/engine';
import { getLocale } from '../src/i18n/i18n.js';
import { formatResult } from '../src/sim/format.js';
import { link, run, setValue } from './circuits.js';
import {
  component,
  createProject,
  place,
  storedProject,
  storedProjects,
  terminal,
  waitForStoredProject,
  waitSaved,
} from './helpers.js';

const en = getLocale('en');
const A = (v: number | null) => (v === null ? 'not defined' : formatResult(en, v, 'ampere'));
const V = (v: number | null) => (v === null ? 'not defined' : formatResult(en, v, 'volt'));
const status = (page: Page) => page.getByTestId('sim-status');
const select = (page: Page, id: string) => component(page, id).locator('.component-hit').click();

/** The production engine on the stored project (named, when several are stored). */
async function truth(page: Page, name?: string): Promise<SolveSuccess> {
  const doc =
    name === undefined
      ? await storedProject(page)
      : (await storedProjects(page)).find((p) => p.name === name)!;
  const o = new EngineSession(createSnapshot(doc)).solve();
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o;
}

async function enableOutput(page: Page) {
  await select(page, 'PSU1');
  await page.getByTestId('param-PSU1-outputEnabled').check();
}

async function probe(page: Page, target: () => Promise<void>) {
  await page.getByTestId('canvas-probe').click();
  await target();
  await page.keyboard.press('Escape');
}

/** PSU1 -> <part> -> R1 (1 kΩ) -> GND. Parts at x=0 (switch/diode) and x=140 (R1). */
async function seriesBench(
  page: Page,
  part: string,
  name: string,
  pins: [string, string] = ['a', 'b'],
) {
  await createProject(page, name);
  await place(page, part, { x: 0, y: -20 });
  await place(page, 'component.resistor', { x: 140, y: 80 });
  const ref = part === 'component.diode' ? 'D1' : 'SW1';
  await link(page, ['PSU1', 'positive'], [ref, pins[0]]);
  await link(page, [ref, pins[1]], ['R1', 'a']); // current flows R1 a -> b (positive)
  await link(page, ['R1', 'b'], ['GND1', 'ref']);
  await link(page, ['PSU1', 'negative'], ['GND1', 'ref']);
  await enableOutput(page);
  await waitForStoredProject(
    page,
    (d) =>
      d.components[0]!.params.outputEnabled === true &&
      d.connections.some((c) => c.component === 'R1' && c.terminal === 'b'),
    'bench stored',
    name,
  );
  return ref;
}

test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

test('A1/A2: diode forward conducts and reverse blocks, matching the production engine', async ({
  page,
}) => {
  await seriesBench(page, 'component.diode', 'Diode forward', ['anode', 'cathode']);
  await run(page);
  let t = await truth(page, 'Diode forward');
  await select(page, 'D1');
  await expect(page.getByTestId('result-D1')).toHaveText(
    `${V(t.components.D1!.voltage)} · ${A(t.components.D1!.current)}`,
  );
  expect(t.components.D1!.current!).toBeGreaterThan(4e-3);
  expect(t.components.D1!.voltage!).toBeGreaterThan(0.6);
  await page.getByTestId('sim-stop').click();

  await seriesBench(page, 'component.diode', 'Diode reverse', ['cathode', 'anode']);
  await run(page);
  t = await truth(page, 'Diode reverse');
  await select(page, 'D1');
  expect(Math.abs(t.components.D1!.current!)).toBeLessThan(1e-8); // blocking: nA only
  await expect(page.getByTestId('result-voltage')).toHaveText(V(t.components.D1!.voltage));
  await expect(page.getByTestId('result-current')).toHaveText(A(t.components.D1!.current));
});

test('A3/A4: push button conducts only while held; pressing never touches the project', async ({
  page,
}) => {
  await seriesBench(page, 'component.push_button', 'Button bench');
  await run(page);
  await probe(page, () => select(page, 'R1'));
  const reading = page.getByTestId('probe-reading-R1');
  await expect(reading).toHaveText('I(R1) = 0 A');
  const bytes = JSON.stringify(await storedProject(page));

  // Pointer: press and hold, then release.
  const box = (await page.getByTestId('actuator-SW1').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(reading).toHaveText('I(R1) = 5 mA');
  await expect(component(page, 'SW1')).toHaveAttribute('data-pressed', 'true');
  await page.mouse.up();
  await expect(reading).toHaveText('I(R1) = 0 A');
  await expect(component(page, 'SW1')).toHaveAttribute('data-pressed', 'false');

  // Pointer cancel (e.g. the OS takes the pointer away) releases a held button.
  await page.mouse.down();
  await expect(reading).toHaveText('I(R1) = 5 mA');
  await page.getByTestId('canvas').dispatchEvent('pointercancel', { pointerId: 1 });
  await expect(reading).toHaveText('I(R1) = 0 A');
  await expect(component(page, 'SW1')).toHaveAttribute('data-pressed', 'false');
  await page.mouse.up();
  await expect(reading).toHaveText('I(R1) = 0 A');

  // Keyboard: Space held on the focused button is momentary, not a toggle.
  await component(page, 'SW1').focus();
  await page.keyboard.down('Space');
  await expect(reading).toHaveText('I(R1) = 5 mA');
  await page.keyboard.up('Space');
  await expect(reading).toHaveText('I(R1) = 0 A');

  // Losing focus while held releases it: a button can never stay stuck.
  await component(page, 'SW1').focus();
  await page.keyboard.down('Space');
  await expect(reading).toHaveText('I(R1) = 5 mA');
  await page.getByTestId('project-name').focus();
  await expect(reading).toHaveText('I(R1) = 0 A');
  await page.keyboard.up('Space');

  // Every re-solve was real (worker round trips), and the project never changed.
  expect(Number(await status(page).getAttribute('data-solves'))).toBeGreaterThanOrEqual(9);
  await page.waitForTimeout(400); // longer than the autosave debounce: nothing may be written
  expect(JSON.stringify(await storedProject(page))).toBe(bytes);
  await expect(page.getByTestId('undo')).toBeEnabled(); // history holds only real edits
  await page.getByTestId('sim-stop').click();
  await run(page);
  await expect(component(page, 'SW1')).toHaveAttribute('data-pressed', 'false');
});

test('A5/A6: toggle position persists; while running it is persisted first, then re-solved', async ({
  page,
}) => {
  await seriesBench(page, 'component.toggle_switch', 'Toggle bench');
  const r0 = (await storedProject(page)).revision.localRevision;
  // Stopped: an ordinary persistent edit.
  await page.getByTestId('actuator-SW1').click();
  const closed = await waitForStoredProject(
    page,
    (d) => d.components.find((c) => c.id === 'SW1')!.params.closed === true,
    'SW1 closed',
  );
  expect(closed.revision.localRevision).toBe(r0 + 1);
  await expect(component(page, 'SW1')).toHaveAttribute('data-closed', 'true');

  // Reopen restores the saved position.
  await page.reload();
  await expect(component(page, 'SW1')).toHaveAttribute('data-closed', 'true');

  // Running: toggle open -> stored first -> mirrored with that revision -> real re-solve.
  await run(page);
  await probe(page, () => select(page, 'R1'));
  await expect(page.getByTestId('probe-reading-R1')).toHaveText('I(R1) = 5 mA');
  await page.getByTestId('actuator-SW1').click();
  const open = await waitForStoredProject(
    page,
    (d) => d.components.find((c) => c.id === 'SW1')!.params.closed === false,
    'SW1 open',
  );
  await expect(status(page)).toHaveAttribute(
    'data-applied-revision',
    String(open.revision.localRevision),
  );
  await expect(page.getByTestId('probe-reading-R1')).toHaveText('I(R1) = 0 A');
  await expect(status(page)).toHaveAttribute('data-solves', '2');
  // Undo is a live edit too: allowed while running, persisted, mirrored, re-solved.
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('probe-reading-R1')).toHaveText('I(R1) = 5 mA');
  await waitForStoredProject(
    page,
    (d) => d.components.find((c) => c.id === 'SW1')!.params.closed === true,
    'undo stored',
  );
});

test('A8: PSU panel shows settings apart from measured V/I and OFF / CV / CC', async ({ page }) => {
  await createProject(page, 'PSU panel');
  await place(page, 'component.resistor', { x: 60, y: 60 });
  await link(page, ['PSU1', 'positive'], ['R1', 'b']);
  await link(page, ['R1', 'a'], ['GND1', 'ref']);
  await link(page, ['PSU1', 'negative'], ['GND1', 'ref']);
  await setValue(page, 'R1', 'resistance', '10');
  await select(page, 'PSU1');
  const panel = page.getByTestId('psu-panel');
  await expect(page.getByTestId('psu-mode')).toHaveAttribute('data-mode', 'none'); // not running
  await expect(page.getByTestId('psu-measured-voltage')).toHaveText('—');
  await run(page);
  await expect(page.getByTestId('psu-mode')).toHaveAttribute('data-mode', 'off');
  await expect(page.getByTestId('psu-measured-current')).toHaveText('0 A');
  await page.getByTestId('param-PSU1-outputEnabled').check();
  // 5 V into 10 Ω wants 500 mA; the 100 mA default limit puts the supply in CC.
  await expect(page.getByTestId('psu-mode')).toHaveAttribute('data-mode', 'cc');
  await expect(page.getByTestId('psu-measured-current')).toHaveText('100 mA');
  await expect(page.getByTestId('psu-measured-voltage')).toHaveText('1 V');
  await expect(panel).toContainText('not a fault');
  await expect(page.getByTestId('sim-error')).toHaveCount(0);
  const limit = page.getByTestId('param-PSU1-currentLimit');
  await limit.fill('1');
  await limit.press('Enter');
  await expect(page.getByTestId('psu-mode')).toHaveAttribute('data-mode', 'cv');
  await expect(page.getByTestId('psu-measured-current')).toHaveText('500 mA');
  await expect(page.getByTestId('psu-measured-voltage')).toHaveText('5 V');
});

test('A9: probes read node voltage to GND and branch current without changing anything', async ({
  page,
}) => {
  await createProject(page, 'Probes');
  await place(page, 'component.resistor', { x: 60, y: -20 });
  await place(page, 'component.resistor', { x: 60, y: 80 });
  await link(page, ['PSU1', 'positive'], ['R1', 'a']);
  await link(page, ['R1', 'b'], ['R2', 'b']);
  await link(page, ['R2', 'a'], ['GND1', 'ref']);
  await link(page, ['PSU1', 'negative'], ['GND1', 'ref']);
  await enableOutput(page);
  await waitForStoredProject(
    page,
    (d) => d.components[0]!.params.outputEnabled === true,
    'output on',
  );
  const bytes = JSON.stringify(await storedProject(page));
  await run(page);
  const before = await truth(page);
  await probe(page, async () => {
    await terminal(page, 'R2', 'b').locator('.terminal-hit').click(); // divider midpoint
    await select(page, 'R1');
  });
  // 5 V across 1 kΩ + 1 kΩ: 2.5 V at the midpoint, 2.5 mA.
  await expect(page.getByTestId('probe-reading-R2.b')).toHaveText('V(R2.b) = 2.5 V');
  await expect(page.getByTestId('probe-reading-R1')).toHaveText('I(R1) = 2.5 mA');
  await expect(page.getByTestId('probe-R2.b')).toBeVisible();
  const after = await truth(page);
  expect(after.components.R1!.current).toBe(before.components.R1!.current); // no loading
  expect(JSON.stringify(await storedProject(page))).toBe(bytes); // probes are not project data
  await page.getByTestId('sim-stop').click();
  await expect(page.getByTestId('probe-reading-R1')).toHaveText('I(R1) = —');
});

test('A10/A11: undo/redo of project edits with new revisions and stable ids (keyboard too)', async ({
  page,
}) => {
  await createProject(page, 'Undo');
  await place(page, 'component.resistor', { x: 60, y: 0 });
  await waitForStoredProject(page, (d) => d.components.some((c) => c.id === 'R1'), 'R1');
  await setValue(page, 'R1', 'resistance', '4k7');
  const r1 = await waitForStoredProject(
    page,
    (d) =>
      (d.components.find((c) => c.id === 'R1')!.params.resistance as { value: number }).value ===
      4700,
    '4k7',
  );
  await page.getByTestId('canvas').click({ position: { x: 5, y: 5 } }); // focus canvas, not an input
  await page.keyboard.press('Control+z');
  const undone = await waitForStoredProject(
    page,
    (d) =>
      (d.components.find((c) => c.id === 'R1')?.params.resistance as { value: number })?.value ===
      1000,
    'value undone',
  );
  expect(undone.revision.localRevision).toBe(r1.revision.localRevision + 1);
  await page.keyboard.press('Control+z');
  await waitForStoredProject(
    page,
    (d) => !d.components.some((c) => c.id === 'R1'),
    'placement undone',
  );
  await page.keyboard.press('Control+Shift+z');
  const redone = await waitForStoredProject(
    page,
    (d) => d.components.some((c) => c.id === 'R1'),
    'placement redone',
  );
  expect(redone.revision.localRevision).toBe(r1.revision.localRevision + 3); // monotonic
  await page.keyboard.press('Control+y');
  await waitForStoredProject(
    page,
    (d) =>
      (d.components.find((c) => c.id === 'R1')!.params.resistance as { value: number }).value ===
      4700,
    'value redone',
  );
  // Undo the placement again, then place anew: the consumed id R1 is not reissued.
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await waitForStoredProject(page, (d) => !d.components.some((c) => c.id === 'R1'), 'undone twice');
  await place(page, 'component.resistor', { x: 60, y: 0 });
  await waitForStoredProject(page, (d) => d.components.some((c) => c.id === 'R2'), 'next id is R2');
  await expect(page.getByTestId('redo')).toBeDisabled();
  // Language changes are not history.
  const undoDepth = await page.getByTestId('undo').isEnabled();
  await page.getByTestId('language-select').selectOption('he');
  await page.getByTestId('language-select').selectOption('en');
  expect(await page.getByTestId('undo').isEnabled()).toBe(undoDepth);
});

test('A12/A13: unwired notice, partial-wiring and wire-over-terminal checks; nothing auto-connects', async ({
  page,
}) => {
  await createProject(page, 'Checks');
  await place(page, 'component.resistor', { x: 60, y: 0 });
  // R1.b -> GND is auto-routed back across R1's own terminal a (not connected to it).
  await link(page, ['R1', 'b'], ['GND1', 'ref']);
  await place(page, 'component.led', { x: 60, y: 140 });
  await waitSaved(page);
  const checks = page.getByTestId('circuit-checks');
  // (The auto-route also crosses a PSU terminal: each ambiguity is reported separately.)
  await expect(
    checks.getByTestId('check-wire_over_terminal').filter({ hasText: 'R1' }),
  ).toContainText('without connecting');
  // R1.a carries two markers: it is unwired (partial wiring) AND a wire crosses it.
  await expect(
    page.locator('[data-testid="check-marker-R1.a"][data-code="wire_over_terminal"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="check-marker-R1.a"][data-code="partially_wired"]'),
  ).toHaveCount(1);
  await expect(checks.getByTestId('check-partially_wired')).toContainText('R1');
  await expect(checks.getByTestId('check-not_connected').filter({ hasText: 'D1' })).toContainText(
    'D1',
  );
  const doc: ProjectDocument = await storedProject(page);
  expect(doc.connections.some((c) => c.component === 'R1' && c.terminal === 'a')).toBe(false);
  // Complete the circuit; the partial-wiring warning goes, the ambiguity stays until redrawn.
  await link(page, ['PSU1', 'positive'], ['R1', 'a']);
  await link(page, ['PSU1', 'negative'], ['GND1', 'ref']);
  await expect(checks.getByTestId('check-partially_wired')).toHaveCount(0);
  await enableOutput(page);
  await run(page);
  await expect(page.getByTestId('sim-not-connected')).toContainText('D1'); // omitted, not blocking
  await expect(page.getByTestId('result-PSU1')).toHaveText(/ · CV$/);
});

test('A12: a connected floating island is diagnosed, never silently skipped', async ({ page }) => {
  await createProject(page, 'Floating');
  await place(page, 'component.resistor', { x: 60, y: -20 });
  await link(page, ['PSU1', 'positive'], ['R1', 'a']);
  await link(page, ['R1', 'b'], ['GND1', 'ref']);
  await link(page, ['PSU1', 'negative'], ['GND1', 'ref']);
  await place(page, 'component.resistor', { x: -40, y: 200 });
  await place(page, 'component.diode', { x: 100, y: 200 });
  await link(page, ['R2', 'b'], ['D1', 'anode']);
  await link(page, ['D1', 'cathode'], ['R2', 'a']);
  await expect(
    page.getByTestId('circuit-checks').getByTestId('check-floating_island'),
  ).toContainText('R2, D1');
  await enableOutput(page);
  await run(page);
  await expect(page.getByTestId('sim-error')).toHaveAttribute('data-code', 'floating_circuit');
});

test('A14: two GND symbols are one reference: the loop closes through both', async ({ page }) => {
  await createProject(page, 'Two grounds');
  await place(page, 'component.resistor', { x: 60, y: -20 });
  await place(page, 'component.ground', { x: 160, y: 100 });
  await link(page, ['PSU1', 'positive'], ['R1', 'a']);
  await link(page, ['R1', 'b'], ['GND2', 'ref']);
  await link(page, ['PSU1', 'negative'], ['GND1', 'ref']);
  await enableOutput(page);
  await waitForStoredProject(
    page,
    (d) => d.nets.filter((n) => n.role === 'ground').length === 2,
    'two ground nets',
  );
  await run(page);
  await select(page, 'R1');
  await expect(page.getByTestId('result-R1')).toHaveText('5 mA');
});

test('A15: English and Hebrew show identical engineering results for Sprint 4 features', async ({
  page,
}) => {
  await seriesBench(page, 'component.toggle_switch', 'Parity');
  // 1. The engineering edit (a real, persistent toggle), then wait until exactly that state is
  //    durable. Capturing bytes before its debounced autosave lands compares two different
  //    engineering states (CI run 35884629891: rev 8 / open vs rev 9 / closed).
  await page.getByTestId('actuator-SW1').click();
  const edited = await waitForStoredProject(
    page,
    (d) => d.components.find((c) => c.id === 'SW1')!.params.closed === true,
    'toggle SW1 closed is durable',
  );
  await run(page);
  await probe(page, () => select(page, 'R1'));
  await select(page, 'PSU1');
  // Locale formatting may add invisible bidi marks (Hebrew puts U+200E before a minus sign);
  // the engineering values themselves must be identical.
  const plain = (text: string | null) => (text ?? '').replace(/[\u200e\u200f\u2066-\u2069]/g, '');
  const read = async () => ({
    probe: plain(await page.getByTestId('probe-reading-R1').textContent()),
    v: plain(await page.getByTestId('psu-measured-voltage').textContent()),
    i: plain(await page.getByTestId('psu-measured-current').textContent()),
    mode: await page.getByTestId('psu-mode').getAttribute('data-mode'),
    sw: await component(page, 'SW1').getAttribute('data-closed'),
  });
  // 2. Baseline AFTER all intended edits: the persisted bytes and the English results.
  const bytes = JSON.stringify(await storedProject(page));
  expect(bytes).toBe(JSON.stringify(edited)); // nothing else was written since the toggle
  const english = await read();
  expect(english).toMatchObject({ probe: 'I(R1) = 5 mA', mode: 'cv', sw: 'true' });
  // 3. Locale only.
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.getByTestId('psu-panel')).toContainText('ספק כוח מעבדתי');
  await expect(page.getByTestId('probes-section')).toContainText('נקודות מדידה');
  // 4. Identical engineering results, and the locale switch wrote nothing (waiting past the
  //    autosave debounce proves an absence of writes; it is not a race fix).
  expect(await read()).toEqual(english);
  await page.waitForTimeout(400);
  expect(JSON.stringify(await storedProject(page))).toBe(bytes);
  expect(
    await page.getByTestId('probe-reading-R1').evaluate((el) => getComputedStyle(el).direction),
  ).toBe('ltr');
  await expect(page.getByTestId('palette-component.push_button')).toContainText('לחצן');
  await expect(page.getByTestId('palette-component.toggle_switch')).toContainText('מתג');
  await expect(page.getByTestId('palette-component.diode')).toContainText('דיודה');
});

test('A15: new Sprint 4 surfaces are fully translated in Hebrew (technical tokens only)', async ({
  page,
}) => {
  await createProject(page, 'Hebrew surfaces');
  await place(page, 'component.push_button', { x: 0, y: -20 });
  await place(page, 'component.toggle_switch', { x: 120, y: -20 });
  await place(page, 'component.diode', { x: 60, y: 100 });
  await link(page, ['PSU1', 'positive'], ['SW1', 'a']);
  await page.getByTestId('language-select').selectOption('he');
  await run(page);
  await probe(page, () => select(page, 'SW1'));
  const allowed = [
    /^TBI$/,
    /^Lab$/,
    /^English$/,
    /^(PSU|R|GND|D|SW)\d+$/,
    /^N_\d+$/,
    /^(GND|LED|DC|CV|CC|OFF)$/,
    /^Vishay$/,
    /^(TLHR5400|N4148)$/, // model names (1N4148 tokenizes as N4148)
    /^Esc$/,
    /^Delete$/,
    /^R$/,
    /^a$/,
    /^b$/,
    /^[VI]$/,
    /^k$/,
    /^\d+k\d*$/,
  ];
  const words = async () => {
    const text = (await page.locator('body').innerText()).replace(
      /[kmMGµunp]?[ΩVA](?![A-Za-z])/g,
      ' ',
    );
    return [
      ...new Set(
        (text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter(
          (w) => !allowed.some((re) => re.test(w)),
        ),
      ),
    ];
  };
  for (const id of ['SW1', 'SW2', 'D1', 'PSU1']) {
    await select(page, id);
    expect(await words(), id).toEqual([]);
  }
  await page.getByTestId('sim-stop').click();
  await select(page, 'D1'); // checks list visible while stopped
  await expect(page.getByTestId('circuit-checks')).toContainText('בדיקות מעגל');
  expect(await words(), 'checks').toEqual([]);
});
