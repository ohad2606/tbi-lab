/**
 * Sprint 27: the experimental Circuit Debugger (DEV-Lab builds only), against the DEV build on
 * :4175 (VITE_TBI_ENV=dev). The fake Session Host is not involved: these circuits run locally.
 *
 * - The routine (production-branded) build has no trace of the feature.
 * - Analysis starts only on request; the project is byte-for-byte unchanged by it.
 * - Simulator findings and the explanation are separate; the mock is labelled as template text,
 *   not a live AI model; every explanation links to its finding and every citation to evidence
 *   that is shown.
 * - English and Hebrew (RTL panel, LTR technical tokens), desktop and tablet.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { createPackage, serializePackage, type ProjectDocument } from '@tbi-lab/domain';
import { boardBench, ledLoop } from '../../packages/assist/eval/bench.js';
import { goToProjects, openImported, storedProjects, waitSaved } from './helpers.js';

const DEV = 'http://127.0.0.1:4175';
const OUT = 'test-results/s27-assist';
mkdirSync(OUT, { recursive: true });

/** openImported, on the DEV build's origin. */
async function openDev(page: Page, doc: ProjectDocument) {
  const text = serializePackage(
    createPackage(doc, { appVersion: '0.1.0', exportedAt: '2026-11-01T00:00:00.000Z' }),
  );
  await page.goto(DEV);
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('import-file').setInputFiles({
    name: 'fixture.tbilab',
    mimeType: 'application/json',
    buffer: Buffer.from(text, 'utf8'),
  });
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}

async function analyze(page: Page) {
  await page.getByTestId('assist-open').click();
  await expect(page.getByTestId('assist-panel')).toBeVisible();
  await page.getByTestId('assist-analyze').click();
  await expect(page.getByTestId('assist-panel')).toHaveAttribute('data-phase', 'done', {
    timeout: 15_000,
  });
}

/** Every explanation links to a shown finding; every citation to evidence of that finding. */
async function expectTraceable(page: Page) {
  const findings = page.getByTestId('assist-finding');
  const keys = await findings.evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
  const explained = await page
    .getByTestId('assist-explanation')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-finding')));
  expect(explained.length).toBeGreaterThan(0);
  for (const k of explained) expect(keys).toContain(k);
  const cites = await page
    .getByTestId('assist-cite')
    .evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  const evidence = await page
    .getByTestId('assist-evidence')
    .evaluateAll((els) => els.map((e) => `#${e.id}`));
  for (const c of cites) expect(evidence).toContain(c);
}

test.describe.configure({ mode: 'serial' });

test('the routine build carries no Circuit Debugger', async ({ page }) => {
  await openImported(page, ledLoop(5, 0.1, null).doc);
  await expect(page.getByTestId('sim-run')).toBeVisible();
  await expect(page.getByTestId('assist-open')).toHaveCount(0);
});

