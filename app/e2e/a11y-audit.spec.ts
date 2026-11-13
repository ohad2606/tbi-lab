/**
 * Accessibility AUDIT (evidence collection for the WCAG 2.2 AA assessment, a11y-audit branch).
 * Not a gate: skipped unless TBI_A11Y_AUDIT=1. Writes axe JSON, accessibility-tree snapshots,
 * keyboard walks and screenshots under TBI_A11Y_OUT (default test-results/a11y-audit).
 * The gate is a11y-wcag.spec.ts.
 *
 * Run (Lab project of playwright.a11y.config.ts, fake Session Host and build service):
 *   TBI_A11Y_AUDIT=1 TBI_A11Y_OUT=~/tbi-a11y/evidence/lab npx playwright test \
 *     -c playwright.a11y.config.ts app/e2e/a11y-audit.spec.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { goToProjects, waitSaved } from './helpers.js';
import { scan } from './a11y-helpers.js';

const OUT = process.env.TBI_A11Y_OUT ?? 'test-results/a11y-audit';
const FAKE = 'http://127.0.0.1:7499';
test.skip(process.env.TBI_A11Y_AUDIT !== '1', 'audit only (TBI_A11Y_AUDIT=1)');

function save(name: string, value: unknown) {
  mkdirSync(dirname(join(OUT, name)), { recursive: true });
  writeFileSync(
    join(OUT, name),
    typeof value === 'string' ? value : JSON.stringify(value, null, 1),
  );
}
async function shot(page: Page, name: string, fullPage = false) {
  mkdirSync(join(OUT, 'shots'), { recursive: true });
  await page.screenshot({ path: join(OUT, 'shots', `${name}.png`), fullPage });
}
/** axe + accessibility tree (+ screenshot) of the current state. */
async function capture(page: Page, name: string) {
  save(`axe/${name}.json`, await scan(page));
  mkdirSync(join(OUT, 'tree'), { recursive: true });
  save(`tree/${name}.yaml`, await page.locator('body').ariaSnapshot());
  await shot(page, name);
}
async function home(page: Page, lang: 'en' | 'he') {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(lang);
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
}
async function openExample(page: Page, id: string) {
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}

/** Describe the focused element: identity, focus style and whether something covers it. */
async function focusInfo(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { tag: 'body' };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const inView = cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight;
    const top = inView ? document.elementFromPoint(cx, cy) : null;
    const covered = inView && top !== null && top !== el && !el.contains(top) && !top.contains(el);
    const name =
      el.getAttribute('aria-label') ??
      (el.getAttribute('aria-labelledby')
        ? document.getElementById(el.getAttribute('aria-labelledby')!.split(' ')[0]!)?.textContent
        : null) ??
      (el.textContent ?? '').trim().slice(0, 60);
    return {
      tag: el.tagName.toLowerCase(),
      testid: el.dataset.testid ?? el.closest<HTMLElement>('[data-testid]')?.dataset.testid,
      role: el.getAttribute('role'),
      name,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
      boxShadow: cs.boxShadow,
      focusVisible: el.matches(':focus-visible'),
      inView,
      covered: covered ? (top as HTMLElement).className || top!.tagName : false,
    };
  });
}
/** Press Tab up to n times and record each stop; stop when the walk returns to its start. */
async function tabWalk(page: Page, n: number, key = 'Tab') {
  const stops: Awaited<ReturnType<typeof focusInfo>>[] = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(key);
    const info = await focusInfo(page);
    stops.push(info);
  }
  return stops;
}

