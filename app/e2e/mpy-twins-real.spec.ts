/**
 * MicroPython expansion: the new verified twins Build and Run on the REAL stack (the staging build
 * service, Session Host and QEMU Runtime v5), each opened from the examples list, plus a language
 * switch on an example that now has a twin (the twin's program, not the starter, builds and runs).
 * Screenshots go to TBI_SHOTS_DIR. Skipped unless TBI_MPY_REAL=1; setup as rc6w2-real.spec.ts
 * (TBI_RUNTIME_PROXY / TBI_BUILD_PROXY at the real backends). About ten session starts: keep a run
 * within the staging per-user rate (20 starts / 10 min).
 */
import { expect, test, type Page } from '@playwright/test';
import { buildProgram, component, goToProjects, waitSaved } from './helpers.js';

test.setTimeout(900_000);
test.skip(!process.env.TBI_MPY_REAL, 'heavy: TBI_MPY_REAL=1');
test.describe.configure({ mode: 'serial' });
const SHOTS = process.env.TBI_SHOTS_DIR ?? 'test-results';
const status = (p: Page) => p.getByTestId('sim-status');
const ARDUINO = 'esp32-arduino-3.3.12';
const MPY = 'esp32-micropython-1.29';

async function open(page: Page, id: string, lang: 'en' | 'he') {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(lang);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}
async function buildRun(page: Page, profile: string) {
  await page.getByTestId('view-code').click();
  await expect(page.getByTestId('program-language')).toHaveValue(profile);
  await buildProgram(page, 300_000);
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 300_000 });
  await expect(status(page)).toHaveAttribute('data-engine', 'mcu');
}
async function serial(page: Page, board: string, re: RegExp) {
  await component(page, board).locator('.component-hit').click({ force: true });
  await expect(page.getByTestId('mcu-serial-output')).toContainText(re, { timeout: 120_000 });
}
async function shot(page: Page, name: string) {
  await page.addStyleTag({
    content: '*, *::before, *::after { font-family: "Liberation Sans", sans-serif !important; }',
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}
async function stop(page: Page) {
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 60_000 });
}

const CASES: [
  id: string,
  profile: string,
  board: string,
  serial: RegExp | null,
  lang: 'en' | 'he',
][] = [
  ['mpy-input-echo', MPY, 'U1', /ECHO34=0/, 'en'],
  ['mpy-bench', MPY, 'U1', /ECHO34=0/, 'he'],
  ['mpy-motion-relay', MPY, 'U1', /ECHO34=0/, 'en'],
  ['mpy-night-light', MPY, 'U1', /ECHO34=0/, 'en'],
  ['mpy-servo-sweep', MPY, 'U1', null, 'he'],
  ['esp32-button', ARDUINO, 'U1', /button released/, 'en'],
  ['esp32-adder-monitor', ARDUINO, 'U5', /A=1 B=0 -> C=0 S=1 = 1 ok/, 'he'],
];

for (const [id, profile, board, re, lang] of CASES)
  test(`${id} (${lang}): opens from the list, builds and runs on the real stack`, async ({
    page,
  }) => {
    await open(page, id, lang);
    await buildRun(page, profile);
    if (re) await serial(page, board, re);
    else await page.waitForTimeout(5000);
    await expect(status(page)).toHaveAttribute('data-status', 'running');
    await shot(page, `mpy-twin-${id}-${lang}`);
    await stop(page);
  });

test('esp32-input-echo: switching to MicroPython shows the verified twin, which builds and runs', async ({
  page,
}) => {
  await open(page, 'esp32-input-echo', 'en');
  await page.getByTestId('view-code').click();
  await page.getByTestId('program-language').selectOption(MPY);
  await expect(page.getByTestId('notice')).toHaveAttribute('data-key', 'program.language.restored');
  await expect(page.getByTestId('code-text')).toHaveValue(/source = Pin\(34, Pin\.IN\)/);
  await page.getByTestId('view-circuit').click();
  await waitSaved(page);
  await buildRun(page, MPY);
  await serial(page, 'U1', /ECHO34=0/);
  await shot(page, 'mpy-twin-switch-input-echo-en');
  await stop(page);
});

// The logic limit demonstrators' MicroPython twins: refused by name as the Arduino versions are.
for (const [id, code] of [
  ['mpy-logic-and', 'logic_mcu_output_uncharacterized'],
  ['mpy-logic-override', 'logic_mcu_input_not_guaranteed'],
  ['mpy-logic-quad-and', 'logic_input_leakage_uncharacterized'],
] as const)
  test(`${id} (en): builds; Run is refused by name (${code}), as its Arduino twin`, async ({
    page,
  }) => {
    await open(page, id, 'en');
    await page.getByTestId('view-code').click();
    await expect(page.getByTestId('program-language')).toHaveValue(MPY);
    await buildProgram(page, 300_000);
    await page.getByTestId('sim-run').click();
    await expect(page.getByTestId('sim-error')).toHaveAttribute('data-code', code, {
      timeout: 180_000,
    });
    await shot(page, `mpy-twin-${id}-refused-en`);
  });
