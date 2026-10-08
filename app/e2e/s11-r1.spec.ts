/**
 * Sprint 11 (R1) routine browser acceptance: the Sprint 10 parts in ESP32 projects, through the
 * real R2 client against the fake Session Host (real transport, validators and engine; scripted
 * MCU: the examples' firmware copies GPIO34 to GPIO4). The curated R1 examples: the PIR dome and
 * the light level are live part parameters mirrored to the running board (ADR-010).
 */
import { expect, test, type Page } from '@playwright/test';
import { buildProgram, component, goToProjects, storedProjects, waitSaved } from './helpers.js';

const FAKE = 'http://127.0.0.1:7499';
const status = (page: Page) => page.getByTestId('sim-status');

async function openExample(page: Page, id: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  await buildProgram(page);
}
async function runOnBoard(page: Page) {
  await page.getByTestId('sim-run').click();
  await expect(status(page)).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
  await expect(status(page)).toHaveAttribute('data-engine', 'mcu');
}

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/capacity?n=4096`);
});

test('ESP32 motion alarm: the PIR dome mirrors motion live; the firmware switches the relay; LED and buzzer follow', async ({
  page,
}) => {
  await openExample(page, 'esp32-motion-relay');
  await runOnBoard(page);
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0');
  await expect(component(page, 'BZ1')).toHaveAttribute('data-sounding', 'false');
  await page.getByTestId('actuator-U2').click();
  await expect(component(page, 'U2')).toHaveAttribute('data-motion', 'true');
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '1');
  await expect(component(page, 'K1')).toHaveAttribute('data-energized', 'true');
  await expect(component(page, 'BZ1')).toHaveAttribute('data-sounding', 'true');
  // The motion is persisted in the project first (a live edit), then mirrored.
  await expect
    .poll(async () => {
      const docs = await storedProjects(page);
      docs.sort((a, b) => b.revision.updatedAt.localeCompare(a.revision.updatedAt));
      return docs[0]!.components.find((c) => c.id === 'U2')!.params.motion;
    })
    .toBe(true);
  await page.getByTestId('actuator-U2').click();
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0');
  await expect(component(page, 'K1')).toHaveAttribute('data-energized', 'false');
  await expect(status(page)).toHaveAttribute('data-status', 'running');
  await page.getByTestId('sim-stop').click();
  await expect(status(page)).toHaveAttribute('data-status', 'stopped', { timeout: 20_000 });
});

test('ESP32 night light: the light level is mirrored live; darkness reads HIGH and lights the RGB LED (EN/HE)', async ({
  page,
}) => {
  await openExample(page, 'esp32-night-light');
  await runOnBoard(page);
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0');
  await component(page, 'LDR1').locator('.component-hit').click();
  const field = page.getByTestId('param-LDR1-illuminance');
  await expect(field).toBeEnabled(); // live while the board runs
  await field.fill('1');
  await field.press('Enter');
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '1');
  // In the hold band (20 lx) the input keeps its level.
  await field.fill('20');
  await field.press('Enter');
  await page.waitForTimeout(500);
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '1');
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.getByTestId('environment-LDR1')).toContainText('סביבה מדומה');
  await page.getByTestId('language-select').selectOption('en');
  await field.fill('300');
  await field.press('Enter');
  await expect(page.getByTestId('pin-level-4')).toHaveAttribute('data-level', '0');
  await expect(status(page)).toHaveAttribute('data-status', 'running');
});

test('ESP32 projects: the capacitor alone stays refused, with its reason; the board is refused next to it', async ({
  page,
}) => {
  await openExample(page, 'esp32-motion-relay');
  for (const t of [
    'component.rgb_led',
    'component.buzzer',
    'sensor.pir_hc_sr501',
    'component.bjt_npn',
    'component.relay',
    'component.photoresistor',
  ])
    await expect(page.getByTestId(`palette-${t}`)).toBeEnabled();
  await expect(page.getByTestId('palette-component.capacitor')).toHaveAttribute(
    'data-unavailable',
    'part_time_dependent',
  );
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('open-example-rc-fade').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.getByTestId('palette-board.esp32_devkitc_wroom32')).toHaveAttribute(
    'data-unavailable',
    'board_time_dependent',
  );
  await expect(page.getByTestId('palette-note-board_time_dependent')).toBeVisible();
});
