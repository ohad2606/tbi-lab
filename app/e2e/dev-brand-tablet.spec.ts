/**
 * 2026-10-29 owner decisions after the first real tablet check:
 * 1. sharp application icons and a web app manifest (brand.config.ts);
 * 2. DEV-Lab clearly marked (VITE_TBI_ENV=dev): DEV strip on every screen, "[DEV]" title, DEV label
 *    in the top bar, DEV manifest names and icons. The routine build (:4173) is production branding;
 *    the same source built with VITE_TBI_ENV=dev is served on :4175 (playwright.app.config.ts);
 * 3. screen support: computers and tablets; tablets best in landscape (a gentle hint in portrait);
 *    phones not supported (ui/screenSupport.ts).
 * Device emulation is Chromium's (isMobile, hasTouch, device scale factor); the iPad descriptors
 * run in Chromium too (this suite has one browser project). With TBI_EVIDENCE_DIR set, every case
 * also saves a screenshot there.
 */
import { expect, test, devices, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const PROD = 'http://127.0.0.1:4173';
const DEV = 'http://127.0.0.1:4175';
const EVIDENCE = process.env.TBI_EVIDENCE_DIR;

async function shot(page: Page, name: string) {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}/${name}.png` });
}

/** A device descriptor without its browser type (this suite's project is Chromium). */
function device(name: string) {
  const { defaultBrowserType: _browser, ...d } = devices[name]!;
  return d;
}

async function open(browser: Browser, base: string, options: Parameters<Browser['newContext']>[0]) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(`${base}/`);
  await expect(page.getByTestId('example-list')).toBeVisible();
  return { context, page };
}

async function setLocale(page: Page, code: 'en' | 'he') {
  await page.getByTestId('language-select').selectOption(code);
  await expect(page.locator('html')).toHaveAttribute('lang', code);
}

async function openEditor(page: Page) {
  // Keyboard activation: in Chromium's phone emulation of the RTL page (a 1024 px layout on a
  // 412 px screen) Playwright's pointer click misses the button even with no notes on the page
  // (~/tbi-dev-brand/tools/click-debug.mjs); Enter on the focused button is the same action.
  await page.getByTestId('open-example-led-current').press('Enter');
  await expect(page.getByTestId('canvas')).toBeVisible();
}

/**
 * Where an element is on the screen after scrolling to the start (a control at the far end of a
 * 1024 px layout, e.g. the language selector, pans a narrow screen sideways; in Hebrew Chromium's
 * mobile emulation shows the END of the RTL page): its box relative to the visual viewport, and the
 * visible width. The notes must be inside it wherever the visible area is.
 */
async function onScreen(page: Page, selector: string) {
  return page.evaluate(async (sel) => {
    scrollTo(0, 0);
    // The notes follow the visible area on the next frame (EnvironmentNotes).
    for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
    const r = document.querySelector(sel)!.getBoundingClientRect();
    const vv = visualViewport!;
    return {
      x: r.left - vv.offsetLeft,
      y: r.top - vv.offsetTop,
      right: r.right - vv.offsetLeft,
      bottom: r.bottom - vv.offsetTop,
      width: r.width,
      visibleWidth: vv.width,
    };
  }, selector);
}

/**
 * A note band (the DEV strip or the screen note): as wide as the top bar and aligned with it (never
 * a partial-width band), above it (it pushes, never covers), and its text inside the visible width
 * wherever the visible part of a wider-than-screen layout is (phones, Hebrew).
 */
async function expectBand(page: Page, selector: string) {
  const band = await onScreen(page, selector);
  const text = await onScreen(page, `${selector} > .note-body`);
  const bar = await onScreen(page, 'header.topbar');
  expect(Math.abs(band.width - bar.width), 'band width = top bar width').toBeLessThanOrEqual(0.5);
  expect(Math.abs(band.x - bar.x), 'band aligned with the top bar').toBeLessThanOrEqual(0.5);
  expect(bar.y).toBeGreaterThanOrEqual(band.bottom - 0.5);
  expect(text.x, 'text inside the visible width').toBeGreaterThanOrEqual(-0.5);
  expect(text.right, 'text inside the visible width').toBeLessThanOrEqual(text.visibleWidth + 0.5);
  return { band, bar };
}

const expectNoteLayout = (page: Page) => expectBand(page, '[data-testid="screen-note"]');

const MESSAGES = {
  phone: {
    en: 'TBI Lab does not support phones or screens this small. Use a computer or a tablet (landscape recommended).',
    he: 'TBI Lab אינו תומך בטלפונים או במסכים קטנים כאלה. השתמשו במחשב או בטאבלט (מומלץ במצב לרוחב).',
  },
  rotate: {
    en: 'For the best experience, rotate your tablet to landscape.',
    he: 'לחוויה הטובה ביותר, סובבו את הטאבלט למצב לרוחב.',
  },
  narrow: {
    en: 'For the best experience, use a window at least 1024 pixels wide.',
    he: 'לחוויה הטובה ביותר, השתמשו בחלון ברוחב של 1024 פיקסלים לפחות.',
  },
} as const;

const DEVICES: [string, Parameters<Browser['newContext']>[0], keyof typeof MESSAGES | null][] = [
  ['desktop-1400x860', { viewport: { width: 1400, height: 860 } }, null],
  ['desktop-1024x768', { viewport: { width: 1024, height: 768 } }, null],
  ['desktop-900x800', { viewport: { width: 900, height: 800 } }, 'narrow'],
  ['galaxy-tab-s4-landscape', device('Galaxy Tab S4 landscape'), null],
  ['galaxy-tab-s4-portrait', device('Galaxy Tab S4'), 'rotate'],
  ['ipad-gen7-landscape', device('iPad (gen 7) landscape'), null],
  ['ipad-gen7-portrait', device('iPad (gen 7)'), 'rotate'],
  ['ipad-mini-portrait', device('iPad Mini'), 'rotate'],
  ['pixel-7', device('Pixel 7'), 'phone'],
  ['pixel-7-landscape', device('Pixel 7 landscape'), 'phone'],
];

test.describe('screen support message per device and orientation (production build)', () => {
  for (const [name, options, want] of DEVICES)
    test(`${name}: ${want ?? 'no message'}`, async ({ browser }) => {
      const { context, page } = await open(browser, PROD, options);
      for (const locale of ['en', 'he'] as const) {
        await setLocale(page, locale);
        const note = page.getByTestId('screen-note');
        if (!want) await expect(note).toHaveCount(0);
        else {
          await expect(note).toBeVisible();
          await expect(note).toHaveAttribute('data-support', want);
          await expect(note).toHaveText(MESSAGES[want][locale]);
          await expectNoteLayout(page);
        }
        // Production branding: no DEV marker anywhere.
        await expect(page.getByTestId('dev-strip')).toHaveCount(0);
        await expect(page.getByTestId('env-badge')).toHaveCount(0);
        await expect(page).toHaveTitle('TBI Lab');
        await shot(page, `prod-${name}-${locale}`);
      }
      // Work is never blocked: the editor opens and the note stays.
      await openEditor(page);
      if (want) await expect(page.getByTestId('screen-note')).toBeVisible();
      await shot(page, `prod-${name}-editor`);
      await context.close();
    });

  test('rotating a tablet updates the message (portrait hint, landscape none)', async ({
    browser,
  }) => {
    const { context, page } = await open(browser, PROD, device('Galaxy Tab S4'));
    await expect(page.getByTestId('screen-note')).toHaveAttribute('data-support', 'rotate');
    await page.setViewportSize({ width: 1138, height: 712 });
    await expect(page.getByTestId('screen-note')).toHaveCount(0);
    await page.setViewportSize({ width: 712, height: 1138 });
    await expect(page.getByTestId('screen-note')).toHaveAttribute('data-support', 'rotate');
    await context.close();
  });
});

test.describe('DEV-Lab build (VITE_TBI_ENV=dev)', () => {
  for (const [name, options, want] of [
    ['desktop-1400x860', { viewport: { width: 1400, height: 860 } }, null],
    ['desktop-1024x768', { viewport: { width: 1024, height: 768 } }, null],
    ['galaxy-tab-s4-landscape', device('Galaxy Tab S4 landscape'), null],
    ['galaxy-tab-s4-portrait', device('Galaxy Tab S4'), 'rotate'],
    ['ipad-gen7-landscape', device('iPad (gen 7) landscape'), null],
    ['ipad-gen7-portrait', device('iPad (gen 7)'), 'rotate'],
    ['pixel-7', device('Pixel 7'), 'phone'],
  ] as typeof DEVICES)
    test(`${name}: DEV strip, title and label on every screen, EN and HE`, async ({ browser }) => {
      const { context, page } = await open(browser, DEV, options);
      for (const screen of ['projects', 'editor']) {
        if (screen === 'editor') await openEditor(page);
        for (const locale of ['en', 'he'] as const) {
          await setLocale(page, locale);
          const strip = page.getByTestId('dev-strip');
          await expect(strip).toBeVisible();
          await expect(strip).toHaveText(
            locale === 'en'
              ? 'DEVDevelopment environment, not production. For testing only.'
              : 'DEVסביבת פיתוח, לא סביבת הייצור. לבדיקות בלבד.',
          );
          await expect(page).toHaveTitle('[DEV] TBI Lab');
          const badge = page.getByTestId('env-badge');
          await expect(badge).toBeVisible();
          await expect(badge).toHaveAttribute(
            'title',
            locale === 'en' ? 'Development environment' : 'סביבת פיתוח',
          );
          // The strip is above the top bar: the page moves down, nothing is covered.
          // It spans the layout exactly like the top bar (every device, orientation, locale).
          const { band: s, bar } = await expectBand(page, '[data-testid="dev-strip"]');
          expect(s.y).toBeLessThanOrEqual(1);
          // The badge sits inside the top bar.
          const b = await onScreen(page, '[data-testid="env-badge"]');
          expect(b.y).toBeGreaterThanOrEqual(bar.y);
          expect(b.bottom).toBeLessThanOrEqual(bar.bottom);
          if (want) {
            await expect(page.getByTestId('screen-note')).toHaveText(MESSAGES[want][locale]);
            await expectNoteLayout(page);
          } else await expect(page.getByTestId('screen-note')).toHaveCount(0);
          await shot(page, `dev-${name}-${screen}-${locale}`);
        }
      }
      // The editor's controls stay usable (nothing covers them): Run is visible and enabled, its
      // centre is the topmost element there.
      if (!want) {
        const run = page.getByTestId('sim-run');
        await expect(run).toBeVisible();
        const box = (await run.boundingBox())!;
        const hit = await page.evaluate(
          ([x, y]) =>
            document.elementFromPoint(x!, y!)?.closest('[data-testid="sim-run"]') !== null,
          [box.x + box.width / 2, box.y + box.height / 2],
        );
        expect(hit).toBe(true);
      }
      await context.close();
    });
});

test.describe('icons and web app manifest', () => {
  for (const [label, base, dev] of [
    ['production', PROD, false],
    ['DEV', DEV, true],
  ] as const)
    test(`${label}: favicon, apple-touch-icon and manifest resolve; sizes are real`, async ({
      page,
    }) => {
      await page.goto(`${base}/`);
      await expect(page.getByTestId('example-list')).toBeVisible();
      const links = await page
        .locator('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')
        .evaluateAll((ls) =>
          ls.map((l) => ({
            rel: l.getAttribute('rel'),
            sizes: l.getAttribute('sizes'),
            href: (l as HTMLLinkElement).href,
            crossorigin: l.getAttribute('crossorigin'),
          })),
        );
      expect(links.map((l) => `${l.rel} ${l.sizes ?? ''}`.trim())).toEqual([
        'icon 16x16',
        'icon 32x32',
        'icon 48x48',
        'apple-touch-icon 180x180',
        'manifest',
      ]);
      const sizeOf = (b: Buffer) => `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
      for (const l of links.filter((x) => x.rel !== 'manifest')) {
        expect(l.href).toMatch(/\/assets\/[a-z0-9-]+-[0-9a-f]{8}\.png$/);
        const r = await page.request.get(l.href);
        expect(r.status()).toBe(200);
        expect(r.headers()['content-type']).toBe('image/png');
        expect(sizeOf(await r.body())).toBe(l.sizes);
      }
      const m = links.find((l) => l.rel === 'manifest')!;
      expect(m.crossorigin).toBe('use-credentials');
      const manifest = await (await page.request.get(m.href)).json();
      expect(manifest).toMatchObject({
        id: '/',
        name: dev ? 'TBI Lab DEV' : 'TBI Lab',
        short_name: dev ? 'TBI Lab DEV' : 'TBI Lab',
        display: 'standalone',
        start_url: '/',
        theme_color: dev ? '#ffcc00' : '#0a1a33',
        background_color: '#0a1a33',
      });
      for (const icon of manifest.icons as { src: string; sizes: string }[]) {
        const r = await page.request.get(new URL(icon.src, m.href).toString());
        expect(r.status()).toBe(200);
        expect(sizeOf(await r.body())).toBe(icon.sizes);
      }
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
        'content',
        dev ? '#ffcc00' : '#0a1a33',
      );
      await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute(
        'content',
        dev ? 'TBI Lab DEV' : 'TBI Lab',
      );
      // Production and DEV ship different icon files (the DEV marker), never each other's.
      const other = await (await page.request.get(`${dev ? PROD : DEV}/`)).text();
      for (const l of links) expect(other).not.toContain(new URL(l.href).pathname);
    });
});
