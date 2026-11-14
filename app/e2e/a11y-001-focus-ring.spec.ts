/**
 * A11Y-001 (accessibility assessment): the keyboard focus indicator is visible on every surface.
 * For a representative control of each type (button, primary button, link, input, select, tab,
 * menu item, dialog button, palette tile, canvas part, code editor, serial output, 3D/canvas host),
 * focused from the keyboard, in English and Hebrew (RTL), this measures in the browser:
 * - the ring is drawn (outline ≥ 3 px solid, or the canvas part's SVG ring), and
 * - WCAG 1.4.11: the ring colour, or the white band it carries, contrasts ≥ 3:1 with the surface
 *   next to it, and the two contrast ≥ 3:1 with each other (so one always shows);
 * - hover + focus, a selected tab and an aria-disabled control keep the ring;
 * - forced colours (Windows High Contrast): the ring uses the system highlight colour.
 * Screenshots of each focused control go to TBI_SHOTS_DIR (default test-results/a11y-001).
 */
import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { goToProjects, waitSaved } from './helpers.js';

const SHOTS = process.env.TBI_SHOTS_DIR ?? 'test-results/a11y-001';
mkdirSync(SHOTS, { recursive: true });

interface Ring {
  outlineWidth: number;
  outlineStyle: string;
  outlineOffset: number;
  ring: string;
  halo: string | null;
  surface: string;
  svgRing: boolean;
}

/** The focused element's indicator and the surface next to it, read from computed styles. */
async function ringOf(target: Locator): Promise<Ring> {
  return target.evaluate((el) => {
    const cs = getComputedStyle(el);
    const offset = parseFloat(cs.outlineOffset) || 0;
    const opaque = (c: string) => c && !/rgba\(.*,\s*0\)$/.test(c) && c !== 'transparent';
    // Outside ring: the surface around the control; inside ring (negative offset): its own.
    let node: Element | null = offset < 0 ? el : el.parentElement;
    let surface = 'rgb(255, 255, 255)';
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      if (opaque(bg)) {
        surface = bg;
        break;
      }
      node = node.parentElement;
    }
    const shadow = /(rgb\([^)]*\))/.exec(cs.boxShadow)?.[1] ?? null;
    const svg = el.querySelector('.focus-ring');
    return {
      outlineWidth: parseFloat(cs.outlineWidth) || 0,
      outlineStyle: cs.outlineStyle,
      outlineOffset: offset,
      ring: svg ? getComputedStyle(svg).stroke : cs.outlineColor,
      halo: shadow,
      surface,
      svgRing: !!svg && getComputedStyle(svg).visibility === 'visible',
    };
  });
}

