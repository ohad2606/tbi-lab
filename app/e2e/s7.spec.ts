/**
 * Sprint 7 routine browser acceptance: Arduino source → Build → immutable artifact → Run, against
 * the fake build service (real builder transport/queue/store, scripted provider) and the fake
 * Session Host (app/e2e/fixtures). No toolchain, no QEMU; s7-real.spec.ts is the heavy suite.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ProjectDocument } from '@tbi-lab/domain';
import { standInImage } from './fixtures/fake-build-service.js';
import { asUser } from './fixtures/identity.js';
import {
  buildProgram,
  exportFromMenu,
  storedProject,
  waitForStoredProject,
  waitSaved,
} from './helpers.js';

const FAKE = 'http://127.0.0.1:7499';
const BUILD = 'http://127.0.0.1:7498';
const status = (page: Page) => page.getByTestId('sim-status');
const phase = (page: Page) => page.getByTestId('build-phase');
const code = (page: Page) => page.getByTestId('code-text');

async function openExample(page: Page, id: string) {
  await page.goto('/');
  await expect(page.getByTestId('example-list')).toBeVisible();
  await page.getByTestId('language-select').selectOption('en');
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}

function requests(page: Page, prefix: string) {
  const seen: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith(prefix)) seen.push(`${r.method()} ${path}`);
  });
  return seen;
}

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/end-all?reason=terminated`);
  await request.post(`${FAKE}/__test/reset-builds`);
});

test('the source is exact project data: typing, Tab, locale switch, reload and export keep every byte', async ({
  page,
}) => {
  await openExample(page, 'esp32-blink');
  await page.getByTestId('view-code').click();
  const editor = code(page);
  await expect(editor).toHaveAttribute('dir', 'ltr');
  // Source typed in the editor (Hebrew comment, tabs, trailing spaces) is stored as typed.
  const typed = '// שלום עולם\nvoid setup() {\n\tSerial.begin(115200);  \n}\nvoid loop() {}\n\n';
  await editor.fill(typed);
  const doc = await waitForStoredProject(
    page,
    (d) => d.programs.U1?.text === typed,
    'source saved',
  );
  expect(doc.programs.U1).toMatchObject({ language: 'arduino-cpp', fileName: 'sketch.ino' });
  const tricky = typed;
  // Tab indents (two spaces) at the caret; Escape then Tab leaves the editor (no keyboard trap).
  await editor.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Tab');
  await waitForStoredProject(page, (d) => d.programs.U1?.text === `${tricky}  `, 'tab indent');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect(editor).not.toBeFocused();
  // Line/column follows the caret.
  await editor.focus();
  await page.keyboard.press('Control+Home');
  await expect(page.getByTestId('code-position')).toHaveText('Line 1, column 1');
  // Hebrew UI: chrome is RTL, the code is not; the bytes are untouched.
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(editor).toHaveAttribute('dir', 'ltr');
  expect((await storedProject(page)).programs.U1!.text).toBe(`${tricky}  `);
  await page.getByTestId('language-select').selectOption('en');
  // Reload: the project (with its source) comes back exactly; no build state was stored.
  const before = await storedProject(page);
  await page.reload();
  await page.getByTestId(`project-${before.projectId}`).getByTestId('open-project').click();
  await page.getByTestId('view-code').click();
  await expect(code(page)).toHaveValue(`${tricky}  `);
  expect(await storedProject(page)).toEqual(before);
  // Export: package format 2 carries the source inside the project, and nothing about builds.
  const download = await exportFromMenu(page);
  const pkg = JSON.parse(readFileSync((await download.path())!, 'utf8')) as {
    formatVersion: number;
    project: ProjectDocument;
    firmware: null;
  };
  expect(pkg.formatVersion).toBe(2);
  expect(pkg.project.programs.U1!.text).toBe(`${tricky}  `);
  expect(pkg.firmware).toBeNull();
  expect(JSON.stringify(pkg.project)).not.toMatch(/"(artifact|buildId|sha256)":/);
});

test('Build required → Run unavailable, no runtime request → Build (Run unavailable while building) → Run; an edit makes the build stale', async ({
  page,
}) => {
  const runtime = requests(page, '/runtime');
  await openExample(page, 'esp32-blink');
  // No build yet (Sprint 13 OS-08): Run is not available, and says why.
  const run = page.getByTestId('sim-run');
  await expect(run).toBeDisabled();
  await expect(run).toHaveAttribute('data-blocked', 'run.blocked.buildRequired');
  await expect(page.getByTestId('sim-run-blocked')).toContainText('Build the code for U1 first');
  expect(runtime).toEqual([]);
  // Build: building (Run still unavailable), then built (an immutable artifact of this source).
  await page.getByTestId('view-code').click();
  await page.getByTestId('build-button').click();
  await expect(phase(page)).toHaveAttribute('data-phase', 'building');
  await expect(run).toBeDisabled();
  await expect(run).toHaveAttribute('data-blocked', 'run.blocked.building');
  await expect(phase(page)).toHaveAttribute('data-phase', 'current');
  await expect(run).toBeEnabled();
  await page.getByTestId('build-details').locator('summary').click();
  await expect(page.getByTestId('build-artifact')).toContainText(/Firmware image [0-9a-f]{16}/);
  await page.getByTestId('view-circuit').click();
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
  await expect(page.getByTestId('pin-level-2')).toHaveAttribute('data-level', '1', {
    timeout: 5_000,
  });
  // Editing while running is allowed and never touches the running firmware; Build waits.
  await page.getByTestId('view-code').click();
  await code(page).press('Control+End');
  await code(page).type('\n// changed');
  await expect(phase(page)).toHaveAttribute('data-phase', 'required');
  await expect(page.getByTestId('build-stale')).toBeVisible();
  await expect(page.getByTestId('build-button')).toBeDisabled();
  await expect(status(page)).toHaveAttribute('data-status', 'running');
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped');
  // The previous artifact is never run for the edited source: Run is unavailable (stale).
  const creates = runtime.filter((r) => r === 'POST /runtime/sessions').length;
  await expect(page.getByTestId('sim-run')).toBeDisabled();
  await expect(page.getByTestId('sim-run')).toHaveAttribute(
    'data-blocked',
    'run.blocked.buildRequired',
  );
  expect(runtime.filter((r) => r === 'POST /runtime/sessions').length).toBe(creates);
});

test('a build whose artifact was evicted fails its lease: Build required → Build → current → Run', async ({
  page,
  request,
}) => {
  // A store of one image: publishing a second build evicts the first (the real LRU).
  await request.post(`${FAKE}/__test/reset-builds?capImages=1`);
  const runtime = requests(page, '/runtime');
  const leases: number[] = [];
  page.on('response', (r) => {
    if (/\/build\/v1\/artifacts\/[0-9a-f]{64}\/lease$/.test(new URL(r.url()).pathname))
      leases.push(r.status());
  });
  const artifactId = async () => {
    await page.getByTestId('build-details').locator('summary').click();
    const text = (await page.getByTestId('build-artifact').textContent()) ?? '';
    await page.getByTestId('build-details').locator('summary').click();
    return /[0-9a-f]{16}/.exec(text)?.[0];
  };
  await openExample(page, 'esp32-blink');
  await buildProgram(page);
  await page.getByTestId('view-code').click();
  const original = await artifactId();
  expect(original).toBeTruthy();
  // Meanwhile another client builds other source, which takes the store's only place: the
  // artifact this page holds as current is evicted (the page is not told).
  // (The test calls the fake service directly, so it plays the gate for that other user.)
  const other = await request.post(`${BUILD}/v1/builds`, {
    headers: asUser('other-client'),
    data: {
      protocol: 'tbi-lab.build/1',
      profile: 'esp32-arduino-3.3.12',
      files: [{ name: 'sketch.ino', text: 'void setup() {}\nvoid loop() {}\n' }],
    },
  });
  expect(other.status()).toBe(202);
  const { buildId, token } = (await other.json()) as { buildId: string; token: string };
  await expect
    .poll(async () => {
      const r = await request.get(`${BUILD}/v1/builds/${buildId}`, {
        headers: { authorization: `Bearer ${token}`, ...asUser('other-client') },
      });
      return ((await r.json()) as { state: string }).state;
    })
    .toBe('succeeded');
  await expect(phase(page)).toHaveAttribute('data-phase', 'current');
  // Run: the lease finds no artifact, so nothing reaches the runtime and the build is forgotten.
  await page.getByTestId('view-circuit').click();
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-error')).toHaveAttribute('data-code', 'mcu_build_required');
  expect(leases).toEqual([404]);
  expect(runtime).toEqual([]);
  await expect(phase(page)).toHaveAttribute('data-phase', 'required');
  await expect(page.getByTestId('build-button')).toBeFocused();
  // Recovery: Build compiles the same source again into the same artifact, and Run succeeds.
  await page.getByTestId('build-button').click();
  await expect(phase(page)).toHaveAttribute('data-phase', 'building');
  await expect(phase(page)).toHaveAttribute('data-phase', 'current');
  expect(await artifactId()).toBe(original);
  await page.getByTestId('view-circuit').click();
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
  await expect(page.getByTestId('pin-level-2')).toHaveAttribute('data-level', '1', {
    timeout: 5_000,
  });
  expect(leases).toEqual([404, 200]);
  expect(runtime.filter((r) => r === 'POST /runtime/sessions')).toHaveLength(1);
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped');
});

test('compiler diagnostics are listed by line and jump to the source; build output never enters the terminal', async ({
  page,
}) => {
  await openExample(page, 'esp32-blink');
  await page.getByTestId('view-code').click();
  await code(page).fill('int x;\nint y;\n');
  await page.getByTestId('build-button').click();
  await expect(phase(page)).toHaveAttribute('data-phase', 'failed');
  const diag = page.getByTestId('diagnostic').first();
  await expect(diag).toContainText('sketch.ino:1:1');
  await expect(diag).toContainText("'setup' was not declared");
  await code(page).press('Control+End');
  await diag.click();
  await expect(code(page)).toBeFocused();
  await expect(page.getByTestId('code-position')).toHaveText('Line 1, column 1');
  await expect(page.getByTestId('mcu-serial-output')).not.toContainText('setup');
  // Hebrew: severity and chrome translated, the compiler message itself untouched and LTR.
  await page.getByTestId('language-select').selectOption('he');
  await expect(diag).toContainText('שגיאה');
  await expect(diag.locator('.diag-message')).toHaveAttribute('dir', 'ltr');
  await expect(diag).toContainText("'setup' was not declared");
});

test('features the simulator does not model are named at build time and Run is refused', async ({
  page,
}) => {
  const runtime = requests(page, '/runtime');
  await openExample(page, 'esp32-blink');
  await page.getByTestId('view-code').click();
  await code(page).fill(
    'void setup() { pinMode(4, INPUT_PULLUP); }\nvoid loop() { if (millis() > 99999) ESP.restart(); }\n',
  );
  await page.getByTestId('build-button').click();
  await expect(phase(page)).toHaveAttribute('data-phase', 'current');
  await expect(page.getByTestId('build-features')).toContainText('internal pull-up/pull-down');
  await expect(page.getByTestId('build-features')).toContainText('chip restart');
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-error')).toHaveAttribute(
    'data-code',
    'mcu_unsupported_features',
  );
  await expect(page.getByTestId('sim-error')).toContainText('internal pull-up/pull-down');
  expect(runtime).toEqual([]);
});

test('Advanced: a prebuilt merged image runs once through the same artifact path; a wrong file is refused', async ({
  page,
}) => {
  await openExample(page, 'esp32-blink');
  await page.locator('[data-hit="component"][data-id="U1"] .component-hit').click();
  await page.getByTestId('mcu-advanced').locator('summary').click();
  // Not a merged 4 MB image: refused with an explanation, nothing runs.
  const [bad] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('mcu-run-prebuilt').click(),
  ]);
  await bad.setFiles({
    name: 'app.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(1024),
  });
  await expect(page.getByTestId('notice')).toHaveAttribute(
    'data-key',
    'mcu.advanced.error.not_an_image',
  );
  await expect(status(page)).toHaveAttribute('data-status', 'stopped');
  // A merged image (here the stand-in of the curated blink firmware): the service computes its
  // identity; the session runs it; nothing about it enters the project.
  const before = await storedProject(page);
  const [good] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('mcu-run-prebuilt').click(),
  ]);
  await good.setFiles({
    name: 'blink-4mb.bin',
    mimeType: 'application/octet-stream',
    buffer: standInImage('TbiGpioProof'),
  });
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
  await expect(page.getByTestId('mcu-serial-output')).toContainText('TBI-ARDUINO-READY');
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped');
  expect(await storedProject(page)).toEqual(before);
});

test('reopening a project recovers its existing build by lookup (never rebuilds); DC projects never call /build', async ({
  page,
}) => {
  const build = requests(page, '/build');
  await page.goto('/');
  await page.getByTestId('open-example-led-current').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running');
  expect(build).toEqual([]); // a DC project: no build service at all
  await page.getByTestId('sim-stop').click();
  await openExample(page, 'esp32-input-echo');
  await buildProgram(page);
  const doc = await storedProject(page).catch(() => null);
  void doc;
  const projectId = (await page.evaluate(() => localStorage.getItem('tbi-lab.lastProject')))!;
  await page.reload();
  await page.getByTestId(`project-${projectId}`).getByTestId('open-project').click();
  await page.getByTestId('view-code').click();
  await expect(phase(page)).toHaveAttribute('data-phase', 'current');
  const builds = build.filter((r) => r === 'POST /build/v1/builds').length;
  expect(builds).toBe(1); // the reopen used GET /build/v1/lookup, not a new build
  expect(build.some((r) => r.startsWith('GET /build/v1/lookup'))).toBe(true);
});

test('a CRLF sketch keeps CRLF when edited; unedited source is never touched', async ({ page }) => {
  await openExample(page, 'esp32-blink');
  const base = await storedProject(page);
  // A project whose sketch uses Windows line endings, imported as a package.
  const crlf = 'void setup() {\r\n  pinMode(2, OUTPUT);\r\n}\r\nvoid loop() {}\r\n';
  const { createPackage, serializePackage } = await import('@tbi-lab/domain');
  const doc: ProjectDocument = {
    ...base,
    projectId: 'prj_crlf',
    name: 'CRLF sketch',
    programs: { U1: { ...base.programs.U1!, text: crlf } },
  };
  await page.getByTestId('app-menu-button').click();
  await page.getByTestId('menu-projects').click();
  await page.getByTestId('import-file').setInputFiles({
    name: 'crlf.tbilab',
    mimeType: 'application/json',
    buffer: Buffer.from(
      serializePackage(
        createPackage(doc, { appVersion: 't', exportedAt: '2026-09-27T00:00:00.000Z' }),
      ),
    ),
  });
  await expect(page.getByTestId('canvas')).toBeVisible();
  const imported = await waitForStoredProject(
    page,
    (d) => d.name.startsWith('CRLF'),
    'imported',
    'CRLF sketch',
  );
  expect(imported.programs.U1!.text).toBe(crlf); // exact until edited
  await page.getByTestId('view-code').click();
  await code(page).press('Control+End');
  await code(page).type('// x');
  const edited = await waitForStoredProject(
    page,
    (d) => d.programs.U1!.text.endsWith('// x'),
    'edited',
    'CRLF sketch',
  );
  expect(edited.programs.U1!.text).toBe(`${crlf}// x`);
  expect(edited.programs.U1!.text).not.toMatch(/[^\r]\n/);
});
