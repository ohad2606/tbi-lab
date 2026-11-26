/**
 * BETA-G3: the schematic view pans and zooms without dragging (WCAG 2.1.1, 2.5.7), English and
 * Hebrew:
 * - the drawing is a named tab stop: arrows move the view (never mirrored in RTL), + = - zoom,
 *   Home fits; browser chords are left alone;
 * - four named pan buttons beside zoom / fit, each at least 24 x 24 CSS px;
 * - a part that gets keyboard focus off screen (or under the controls) is brought into view; a
 *   mouse click or a drag never makes the view jump;
 * - the controls stay inside the view at a 320px-wide window. The project is never edited.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { goToProjects, storedProjects, waitSaved } from './helpers.js';

const TEXT = {
  en: {
    name: /^Schematic of .+\. Arrow keys move the view, plus and minus zoom, Home fits/,
    buttons: ['Move view left', 'Move view right', 'Move view up', 'Move view down'],
  },
  he: {
    name: /^סכמה חשמלית של .+\. מקשי החצים מזיזים את התצוגה/,
    buttons: ['הזזת התצוגה שמאלה', 'הזזת התצוגה ימינה', 'הזזת התצוגה למעלה', 'הזזת התצוגה למטה'],
  },
} as const;
const DIRECTIONS = ['left', 'right', 'up', 'down'] as const;

async function openSchematic(page: Page, lang: 'en' | 'he') {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(lang);
  await page.getByTestId('open-example-voltage-divider').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  await page.getByTestId('view-schematic').click();
  await expect(page.getByTestId('schematic-view')).toBeVisible();
}

const svgOf = (page: Page) => page.locator('svg.schematic');
type Box = { x: number; y: number; w: number; h: number };
async function viewBox(page: Page): Promise<Box> {
  const [x, y, w, h] = (await svgOf(page).getAttribute('viewBox'))!.split(' ').map(Number);
  return { x: x!, y: y!, w: w!, h: h! };
}
/** The view box once it no longer equals `before`. */
async function changed(page: Page, before: Box): Promise<Box> {
  await expect.poll(() => viewBox(page)).not.toEqual(before);
  return viewBox(page);
}
const revision = async (page: Page) =>
  (await storedProjects(page)).map((d) => d.revision.localRevision).join(',');

const rect = async (l: Locator) => (await l.boundingBox())!;
const overlap = (
  a: { x: number; y: number; width: number; height: number },
  b: typeof a,
): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The part is wholly inside the drawing and not under the controls or the note. */
async function expectInView(page: Page, id: string) {
  await expect
    .poll(async () => {
      const part = await rect(page.locator(`.schematic [data-part="${id}"]`));
      const svg = await rect(svgOf(page));
      const inside =
        part.x >= svg.x - 0.5 &&
        part.y >= svg.y - 0.5 &&
        part.x + part.width <= svg.x + svg.width + 0.5 &&
        part.y + part.height <= svg.y + svg.height + 0.5;
      const covered =
        overlap(part, await rect(page.locator('.schematic-wrap .canvas-controls'))) ||
        overlap(part, await rect(page.locator('.schematic-wrap .view-note')));
      return { inside, covered };
    })
    .toEqual({ inside: true, covered: false });
}