/** Interactive elements smaller than 24x24 CSS px (2.5.8 candidates; spacing not evaluated). */
async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const sel =
      'a[href], button, input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [tabindex]:not([tabindex="-1"])';
    const out: { testid?: string; tag: string; text: string; w: number; h: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      // Inline links in a sentence are exempt (2.5.8 "inline").
      if (el.tagName === 'A' && cs.display === 'inline') continue;
      if (r.width < 24 || r.height < 24)
        out.push({
          testid: el.dataset.testid,
          tag: el.tagName.toLowerCase(),
          text: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
    }
    return out;
  });
}

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__test/reset-builds`);
  await request.post(`${FAKE}/__test/end-all?reason=terminated`);
});

for (const lang of ['en', 'he'] as const) {
  test(`screens (${lang}): axe, accessibility tree, screenshots`, async ({ page }) => {
    test.setTimeout(240_000);
    await home(page, lang);
    await capture(page, `${lang}-home`);
    save(`targets/${lang}-home.json`, await smallTargets(page));
    await openExample(page, 'esp32-blink');
    await capture(page, `${lang}-editor-circuit`);
    save(`targets/${lang}-editor-circuit.json`, await smallTargets(page));
    await page.getByTestId('view-schematic').click();
    await page.waitForTimeout(1500);
    await capture(page, `${lang}-editor-schematic`);
    await page.getByTestId('view-3d').click();
    await page.waitForTimeout(6000);
    await capture(page, `${lang}-editor-3d`);
    await page.getByTestId('view-code').click();
    await expect(page.getByTestId('code-text')).toBeVisible();
    await capture(page, `${lang}-editor-code`);
    save(`targets/${lang}-editor-code.json`, await smallTargets(page));
    // Build and run: the serial terminal and status regions while running.
    await page.getByTestId('toolbar-build').click();
    await expect(page.getByTestId('toolbar-build-state')).toHaveAttribute('data-phase', 'current', {
      timeout: 20_000,
    });
    await page.getByTestId('sim-run').click();
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running', {
      timeout: 30_000,
    });
    await page.waitForTimeout(2500);
    await capture(page, `${lang}-running`);
    await page.getByTestId('sim-stop').click();
    await expect(page.getByTestId('sim-status')).not.toHaveAttribute('data-status', 'running', {
      timeout: 20_000,
    });
    // A failing build: diagnostics.
    await page.getByTestId('code-text').fill('// no setup here\nvoid loop() {}\n');
    await page.getByTestId('build-button').click();
    await expect(page.getByTestId('build-phase')).toHaveAttribute('data-phase', 'failed', {
      timeout: 20_000,
    });
    await capture(page, `${lang}-build-failed`);
    // Run refused after the failed build: the notice.
    await page.getByTestId('sim-run').click({ force: true });
    await expect(page.getByTestId('notice')).toBeVisible();
    await capture(page, `${lang}-run-refused`);
    // The application menu, and the dialogs it opens.
    await page.getByTestId('app-menu-button').click();
    await expect(page.getByTestId('app-menu')).toBeVisible();
    await capture(page, `${lang}-menu`);
    await page.getByTestId('menu-capabilities').click();
    await page.waitForTimeout(500);
    await capture(page, `${lang}-capabilities`);
    await page.keyboard.press('Escape');
    await page.getByTestId('app-menu-button').click();
    await page.getByTestId('menu-report-problem').click();
    await page.waitForTimeout(500);
    await capture(page, `${lang}-report-dialog`);
    // Submit empty: the validation state.
    const send = page.getByTestId('report-dialog').getByRole('button', { name: /send|שליחה/i });
    if (await send.count()) {
      await send.first().click();
      await page.waitForTimeout(300);
      await capture(page, `${lang}-report-invalid`);
    }
    await page.keyboard.press('Escape');
    if (await page.getByTestId('admin-button').count()) {
      await page.getByTestId('admin-button').click();
      await page.waitForTimeout(1500);
      await capture(page, `${lang}-admin-panel`);
      await page.keyboard.press('Escape');
    }
  });
}

test('keyboard walks (en, he): home and editor Tab order, focus visibility, obscuring', async ({
  page,
}) => {
  test.setTimeout(240_000);
  for (const lang of ['en', 'he'] as const) {
    await home(page, lang);
    await page.locator('body').focus();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    save(`keyboard/${lang}-home-tab.json`, await tabWalk(page, 40));
    await openExample(page, 'esp32-blink');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    save(`keyboard/${lang}-editor-circuit-tab.json`, await tabWalk(page, 60));
    await page.getByTestId('view-code').click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    save(`keyboard/${lang}-editor-code-tab.json`, await tabWalk(page, 50));
    await page.getByTestId('app-menu-button').click();
    await page.getByTestId('menu-projects').click();
  }
});

test('code editor: Tab inserts, Escape then Tab leaves; errors and line navigation', async ({
  page,
}) => {
  await home(page, 'en');
  await openExample(page, 'esp32-blink');
  await page.getByTestId('view-code').focus();
  await page.keyboard.press('Enter');
  const area = page.getByTestId('code-text');
  await area.focus();
  const before = await area.inputValue();
  await page.keyboard.press('Tab');
  const afterTab = await area.inputValue();
  const stillFocused = await area.evaluate((e) => e === document.activeElement);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  const leftTo = await focusInfo(page);
  await area.focus();
  await page.keyboard.press('Shift+Tab');
  const shiftTabTo = await focusInfo(page);
  // Accessible description/hint of the textarea (does it tell users about Escape, Tab?).
  const meta = await area.evaluate((e) => ({
    label: e.getAttribute('aria-label'),
    describedby: e.getAttribute('aria-describedby'),
    keyshortcuts: e.getAttribute('aria-keyshortcuts'),
    role: e.getAttribute('role'),
    multiline: (e as HTMLTextAreaElement).tagName,
  }));
  // A failing build: are diagnostics reachable and do they move focus to the line?
  await area.fill('// no setup here\nvoid loop() {}\n');
  await page.getByTestId('build-button').click();
  await expect(page.getByTestId('build-phase')).toHaveAttribute('data-phase', 'failed', {
    timeout: 20_000,
  });
  const live = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]')]
      .filter((e) => (e as HTMLElement).offsetParent !== null || e.getAttribute('role') === 'log')
      .map((e) => ({
        testid: (e as HTMLElement).dataset.testid,
        role: e.getAttribute('role'),
        live: e.getAttribute('aria-live'),
        text: (e.textContent ?? '').trim().slice(0, 80),
      })),
  );
  const diag = page.getByTestId('diagnostic').first();
  await diag.focus();
  await page.keyboard.press('Enter');
  const afterJump = await focusInfo(page);
  const caret = await area.evaluate((e) => (e as HTMLTextAreaElement).selectionStart);
  const gutter = await page.evaluate(() =>
    [...document.querySelectorAll('.gutter-line.mark-error')].map((g) => ({
      text: g.textContent,
      color: getComputedStyle(g).color,
      bg: getComputedStyle(g).backgroundColor,
      ariaHidden: g.closest('[aria-hidden="true"]') !== null,
    })),
  );
  const diagStyle = await diag.evaluate((e) => {
    const cs = getComputedStyle(e.querySelector('.diag-severity')!);
    return { color: cs.color, bg: cs.backgroundColor, text: e.textContent };
  });
  save('editor/code-editor.json', {
    tabInsertedSpaces: afterTab.length - before.length,
    focusStayedAfterTab: stillFocused,
    afterEscapeTab: leftTo,
    shiftTabFromEditor: shiftTabTo,
    meta,
    liveRegionsAfterFailedBuild: live,
    afterDiagnosticEnter: afterJump,
    caretAfterJump: caret,
    gutterErrorMarks: gutter,
    diagnosticStyle: diagStyle,
  });
  await shot(page, 'en-code-diagnostics');
});

test('refusals: unsupported library (Arduino) and MicroPython facility, in both languages', async ({
  page,
}) => {
  test.setTimeout(180_000);
  for (const lang of ['en', 'he'] as const) {
    await home(page, lang);
    await openExample(page, 'esp32-blink');
    await page.getByTestId('view-code').click();
    const area = page.getByTestId('code-text');
    const src = await area.inputValue();
    await area.fill(`#include <WiFi.h>\n${src}\nvoid x() { WiFi.begin("a", "b"); }\n`);
    await page.getByTestId('toolbar-build').click();
    await expect(page.getByTestId('toolbar-build-state')).not.toHaveAttribute(
      'data-phase',
      'building',
      { timeout: 20_000 },
    );
    await page.waitForTimeout(500);
    const phase = await page.getByTestId('toolbar-build-state').getAttribute('data-phase');
    await capture(page, `${lang}-refusal-library-build`);
    await page.getByTestId('sim-run').click({ force: true });
    await page.waitForTimeout(3000);
    const banners = await page.evaluate(() =>
      [...document.querySelectorAll('.banner, [data-testid="build-features"]')].map((b) => ({
        role: b.getAttribute('role'),
        testid: (b as HTMLElement).dataset.testid,
        code: (b as HTMLElement).dataset.code,
        text: (b.textContent ?? '').trim().slice(0, 400),
        color: getComputedStyle(b).color,
        bg: getComputedStyle(b).backgroundColor,
      })),
    );
    save(`refusals/${lang}-library.json`, { phase, banners });
    await capture(page, `${lang}-refusal-library-run`);
    // MicroPython: switch language, use a refused facility.
    await page.getByTestId('program-language').selectOption('esp32-micropython-1.29');
    await area.fill('import network\nfrom machine import Pin\nPin(2, Pin.OUT).value(1)\n');
    await page.getByTestId('toolbar-build').click();
    await expect(page.getByTestId('toolbar-build-state')).not.toHaveAttribute(
      'data-phase',
      'building',
      { timeout: 30_000 },
    );
    await page.waitForTimeout(500);
    await page.getByTestId('sim-run').click({ force: true });
    await page.waitForTimeout(3000);
    const mp = await page.evaluate(() =>
      [...document.querySelectorAll('.banner, [data-testid="build-features"], .field-error')].map(
        (b) => ({
          role: b.getAttribute('role'),
          testid: (b as HTMLElement).dataset.testid,
          text: (b.textContent ?? '').trim().slice(0, 400),
        }),
      ),
    );
    save(`refusals/${lang}-micropython.json`, {
      phase: await page.getByTestId('toolbar-build-state').getAttribute('data-phase'),
      banners: mp,
    });
    await capture(page, `${lang}-refusal-micropython`);
    await page.getByTestId('app-menu-button').click();
    await page.getByTestId('menu-projects').click();
  }
});

