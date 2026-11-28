/**
 * BETA-G3 (WCAG 2.2 2.4.11): in a small desktop window every shipped example opens, and
 * "Fit" shows it, with no connection point, part or label under the view controls or the hint,
 * in the Circuit and Schematic views (every example, English and Hebrew). Also: a wire
 * stepped to with [ ] is panned into view, and the drawing's status stays with its project. A
 * window resize fits again only while the user has not panned or zoomed (a panel that resizes
 * the canvas alone moves nothing); a list button leaves the instruction of keyboard wiring in
 * place.
 */
import { expect, test, type Page } from '@playwright/test';
import { EXAMPLES } from '../src/examples/catalog.js';
import { goToProjects, openAppMenu, storedProjects, waitSaved } from './helpers.js';

test.use({ viewport: { width: 800, height: 600 } });
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

/** What lies under an overlay of a view, or outside the view (empty when all is clear). */
const covered = (page: Page, wrapSelector: string, items: string) =>
  page.evaluate(
    ([wrapSelector, items]) => {
      const wrap = document.querySelector(wrapSelector!)!;
      const view = wrap.querySelector(':scope > svg')!.getBoundingClientRect();
      const overlays = [
        ...wrap.querySelectorAll(
          ':scope > .canvas-controls, :scope > .canvas-hint, :scope > .view-note',
        ),
      ].map((e) => ({ name: e.className.split(' ')[0], r: e.getBoundingClientRect() }));
      const found = [...wrap.querySelectorAll(items!)];
      const bad: string[] = found.length ? [] : ['no items'];
      for (const el of found) {
        const r = el.getBoundingClientRect();
        const owner = el.closest('[data-component], [data-id], [data-part]') as SVGElement | null;
        const d = owner?.dataset ?? {};
        const name = `${d.component ?? d.id ?? d.part ?? ''}.${d.terminal ?? el.textContent}`;
        if (
          r.left < view.left - 0.5 ||
          r.top < view.top - 0.5 ||
          r.right > view.right + 0.5 ||
          r.bottom > view.bottom + 0.5
        )
          bad.push(`${name} outside`);
        for (const o of overlays)
          if (
            r.left < o.r.right - 0.5 &&
            o.r.left < r.right - 0.5 &&
            r.top < o.r.bottom - 0.5 &&
            o.r.top < r.bottom - 0.5
          )
            bad.push(`${name} under ${o.name}`);
      }
      return bad;
    },
    [wrapSelector, items],
  );

const CIRCUIT =
  '[data-hit="terminal"] .terminal-hit, [data-hit="component"] .focus-ring, ' +
  '[data-hit="component"] > text, .probe-label';
/** Parts, their labels, and the supply, ground and net marks. */
const SCHEMATIC = '.sch-hit, .sch-module > rect, .sch-part text, .sch-marks > *';
const circuit = (page: Page) => covered(page, '.canvas-wrap', CIRCUIT);

async function start(page: Page, lang: 'en' | 'he') {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(lang);
}
async function openExample(page: Page, id: string) {
  if (!(await page.getByTestId('example-list').isVisible())) await goToProjects(page);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.locator('[data-hit="component"]').first()).toBeVisible();
}
/** The fit follows the layout, so wait for two equal readings of the camera. */
async function settled(page: Page, view = '[data-testid="canvas"]') {
  let last = '';
  await expect
    .poll(
      async () => {
        const now = `${await page.locator(view).getAttribute('viewBox')}`;
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [150] },
    )
    .toBe(true);
}

for (const lang of ['en', 'he'] as const) {
  test(`${lang}: every example opens and fits with nothing covered at 800x600`, async ({
    page,
  }) => {
    test.setTimeout(900_000);
    await start(page, lang);
    const failures: Record<string, string[]> = {};
    for (const { id } of EXAMPLES) {
      await openExample(page, id);
      await settled(page);
      const bad = await circuit(page);
      // Fit again, from a moved camera: the same promise.
      await page.getByTestId('canvas-pan-left').click();
      await page.getByTestId('canvas-fit').click();
      await settled(page);
      bad.push(...(await circuit(page)).map((s) => `fit: ${s}`));
      // The generated view of the same project: as it opens (it is fitted until moved).
      await page.getByTestId('view-schematic').click();
      await expect(page.getByTestId('schematic-view')).toBeVisible();
      await settled(page, '.schematic-wrap > svg');
      bad.push(...(await covered(page, '.schematic-wrap', SCHEMATIC)).map((s) => `sch: ${s}`));
      if (bad.length) failures[id] = bad;
      await page.getByTestId('view-circuit').click();
    }
    expect(failures).toEqual({});
  });

  test(`${lang}: a wire stepped to with [ ] is panned into view, clear of the overlays`, async ({
    page,
  }) => {
    await start(page, lang);
    await openExample(page, 'logic-half-adder');
    await settled(page);
    // Everything out of view to the side.
    for (let i = 0; i < 15; i++) await page.getByTestId('canvas-pan-right').click();
    await page.getByTestId('canvas').focus();
    for (const key of [']', ']', ']', '[']) {
      await page.keyboard.press(key);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const path = document.querySelector<SVGPathElement>('.wire-group.selected path')!;
            const wrap = document.querySelector('.canvas-wrap')!;
            const view = wrap.querySelector(':scope > svg')!.getBoundingClientRect();
            // A point of the wire is on screen and not under the controls or the hint.
            const length = path.getTotalLength();
            const m = path.getScreenCTM()!;
            return Array.from({ length: 101 }, (_, i) =>
              path.getPointAtLength((length * i) / 100).matrixTransform(m),
            ).some(
              (p) =>
                p.x > view.left &&
                p.x < view.right &&
                p.y > view.top &&
                p.y < view.bottom &&
                [...wrap.querySelectorAll(':scope > .canvas-controls, :scope > .canvas-hint')]
                  .map((o) => o.getBoundingClientRect())
                  .every((r) => p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom),
            );
          }),
        )
        .toBe(true);
    }
  });

  test(`${lang}: the drawing's status does not follow into another project`, async ({ page }) => {
    await start(page, lang);
    await openExample(page, 'voltage-divider');
    await waitSaved(page);
    const first = (await storedProjects(page))[0]!.projectId;
    await openExample(page, 'ohms-law');
    // Said from a view control: focus leaving the drawing is not what clears it.
    await page.getByTestId('canvas-several').click();
    const status = page.getByTestId('kbwire-status');
    await expect(status).not.toHaveText('');
    await openAppMenu(page);
    await page.getByTestId(`menu-recent-${first}`).click();
    await expect(page.locator('[data-hit="component"][data-id="R2"]')).toBeVisible();
    await expect(status).toHaveText('');
  });
}

