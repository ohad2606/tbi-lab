/**
 * Operating physical controls in 3D during a simulation (Sprint 10, owner-approved): the toggle
 * switch's lever toggles on a click, the push button is held exactly while pressed; both act
 * through the same action path as the Circuit view (one state, both views agree); stopped, a
 * click selects instead; nothing ever stays pressed (release, cancel, leaving, Stop).
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects, storedProject } from './helpers.js';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.addInitScript(() => localStorage.setItem('tbi-lab.3d.inspect', '1'));
});

async function openExample(page: Page, id: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
}
async function open3d(page: Page) {
  await page.getByTestId('view-3d').click();
  const view = page.getByTestId('view3d');
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 120_000 });
  await page.getByTestId('view3d-view-top').click();
  return view;
}
const run = async (page: Page) => {
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
};
/** Screen point of a part's actuator (the opt-in viewer hook). */
const actuatorAt = (page: Page, id: string) =>
  page.evaluate((part) => {
    const host = document.querySelector('[data-testid="view3d-host"]') as unknown as {
      tbiViewer: { screenOf(p: [number, number, number]): { x: number; y: number } };
      tbiActuators: { id: string; box: Record<string, number> }[];
    };
    const b = host.tbiActuators.find((a) => a.id === part)!.box;
    return host.tbiViewer.screenOf([(b.x0! + b.x1!) / 2, b.top!, (b.z0! + b.z1!) / 2]);
  }, id);
const pose = (page: Page, id: string) =>
  page.evaluate((part) => {
    const host = document.querySelector('[data-testid="view3d-host"]') as unknown as {
      tbiViewer: { poses(): Record<string, number> };
    };
    return host.tbiViewer.poses()[part]!;
  }, id);
const circuit = (page: Page, id: string) => page.locator(`[data-hit="component"][data-id="${id}"]`);

test('toggle switch: the 3D lever toggles while running, both views agree; stopped, it selects', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await openExample(page, 'rgb-mixer'); // SW3 open: the blue channel off
  const view = await open3d(page);
  await expect(view).toHaveAttribute('data-controls', /SW3:open/);
  expect(await pose(page, 'SW3')).toBeCloseTo(0.38, 2);

  // Stopped: a click on the lever selects the switch and changes nothing.
  let at = await actuatorAt(page, 'SW3');
  await page.mouse.click(at.x, at.y);
  await expect(view).toHaveAttribute('data-selected', 'C:SW3');
  await expect(view).toHaveAttribute('data-controls', /SW3:open/);

  // Running: the lever toggles; the lever moves; the Circuit view and the circuit follow.
  await run(page);
  await expect(page.getByTestId('view3d-controls-hint')).toBeVisible();
  const glowBefore = await view.getAttribute('data-glow');
  at = await actuatorAt(page, 'SW3');
  await page.mouse.click(at.x, at.y);
  await expect(view).toHaveAttribute('data-controls', /SW3:closed/);
  await expect(circuit(page, 'SW3')).toHaveAttribute('data-closed', 'true');
  await expect.poll(() => pose(page, 'SW3')).toBeCloseTo(-0.38, 2);
  await expect.poll(() => view.getAttribute('data-glow')).not.toBe(glowBefore);
  expect((await storedProject(page)).components.find((c) => c.id === 'SW3')!.params.closed).toBe(
    true,
  );
  // The click operated it; it did not orbit the camera or change the selection.
  await expect(view).toHaveAttribute('data-selected', 'C:SW3');

  // A second click: back to open.
  await page.mouse.click(at.x, at.y);
  await expect(view).toHaveAttribute('data-controls', /SW3:open/);
  await expect(circuit(page, 'SW3')).toHaveAttribute('data-closed', 'false');
  await expect.poll(() => pose(page, 'SW3')).toBeCloseTo(0.38, 2);

  // Keyboard: the selected switch toggles with Space while running.
  await page.getByTestId('view3d-host').focus();
  await page.keyboard.press('Space');
  await expect(view).toHaveAttribute('data-controls', /SW3:closed/);
  await expect(page.getByTestId('view3d-control')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('view3d-control')).toHaveAttribute(
    'aria-label',
    'Toggle switch SW3, closed',
  );

  // Circuit -> 3D: flipped in the Circuit view, the lever follows.
  await page.getByTestId('sim-stop').click();
  await page.getByTestId('view-circuit').click();
  await page.getByTestId('actuator-SW3').click();
  await expect(circuit(page, 'SW3')).toHaveAttribute('data-closed', 'false');
  await open3d(page);
  await expect(view).toHaveAttribute('data-controls', /SW3:open/);
  await expect.poll(() => pose(page, 'SW3')).toBeCloseTo(0.38, 2);
});

