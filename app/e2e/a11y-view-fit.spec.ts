/**
 * BETA-G3 (WCAG 2.2 2.4.11): in a small desktop window every shipped example opens, and
 * "Fit" shows it, with no connection point or part under the view controls or the hint, in the
 * Circuit view (every example, English and Hebrew) and in the Schematic view. Also: a wire
 * stepped to with [ ] is panned into view, and the drawing's status stays with its project.
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
        const owner = el.closest('[data-component], [data-id], [data-part]') as SVGElement;
        const d = owner.dataset;
        const name = `${d.component ?? d.id ?? d.part}.${d.terminal ?? ''}`;
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

const CIRCUIT = '[data-hit="terminal"] .terminal-hit, [data-hit="component"] .focus-ring';
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
async function settled(page: Page) {
  let last = '';
  await expect
    .poll(
      async () => {
        const now = `${await page.getByTestId('canvas').getAttribute('viewBox')}`;
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
    test.setTimeout(480_000);
    await start(page, lang);
    const failures: Record<string, string[]> = {};
    for (const { id } of EXAMPLES) {
      await openExample(page, id);
      await settled(page);
      const onLoad = await circuit(page);
      // Fit again, from a moved camera: the same promise.
      await page.getByTestId('canvas-pan-left').click();
      await page.getByTestId('canvas-fit').click();
      await settled(page);
      const onFit = (await circuit(page)).map((s) => `fit: ${s}`);
      if (onLoad.length || onFit.length) failures[id] = [...onLoad, ...onFit];
    }
    expect(failures).toEqual({});
  });

  test(`${lang}: the Schematic view fits with no part covered at 800x600`, async ({ page }) => {
    await start(page, lang);
    const failures: Record<string, string[]> = {};
    for (const id of ['voltage-divider', 'logic-half-adder', 'logic-full-adder', 'rgb-mixer']) {
      await openExample(page, id);
      await page.getByTestId('view-schematic').click();
      await expect(page.getByTestId('schematic-view')).toBeVisible();
      const check = () => covered(page, '.schematic-wrap', '.sch-hit, .sch-module > rect');
      await page.waitForTimeout(200);
      const bad = await check();
      await page.getByTestId('schematic-fit').click();
      bad.push(...(await check()));
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
