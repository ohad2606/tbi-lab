/**
 * WCAG 2.2 2.4.11 Focus Not Obscured (BETA-G3), English and Hebrew:
 * - a Circuit part, wiring pin or wiring target that gets keyboard focus is panned clear of the
 *   view controls and the hint; a mouse click never makes the view jump;
 * - the hint never covers the view controls; the 3D note never paints over the preset buttons.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { component, goToProjects, waitSaved } from './helpers.js';

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

type Rect = { x: number; y: number; width: number; height: number };
const rect = async (l: Locator): Promise<Rect> => (await l.boundingBox())!;
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.width - 0.5 &&
  b.x < a.x + a.width - 0.5 &&
  a.y < b.y + b.height - 0.5 &&
  b.y < a.y + a.height - 0.5;

/** `target` is wholly inside the drawing and clear of the controls and the hint. */
async function expectClear(page: Page, target: Locator, what: string) {
  await expect
    .poll(
      async () => {
        const t = await rect(target);
        const view = await rect(page.getByTestId('canvas'));
        const inside =
          t.x >= view.x - 0.5 &&
          t.y >= view.y - 0.5 &&
          t.x + t.width <= view.x + view.width + 0.5 &&
          t.y + t.height <= view.y + view.height + 0.5;
        const controls = overlap(t, await rect(page.locator('.canvas-wrap .canvas-controls')));
        const hint = overlap(t, await rect(page.getByTestId('canvas-hint')));
        return { inside, controls, hint };
      },
      { message: what },
    )
    .toEqual({ inside: true, controls: false, hint: false });
}

/** Middle-button drag that puts the centre of `what` under the centre of the controls. */
async function dragUnderControls(page: Page, what: Locator) {
  const a = await rect(what);
  const b = await rect(page.locator('.canvas-wrap .canvas-controls'));
  const view = await rect(page.getByTestId('canvas'));
  const from = { x: view.x + view.width / 3, y: view.y + view.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(
    from.x + b.x + b.width / 2 - a.x - a.width / 2,
    from.y + b.y + b.height / 2 - a.y - a.height / 2,
    { steps: 4 },
  );
  await page.mouse.up({ button: 'middle' });
  await expect.poll(async () => overlap(await rect(what), b)).toBe(true);
}

const viewBox = (page: Page) => page.getByTestId('canvas').getAttribute('viewBox');

for (const lang of ['en', 'he'] as const) {
  test.describe(lang, () => {
    test('a part focused by Tab is brought clear; a click never moves the view', async ({
      page,
    }) => {
      await openCircuit(page, lang);
      const first = page.locator('[data-hit="component"]').first();
      const ring = first.locator('.focus-ring');
      for (const [width, height] of [
        [1366, 768],
        [683, 384],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.getByTestId('canvas-fit').click();
        await dragUnderControls(page, ring);
        await page.getByTestId('canvas').focus();
        await page.keyboard.press('Tab');
        await expect(first).toBeFocused();
        await expectClear(page, ring, `part at ${width}x${height}`);
      }
      // Pointer: a part partly under the controls stays where it is when clicked.
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.getByTestId('canvas-fit').click();
      const id = (await first.getAttribute('data-id'))!;
      const hit = component(page, id).locator('.component-hit');
      const a = await rect(hit);
      const bar = await rect(page.locator('.canvas-wrap .canvas-controls'));
      const from = { x: a.x - 100, y: bar.y + bar.height + 100 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(from.x + bar.x - a.x - a.width / 2, from.y + bar.y + 20 - a.y);
      await page.mouse.up({ button: 'middle' });
      const before = await viewBox(page);
      const moved = await rect(hit);
      await page.mouse.click(moved.x + 4, moved.y + moved.height / 2);
      await expect(first).toHaveAttribute('data-selected', 'true');
      await page.waitForTimeout(200);
      expect(await viewBox(page)).toBe(before);
    });

    test('wiring pins and targets are never under the controls or the hint', async ({ page }) => {
      await openCircuit(page, lang);
      const first = page.locator('[data-hit="component"]').first();
      for (const [width, height] of [
        [1366, 768],
        [683, 384],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.getByTestId('canvas-fit').click();
        await page.getByTestId('canvas').focus();
        await page.keyboard.press('Tab');
        await expect(first).toBeFocused();
        await dragUnderControls(page, first.locator('.focus-ring'));
        await page.keyboard.press('w');
        const pin = page.locator('[data-hit="terminal"]:focus');
        await expect(pin).toHaveCount(1);
        await expectClear(page, pin, `first pin at ${width}x${height}`);
        await page.keyboard.press('ArrowRight');
        await expectClear(page, pin, `second pin at ${width}x${height}`);
        await page.keyboard.press('Enter');
        for (let i = 0; i < 4; i++) await page.keyboard.press('+');
        for (let i = 0; i < 14; i++) {
          await page.keyboard.press('ArrowRight');
          const target = page.locator('[data-kb-candidate="true"], [data-kb-wire-target="true"]');
          // A wire target is a long line; pins and junctions are points.
          const point = page.locator('[data-kb-candidate="true"]');
          if ((await target.count()) && (await point.count()))
            await expectClear(page, point.first(), `target ${i} at ${width}x${height}`);
        }
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
      }
    });

    test('a long hint never covers the view controls in low views', async ({ page }) => {
      await openCircuit(page, lang);
      const wrap = page.locator('.canvas-wrap');
      for (const target of [260, 285, 310, 335]) {
        await page.setViewportSize({ width: 900, height: 600 });
        const now = (await rect(wrap)).height;
        await page.setViewportSize({ width: 900, height: Math.round(600 + target - now) });
        await page.waitForTimeout(200);
        await page.getByTestId('canvas-hint').evaluate((el) => {
          el.querySelector('.view-note-warning')?.remove();
          const extra = document.createElement('div');
          extra.className = 'view-note-warning';
          extra.textContent = 'W1, W2, W3 route warning text. '.repeat(30);
          el.append(extra);
        });
        const hint = await rect(page.getByTestId('canvas-hint'));
        for (const button of await page.locator('.canvas-wrap .canvas-controls button').all()) {
          const at = `view ${(await rect(wrap)).height}px`;
          expect(overlap(await rect(button), hint), at).toBe(false);
        }
      }
    });

    test('3D: a long note never paints over the preset buttons', async ({ page }) => {
      test.setTimeout(180_000);
      await openCircuit(page, lang);
      await page.getByTestId('view-3d').click();
      await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready', {
        timeout: 120_000,
      });
      for (const [width, height] of [
        [683, 384],
        [320, 640],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(300);
        const note = page.locator('.view3d-wrap .view-note');
        await note.evaluate((el) => {
          const extra = document.createElement('div');
          extra.className = 'view-note-warning';
          extra.textContent = 'R1, R2 overlap warning text. '.repeat(40);
          el.append(extra);
        });
        const view = await rect(page.locator('.view3d-wrap'));
        expect((await rect(note)).height).toBeLessThanOrEqual(view.height / 2 + 1);
        for (const button of await page.locator('.view3d-presets button').all()) {
          await button.focus();
          // At 320px the page scrolls sideways: bring the whole button on screen.
          await button.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
          const onTop = await button.evaluate((el) => {
            const n = document.querySelector<HTMLElement>('.view3d-wrap .view-note')!;
            n.style.pointerEvents = 'auto';
            const r = el.getBoundingClientRect();
            const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            n.style.pointerEvents = '';
            return el.contains(top);
          });
          expect(onTop, `preset on top at ${width}x${height}`).toBe(true);
        }
      }
    });
  });
}
