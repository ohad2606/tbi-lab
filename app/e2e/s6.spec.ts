/**
 * Sprint 6 routine browser acceptance: Classic ESP32 projects through the R2 client, against the
 * fake Session Host (real R2 transport + real engine, scripted MCU; app/e2e/fixtures). No QEMU.
 * The same flows run against the real Session Host + QEMU in s6-real.spec.ts (heavy).
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ProjectDocument } from '@tbi-lab/domain';
import {
  buildProgram,
  createProject,
  exportFromMenu,
  goToProjects,
  place,
  reopenFromLibrary,
  storedProject,
  storedProjects,
  terminal,
  waitSaved,
  wire,
} from './helpers.js';

const FAKE = 'http://127.0.0.1:7499';
/** The example sketches' exact source (the examples embed these files). */
const EXAMPLE_SOURCE: Record<string, string> = {
  'esp32-blink': readFileSync(
    new URL('../../runtime/firmware/arduino/TbiGpioProof/TbiGpioProof.ino', import.meta.url),
    'utf8',
  ),
  'esp32-input-echo': readFileSync(
    new URL('../../runtime/firmware/arduino/TbiBanks/TbiBanks.ino', import.meta.url),
    'utf8',
  ),
};
const status = (page: Page) => page.getByTestId('sim-status');
const selectBoard = (page: Page) =>
  page.locator('[data-hit="component"][data-id="U1"] .component-hit').click();

async function openExample(page: Page, id: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  // Sprint 7: an ESP32 example runs its Arduino code, which is built first.
  if (id.startsWith('esp32-')) await buildProgram(page);
}

/** Count requests to the runtime API made by the page. */
function runtimeRequests(page: Page): { count: number } {
  const counter = { count: 0 };
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/runtime')) counter.count++;
  });
  return counter;
}

async function runAndWait(page: Page) {
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
  await expect(status(page)).toHaveAttribute('data-engine', 'mcu');
}