for (const vp of [
  { n: 'desktop', width: 1400, height: 860 },
  { n: 'tablet', width: 1024, height: 768 },
])
  test(`LED without a resistor (${vp.n}): EN then HE, findings vs explanation, project unchanged`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openDev(page, { ...ledLoop(5, 0.1, null).doc, name: 'Assist LED' });
    // Not running yet: the debugger says there is no electrical result rather than guessing.
    await analyze(page);
    await expect(
      page.locator('[data-testid="assist-finding"][data-id="analysis.no_operating_point"]'),
    ).toHaveCount(1);
    await expect(page.locator('[data-testid="assist-finding"][data-severity="error"]')).toHaveCount(
      0,
    );

    await page.getByTestId('sim-run').click();
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
    const before = JSON.stringify(await storedProjects(page));
    await page.getByTestId('assist-analyze').click();
    await expect(page.getByTestId('assist-panel')).toHaveAttribute('data-phase', 'done', {
      timeout: 15_000,
    });
    const led = page.locator('[data-testid="assist-finding"][data-id="current.led_overcurrent"]');
    await expect(led).toHaveCount(1);
    await expect(led).toHaveAttribute('data-severity', 'error');
    await expect(led).toHaveAttribute('data-certainty', 'verified');
    await expect(led.getByTestId('assist-finding-text')).toContainText('D1');
    await expect(led.getByTestId('assist-action')).toContainText('series resistor');
    // The explanation section is separate and says what it is.
    const ai = page.getByTestId('assist-explanation-section');
    await expect(ai).toHaveAttribute('data-provider', 'mock');
    await expect(ai).toHaveAttribute('data-live', 'false');
    await expect(page.getByTestId('assist-mock-label')).toContainText('not a live AI model');
    await expect(page.getByTestId('assist-accounting')).toContainText('template-mock-1');
    await expect(
      page.locator('[data-testid="assist-explanation"]').filter({ hasText: 'datasheet maximum' }),
    ).toHaveCount(1);
    await expectTraceable(page);
    await page.screenshot({ path: `${OUT}/led-${vp.n}-en.png` });
    // Nothing was written: the stored project is the same, byte for byte.
    expect(JSON.stringify(await storedProjects(page))).toBe(before);

    // Hebrew: the same findings (same ids), Hebrew text, RTL panel, LTR technical tokens.
    const idsEn = await page
      .getByTestId('assist-finding')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
    await page.getByTestId('language-select').selectOption('he');
    await page.getByTestId('assist-analyze').click();
    await expect(page.getByTestId('assist-panel')).toHaveAttribute('data-phase', 'done', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('assist-panel')).toHaveAttribute('dir', 'rtl');
    const idsHe = await page
      .getByTestId('assist-finding')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
    expect(idsHe).toEqual(idsEn);
    await expect(page.getByTestId('assist-mock-label')).toContainText('לא מודל AI חי');
    await expect(page.locator('[data-testid="assist-explanation"]').first()).toContainText(
      'גיליון הנתונים',
    );
    await expectTraceable(page);
    // The panel fits the viewport (no horizontal overflow).
    const box = await page.getByTestId('assist-panel').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1);
    await page.screenshot({ path: `${OUT}/led-${vp.n}-he.png` });
    expect(JSON.stringify(await storedProjects(page))).toBe(before);
  });

test('a floating input the program reads: conservative finding, code excerpt, pull resistor advice', async ({
  page,
}) => {
  const { b, u } = boardBench();
  const btn = b.add('component.push_button');
  b.wire(`${u}.gpio4`, `${btn}.a`).wire(`${btn}.b`, 'PSU1.positive').psu(3.3, 0.1);
  b.program(
    '// read the button\nvoid setup() { pinMode(4, INPUT); }\nvoid loop() { int v = digitalRead(4); }\n',
  );
  await openDev(page, { ...b.doc, name: 'Assist floating' });
  await analyze(page);
  const f = page.locator('[data-testid="assist-finding"][data-id="gpio.input_floating"]');
  await expect(f).toHaveCount(1);
  await expect(f).toHaveAttribute('data-certainty', 'conservative');
  await expect(f.getByTestId('assist-action')).toContainText('pull-down');
  await f.locator('details').last().locator('summary').click();
  const excerpt = f.getByTestId('assist-excerpt').first();
  await expect(excerpt).toContainText('pinMode(4, INPUT)');
  // Comments are not sent: the excerpt has the code without them.
  await expect(excerpt).not.toContainText('read the button');
  await expectTraceable(page);
  await page.screenshot({ path: `${OUT}/floating-en.png` });
});

test('cancel, Escape and focus return', async ({ page }) => {
  await openDev(page, { ...ledLoop(5, 0.1, 220).doc, name: 'Assist cancel' });
  await page.getByTestId('assist-open').click();
  await page.getByTestId('assist-analyze').click();
  await page.getByTestId('assist-cancel').click();
  await expect(page.getByTestId('assist-explain-error')).toHaveAttribute('data-error', 'cancelled');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('assist-panel')).toHaveCount(0);
  await expect(page.getByTestId('assist-open')).toBeFocused();
});
