/**
 * BETA-G3: the Circuit and 3D views pan, and the 3D view orbits, without dragging (WCAG 2.5.7,
 * 2.1.1), English and Hebrew:
 * - four named pan buttons in both views, tilt buttons and keys in 3D, each at least 24 x 24
 *   CSS px with a visible focus ring; directions are physical (never mirrored in RTL);
 * - arrows move the view the same way in the Circuit, Schematic and 3D views;
 * - at 1366x768, in a short view and at 320 CSS px the controls stay inside the view, clear of
 *   each other and of the view's other overlays. The project is never edited.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { goToProjects, storedProjects, waitSaved } from './helpers.js';

const PAN = {
  en: ['Move view left', 'Move view right', 'Move view up', 'Move view down'],
  he: ['הזזת התצוגה שמאלה', 'הזזת התצוגה ימינה', 'הזזת התצוגה למעלה', 'הזזת התצוגה למטה'],
} as const;
const TEXT = {
  en: { group: 'Circuit view controls', tilt: ['Look from higher', 'Look from lower'] },
  he: { group: 'פקדי תצוגת המעגל', tilt: ['מבט מגבוה יותר', 'מבט מנמוך יותר'] },
} as const;
/** Optional directory for review screenshots; nothing is written without it. */
const SHOTS = process.env.TBI_SHOT_DIR;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};
const DIRECTIONS = ['left', 'right', 'up', 'down'] as const;
/** 1366x768, two short views (as zoomed laptop screens) and a 320 CSS px reflow width. */
const SIZES = [
  [1366, 768],
  [683, 384],
  [640, 360],
  [320, 640],
] as const;

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.addInitScript(() => localStorage.setItem('tbi-lab.3d.inspect', '1'));
});

async function openCircuit(page: Page, lang: 'en' | 'he') {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(lang);
  await page.getByTestId('open-example-voltage-divider').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}
async function open3d(page: Page) {
  await page.getByTestId('view-3d').click();
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready', {
    timeout: 120_000,
  });
}
const revision = async (page: Page) =>
  (await storedProjects(page)).map((d) => d.revision.localRevision).join(',');
const rect = async (l: Locator) => (await l.boundingBox())!;
type Rect = { x: number; y: number; width: number; height: number };
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.width - 0.5 &&
  b.x < a.x + a.width - 0.5 &&
  a.y < b.y + b.height - 0.5 &&
  b.y < a.y + a.height - 0.5;

const box2d = async (page: Page) => {
  const [x, y, w, h] = (await page.getByTestId('canvas').getAttribute('viewBox'))!
    .split(' ')
    .map(Number);
  return { x: x!, y: y!, w: w!, h: h! };
};
async function changed2d(page: Page, before: Awaited<ReturnType<typeof box2d>>) {
  await expect.poll(() => box2d(page)).not.toEqual(before);
  return box2d(page);
}
/** Where the camera's target and a point above it appear on screen (opt-in viewer hook). */
const seen = async (page: Page, target?: string) => {
  const at = (target ?? (await page.getByTestId('view3d').getAttribute('data-target'))!)
    .split(',')
    .map(Number) as [number, number, number];
  return page.evaluate(([x, y, z]) => {
    const host = document.querySelector('[data-testid="view3d-host"]') as unknown as {
      tbiViewer: { screenOf(p: [number, number, number]): { x: number; y: number } };
    };
    return {
      origin: host.tbiViewer.screenOf([x, y, z]),
      up: host.tbiViewer.screenOf([x, y + 5, z]),
    };
  }, at);
};
/** How tall a vertical rod through the target looks: nothing from above, long from low down. */
const rise = async (page: Page) => {
  const s = await seen(page);
  return s.origin.y - s.up.y;
};

/** The button: translated name and target size (the focus ring is checked where it is tabbed to). */
async function expectButton(button: Locator, name: string) {
  await expect(button).toHaveAccessibleName(name);
  const box = await rect(button);
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);
}

