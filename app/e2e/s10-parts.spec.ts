/**
 * Sprint 10 parts (PM-6 revision) in the real app: the RGB LED mixes what the circuit drives, the
 * photoresistor follows its simulated light (a live environment control), and the relay's coil
 * moves its contacts between two separate load circuits. Every view shows the same truth.
 */
import { expect, test, type Page } from '@playwright/test';
import { component, goToProjects, storedProjects, waitSaved } from './helpers.js';

test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

async function openExample(page: Page, id: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
}
const run = async (page: Page) => {
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
};
const channels = (page: Page) =>
  component(page, 'D1')
    .locator('.rgb-glow')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-channel')));

test('RGB LED: the channels the switches enable glow, in every view; a switch flip remixes live', async ({
  page,
}) => {
  await openExample(page, 'rgb-mixer');
  await run(page);
  expect(await channels(page)).toEqual(['red', 'green']);
  await component(page, 'D1').locator('.component-hit').click();
  await expect(page.getByTestId('result-current-red')).toHaveText(/17\.\d+ mA/);
  await expect(page.getByTestId('result-current-blue')).toHaveText('0 A');
  // Flip SW3 while running: a live control, persisted, and the blue channel joins.
  await page.getByTestId('actuator-SW3').click();
  await expect.poll(() => channels(page)).toEqual(['red', 'green', 'blue']);
  await component(page, 'D1').locator('.component-hit').click();
  await expect(page.getByTestId('result-current-blue')).toHaveText(/1\d\.\d+ mA/);
  // Schematic: a labelled block with its common-cathode glyph and part number.
  await page.getByTestId('view-schematic').click();
  await expect(page.locator('[data-part="D1"] [data-glyph="rgb_led.cc"]')).toBeVisible();
  await expect(page.locator('[data-part="D1"]')).toContainText('WP154A4SUREQBFZGC');
  // 3D: the lamp glows in the mix of the solved currents (all three on: near white).
  await page.getByTestId('view-3d').click();
  const view = page.getByTestId('view3d');
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await expect(view).toHaveAttribute('data-lit', 'D1');
  await expect(view).toHaveAttribute('data-glow', /^D1:#[0-9a-f]{6}$/);
  await page.getByTestId('sim-stop').click();
  await expect(view).toHaveAttribute('data-lit', '');
});

test('photoresistor: the simulated light is a live environment control; the divider follows it (EN/HE)', async ({
  page,
}) => {
  await openExample(page, 'light-sensor');
  await waitSaved(page);
  await run(page);
  const reading = page.getByTestId('probe-reading-R1.a');
  await expect(reading).toContainText('3.728 V');
  await component(page, 'LDR1').locator('.component-hit').click();
  await expect(page.getByTestId('environment-LDR1')).toBeVisible();
  const field = page.getByTestId('param-LDR1-illuminance');
  await expect(field).toBeEnabled(); // live while running
  await field.fill('100');
  await field.press('Enter');
  // 9 V x 10k / (10k + 14.14k x 10^-0.6 = 3.552k) = 6.641 V
  await expect(reading).toContainText('6.641 V');
  await expect(page.getByTestId('result-state-resistance')).toHaveText(/3\.55\d kΩ/);
  // Persisted in the project, as a language-neutral SI value.
  await expect
    .poll(async () => {
      const docs = await storedProjects(page);
      docs.sort((a, b) => b.revision.updatedAt.localeCompare(a.revision.updatedAt));
      return docs[0]!.components.find((c) => c.id === 'LDR1')!.params.illuminance;
    })
    .toEqual({ value: 100, unit: 'lux' });
  // Beyond the characterised 1-100 lx the result says it is extrapolated.
  await field.fill('500');
  await field.press('Enter');
  await expect(page.getByTestId('result-outside-model')).toBeVisible();
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.getByTestId('environment-LDR1')).toContainText('סביבה מדומה');
  await page.getByTestId('language-select').selectOption('en');
});

test('relay: holding the button energizes the coil, NO lights the LED and NC silences the buzzer', async ({
  page,
}) => {
  await openExample(page, 'relay-load');
  await run(page);
  const k = component(page, 'K1');
  const bz = component(page, 'BZ1');
  await expect(k).toHaveAttribute('data-energized', 'false');
  await expect(bz).toHaveAttribute('data-sounding', 'true');
  await expect(page.getByTestId('probe-reading-D1')).toContainText('0 A');
  // Sound is optional presentation: off until the user turns it on; it follows the solved state.
  const sound = page.getByTestId('sound-toggle');
  await expect(sound).toHaveAttribute('aria-pressed', 'false');
  await expect(sound).toHaveAttribute('data-audible', 'BZ1');
  await sound.click();
  await expect(sound).toHaveAttribute('aria-pressed', 'true');
  const act = page.getByTestId('actuator-SW1');
  const b = (await act.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await expect(k).toHaveAttribute('data-energized', 'true');
  await expect(bz).toHaveAttribute('data-sounding', 'false');
  await expect(page.getByTestId('probe-reading-D1')).toContainText('13.72 mA');
  await expect(sound).toHaveAttribute('data-audible', '');
  await page.mouse.up();
  await expect(k).toHaveAttribute('data-energized', 'false');
  await expect(bz).toHaveAttribute('data-sounding', 'true');
  await sound.click(); // mute
  await expect(sound).toHaveAttribute('aria-pressed', 'false');
  // Schematic: the relay block shows its coil and change-over contact glyph and every wired pin.
  await page.getByTestId('view-schematic').click();
  await expect(page.locator('[data-part="K1"] [data-glyph="relay.spdt"]')).toBeVisible();
  for (const pin of ['coil1', 'coil2', 'com', 'no', 'nc'])
    await expect(page.locator(`[data-part="K1"] [data-pin="${pin}"]`)).toBeVisible();
});
