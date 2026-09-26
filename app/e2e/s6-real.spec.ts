/**
 * Sprint 6 HEAVY acceptance: the product UI running Classic ESP32 projects through the REAL R2
 * Session Host and QEMU. Skipped unless TBI_S6_REAL=1 (routine CI has no QEMU).
 *
 * Setup (see docs/sprints/SPRINT-6.md): a Session Host bundle on loopback against a provisioned
 * runtime, and the production build served with `/runtime` proxied to it:
 *   TBI_RUNTIME_HOME=<rt> TBI_HOST_PORT=7410 node runtime/host/dist/session-host.mjs &
 *   npm run build -w @tbi-lab/app && TBI_RUNTIME_PROXY=http://127.0.0.1:7410 \
 *     npm run preview -w @tbi-lab/app -- --host 127.0.0.1 &
 *   TBI_S6_REAL=1 npx playwright test -c playwright.app.config.ts app/e2e/s6-real.spec.ts
 */
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { storedProject, waitSaved } from './helpers.js';

test.skip(!process.env.TBI_S6_REAL, 'heavy: needs the real Session Host + QEMU (TBI_S6_REAL=1)');
test.describe.configure({ mode: 'serial' });

const qemuCount = () => {
  try {
    return execFileSync('pgrep', ['-c', '-f', '^[^ ]*qemu-system-xtensa'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map(Number)[0]!;
  } catch {
    return 0;
  }
};

async function openExample(page: Page, id: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) {
    await page.getByRole('button', { name: /^‹?\s*(Projects|פרויקטים)$/ }).click();
  }
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}

const status = (page: Page) => page.getByTestId('sim-status');

test('ESP32 blink: Run creates a session, GPIO2 drives the LED, serial arrives; Stop releases everything', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await openExample(page, 'esp32-blink');
  const before = await storedProject(page);
  // Sessions of an earlier (failed) test are reclaimed by the host lease.
  await expect.poll(qemuCount, { timeout: 45_000 }).toBe(0);
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'starting');
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
  await expect(status(page)).toHaveAttribute('data-engine', 'mcu');
  expect(qemuCount()).toBe(1);
  // GPIO2 is driven HIGH and LOW by the firmware: the level dot on the board follows it.
  await expect(page.getByTestId('pin-level-2')).toHaveAttribute('data-level', '1', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('pin-level-2')).toHaveAttribute('data-level', '0', {
    timeout: 30_000,
  });
  // Serial output arrives in the inspector (the board is the selected part).
  await page.locator('[data-hit="component"][data-id="U1"] .component-hit').click();
  await expect(page.getByTestId('mcu-serial-output')).toContainText('TBI-ARDUINO-READY', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('pin-level-2')).toHaveAttribute('data-level', '1', {
    timeout: 30_000,
  });
  await page.screenshot({ path: info.outputPath('s6-blink-running.png') });
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 30_000 });
  await expect.poll(qemuCount, { timeout: 15_000 }).toBe(0);
  // The project is exactly what it was: no runtime state was written into it.
  const after = await storedProject(page);
  expect(after).toEqual(before);
});

const qemuPids = () => {
  try {
    return execFileSync('pgrep', ['-f', '^[^ ]*qemu-system-xtensa'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};

test('ESP32 input echo: toggle mirrors browser-first, push button is transient, Stop/Run is a fresh session', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  await openExample(page, 'esp32-input-echo');
  const rev0 = (await storedProject(page)).revision.localRevision;
  await expect.poll(qemuCount, { timeout: 45_000 }).toBe(0);
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
  const firstPid = qemuPids();
  expect(firstPid).toHaveLength(1);
  // After the start-up sweep, GPIO4 follows GPIO34, which is LOW (pull-down, switch open).
  await page.locator('[data-hit="component"][data-id="U1"] .component-hit').click();
  await expect(page.getByTestId('mcu-serial-output')).toContainText('TBI-BANKS-SWEEP-DONE', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0');

  // PERSISTENT toggle: committed to the project first (new revision), then mirrored.
  await page.getByTestId('actuator-SW1').click();
  const closed = await expect
    .poll(
      async () => (await storedProject(page)).components.find((c) => c.id === 'SW1')?.params.closed,
    )
    .toBe(true);
  void closed;
  expect((await storedProject(page)).revision.localRevision).toBeGreaterThan(rev0);
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '1', {
    timeout: 20_000,
  });
  await page.locator('[data-hit="component"][data-id="U1"] .component-hit').click();
  await expect(page.getByTestId('mcu-serial-output')).toContainText('ECHO34=1');
  await page.screenshot({ path: info.outputPath('s6-echo-toggle-on.png') });
  await page.getByTestId('actuator-SW1').click();
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0', {
    timeout: 20_000,
  });

  // TRANSIENT push button: held -> LED on; released -> off; the project is not touched.
  await waitSaved(page); // the toggle-off edit is persisted before the baseline is taken
  const revBefore = (await storedProject(page)).revision.localRevision;
  const box = (await page.getByTestId('actuator-SW2').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '1', {
    timeout: 20_000,
  });
  await page.mouse.up();
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0', {
    timeout: 20_000,
  });
  await waitSaved(page);
  expect((await storedProject(page)).revision.localRevision).toBe(revBefore);

  // Stop, then Run again: a completely fresh session (new QEMU, fresh boot, empty serial).
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 30_000 });
  await expect.poll(qemuCount, { timeout: 15_000 }).toBe(0);
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
  const secondPid = qemuPids();
  expect(secondPid).toHaveLength(1);
  expect(secondPid[0]).not.toBe(firstPid[0]);
  await page.locator('[data-hit="component"][data-id="U1"] .component-hit').click();
  await expect(page.getByTestId('mcu-serial-output')).not.toContainText('ECHO34=1');
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 30_000 });
  await expect.poll(qemuCount, { timeout: 15_000 }).toBe(0);
});

test('product-level determinism: the same project + firmware gives the same canonical runtime sequence', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const SECONDS = 6;
  const runs: [number, string][][] = [];
  for (let i = 0; i < 3; i++) {
    await openExample(page, 'esp32-blink');
    await page.getByTestId('sim-run').click();
    await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
    await expect
      .poll(
        async () =>
          (
            JSON.parse((await status(page).getAttribute('data-trace-checkpoints')) ?? '[]') as [
              number,
              string,
            ][]
          ).length,
        { timeout: 120_000 },
      )
      .toBeGreaterThanOrEqual(SECONDS);
    const cps = JSON.parse((await status(page).getAttribute('data-trace-checkpoints'))!) as [
      number,
      string,
    ][];
    runs.push(cps.slice(0, SECONDS));
    await page.getByTestId('sim-stop').click();
    await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 30_000 });
  }
  console.log('determinism checkpoints', JSON.stringify(runs));
  expect(runs[1]).toEqual(runs[0]);
  expect(runs[2]).toEqual(runs[0]);
  expect(new Set(runs[0]!.map(([, h]) => h)).size).toBeGreaterThan(1); // the sequence evolves
});