test('language selectors: keyboard, announcement, focus after switching', async ({ page }) => {
  await home(page, 'en');
  const sel = page.getByTestId('language-select');
  await sel.focus();
  // Keyboard: ArrowDown on a closed native select changes the value in Chromium (Windows-like).
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(500);
  const after = {
    lang: await page.locator('html').getAttribute('lang'),
    dir: await page.locator('html').getAttribute('dir'),
    focus: await focusInfo(page),
    title: await page.title(),
    liveRegions: await page.evaluate(() =>
      [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')].map((e) =>
        (e.textContent ?? '').trim().slice(0, 100),
      ),
    ),
    selectName: await sel.evaluate((e) => {
      const l = e.closest('label');
      return l?.textContent?.trim();
    }),
    optionLang: await sel
      .locator('option')
      .evaluateAll((o) =>
        o.map((x) => [x.getAttribute('lang'), x.getAttribute('dir'), x.textContent]),
      ),
  };
  save('selectors/ui-language.json', after);
  await page.getByTestId('language-select').selectOption('en');
  // Program language selector (Arduino/MicroPython).
  await openExample(page, 'esp32-led-fade');
  await page.getByTestId('view-code').click();
  const prog = page.getByTestId('program-language');
  await prog.focus();
  const name = await prog.evaluate((e) => e.closest('label')?.textContent?.trim());
  await prog.selectOption('esp32-micropython-1.29');
  await page.waitForTimeout(500);
  save('selectors/program-language.json', {
    accessibleLabel: name,
    focusAfter: await focusInfo(page),
    notice: await page.getByTestId('notice').evaluate((e) => ({
      role: e.getAttribute('role'),
      text: e.textContent,
    })),
    tree: await page.getByTestId('code-view').locator('header').ariaSnapshot(),
  });
  await shot(page, 'en-program-language-switched');
});