test('push button: held in 3D exactly while pressed; release, cancel, leaving and Stop all release it', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await openExample(page, 'push-button'); // SW1 lights D1 only while pressed
  const view = await open3d(page);
  const rest = await pose(page, 'SW1');
  await run(page);
  const at = await actuatorAt(page, 'SW1');

  // Press: pressed electrically (the LED lights, the Circuit view shows it) and visually.
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await expect(view).toHaveAttribute('data-controls', /SW1:pressed/);
  await expect(circuit(page, 'SW1')).toHaveAttribute('data-pressed', 'true');
  await expect(view).toHaveAttribute('data-lit', /D1/);
  await expect.poll(() => pose(page, 'SW1')).toBeLessThan(rest - 0.3);
  // Release.
  await page.mouse.up();
  await expect(view).not.toHaveAttribute('data-controls', /SW1:pressed/);
  await expect(circuit(page, 'SW1')).toHaveAttribute('data-pressed', 'false');
  await expect(view).not.toHaveAttribute('data-lit', /D1/);
  await expect.poll(() => pose(page, 'SW1')).toBeCloseTo(rest, 3);

  // Leaving the view while held: the release still arrives (pointer capture).
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await expect(view).toHaveAttribute('data-controls', /SW1:pressed/);
  await page.mouse.move(5, 5, { steps: 4 });
  await page.mouse.up();
  await expect(view).not.toHaveAttribute('data-controls', /SW1:pressed/);

  // A cancelled pointer releases it.
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await expect(view).toHaveAttribute('data-controls', /SW1:pressed/);
  await page.evaluate(() =>
    document
      .querySelector('[data-testid="view3d-host"]')!
      .dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })),
  );
  await expect(view).not.toHaveAttribute('data-controls', /SW1:pressed/);
  await page.mouse.up();

  // Keyboard: selected, Space held = pressed, released on key up (auto-repeat changes nothing).
  await page.getByTestId('sim-stop').click();
  await page.mouse.click(at.x, at.y); // stopped: selects
  await expect(view).toHaveAttribute('data-selected', 'C:SW1');
  await run(page);
  await page.getByTestId('view3d-host').focus();
  await page.keyboard.down('Space');
  await expect(view).toHaveAttribute('data-controls', /SW1:pressed/);
  await expect(page.getByTestId('view3d-control')).toHaveAttribute(
    'aria-label',
    'Push button SW1, pressed',
  );
  await page.keyboard.up('Space');
  await expect(view).not.toHaveAttribute('data-controls', /SW1:pressed/);

  // Stop while held: nothing stays pressed, the cap returns.
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await expect(view).toHaveAttribute('data-controls', /SW1:pressed/);
  await page.evaluate(() =>
    (document.querySelector('[data-testid="sim-stop"]') as HTMLButtonElement).click(),
  );
  await expect(page.getByTestId('sim-status')).not.toHaveAttribute('data-status', 'running');
  await expect(view).not.toHaveAttribute('data-controls', /SW1:pressed/);
  await page.mouse.up();
  await expect.poll(() => pose(page, 'SW1')).toBeCloseTo(rest, 3);
  await expect(circuit(page, 'SW1')).toHaveAttribute('data-pressed', 'false');
});