test('a window resize fits the drawing again only until the user pans or zooms', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 860 });
  await start(page, 'en');
  await openExample(page, 'rc-fade');
  await settled(page);
  const camera = async () => {
    await settled(page);
    const box = await page
      .getByTestId('canvas')
      .evaluate((svg: SVGSVGElement) => [
        svg.viewBox.baseVal.x,
        svg.viewBox.baseVal.y,
        svg.clientWidth / svg.viewBox.baseVal.width,
      ]);
    return box.map((n) => n.toFixed(3)).join(' ');
  };
  const width = () => page.getByTestId('canvas').evaluate((svg) => svg.clientWidth);
  const resize = async (w: number, h: number) => {
    const before = await width();
    await page.setViewportSize({ width: w, height: h });
    await expect.poll(width).not.toBe(before);
  };
  // A panel or banner that takes room from the canvas is no window resize: the drawing must not
  // move under the pointer.
  const room = (margin: string) =>
    page.getByTestId('canvas').evaluate((svg, m) => {
      svg.parentElement!.style.marginBottom = m;
    }, margin);
  const full = await camera();
  const height = () => page.getByTestId('canvas').evaluate((svg) => svg.clientHeight);
  const tall = await height();
  await room('80px');
  await expect.poll(height).toBeLessThan(tall);
  expect(await camera()).toBe(full);
  await room('');
  await expect.poll(height).toBe(tall);
  expect(await camera()).toBe(full);
  // Untouched: the new size gets a new fit, with nothing covered.
  const large = await camera();
  await resize(800, 600);
  await expect.poll(camera).not.toBe(large);
  await expect.poll(() => circuit(page)).toEqual([]);
  // Another tab and back is no resize, and no reason to move.
  const small = await camera();
  await page.getByTestId('view-schematic').click();
  await page.getByTestId('view-circuit').click();
  expect(await camera()).toBe(small);
  // Panned by the user: a resize keeps their view (its corner and its zoom).
  await page.getByTestId('canvas-pan-left').click();
  const moved = await camera();
  await resize(1400, 860);
  expect(await camera()).toBe(moved);
  // "Fit" hands the view back: it follows the size again.
  await page.getByTestId('canvas-fit').click();
  const fitted = await camera();
  await resize(800, 600);
  await expect.poll(camera).not.toBe(fitted);
  await expect.poll(() => circuit(page)).toEqual([]);
  // The keyboard zoom counts as the user's view too.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('+');
  const zoomed = await camera();
  await resize(1400, 860);
  expect(await camera()).toBe(zoomed);
});

for (const lang of ['en', 'he'] as const) {
  test(`${lang}: a list button leaves the keyboard wiring instruction in place`, async ({
    page,
  }) => {
    await start(page, lang);
    await openExample(page, 'voltage-divider');
    await settled(page);
    const status = page.getByTestId('kbwire-status');
    await page.locator('[data-hit="component"][data-id="R1"]').focus();
    await page.keyboard.press('w');
    await page.keyboard.press('Enter');
    await expect(status).not.toHaveText('');
    const said = (await status.textContent())!.trim();
    // Activated without taking focus from the drawing, as some assistive technology does.
    for (const list of ['.wires-list-item', '[data-testid="junctions-list"] button']) {
      const button = page.locator(list).first();
      if (!(await button.count())) continue;
      await button.dispatchEvent('click');
      await expect(page.locator('.wires-list-item[aria-pressed="true"]')).toHaveCount(1);
      await page.waitForTimeout(100);
      expect((await status.textContent())!.trim()).toBe(said);
    }
  });
}

test('Schematic: zoom in then out returns to a fit below the usual minimum', async ({ page }) => {
  await start(page, 'en');
  await openExample(page, 'logic-full-adder');
  await page.getByTestId('view-schematic').click();
  const view = page.getByTestId('schematic-view').locator(':scope > svg');
  await expect(view).toBeVisible();
  await page.setViewportSize({ width: 320, height: 320 });
  const scale = () =>
    view.evaluate((svg: SVGSVGElement) => svg.clientWidth / svg.viewBox.baseVal.width);
  const fit = page.getByTestId('schematic-fit');
  await expect
    .poll(async () => {
      await fit.click();
      return scale();
    })
    .toBeLessThan(0.2);
  await page.waitForTimeout(200);
  await fit.click();
  const fitted = await scale();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(scale).toBeGreaterThan(fitted * 1.2);
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect.poll(scale).toBeCloseTo(fitted, 3);
});
