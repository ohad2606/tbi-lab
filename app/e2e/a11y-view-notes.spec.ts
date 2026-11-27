/**
 * BETA-G3 follow-ups: the message boxes of the Circuit and 3D views, English and Hebrew:
 * - clipped messages scroll with the mouse wheel and the keyboard (WCAG 1.4.10, 2.1.1), while
 *   pointer clicks still reach the drawing under the box;
 * - a clipped box has two named buttons, so a mouse without a wheel can scroll it;
 * - the box is a named Tab stop only while it overflows;
 * - a focused part is never fully hidden by the box (2.4.11), also when the box grows later;
 * - a wire selected with [ ] is panned into view.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { goToProjects, storedProjects, waitSaved } from './helpers.js';

const NAME = { en: 'View messages', he: 'הודעות התצוגה' } as const;
const SCROLL = {
  en: { up: 'Scroll message up', down: 'Scroll message down' },
  he: { up: 'גלילת ההודעה למעלה', down: 'גלילת ההודעה למטה' },
} as const;

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
const grow = (box: Locator, times = 200) =>
  box.evaluate((el, n) => {
    const extra = document.createElement('div');
    extra.className = 'view-note-warning test-long';
    extra.textContent = 'W1, W2, W3 route warning text. '.repeat(n);
    el.append(extra);
  }, times);
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

/** Both buttons completely inside their box, the view and the window; nothing lies over them. */
async function expectWhole(page: Page, box: Locator, lang: 'en' | 'he', label: string) {
  const window = page.viewportSize()!;
  for (const name of [SCROLL[lang].up, SCROLL[lang].down]) {
    const b = box.getByRole('button', { name, exact: true });
    await b.scrollIntoViewIfNeeded();
    const whole = await b.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const inside = (o: DOMRect) =>
        r.left >= o.left - 0.5 &&
        r.right <= o.right + 0.5 &&
        r.top >= o.top - 0.5 &&
        r.bottom <= o.bottom + 0.5;
      const note = el.closest('.view-note-scroll')!.parentElement!;
      return {
        box: inside(note.getBoundingClientRect()),
        view: inside(note.parentElement!.getBoundingClientRect()),
        onTop: [
          [r.left + 3, r.top + 3],
          [r.right - 3, r.top + 3],
          [r.left + 3, r.bottom - 3],
          [r.right - 3, r.bottom - 3],
        ].every(([x, y]) => el.contains(document.elementFromPoint(x!, y!))),
        rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      };
    });
    expect(whole, `${label}: ${name}`).toMatchObject({ box: true, view: true, onTop: true });
    expect(whole.rect.left, label).toBeGreaterThanOrEqual(0);
    expect(whole.rect.top, label).toBeGreaterThanOrEqual(0);
    expect(whole.rect.right, label).toBeLessThanOrEqual(window.width);
    expect(whole.rect.bottom, label).toBeLessThanOrEqual(window.height);
  }
}

