/**
 * Sprint 18 R4-B (staging) / R4-C (DEV-Lab) acceptance, HEAVY: the R4 pair (Session Host + build
 * service of this commit, QEMU Runtime v3 with capability pwm) through TBI_RUNTIME_PROXY /
 * TBI_BUILD_PROXY, as s15-r4-real.spec.ts. Skipped unless TBI_S18_REAL=1.
 *
 * - SG90: the sweep example reaches 0, 90 and 180 deg (1.0 / 1.5 / 2.0 ms pulses);
 * - three PWM channels on independent LED loads at 25 / 50 / 75 %: each pad is a waveform and the
 *   LED currents are in the exact ratio 1 : 2 : 3 (A1 averages, display rounding only);
 * - the project persists: reloaded from the library, it runs again unchanged;
 * - refusals, named: duty 0 into an LED (O-R4-1) in English, then the same message in Hebrew; a CPU
 *   clock change refused at Build (F-17C-1, `cpu_frequency`);
 * - Sprint 18F: the 3D view's SG90 horn follows the angle Runtime v3 reports (0 / 90 / 180, equal
 *   to the inspector's), through a view switch during the run; at rest and still after Stop and
 *   after a crash;
 * - recovery (only with TBI_S18_UNIT=<instance>, e.g. tbi-s8; it acts on that instance's units):
 *   the session's QEMU killed -> `runtime_crashed`, a new Run works; the Session Host restarted
 *   during a run -> the session ends with a named failure, a new Run works.
 */
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import {
  addComponent,
  addWire,
  createProject,
  setParam,
  setProgramText,
  useBoardProgram,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { buildProgram, component, openImported, reopenFromLibrary, waitSaved } from './helpers.js';

test.setTimeout(600_000);
test.skip(
  !process.env.TBI_S18_REAL,
  'heavy: needs the real R4 Session Host + QEMU v3 (TBI_S18_REAL=1)',
);
test.describe.configure({ mode: 'serial' });

const status = (page: Page) => page.getByTestId('sim-status');
const select = (page: Page, id: string) =>
  component(page, id).locator('.component-hit').click({ force: true });

async function runOnBoard(page: Page) {
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 90_000 });
  await expect(status(page)).toHaveAttribute('data-engine', 'mcu');
}
async function stop(page: Page) {
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 60_000 });
}
async function openExample(page: Page, id: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) {
    await page.getByTestId('app-menu-button').click();
    await page.getByTestId('menu-projects').click();
  }
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  await buildProgram(page, 300_000);
}

/** ESP32 with 220 Ω + LED from each of GPIO18/19/21 to ground, and `code` as its program. */
function threeLeds(projectId: string, name: string, code: string): ProjectDocument {
  let doc = createProject({ projectId, deviceId: 'dev_s18', name, appVersion: '0' });
  const ok = <T extends { ok: boolean }>(r: T): T & { ok: true } => {
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r as T & { ok: true };
  };
  const add = (type: Parameters<typeof addComponent>[1], x: number, y: number) => {
    const r = ok(addComponent(doc, type, { x, y }));
    doc = r.doc;
    return r.id;
  };
  const wire = (a: string, at: string, b: string, bt: string) => {
    doc = ok(
      addWire(
        doc,
        { kind: 'terminal', component: a, terminal: at },
        { kind: 'terminal', component: b, terminal: bt },
      ),
    ).doc;
  };
  const u = add('board.esp32_devkitc_wroom32', 0, 0);
  wire(u, 'gnd', 'GND1', 'ref');
  [18, 19, 21].forEach((gpio, i) => {
    const r = add('component.resistor', 260, -60 + i * 120);
    const d = add('component.led', 400, -60 + i * 120);
    doc = ok(setParam(doc, r, 'resistance', { value: 220, unit: 'ohm' })).doc;
    wire(u, `gpio${gpio}`, r, 'a');
    wire(r, 'b', d, 'anode');
    wire(d, 'cathode', 'GND1', 'ref');
  });
  doc = ok(useBoardProgram(doc, u)).doc;
  doc = ok(setProgramText(doc, u, code)).doc;
  return doc;
}

const THREE =
  'void setup() {\n  analogWrite(18, 64);\n  analogWrite(19, 128);\n  analogWrite(21, 192);\n}\nvoid loop() { delay(1000); }\n';

/** The displayed current of a part, in amperes (the inspector's first current row). */
async function currentOf(page: Page, id: string): Promise<number> {
  await select(page, id);
  const text = (await page.getByTestId('result-current').first().textContent()) ?? '';
  const m = /(-?[\d.]+)\s*(µA|uA|mA|A)/.exec(text.replace(',', '.'));
  if (!m) throw new Error(`no current in ${JSON.stringify(text)}`);
  const scale = m[2] === 'A' ? 1 : m[2] === 'mA' ? 1e-3 : 1e-6;
  return Number(m[1]) * scale;
}