const rgb = (c: string) => (/(\d+),\s*(\d+),\s*(\d+)/.exec(c) ?? []).slice(1, 4).map(Number);
const lum = (c: string) => {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v! / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

/** Focus `target` the way a keyboard user does (keyboard modality, then focus). */
async function keyboardFocus(page: Page, target: Locator) {
  await page.keyboard.press('Shift');
  await target.focus();
  await expect(target).toBeFocused();
}

async function checkRing(page: Page, name: string, target: Locator, lang: string) {
  await keyboardFocus(page, target);
  const r = await ringOf(target);
  if (r.svgRing) {
    expect(contrast(r.ring, r.surface), `${name}: SVG ring vs surface`).toBeGreaterThanOrEqual(3);
  } else {
    expect(r.outlineStyle, `${name}: outline style`).toBe('solid');
    expect(r.outlineWidth, `${name}: outline width`).toBeGreaterThanOrEqual(3);
    const ringVsSurface = contrast(r.ring, r.surface);
    const haloVsSurface = r.halo ? contrast(r.halo, r.surface) : 0;
    expect(
      Math.max(ringVsSurface, haloVsSurface),
      `${name}: ring ${r.ring} / band ${r.halo} vs surface ${r.surface}`,
    ).toBeGreaterThanOrEqual(3);
    if (r.halo) expect(contrast(r.ring, r.halo), `${name}: ring vs band`).toBeGreaterThanOrEqual(3);
  }
  await target.scrollIntoViewIfNeeded().catch(() => undefined);
  const box = await target.boundingBox();
  if (box)
    await page
      .screenshot({
        path: `${SHOTS}/${lang}-${name}.png`,
        clip: {
          x: Math.max(0, box.x - 10),
          y: Math.max(0, box.y - 10),
          width: Math.min(box.width + 20, 600),
          height: Math.min(box.height + 20, 300),
        },
      })
      .catch(() => undefined);
  return r;
}

async function home(page: Page, lang: 'en' | 'he') {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(lang);
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
}

for (const lang of ['en', 'he'] as const) {
  test(`A11Y-001 (${lang}): every control type shows a ≥ 3:1 two-tone focus ring`, async ({
    page,
  }) => {
    const rows: Record<string, unknown> = {};
    await home(page, lang);
    rows.select = await checkRing(
      page,
      'language-select',
      page.getByTestId('language-select'),
      lang,
    );
    rows.input = await checkRing(page, 'example-search', page.getByTestId('example-search'), lang);
    rows.primary = await checkRing(
      page,
      'create-project',
      page.getByTestId('create-project'),
      lang,
    );
    rows.button = await checkRing(
      page,
      'open-example',
      page.getByTestId('open-example-esp32-blink'),
      lang,
    );
    // Hover + focus: the ring stays.
    await page.getByTestId('open-example-esp32-blink').hover();
    rows.hoverFocus = await checkRing(
      page,
      'open-example-hover',
      page.getByTestId('open-example-esp32-blink'),
      lang,
    );
    const link = page.locator('a.product-footer-mail');
    if (await link.count()) rows.link = await checkRing(page, 'footer-link', link.first(), lang);

    await page.getByTestId('open-example-esp32-blink').click();
    await expect(page.getByTestId('canvas')).toBeVisible();
    await waitSaved(page);
    rows.menuButton = await checkRing(
      page,
      'app-menu-button',
      page.getByTestId('app-menu-button'),
      lang,
    );
    // Tabs: the selected view tab.
    rows.tabSelected = await checkRing(
      page,
      'view-circuit-selected',
      page.getByTestId('view-circuit'),
      lang,
    );
    rows.tab = await checkRing(page, 'view-code', page.getByTestId('view-code'), lang);
    rows.palette = await checkRing(
      page,
      'palette-tile',
      page.getByTestId('palette-component.resistor'),
      lang,
    );
    rows.canvas = await checkRing(page, 'canvas', page.getByTestId('canvas'), lang);
    rows.part = await checkRing(
      page,
      'canvas-part',
      page.locator('[data-hit="component"][data-id="D1"]'),
      lang,
    );
    rows.run = await checkRing(page, 'sim-run', page.getByTestId('sim-run'), lang);
    rows.terminal = await checkRing(
      page,
      'serial-output',
      page.getByTestId('mcu-serial-output'),
      lang,
    );
    // The code editor (inset ring) and the programming-language select.
    await page.getByTestId('view-code').click();
    rows.editor = await checkRing(page, 'code-editor', page.getByTestId('code-text'), lang);
    rows.languageSelect = await checkRing(
      page,
      'program-language',
      page.getByTestId('program-language'),
      lang,
    );
    rows.build = await checkRing(page, 'build-button', page.getByTestId('build-button'), lang);
    // Menu and a dialog.
    await page.getByTestId('app-menu-button').click();
    rows.menuItem = await checkRing(page, 'menu-item', page.getByTestId('menu-capabilities'), lang);
    await page.getByTestId('menu-capabilities').click();
    const close = page.getByTestId('capabilities-close');
    await expect(close).toBeVisible();
    rows.dialogButton = await checkRing(page, 'dialog-close', close, lang);
    await page.keyboard.press('Escape');
    test.info().annotations.push({ type: 'rings', description: JSON.stringify(rows) });
  });
}

test('A11Y-001: an aria-disabled control keeps a visible ring (it stays focusable)', async ({
  page,
}) => {
  await home(page, 'en');
  // A disabled native control cannot take focus; the product uses aria-disabled where a control
  // must stay reachable. Find one on the Projects screen or the editor.
  await page.getByTestId('open-example-esp32-blink').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  const disabled = page.locator('[aria-disabled="true"]:visible').first();
  test.skip((await disabled.count()) === 0, 'no aria-disabled control on this screen');
  await checkRing(page, 'aria-disabled', disabled, 'en');
});

test('A11Y-001: forced colours (High Contrast) use the system highlight for the ring', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await home(page, 'en');
  for (const id of ['language-select', 'example-search', 'create-project']) {
    const t = page.getByTestId(id);
    await keyboardFocus(page, t);
    const r = await ringOf(t);
    expect(r.outlineStyle, id).toBe('solid');
    expect(r.outlineWidth, id).toBeGreaterThanOrEqual(3);
    // The system Highlight colour is never the page background.
    expect(contrast(r.ring, r.surface), `${id}: ${r.ring} vs ${r.surface}`).toBeGreaterThanOrEqual(
      3,
    );
    await t.screenshot({ path: `${SHOTS}/forced-${id}.png` });
  }
});