/** The scroll buttons of one message box, used with a mouse only (no wheel, no keyboard). */
async function scrollByButtons(page: Page, box: Locator, lang: 'en' | 'he', label: string) {
  const up = box.getByRole('button', { name: SCROLL[lang].up, exact: true });
  const down = box.getByRole('button', { name: SCROLL[lang].down, exact: true });
  await expect(up, label).toBeVisible();
  await expect(down, label).toBeVisible();
  await expect(up).toHaveAttribute('aria-disabled', 'true');
  await expect(down).toHaveAttribute('aria-disabled', 'false');
  const outer = await rect(box);
  for (const b of [up, down]) {
    const r = await rect(b);
    expect(r.width, label).toBeGreaterThanOrEqual(24);
    expect(r.height, label).toBeGreaterThanOrEqual(24);
    // Inside the message box: nothing more of the drawing is covered.
    expect(r.x, label).toBeGreaterThanOrEqual(outer.x);
    expect(r.y, label).toBeGreaterThanOrEqual(outer.y);
    expect(r.x + r.width, label).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
    expect(r.y + r.height, label).toBeLessThanOrEqual(outer.y + outer.height + 0.5);
  }
  /** A real pointer click at the button's centre (fails if anything lies over it). */
  const press = async (b: Locator) => {
    await b.scrollIntoViewIfNeeded();
    const r = await rect(b);
    const [x, y] = [r.x + r.width / 2, r.y + r.height / 2];
    expect(
      await b.evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), { x, y }),
      `${label}: the button is on top at its centre`,
    ).toBe(true);
    await page.mouse.click(x, y);
  };
  await down.scrollIntoViewIfNeeded();
  const at = await rect(down);
  await press(down);
  await expect.poll(() => scrollTop(box), { message: label }).toBeGreaterThan(0);
  await expect(up).toHaveAttribute('aria-disabled', 'false');
  // The buttons stay in place while the text moves under the pointer.
  expect(Math.abs((await rect(down)).y - at.y), label).toBeLessThan(1);
  for (let i = 0; i < 400; i++) {
    if ((await down.getAttribute('aria-disabled')) === 'true') break;
    await press(down);
  }
  await expect(down).toHaveAttribute('aria-disabled', 'true');
  expect(
    await box.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    label,
  ).toBeLessThanOrEqual(1);
  // Disabled at the end: focus stays on the button, with a visible focus ring from the keyboard.
  await press(down);
  await expect(down).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(up).toBeFocused();
  expect(await up.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  const end = await scrollTop(box);
  await page.keyboard.press('Enter');
  await expect.poll(() => scrollTop(box)).toBeLessThan(end);
  for (let i = 0; i < 400; i++) {
    if ((await up.getAttribute('aria-disabled')) === 'true') break;
    await press(up);
  }
  await expect.poll(() => scrollTop(box)).toBe(0);
  await expect(up).toBeFocused();
}