test('SG90 on the R4 pair: the sweep reaches 0, 90 and 180 deg', async ({ page }, info) => {
  await openExample(page, 'esp32-servo-sweep');
  await runOnBoard(page);
  await select(page, 'M1');
  const angle = page.getByTestId('result-state-angleDeg');
  await expect(angle).toHaveText(/^0°$/, { timeout: 120_000 });
  await expect(angle).toHaveText(/^(89\.9|90|90\.0|90\.1)°$/, { timeout: 30_000 });
  await expect(angle).toHaveText(/^180°$|^179\.9°$/, { timeout: 30_000 });
  await page.screenshot({ path: info.outputPath('s18-servo.png') });
  await stop(page);
});

/** The 3D view's servo horn (opt-in viewer hook): yaw in degrees and its own mesh count. */
const horn3d = (page: Page) =>
  page.evaluate(() => {
    const host = document.querySelector('[data-testid="view3d-host"]') as unknown as {
      tbiViewer: { horns(): Record<string, { yaw: number; meshes: number }> };
    };
    const h = host.tbiViewer.horns().M1!;
    return { deg: (h.yaw * 180) / Math.PI, meshes: h.meshes };
  });
const shownAngle = async (page: Page) =>
  Number(((await page.getByTestId('result-state-angleDeg').textContent()) ?? '').replace('°', ''));
async function open3d(page: Page) {
  await page.getByTestId('view-3d').click();
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready', {
    timeout: 120_000,
  });
}
/** The horn reaches `target` (deg) and agrees with the inspector's angle at that moment. */
async function hornAt(page: Page, target: number) {
  await expect(async () => {
    const shown = await shownAngle(page);
    const h = await horn3d(page);
    expect(Math.abs(shown - target)).toBeLessThan(0.2);
    expect(Math.abs(h.deg - shown)).toBeLessThan(0.1); // display rounding only
  }).toPass({ timeout: 30_000, intervals: [100] });
}

test("Sprint 18F: the 3D horn follows Runtime v3's angle; view switch; Stop -> rest, still", async ({
  page,
}, info) => {
  await page.addInitScript(() => localStorage.setItem('tbi-lab.3d.inspect', '1'));
  await openExample(page, 'esp32-servo-sweep');
  await select(page, 'M1');
  await runOnBoard(page);
  await open3d(page);
  expect((await horn3d(page)).meshes).toBe(4);
  await hornAt(page, 0);
  await hornAt(page, 90);
  await hornAt(page, 180);
  await page.screenshot({ path: info.outputPath('s18f-horn-180.png') });
  // Away and back during the run: the rebuilt view picks the angle up again.
  await page.getByTestId('view-circuit').click();
  await open3d(page);
  await hornAt(page, 0);
  await page.screenshot({ path: info.outputPath('s18f-horn-0.png') });
  await hornAt(page, 90);
  await stop(page);
  // Stopped: the horn at rest and still (nothing reported, nothing moves).
  await expect.poll(async () => (await horn3d(page)).deg, { timeout: 10_000 }).toBeCloseTo(90, 6);
  await page.waitForTimeout(2000);
  expect((await horn3d(page)).deg).toBeCloseTo(90, 6);
});

test('three PWM channels: every pad a waveform; LED currents 1 : 2 : 3; the project persists', async ({
  page,
}, info) => {
  const doc = threeLeds('prj_s18threepwm', 'S18 three PWM channels', THREE);
  await openImported(page, doc);
  await waitSaved(page);
  await buildProgram(page, 300_000);
  await runOnBoard(page);
  await select(page, 'U1');
  for (const gpio of [18, 19, 21])
    await expect(page.getByTestId(`mcu-live-${gpio}`)).toHaveAttribute('data-pwm', 'wave', {
      timeout: 90_000,
    });
  const ids = ['D1', 'D2', 'D3'];
  const i = [];
  for (const id of ids) i.push(await currentOf(page, id));
  // 25 / 50 / 75 % of the same high-state current (same parts): exact in the model; the display
  // rounds to 3 significant digits.
  expect(i[1]! / i[0]!).toBeGreaterThan(1.98);
  expect(i[1]! / i[0]!).toBeLessThan(2.02);
  expect(i[2]! / i[0]!).toBeGreaterThan(2.97);
  expect(i[2]! / i[0]!).toBeLessThan(3.03);
  await page.screenshot({ path: info.outputPath('s18-three-pwm.png') });
  await stop(page);
  // Persistence: reload, reopen from the library, run again.
  await page.reload();
  await reopenFromLibrary(page, 'prj_s18threepwm');
  await expect(component(page, 'D3')).toBeVisible();
  await page.getByTestId('view-code').click();
  await expect(page.getByTestId('code-text')).toHaveValue(/analogWrite\(21, 192\)/);
  await buildProgram(page, 300_000);
  await runOnBoard(page);
  await select(page, 'U1');
  await expect(page.getByTestId('mcu-live-21')).toHaveAttribute('data-pwm', 'wave', {
    timeout: 90_000,
  });
  await stop(page);
});