/** Every control is inside its view, uncovered, and clear of the other controls and overlays. */
async function expectLayout(page: Page, wrap: string, others: string[]) {
  const buttons = page.locator(`${wrap} .canvas-controls button`);
  const boxes: Rect[] = [];
  for (let i = 0; i < (await buttons.count()); i++) {
    // At 320px the page scrolls sideways: bring the button on screen before measuring.
    await buttons.nth(i).scrollIntoViewIfNeeded();
    const view = await rect(page.locator(wrap));
    const b = await rect(buttons.nth(i));
    expect(b.x).toBeGreaterThanOrEqual(view.x - 0.5);
    expect(b.y).toBeGreaterThanOrEqual(view.y - 0.5);
    expect(b.x + b.width).toBeLessThanOrEqual(view.x + view.width + 0.5);
    expect(b.y + b.height).toBeLessThanOrEqual(view.y + view.height + 0.5);
    const local = { ...b, x: b.x - view.x, y: b.y - view.y };
    for (const o of boxes) expect(overlap(local, o), `button ${i}`).toBe(false);
    boxes.push(local);
    const hit = await buttons.nth(i).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    });
    expect(hit, `button ${i} of ${wrap} at ${JSON.stringify(page.viewportSize())} is on top`).toBe(
      true,
    );
  }
  const controls = await rect(page.locator(`${wrap} .canvas-controls`));
  for (const other of others) {
    const el = page.locator(`${wrap} ${other}`);
    if (!(await el.isVisible())) continue;
    const o = await rect(el);
    const at = JSON.stringify({ other, view: page.viewportSize(), controls, o });
    expect(overlap(controls, o), at).toBe(false);
  }
}