for (const lang of ['en', 'he'] as const) {
  test.describe(lang, () => {
    test('circuit: a mouse alone scrolls a clipped message with two buttons', async ({ page }) => {
      await openCircuit(page, lang);
      const box = page.getByTestId('canvas-hint');
      await expect(box.getByRole('button')).toHaveCount(0);
      for (const [width, height] of [
        [683, 384],
        [320, 480],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.getByTestId('canvas').scrollIntoViewIfNeeded();
        await page.getByTestId('canvas-fit').click();
        await grow(box);
        await box.scrollIntoViewIfNeeded();
        const [view, doc] = [await viewBox(page), await revision(page)];
        await scrollByButtons(page, box, lang, `${width}x${height}`);
        expect(await viewBox(page)).toBe(view);
        expect(await revision(page)).toBe(doc);
        // The message becomes short while a button has focus: no focus loss.
        const up = box.getByRole('button', { name: SCROLL[lang].up, exact: true });
        await shrink(box);
        await page.waitForTimeout(100);
        await expect(up).toBeFocused();
        await expect(up).toHaveAttribute('aria-disabled', 'true');
        await page.getByTestId('canvas-fit').focus();
        if (!(await box.evaluate((el) => el.scrollHeight - el.clientHeight > 1)))
          await expect(box.getByRole('button')).toHaveCount(0);
      }
      await page.setViewportSize({ width: 1366, height: 768 });
      await expect(box.getByRole('button')).toHaveCount(0);
    });

    test('320x256: the scroll buttons are whole, on screen and operable', async ({ page }) => {
      await openCircuit(page, lang);
      await page.setViewportSize({ width: 320, height: 256 });
      await page.getByTestId('canvas').scrollIntoViewIfNeeded();
      await page.getByTestId('canvas-fit').click();
      const box = page.getByTestId('canvas-hint');
      await grow(box, 20);
      await box.scrollIntoViewIfNeeded();
      await expectWhole(page, box, lang, 'circuit');
      await scrollByButtons(page, box, lang, 'circuit 320x256');
      // The message stays below the view controls: it covers none of them.
      const [h, c] = [await rect(box), await rect(page.locator('.canvas-wrap .canvas-controls'))];
      expect(h.y).toBeGreaterThanOrEqual(c.y + c.height - 0.5);
    });

    test('Tab after the message became short never drops the focus', async ({ page }) => {
      await openCircuit(page, lang);
      await page.setViewportSize({ width: 683, height: 384 });
      await page.getByTestId('canvas-fit').click();
      const box = page.getByTestId('canvas-hint');
      const up = box.getByRole('button', { name: SCROLL[lang].up, exact: true });
      const down = box.getByRole('button', { name: SCROLL[lang].down, exact: true });
      const onBody = () => page.evaluate(() => document.activeElement === document.body);
      const arm = async (b: Locator) => {
        await grow(box);
        await b.focus();
        await shrink(box);
        await page.waitForTimeout(100);
        // Only a message that now fits shows the problem.
        expect(await box.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThan(2);
        await expect(b).toBeFocused();
      };
      // Between the two buttons.
      await arm(up);
      await page.keyboard.press('Tab');
      await page.waitForTimeout(100);
      await expect(down).toBeFocused();
      // Out of the box: to a real element, and the buttons go.
      await page.keyboard.press('Tab');
      await page.waitForTimeout(100);
      expect(await onBody()).toBe(false);
      await expect(box.getByRole('button')).toHaveCount(0);
      // Back from the first button: the named scroll region.
      await arm(up);
      await page.keyboard.press('Shift+Tab');
      await page.waitForTimeout(100);
      await expect(box).toBeFocused();
      await expect(box).toHaveAccessibleName(NAME[lang]);
      await page.keyboard.press('Tab');
      await page.waitForTimeout(100);
      expect(await onBody()).toBe(false);
    });

    test('forced colours: a disabled scroll button differs; focus stays visible', async ({
      page,
    }) => {
      await page.emulateMedia({ forcedColors: 'active' });
      await openCircuit(page, lang);
      await page.setViewportSize({ width: 683, height: 384 });
      await page.getByTestId('canvas-fit').click();
      const box = page.getByTestId('canvas-hint');
      await grow(box);
      const up = box.getByRole('button', { name: SCROLL[lang].up, exact: true });
      const down = box.getByRole('button', { name: SCROLL[lang].down, exact: true });
      await expect(up).toHaveAttribute('aria-disabled', 'true');
      const system = (name: string) =>
        page.evaluate((c) => {
          const x = document.body.appendChild(document.createElement('span'));
          x.style.color = c;
          const out = getComputedStyle(x).color;
          x.remove();
          return out;
        }, name);
      const paint = (b: Locator) =>
        b.evaluate((el) => {
          const s = getComputedStyle(el);
          const icon = getComputedStyle(el.querySelector('svg')!).stroke;
          return { color: s.color, border: s.borderTopColor, icon };
        });
      const gray = await system('GrayText');
      const text = await system('ButtonText');
      expect(gray).not.toBe(text);
      expect(await paint(up)).toEqual({ color: gray, border: gray, icon: gray });
      expect(await paint(down)).toEqual({ color: text, border: text, icon: text });
      // Keyboard focus on the disabled button and on the enabled one: a highlight ring.
      await down.focus();
      for (const [key, b] of [
        ['Shift+Tab', up],
        ['Tab', down],
      ] as const) {
        await page.keyboard.press(key);
        await expect(b).toBeFocused();
        const ring = await b.evaluate((el) => {
          const s = getComputedStyle(el);
          return [s.outlineStyle, s.outlineColor, s.outlineWidth];
        });
        expect(ring).toEqual(['solid', await system('Highlight'), '3px']);
      }
    });

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
        [320, 256],
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
        // Let the smooth keyboard scroll finish before going back to the top.
        await page.waitForTimeout(500);
        await box.evaluate((el) => (el.scrollTop = 0));
        await scrollByButtons(page, box, lang, `3D ${width}x${height}`);
        await shrink(box);
        await page.getByTestId('view-3d').focus();
        await expect(box.getByRole('button')).toHaveCount(0);
      }
      await page.setViewportSize({ width: 320, height: 256 });
      await page.waitForTimeout(300);
      await grow(box, 20);
      await box.scrollIntoViewIfNeeded();
      await expectWhole(page, box, lang, '3D');
      await scrollByButtons(page, box, lang, '3D 320x256');
    });
  });
}