test('duty 0 into an LED is refused, named, in English and then in Hebrew', async ({ page }) => {
  const code =
    'void setup() {\n  ledcAttach(18, 1000, 8);\n  ledcWrite(18, 0);\n}\nvoid loop() { delay(1000); }\n';
  await openImported(page, threeLeds('prj_s18dutyzero', 'S18 duty zero', code));
  await waitSaved(page);
  await buildProgram(page, 300_000);
  await page.getByTestId('sim-run').click();
  const err = page.getByTestId('sim-error');
  await expect(err).toHaveAttribute('data-code', 'pwm_duty_zero_unverified', { timeout: 120_000 });
  await expect(err).toContainText('GPIO18');
  await expect(err).toContainText('duty 0');
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(err).toContainText('מחזור עבודה 0');
  await expect(err).toContainText('GPIO18');
  await page.getByTestId('language-select').selectOption('en');
});

test('a CPU clock change is refused at Build (cpu_frequency); Run is refused naming it', async ({
  page,
}) => {
  const code =
    'void setup() {\n  setCpuFrequencyMhz(80);\n  analogWrite(18, 64);\n}\nvoid loop() { delay(1000); }\n';
  await openImported(page, threeLeds('prj_s18cpufreq', 'S18 CPU clock', code));
  await waitSaved(page);
  await buildProgram(page, 300_000);
  await page.getByTestId('view-code').click();
  await expect(
    page.getByTestId('build-features').locator('li[data-feature="cpu_frequency"]'),
  ).toBeVisible();
  await page.getByTestId('view-circuit').click();
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-error')).toHaveAttribute(
    'data-code',
    'mcu_unsupported_features',
  );
  await expect(page.getByTestId('sim-error')).toContainText('CPU clock change');
});

const unit = process.env.TBI_S18_UNIT;
const sudo = (...args: string[]) => execFileSync('sudo', ['-n', ...args], { stdio: 'pipe' });

test('Sprint 18F: QEMU killed during the sweep -> runtime_crashed; the 3D horn rests, still', async ({
  page,
}) => {
  test.skip(!unit, 'acts on an installed instance: TBI_S18_UNIT=<instance>');
  await page.addInitScript(() => localStorage.setItem('tbi-lab.3d.inspect', '1'));
  await openExample(page, 'esp32-servo-sweep');
  await runOnBoard(page);
  await open3d(page);
  await expect.poll(async () => (await horn3d(page)).deg, { timeout: 60_000 }).toBeLessThan(1);
  sudo('systemctl', 'kill', '--signal=SIGKILL', '--kill-whom=all', `${unit}-qemu@*.service`);
  await expect(page.getByTestId('sim-error')).toHaveAttribute('data-code', 'runtime_crashed', {
    timeout: 60_000,
  });
  await expect.poll(async () => (await horn3d(page)).deg, { timeout: 10_000 }).toBeCloseTo(90, 6);
  await page.waitForTimeout(2500); // the sketch would have moved it by now: it does not
  expect((await horn3d(page)).deg).toBeCloseTo(90, 6);
});

test('recovery: QEMU killed during a fade -> runtime_crashed; a new Run works', async ({
  page,
}) => {
  test.skip(!unit, 'acts on an installed instance: TBI_S18_UNIT=<instance>');
  await openExample(page, 'esp32-led-fade');
  await runOnBoard(page);
  await page.waitForTimeout(3000);
  sudo('systemctl', 'kill', '--signal=SIGKILL', '--kill-whom=all', `${unit}-qemu@*.service`);
  await expect(page.getByTestId('sim-error')).toHaveAttribute('data-code', 'runtime_crashed', {
    timeout: 60_000,
  });
  await runOnBoard(page);
  await select(page, 'U1');
  await expect(page.getByTestId('mcu-live-18')).toHaveAttribute('data-pwm', 'wave', {
    timeout: 90_000,
  });
  await stop(page);
});

test('recovery: the Session Host restarted during a run -> a named failure; a new Run works', async ({
  page,
}) => {
  test.skip(!unit, 'acts on an installed instance: TBI_S18_UNIT=<instance>');
  await openExample(page, 'esp32-led-fade');
  await runOnBoard(page);
  await page.waitForTimeout(3000);
  sudo('systemctl', 'restart', `${unit}-session-host.service`);
  const err = page.getByTestId('sim-error');
  await expect(err).toBeVisible({ timeout: 90_000 });
  const code = await err.getAttribute('data-code');
  // The stream ends (session_lost / protocol_error) or the restarting host refuses (runtime_busy).
  expect(code).toMatch(/^(session_lost|protocol_error|runtime_busy|runtime_crashed)$/);
  // The restarted host accepts a new session.
  await expect(async () => {
    await page.getByTestId('sim-run').click();
    await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
  }).toPass({ timeout: 180_000 });
  await stop(page);
});