for (const lang of ['en', 'he'] as const) {
  test.describe(lang, () => {
    test('circuit: four named pan buttons move the view, by pointer and keyboard', async ({
      page,
    }) => {
      await openCircuit(page, lang);
      const before = await revision(page);
      await expect(page.getByRole('group', { name: TEXT[lang].group })).toBeVisible();
      const fit = await box2d(page);
      let prev = fit;
      for (const [i, direction] of DIRECTIONS.entries()) {
        const button = page.getByTestId(`canvas-pan-${direction}`);
        await expectButton(button, PAN[lang][i]!);
        await button.click();
        const now = await changed2d(page, prev);
        const sign = direction === 'left' || direction === 'up' ? -1 : 1;
        const horizontal = direction === 'left' || direction === 'right';
        expect(now.x - prev.x).toBeCloseTo(horizontal ? sign * prev.w * 0.1 : 0, 3);
        expect(now.y - prev.y).toBeCloseTo(horizontal ? 0 : sign * prev.h * 0.1, 3);
        prev = now;
      }
      // Physical placement: "left" is left of "right", also in Hebrew.
      const left = page.getByTestId('canvas-pan-left');
      expect((await rect(left)).x).toBeLessThan(
        (await rect(page.getByTestId('canvas-pan-right'))).x,
      );
      await page.getByTestId('canvas-fit').focus();
      await page.keyboard.press('Tab');
      await expect(left).toBeFocused();
      expect(await left.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
      await page.keyboard.press('Enter');
      prev = await changed2d(page, prev);
      await page.keyboard.press('Space');
      await changed2d(page, prev);
      expect(await revision(page)).toBe(before);
    });

    test('circuit: the drawing and its parts are real tab stops', async ({ page }) => {
      await openCircuit(page, lang);
      await expect(page.getByTestId('canvas')).toHaveAttribute('tabindex', '0');
      await expect(page.locator('[data-hit="component"]').first()).toHaveAttribute('tabindex', '0');
    });

    test('2D: the empty part of the control box lets the pointer reach the drawing', async ({
      page,
    }) => {
      await openCircuit(page, lang);
      for (const wrap of ['.canvas-wrap', '.schematic-wrap']) {
        if (wrap === '.schematic-wrap') await page.getByTestId('view-schematic').click();
        const controls = page.locator(`${wrap} .canvas-controls`);
        await expect(controls).toBeVisible();
        const box = await rect(controls);
        // Beside the single column of buttons, above the pan buttons.
        const reachesDrawing = await page.evaluate(
          ([x, y, selector]) =>
            document.elementFromPoint(x, y)?.closest('svg') ===
            document.querySelector(`${selector} > svg`),
          [box.x + 4, box.y + 4, wrap] as const,
        );
        expect(reachesDrawing, wrap).toBe(true);
      }
    });

    test('3D: pan and tilt by buttons and keys; arrows go the same way as in 2D', async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openCircuit(page, lang);
      const before = await revision(page);
      await open3d(page);
      const host = page.getByTestId('view3d-host');
      const reset = page.getByTestId('view3d-reset');
      await reset.click();
      const view = page.getByTestId('view3d');
      await expect(view).toHaveAttribute('data-target', /,/);
      const home = (await view.getAttribute('data-target'))!;
      for (const [i, direction] of DIRECTIONS.entries()) {
        const button = page.getByTestId(`view3d-pan-${direction}`);
        await expectButton(button, PAN[lang][i]!);
        for (const by of ['click', 'key'] as const) {
          await reset.click();
          const from = await seen(page, home);
          if (by === 'click') await button.click();
          else {
            await host.focus();
            await page.keyboard.press(
              `Shift+Arrow${direction[0]!.toUpperCase()}${direction.slice(1)}`,
            );
          }
          // The view moves that way, so the content appears to move the other way.
          const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';
          const sign = direction === 'left' || direction === 'up' ? 1 : -1;
          await expect
            .poll(async () => ((await seen(page, home)).origin[axis] - from.origin[axis]) * sign)
            .toBeGreaterThan(5);
        }
      }
      for (const [i, direction] of (['up', 'down'] as const).entries()) {
        const button = page.getByTestId(`view3d-tilt-${direction}`);
        await expectButton(button, TEXT[lang].tilt[i]!);
        for (const by of ['click', 'key'] as const) {
          await reset.click();
          const from = await rise(page);
          if (by === 'click') await button.click();
          else {
            await host.focus();
            await page.keyboard.press(direction === 'up' ? 'ArrowUp' : 'ArrowDown');
          }
          const sign = direction === 'up' ? -1 : 1;
          await expect
            .poll(async () => ((await rise(page)) - from) * sign, `${direction} by ${by}`)
            .toBeGreaterThan(1);
        }
      }
      // Both limits hold: straight above, and not under the bench.
      await host.focus();
      for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowUp');
      await expect.poll(async () => Math.abs(await rise(page))).toBeLessThan(2);
      for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
      await expect.poll(() => rise(page)).toBeGreaterThan(2);
      await reset.focus();
      await page.keyboard.press('Tab');
      const first = page.getByTestId('view3d-pan-left');
      await expect(first).toBeFocused();
      expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
      expect(await revision(page)).toBe(before);
    });

    test('controls stay clear in wide, short and 320px views', async ({ page }) => {
      test.setTimeout(180_000);
      await openCircuit(page, lang);
      for (const [width, height] of SIZES) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(200);
        await page.locator('.canvas-wrap').scrollIntoViewIfNeeded();
        await shot(page, `circuit-${lang}-${width}x${height}`);
        await expectLayout(page, '.canvas-wrap', ['.canvas-hint']);
      }
      await page.setViewportSize({ width: 1366, height: 768 });
      await open3d(page);
      for (const [width, height] of SIZES) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(300);
        await page.locator('.view3d-wrap').scrollIntoViewIfNeeded();
        await shot(page, `view3d-${lang}-${width}x${height}`);
        await expectLayout(page, '.view3d-wrap', ['.view-note', '.view3d-presets']);
      }
    });
  });
}
