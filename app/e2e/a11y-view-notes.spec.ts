/**
 * BETA-G3 follow-ups: the message boxes of the Circuit and 3D views, English and Hebrew:
 * - clipped messages scroll with the mouse wheel and the keyboard (WCAG 1.4.10, 2.1.1), while
 *   pointer clicks still reach the drawing under the box;
 * - the box is a named Tab stop only while it overflows;
 * - a focused part is never fully hidden by the box (2.4.11), also when the box grows later;
 * - a wire selected with [ ] is panned into view.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { goToProjects, storedProjects, waitSaved } from './helpers.js';

const NAME = { en: 'View messages', he: 'הודעות התצוגה' } as const;

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
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

type Rect = { x: number; y: number; width: number; height: number };
const rect = async (l: Locator): Promise<Rect> => (await l.boundingBox())!;
const viewBox = (page: Page) => page.getByTestId('canvas').getAttribute('viewBox');
const revision = async (page: Page) =>
  (await storedProjects(page)).map((d) => d.revision.localRevision).join(',');
const scrollTop = (box: Locator) => box.evaluate((el) => el.scrollTop);

/** A long warning, added the way a real one appears: more content in the box. */
const grow = (box: Locator) =>
  box.evaluate((el) => {
    const extra = document.createElement('div');
    extra.className = 'view-note-warning test-long';
    extra.textContent = 'W1, W2, W3 route warning text. '.repeat(200);
    el.append(extra);
  });
const shrink = (box: Locator) =>
  box.evaluate((el) => el.querySelectorAll('.test-long').forEach((x) => x.remove()));

/** The point in the middle of the box belongs to the drawing for the pointer. */
const clickThrough = (box: Locator, drawing: string) =>
  box.evaluate((el, selector) => {
    const r = el.getBoundingClientRect();
    return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(selector);
  }, drawing);

async function wheelOver(page: Page, box: Locator, dy: number) {
  const r = await rect(box);
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.wheel(0, dy);
}

