/**
 * Sprint 30 in the browser (no real stack; the real-QEMU run is the kit spec s30-real): the two
 * logic-feedback twins open from the library in EN and HE, carry their own program (sketch.ino /
 * main.py) and the verified twin as the other language, show the parts the texts name (the
 * 100 kΩ pull-down on the request input, the SN74LVC1G08 gates, the relay stage), and survive
 * save/reopen with the PERMIT switch position.
 */
import { expect, test, type Page } from '@playwright/test';
import { component, goToProjects, reopenFromLibrary, storedProject, waitSaved } from './helpers.js';

test.beforeEach(async ({ page }) => {
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
  await waitSaved(page);
}
async function inspect(page: Page, id: string) {
  await component(page, id).locator('.component-hit').click({ force: true });
  await expect(page.getByTestId('inspector-ref')).toHaveText(id);
}

for (const [id, file, profile] of [
  ['esp32-logic-feedback', 'sketch.ino', 'esp32-arduino-3.3.12'],
  ['mpy-logic-feedback', 'main.py', 'esp32-micropython-1.29'],
] as const)
  test(`${id}: opens with its own program, the S30-L1 pull-down and the relay stage; EN/HE; PERMIT persists`, async ({
    page,
  }) => {
    await openExample(page, id);
    const doc = await storedProject(page);
    const program = Object.values(doc.programs)[0]!;
    expect(program.profile).toBe(profile);
    // The verified twin is attached as the other language (P1 language switch).
    expect(program.alternates?.length).toBe(1);
    expect(doc.components.find((c) => c.id === 'R2')!.params.resistance).toEqual({
      value: 100_000,
      unit: 'ohm',
    });
    for (const t of ['logic.gate_and', 'component.relay', 'component.bjt_npn'])
      expect(
        doc.components.some((c) => c.type === t),
        t,
      ).toBe(true);
    await inspect(page, 'U2');
    await expect(page.getByTestId('inspector')).toContainText('SN74LVC1G08');
    await page.getByTestId('view-code').click();
    await expect(page.getByTestId('code-view')).toContainText(file);
    await expect(page.getByTestId('code-text')).toHaveAttribute('dir', 'ltr');
    await page.getByTestId('view-circuit').click();
    // Hebrew: the panel is RTL; the part number stays as written.
    await page.getByTestId('language-select').selectOption('he');
    await inspect(page, 'U2');
    await expect(page.getByTestId('inspector')).toContainText('SN74LVC1G08');
    await page.getByTestId('language-select').selectOption('en');
    // PERMIT open is a saved edit: a click on the switch on the canvas opens it (and selects it).
    await inspect(page, 'SW1');
    await expect(page.getByTestId('param-SW1-closed')).not.toBeChecked();
    await expect
      .poll(
        async () =>
          (await storedProject(page)).components.find((c) => c.id === 'SW1')!.params.closed,
      )
      .toBe(false);
    await waitSaved(page);
    await goToProjects(page);
    await reopenFromLibrary(page);
    expect((await storedProject(page)).components.find((c) => c.id === 'SW1')!.params.closed).toBe(
      false,
    );
  });