async function stopAndWait(page: Page) {
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 20_000 });
}

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/capacity?n=4096`);
  await request.post(`${FAKE}/__test/end-all?reason=terminated`);
});

test('the board: only runtime-supported pins are connectable; without a build Run is unavailable and says why, offline', async ({
  page,
}) => {
  const calls = runtimeRequests(page);
  await createProject(page, 'Board');
  await place(page, 'board.esp32_devkitc_wroom32', { x: 60, y: 0 });
  for (const ok of ['gpio2', 'gpio4', 'gpio32', 'gpio33', 'gpio34', 'gpio39', 'gnd'])
    await expect(terminal(page, 'U1', ok)).toHaveCount(1);
  // Flash (6-11), UART0 console (1, 3), supplies and EN are drawn but not connectable.
  for (const no of ['gpio6', 'gpio7', 'gpio11', 'gpio1', 'gpio3', '3v3', '5v', 'en'])
    await expect(terminal(page, 'U1', no)).toHaveCount(0);
  await expect(page.locator('.pin-label', { hasText: 'IO34' })).toHaveCount(1);
  await expect(page.locator('.pin-label-unavailable', { hasText: 'CMD' })).toHaveCount(1);
  // Capabilities are shown as the simulator supports them, with the caveats.
  await selectBoard(page);
  await page.getByTestId('mcu-pins').locator('summary').click();
  await expect(page.getByTestId('mcu-pin-34')).toHaveAttribute('data-support', 'digital-input');
  await expect(page.getByTestId('mcu-pin-9')).toHaveAttribute('data-support', 'none');
  await expect(page.getByTestId('mcu-pin-2')).toContainText('Strapping');
  await wire(page, ['U1', 'gnd'], ['GND1', 'ref']);
  // The new board has its starter code but no build (Sprint 13 OS-08): Run is not available and
  // says why, and no runtime request is made.
  const run = page.getByTestId('sim-run');
  await expect(run).toBeDisabled();
  await expect(run).toHaveAttribute('data-blocked', 'run.blocked.buildRequired');
  await expect(page.getByTestId('sim-run-blocked')).toContainText('Build the code for U1 first');
  expect(calls.count).toBe(0);
});

test('one-shot sessions: Run -> running (GPIO2 blinks, serial arrives) -> Stop; Run again is fresh', async ({
  page,
  request,
}) => {
  await openExample(page, 'esp32-blink');
  const before = await storedProject(page);
  const ended = async () =>
    ((await (await request.get(`${FAKE}/__test/sessions`)).json()) as { ended?: number }).ended ??
    0;
  const ended0 = await ended();
  await runAndWait(page);
  await expect(page.getByTestId('pin-level-2')).toHaveAttribute('data-level', '1', {
    timeout: 5_000,
  });
  await expect(page.getByTestId('pin-level-2')).toHaveAttribute('data-level', '0', {
    timeout: 5_000,
  });
  await selectBoard(page);
  await expect(page.getByTestId('mcu-serial-output')).toContainText('TBI-ARDUINO-READY');
  // The LED is driven by the pad through the real engine.
  await expect(page.getByTestId('pin-level-2')).toHaveAttribute('data-level', '1', {
    timeout: 5_000,
  });
  await stopAndWait(page);
  expect(await ended()).toBe(ended0 + 1); // that session is over for good
  // Run again: a new session with its own, fresh serial output (no resume).
  await runAndWait(page);
  await selectBoard(page);
  await expect(page.getByTestId('mcu-serial-output')).toContainText('TBI-ARDUINO-READY');
  expect(
    ((await page.getByTestId('mcu-serial-output').textContent()) ?? '').split('TBI-ARDUINO-READY')
      .length - 1,
  ).toBe(1);
  await stopAndWait(page);
  expect(await ended()).toBe(ended0 + 2);
  expect(await storedProject(page)).toEqual(before); // no runtime state entered the project
});

test('toggle mirrors browser-first; push button is transient; structural edits wait for Stop', async ({
  page,
}) => {
  await openExample(page, 'esp32-input-echo');
  await runAndWait(page);
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0');
  const rev = (await storedProject(page)).revision.localRevision;
  // Persistent: the project is written FIRST, then the running session mirrors it.
  await page.getByTestId('actuator-SW1').click();
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '1');
  await waitSaved(page);
  const stored = await storedProject(page);
  expect(stored.components.find((c) => c.id === 'SW1')!.params.closed).toBe(true);
  expect(stored.revision.localRevision).toBe(rev + 1);
  await page.getByTestId('actuator-SW1').click();
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0');
  await waitSaved(page);
  // Transient: held -> high; released -> low; no revision, nothing stored.
  const revBefore = (await storedProject(page)).revision.localRevision;
  const box = (await page.getByTestId('actuator-SW2').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '1');
  await page.mouse.up();
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0');
  await waitSaved(page);
  expect((await storedProject(page)).revision.localRevision).toBe(revBefore);
  // Structural edits are refused while the ESP32 session runs, with an explanation.
  await page.locator('[data-hit="component"][data-id="R3"] .component-hit').click();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('notice')).toHaveAttribute('data-key', 'sim.stopToEdit');
  expect((await storedProject(page)).components.some((c) => c.id === 'R3')).toBe(true);
  // The code stays editable while running, but a new Build waits for Stop (D-S7-9); the running
  // session keeps its firmware.
  await page.getByTestId('view-code').click();
  await expect(page.getByTestId('build-button')).toBeDisabled();
  await expect(page.getByTestId('build-blocked-note')).toBeVisible();
  await expect(page.getByTestId('code-text')).toBeEditable();
  await stopAndWait(page);
  await expect(page.getByTestId('build-button')).toBeEnabled();
});

test('a dropped event stream reconnects with Last-Event-ID; nothing is missed or repeated', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await openExample(page, 'esp32-blink');
  await runAndWait(page);
  await selectBoard(page);
  // Through the development proxy the dropped stream stays half-open and silent, so this also
  // proves the client's liveness watchdog (keepalive-based, 20 s) detects it.
  await page.waitForTimeout(500);
  const before = Number(await status(page).getAttribute('data-trace-events'));
  await request.post(`${FAKE}/__test/drop-streams`);
  await expect
    .poll(async () => Number(await status(page).getAttribute('data-trace-events')), {
      timeout: 40_000,
    })
    .toBeGreaterThan(before + 3);
  await expect(status(page)).toHaveAttribute('data-connection', 'connected');
  await expect(status(page)).toHaveAttribute('data-status', 'running');
  // The host still had every event (4096-event window): replayed contiguously, no resync.
  await expect(page.getByTestId('mcu-resync')).toHaveCount(0);
  await stopAndWait(page);
});

test('history evicted while disconnected is reported by an explicit resync, never hidden', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await request.post(`${FAKE}/__test/capacity?n=8`);
  await openExample(page, 'esp32-blink');
  await runAndWait(page);
  await selectBoard(page);
  // Keep the client away while the host moves on past its 8-event window.
  await page.route('**/runtime/sessions/*/events', (r) => r.abort());
  await request.post(`${FAKE}/__test/drop-streams`);
  await expect(page.getByTestId('mcu-reconnecting')).toBeVisible({ timeout: 40_000 });
  await page.waitForTimeout(2500);
  await page.unroute('**/runtime/sessions/*/events');
  await expect(page.getByTestId('mcu-resync')).toBeVisible({ timeout: 15_000 });
  await expect(status(page)).toHaveAttribute('data-connection', 'connected');
  await expect(status(page)).toHaveAttribute('data-status', 'running');
  await stopAndWait(page);
});

test('a lost session is reported, the project is safe, and the next Run starts fresh', async ({
  page,
  request,
}) => {
  await openExample(page, 'esp32-blink');
  const before = await storedProject(page);
  await runAndWait(page);
  await request.post(`${FAKE}/__test/end-all?reason=lease_expired`);
  await expect(page.getByTestId('sim-error')).toHaveAttribute('data-code', 'session_lost', {
    timeout: 10_000,
  });
  expect(await storedProject(page)).toEqual(before);
  await runAndWait(page);
  await stopAndWait(page);
  // A busy host is a clear, localized error too.
  await request.post(`${FAKE}/__test/fail-next-create?status=429`);
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-error')).toHaveAttribute('data-code', 'runtime_busy');
});

test('local DC projects keep the browser Worker engine and never use the runtime service', async ({
  page,
}) => {
  const calls = runtimeRequests(page);
  await openExample(page, 'ohms-law');
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('sim-stop')).toHaveAttribute('data-engine', 'local');
  expect(await status(page).getAttribute('data-engine')).toBeNull();
  await stopAndWait(page);
  expect(calls.count).toBe(0);
});

test('no runtime state in the project: reload, duplicate and export carry only engineering data', async ({
  page,
}) => {
  await openExample(page, 'esp32-input-echo');
  await runAndWait(page);
  await page.getByTestId('actuator-SW1').click();
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '1');
  await stopAndWait(page);
  await waitSaved(page);
  const doc = await storedProject(page);
  // The authored source is stored exactly (it contains the firmware's own strings); everything
  // else carries no runtime or build state: no session, serial output, artifact or build.
  const source = EXAMPLE_SOURCE['esp32-input-echo'];
  expect(doc.programs.U1!.text).toBe(source);
  const text = JSON.stringify({ ...doc, programs: {} });
  for (const word of [
    'session',
    'token',
    'serial',
    'simNs',
    'gpio":',
    'TBI-BANKS',
    'eventId',
    'artifact',
    'build',
  ])
    expect(text, word).not.toContain(word);
  expect(doc.components.find((c) => c.id === 'U1')!.params.firmware).toBe('program');
  expect(doc.components.find((c) => c.id === 'SW1')!.params.closed).toBe(true); // persisted edit
  // Reload: the app opens on Projects; the project reopens stopped, unchanged.
  await page.reload();
  await reopenFromLibrary(page, doc.projectId);
  await expect(status(page)).toHaveAttribute('data-status', 'stopped');
  expect(await storedProject(page)).toEqual(doc);
  // Export: the package carries the firmware identity and no runtime state.
  const download = await exportFromMenu(page);
  const pkg = readFileSync((await download.path())!, 'utf8');
  const parsed = JSON.parse(pkg) as {
    project: ProjectDocument;
    firmware: null;
    formatVersion: number;
  };
  expect(parsed.formatVersion).toBe(2);
  expect(parsed.project.programs.U1!.text).toBe(source); // the source travels exactly
  const outside = JSON.stringify({ ...parsed, project: { ...parsed.project, programs: {} } });
  for (const word of ['session', 'token', 'TBI-BANKS', 'serial', 'artifact'])
    expect(outside).not.toContain(word);
  expect(parsed.firmware).toBeNull(); // artifacts are never exported (rebuilt from source)
  expect((await storedProjects(page)).length).toBeGreaterThanOrEqual(1);
});

test('Hebrew: S6 surfaces are translated; pins, levels and serial stay LTR', async ({ page }) => {
  await openExample(page, 'esp32-blink');
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await runAndWait(page);
  await expect(page.getByTestId('sim-status-label')).toHaveText('רץ · ESP32');
  await selectBoard(page);
  await expect(page.getByTestId('mcu-panel').locator('h3')).toHaveText('ריצת ESP32');
  await expect(page.getByTestId('mcu-serial-output')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('.pin-label').first()).toHaveAttribute('direction', 'ltr');
  await expect(page.getByTestId('mcu-live-2').locator('td').first()).toHaveAttribute('dir', 'ltr');
  await stopAndWait(page);
  // The project is the same whatever the language.
  await page.getByTestId('language-select').selectOption('en');
});

test('ESP32 terminal: the serial console under the properties, from boot; kept readable after Stop; fresh per Run', async ({
  page,
}) => {
  // Ordinary DC projects have no terminal.
  await openExample(page, 'led-current');
  await expect(page.getByTestId('mcu-terminal')).toHaveCount(0);

  await openExample(page, 'esp32-blink');
  const terminal = page.getByTestId('mcu-terminal');
  const out = page.getByTestId('mcu-serial-output');
  const state = page.getByTestId('mcu-terminal-state');
  await expect(terminal).toBeVisible();
  await expect(terminal).toContainText('ESP32 terminal');
  await expect(state).toHaveAttribute('data-state', 'idle');
  await expect(out).toHaveAttribute('dir', 'ltr');
  await expect(out).toContainText('Press Run');

  // Running: output appears without selecting the board; the state reads as running.
  await runAndWait(page);
  await expect(state).toHaveAttribute('data-state', 'running');
  await expect(out).toContainText('TBI-ARDUINO-READY');
  await expect(state).toContainText(/Running · \u2066?[\d.]+ s\u2069? simulated/);

  // Stop: the last output stays, marked as ended; nothing of it is stored.
  await stopAndWait(page);
  await expect(state).toHaveAttribute('data-state', 'ended');
  await expect(out).toHaveAttribute('data-ended', 'true');
  await expect(out).toContainText('TBI-ARDUINO-READY');
  // Only the authored source mentions it: the terminal output itself is never stored.
  const storedNow = await storedProjects(page);
  expect(JSON.stringify(storedNow.map((d) => ({ ...d, programs: {} })))).not.toContain(
    'TBI-ARDUINO-READY',
  );

  // A new Run is a new session: the terminal starts over.
  await runAndWait(page);
  await expect(out).not.toHaveAttribute('data-ended', 'true');
  await expect(out).toContainText('TBI-ARDUINO-READY');
  expect(((await out.textContent()) ?? '').split('TBI-ARDUINO-READY').length - 1).toBe(1);

  // Collapsible, keyboard operable; the output is a scrollable, focusable log.
  const toggle = page.getByTestId('mcu-terminal-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(out).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(out).toBeVisible();
  await expect(out).toHaveAttribute('role', 'log');

  // Hebrew chrome, technical output still LTR.
  await page.getByTestId('language-select').selectOption('he');
  await expect(terminal).toContainText('מסוף ESP32');
  await expect(state).toContainText('רץ');
  await expect(out).toHaveAttribute('dir', 'ltr');
  await page.getByTestId('language-select').selectOption('en');
  await stopAndWait(page);

  // Another project never shows this session's output.
  await openExample(page, 'esp32-input-echo');
  await expect(page.getByTestId('mcu-terminal-state')).toHaveAttribute('data-state', 'idle');
  await expect(page.getByTestId('mcu-serial-output')).not.toContainText('TBI-ARDUINO-READY');
});

test('the app opens on the Projects screen, also after working in a project', async ({ page }) => {
  await openExample(page, 'esp32-blink');
  await page.reload();
  await expect(page.getByTestId('example-list')).toBeVisible();
  await expect(page.getByTestId('canvas')).toHaveCount(0);
  await page.goto('/');
  await expect(page.getByTestId('example-list')).toBeVisible();
});