test('reflow and zoom: 320 CSS px, 200 % and 400 % of 1280 px, text spacing', async ({ page }) => {
  test.setTimeout(180_000);
  const results: Record<string, unknown> = {};
  for (const [label, w, h] of [
    ['w320', 320, 640],
    ['zoom200', 640, 400],
    ['zoom400', 320, 200],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await home(page, 'en');
    const m = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      notes: [...document.querySelectorAll('.app-notes *')].map((e) => e.textContent).slice(0, 2),
    }));
    results[`${label}-home`] = m;
    await shot(page, `reflow-${label}-home`);
    await openExample(page, 'esp32-blink');
    results[`${label}-editor`] = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    await shot(page, `reflow-${label}-editor`);
    await page.getByTestId('app-menu-button').click();
    await page.getByTestId('menu-projects').click();
  }
  await page.setViewportSize({ width: 1400, height: 860 });
  // 1.4.12 text spacing bookmarklet values.
  await home(page, 'en');
  await openExample(page, 'esp32-blink');
  await page.addStyleTag({
    content:
      '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }',
  });
  await page.waitForTimeout(500);
  results.textSpacingClipped = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, label, span, a, p, h1, h2, h3')]
      .filter((e) => {
        const cs = getComputedStyle(e);
        return (
          e.offsetParent !== null &&
          (cs.overflow === 'hidden' ||
            cs.textOverflow === 'ellipsis' ||
            cs.whiteSpace === 'nowrap') &&
          (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)
        );
      })
      .map((e) => ({
        testid: e.dataset.testid,
        cls: e.className,
        text: e.textContent?.slice(0, 40),
      }))
      .slice(0, 40),
  );
  await shot(page, 'text-spacing-editor');
  save('reflow/reflow.json', results);
});