for (const lang of ['en', 'he'] as const) {
  test.describe(lang, () => {
    test('circuit: a clipped message scrolls by wheel; clicks reach the drawing', async ({
      page,
    }) => {
      await openCircuit(page, lang);
      const box = page.getByTestId('canvas-hint');
      for (const [width, height] of [
        [1366, 768],
        [683, 384],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.getByTestId('canvas-fit').click();
        await grow(box);
        await expect(box).toHaveAttribute('tabindex', '0');
        expect(await clickThrough(box, 'svg.canvas'), `click through at ${height}`).toBe(true);
        const before = await viewBox(page);
        await wheelOver(page, box, 60);
        await expect.poll(() => scrollTop(box)).toBeGreaterThan(0);
        // To the end and beyond: the drawing is never zoomed from over a clipped message.
        for (let i = 0; i < 4; i++) await wheelOver(page, box, 2000);
        await expect
          .poll(() => box.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
          .toBeLessThan(2);
        await wheelOver(page, box, -4000);
        await expect.poll(() => scrollTop(box)).toBe(0);
        await page.waitForTimeout(100);
        expect(await viewBox(page)).toBe(before);
        await shrink(box);
      }
      // A message that fits leaves the wheel to the drawing (zoom), as before.
      await page.setViewportSize({ width: 1366, height: 768 });
      await expect(box).not.toHaveAttribute('tabindex');
      const before = await viewBox(page);
      await wheelOver(page, box, 100);
      await expect.poll(() => viewBox(page)).not.toBe(before);
    });

    test('circuit: the box is a named Tab stop only while it overflows', async ({ page }) => {
      await openCircuit(page, lang);
      const before = await revision(page);
      const box = page.getByTestId('canvas-hint');
      const last = page.getByTestId('canvas-pan-down');
      await expect(box).not.toHaveAttribute('tabindex');
      await expect(box).not.toHaveAttribute('role');
      await grow(box);
      await expect(box).toHaveAttribute('tabindex', '0');
      await expect(page.getByRole('group', { name: NAME[lang], exact: true })).toHaveCount(1);
      await last.focus();
      await page.keyboard.press('Tab');
      await expect(box).toBeFocused();
      expect(await box.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
      const view = await viewBox(page);
      await page.keyboard.press('ArrowDown');
      await expect.poll(() => scrollTop(box)).toBeGreaterThan(0);
      await page.keyboard.press('End');
      await page.keyboard.press('Home');
      await expect.poll(() => scrollTop(box)).toBe(0);
      expect(await viewBox(page)).toBe(view);
      // Focus is not lost when the message becomes short while the box has it.
      await shrink(box);
      await page.waitForTimeout(100);
      await expect(box).toBeFocused();
      await last.focus();
      await expect(box).not.toHaveAttribute('tabindex');
      await expect(box).not.toHaveAttribute('role');
      expect(await revision(page)).toBe(before);
    });

    test('a focused part is never fully hidden by the message box', async ({ page }) => {
      await openCircuit(page, lang);
      const box = page.getByTestId('canvas-hint');
      const first = page.locator('[data-hit="component"]').first();
      const ring = first.locator('.focus-ring');
      /** Height of the ring that is inside the drawing, above the box and below the controls. */
      const showing = async () => {
        const [t, h, c, v] = [
          await rect(ring),
          await rect(box),
          await rect(page.locator('.canvas-wrap .canvas-controls')),
          await rect(page.getByTestId('canvas')),
        ];
        const besideControls = t.x + t.width <= c.x || t.x >= c.x + c.width;
        const top = Math.max(t.y, v.y, besideControls ? v.y : c.y + c.height);
        return Math.min(t.y + t.height, h.y) - top;
      };
      for (const [width, height] of [
        [1366, 768],
        [683, 384],
        [320, 480],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.getByTestId('canvas').scrollIntoViewIfNeeded();
        await page.getByTestId('canvas-fit').click();
        // Focus first, then the message grows over the part.
        await page.getByTestId('canvas').focus();
        await page.keyboard.press('Tab');
        await expect(first).toBeFocused();
        for (let i = 0; i < 40; i++) {
          const [t, h] = [await rect(ring), await rect(box)];
          if (t.y + t.height >= h.y - 12) break;
          await page.getByTestId('canvas-pan-up').dispatchEvent('click');
        }
        await grow(box);
        await expect.poll(showing, { message: `grown at ${height}` }).toBeGreaterThan(8);
        // The message is long before the part gets focus.
        await page.getByTestId('canvas').focus();
        await page.keyboard.press('Tab');
        await expect(first).toBeFocused();
        await expect.poll(showing, { message: `tabbed at ${height}` }).toBeGreaterThan(8);
        await shrink(box);
      }
    });

    test('a wire selected with [ ] is brought into view', async ({ page }) => {
      await openCircuit(page, lang);
      const canvas = page.getByTestId('canvas');
      await canvas.focus();
      // Pan the whole circuit out of view with the keyboard-independent pan button.
      for (let i = 0; i < 14; i++) await page.getByTestId('canvas-pan-right').click();
      await canvas.focus();
      const wire = page.locator('.wire-group.selected .wire');
      for (const key of [']', '[']) {
        await page.keyboard.press(key);
        await expect(wire).toHaveCount(1);
        await expect
          .poll(async () => {
            const [w, v] = [await rect(wire), await rect(canvas)];
            const x = Math.min(w.x + w.width, v.x + v.width) - Math.max(w.x, v.x);
            const y = Math.min(w.y + w.height, v.y + v.height) - Math.max(w.y, v.y);
            return x >= 0 && y >= 0;
          })
          .toBe(true);
      }
    });

    test('3D: a clipped note scrolls by wheel and keyboard; clicks reach the model', async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openCircuit(page, lang);
      await page.getByTestId('view-3d').click();
      await expect(page.getByTestId('view3d')).toHaveAttribute('data-status', 'ready', {
        timeout: 120_000,
      });
      const box = page.locator('.view3d-wrap .view-note');
      await expect(box).not.toHaveAttribute('tabindex');
      for (const [width, height] of [
        [1366, 768],
        [683, 384],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(300);
        await grow(box);
        await expect(box).toHaveAttribute('tabindex', '0');
        await expect(page.getByRole('group', { name: NAME[lang], exact: true })).toHaveCount(1);
        expect(await clickThrough(box, '.view3d-host'), `click through at ${height}`).toBe(true);
        const renders = await page.getByTestId('view3d').getAttribute('data-renders');
        await wheelOver(page, box, 60);
        await expect.poll(() => scrollTop(box)).toBeGreaterThan(0);
        await page.waitForTimeout(500);
        // No camera zoom: the scene was not redrawn.
        expect(await page.getByTestId('view3d').getAttribute('data-renders')).toBe(renders);
        await box.focus();
        await page.keyboard.press('Home');
        await expect.poll(() => scrollTop(box)).toBe(0);
        await page.keyboard.press('ArrowDown');
        await expect.poll(() => scrollTop(box)).toBeGreaterThan(0);
        await shrink(box);
      }
    });
  });
}