for (const lang of ['en', 'he'] as const) {
  test.describe(lang, () => {
    test('the drawing is a named tab stop; arrows move the view, + - zoom, Home fits', async ({
      page,
    }) => {
      await openSchematic(page, lang);
      const before = await revision(page);
      const svg = svgOf(page);
      await expect(svg).toHaveAttribute('role', 'group');
      await expect(svg).toHaveAccessibleName(TEXT[lang].name);
      await expect(svg).toHaveAttribute(
        'aria-keyshortcuts',
        'ArrowLeft ArrowRight ArrowUp ArrowDown Plus = - Home',
      );
      // Reached by Tab from the view tabs, ahead of its parts; the focus ring is drawn.
      await page.getByTestId('view-schematic').focus();
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab');
        if (await svg.evaluate((el) => el === document.activeElement)) break;
        expect(await page.evaluate(() => !!document.activeElement?.closest('[data-part]'))).toBe(
          false,
        );
      }
      await expect(svg).toBeFocused();
      expect(await svg.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
      await page.keyboard.press('Tab');
      await expect(page.locator('.schematic [data-part]:focus')).toHaveCount(1);
      await page.keyboard.press('Shift+Tab');
      await expect(svg).toBeFocused();

      const fit = await viewBox(page);
      let prev = fit;
      for (const [key, dx, dy] of [
        ['ArrowRight', 1, 0],
        ['ArrowDown', 0, 1],
        ['ArrowLeft', -1, 0],
        ['ArrowUp', 0, -1],
        ['Shift+ArrowRight', 1, 0],
      ] as const) {
        await page.keyboard.press(key);
        const now = await changed(page, prev);
        expect(now.x - prev.x, key).toBeCloseTo(dx * prev.w * 0.1, 3);
        expect(now.y - prev.y, key).toBeCloseTo(dy * prev.h * 0.1, 3);
        expect(now.w, key).toBeCloseTo(prev.w, 6);
        prev = now;
      }
      for (const key of ['+', '=']) {
        await page.keyboard.press(key);
        const now = await changed(page, prev);
        expect(now.w, key).toBeLessThan(prev.w);
        prev = now;
      }
      await page.keyboard.press('-');
      expect((await changed(page, prev)).w).toBeGreaterThan(prev.w);
      await page.keyboard.press('Home');
      await expect.poll(() => viewBox(page)).toEqual(fit);
      // Browser chords are not taken.
      for (const key of ['Control+ArrowRight', 'Control+-', 'Control+Home', 'Alt+ArrowDown']) {
        const taken = svg.evaluate(
          (el) =>
            new Promise<boolean>((done) =>
              el.addEventListener(
                'keydown',
                (e) => {
                  if (!['Control', 'Alt'].includes((e as KeyboardEvent).key))
                    setTimeout(() => done(e.defaultPrevented));
                },
                { once: false },
              ),
            ),
        );
        await page.waitForTimeout(50);
        await page.keyboard.press(key);
        expect(await taken, key).toBe(false);
      }
      expect(await viewBox(page)).toEqual(fit);
      expect(await revision(page)).toBe(before);
    });

    test('four named pan buttons move the view without dragging', async ({ page }) => {
      await openSchematic(page, lang);
      const before = await revision(page);
      const fit = await viewBox(page);
      let prev = fit;
      for (const [i, direction] of DIRECTIONS.entries()) {
        const button = page.getByTestId(`schematic-pan-${direction}`);
        await expect(button).toHaveAccessibleName(TEXT[lang].buttons[i]!);
        const box = await rect(button);
        expect(box.width).toBeGreaterThanOrEqual(24);
        expect(box.height).toBeGreaterThanOrEqual(24);
        await button.click();
        const now = await changed(page, prev);
        const sign = direction === 'left' || direction === 'up' ? -1 : 1;
        const horizontal = direction === 'left' || direction === 'right';
        expect(now.x - prev.x).toBeCloseTo(horizontal ? sign * prev.w * 0.1 : 0, 3);
        expect(now.y - prev.y).toBeCloseTo(horizontal ? 0 : sign * prev.h * 0.1, 3);
        prev = now;
      }
      // The same buttons work from the keyboard, with a visible focus ring.
      await page.getByTestId('schematic-fit').focus();
      await page.keyboard.press('Tab');
      const left = page.getByTestId('schematic-pan-left');
      await expect(left).toBeFocused();
      expect(await left.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
      await page.keyboard.press('Enter');
      prev = await changed(page, prev);
      await page.keyboard.press('Space');
      await changed(page, prev);
      await page.getByTestId('schematic-fit').click();
      await expect.poll(() => viewBox(page)).toEqual(fit);
      expect(await revision(page)).toBe(before);
    });

    test('keyboard focus brings an off-screen part into view; Enter and Space still select', async ({
      page,
    }) => {
      await openSchematic(page, lang);
      const before = await revision(page);
      const svg = svgOf(page);
      const ids = await page
        .locator('.schematic [data-part]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-part')!));
      const frame = await rect(svg);
      await svg.focus();
      // Parts already in view do not move it when they get focus.
      const fit = await viewBox(page);
      for (const id of ids) {
        await page.keyboard.press('Tab');
        await expectInView(page, id);
      }
      expect(await viewBox(page)).toEqual(fit);
      await svg.focus();
      await page.keyboard.press('+');
      await page.keyboard.press('+');
      // Move far enough that every part is off screen.
      for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowRight');
      for (const id of ids) {
        await expect
          .poll(async () => {
            const part = await rect(page.locator(`.schematic [data-part="${id}"]`));
            return part.x + part.width < frame.x;
          })
          .toBe(true);
      }
      for (const id of ids) {
        await page.keyboard.press('Tab');
        await expect(page.locator(`.schematic [data-part="${id}"]`)).toBeFocused();
        await expectInView(page, id);
      }
      // Backwards too, and the page itself has not scrolled.
      for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Shift+Tab');
      const previous = ids.at(-2)!;
      await expect(page.locator(`.schematic [data-part="${previous}"]`)).toBeFocused();
      await expectInView(page, previous);
      expect(await rect(svg)).toEqual(frame);
      const still = await viewBox(page);
      const part = page.locator(`.schematic [data-part="${previous}"]`);
      await page.keyboard.press('Enter');
      await expect(part).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('inspector-ref')).toHaveText(previous);
      await page.keyboard.press('Shift+Tab');
      const first = page.locator(`.schematic [data-part="${ids.at(-3)!}"]`);
      await expect(first).toBeFocused();
      await page.keyboard.press('Space');
      await expect(first).toHaveAttribute('aria-pressed', 'true');
      expect((await viewBox(page)).w).toBeCloseTo(still.w, 6);
      // The view keys also work while a part has focus.
      const moved = await viewBox(page);
      await page.keyboard.press('ArrowRight');
      await changed(page, moved);
      expect(await revision(page)).toBe(before);
    });

    test('a mouse click never makes the view jump; dragging still pans', async ({ page }) => {
      await openSchematic(page, lang);
      const before = await revision(page);
      const svg = svgOf(page);
      const frame = await rect(svg);
      const part = page.locator('.schematic [data-part="R2"]');
      const hit = part.locator('.sch-hit');
      // Drag R2 partly past the left edge.
      const start = await rect(hit);
      const from = { x: frame.x + 40, y: frame.y + 40 };
      const dx = frame.x - (start.x + start.width / 2);
      const fit = await viewBox(page);
      await page.mouse.move(from.x - dx, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x, from.y, { steps: 5 });
      await page.mouse.up();
      const dragged = await changed(page, fit);
      const now = await rect(hit);
      expect(now.x).toBeLessThan(frame.x);
      await page.mouse.click(now.x + now.width * 0.75, now.y + now.height / 2);
      await expect(page.getByTestId('inspector-ref')).toHaveText('R2');
      await expect(part).toBeFocused();
      expect((await viewBox(page)).x).toBeCloseTo(dragged.x, 6);
      expect((await viewBox(page)).y).toBeCloseTo(dragged.y, 6);
      expect(await revision(page)).toBe(before);
    });

    test('at a 320px-wide window the controls stay inside the view', async ({ page }) => {
      await openSchematic(page, lang);
      await page.setViewportSize({ width: 320, height: 640 });
      const wrap = page.getByTestId('schematic-view');
      await wrap.scrollIntoViewIfNeeded();
      const frame = await rect(wrap);
      const buttons = page.locator('.schematic-wrap .canvas-controls button');
      await expect(buttons).toHaveCount(7);
      const boxes = [];
      for (const b of await buttons.all()) boxes.push(await rect(b));
      for (const [i, b] of boxes.entries()) {
        expect(b.width).toBeGreaterThanOrEqual(24);
        expect(b.height).toBeGreaterThanOrEqual(24);
        expect(b.x).toBeGreaterThanOrEqual(frame.x);
        expect(b.x + b.width).toBeLessThanOrEqual(frame.x + frame.width);
        expect(b.y + b.height).toBeLessThanOrEqual(frame.y + frame.height);
        for (const other of boxes.slice(i + 1)) expect(overlap(b, other)).toBe(false);
      }
    });
  });
}