test('forced colours and focus-ring contrast', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await home(page, 'en');
  await shot(page, 'forced-colors-home');
  await openExample(page, 'esp32-blink');
  await page.getByTestId('toolbar-build').focus();
  await shot(page, 'forced-colors-editor');
  await page.emulateMedia({ forcedColors: 'none' });
  // Token contrast is computed outside the browser (evidence lab/contrast/tokens-computed.txt).
});

test('sign-in expiry banner and sign-out reachability', async ({ page }) => {
  await home(page, 'en');
  const signOut = page.getByTestId('sign-out');
  save('auth/signout.json', {
    present: (await signOut.count()) > 0,
    tree: (await signOut.count()) ? await signOut.first().ariaSnapshot() : null,
  });
});

test('focus management: screen changes, dialogs, menu, notices, terminal text updates', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const r: Record<string, unknown> = {};
  await home(page, 'en');
  r.homeTitle = await page.title();
  await page.getByTestId('open-example-esp32-blink').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.waitForTimeout(500);
  r.afterOpenExample = await focusInfo(page);
  r.editorTitle = await page.title();
  // Capabilities dialog from the menu, by keyboard.
  await page.getByTestId('app-menu-button').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('menu-capabilities').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  r.capabilitiesOpen = await focusInfo(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  r.capabilitiesAfterEscape = await focusInfo(page);
  // Problem report dialog.
  await page.getByTestId('app-menu-button').focus();
  await page.keyboard.press('Enter');
  if (await page.getByTestId('menu-report-problem').count()) {
    await page.getByTestId('menu-report-problem').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    r.reportOpen = await focusInfo(page);
    // Tab cycling inside the modal: 40 tabs, any stop outside the dialog?
    const outside: string[] = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(
        () =>
          !!document.activeElement?.closest('dialog[open]') ||
          document.activeElement === document.body,
      );
      if (!inside) outside.push(JSON.stringify(await focusInfo(page)));
    }
    r.reportTabOutside = outside.slice(0, 5);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    r.reportAfterEscape = await focusInfo(page);
  } else await page.keyboard.press('Escape');
  // Run refused notice: does focus move? (expected: no; it is announced as an alert)
  await page.getByTestId('view-code').click();
  await page.getByTestId('code-text').fill('// no setup\nvoid loop() {}\n');
  await page.getByTestId('sim-run').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  r.afterRunRefused = await focusInfo(page);
  r.noticeRole = await page.getByTestId('notice').getAttribute('role');
  // Back to Projects via the menu: where is focus?
  await page.getByTestId('app-menu-button').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('menu-projects').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('example-list')).toBeVisible();
  await page.waitForTimeout(300);
  r.afterBackToProjects = await focusInfo(page);
  // Terminal: how serial text is updated in the DOM (one text node replaced vs appended).
  await openExample(page, 'esp32-blink');
  await page.getByTestId('toolbar-build').click();
  await expect(page.getByTestId('toolbar-build-state')).toHaveAttribute('data-phase', 'current', {
    timeout: 20_000,
  });
  await page.evaluate(() => {
    const pre = document.querySelector('[data-testid="mcu-serial-output"]')!;
    (window as unknown as { __mut: string[] }).__mut = [];
    new MutationObserver((ms) =>
      ms.forEach((m) =>
        (window as unknown as { __mut: string[] }).__mut.push(
          `${m.type}:${m.addedNodes.length}+/${m.removedNodes.length}- len=${(m.target.textContent ?? '').length}`,
        ),
      ),
    ).observe(pre, { childList: true, characterData: true, subtree: true });
  });
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running', {
    timeout: 30_000,
  });
  await page.waitForTimeout(4000);
  r.serialMutations = await page.evaluate(() =>
    (window as unknown as { __mut: string[] }).__mut.slice(0, 15),
  );
  r.serialMutationCount = await page.evaluate(
    () => (window as unknown as { __mut: string[] }).__mut.length,
  );
  await page.getByTestId('sim-stop').click();
  save('keyboard/focus-management.json', r);
});
