/**
 * Sprint 18F build latency on the REAL build service (pinned toolchain, sandboxed jobs, the core
 * seed and prewarm deployed), through the app, as the owner builds. Skipped unless TBI_S18_REAL=1
 * (TBI_BUILD_PROXY to an installed instance).
 *
 * - the Servo Sweep example: a shared (prewarmed) build, a cache hit;
 * - the same sketch with a one-line edit (a new user source, unique per run): compiled from the
 *   core seed, well under the old ~30 s, with the elapsed seconds shown while it builds;
 * - Build again unchanged: a cache hit;
 * - a different user sketch: also seeded.
 * Timings are attached to the report (the deployment record cites them); the bound is generous
 * (25 s) so a busy host does not fail it, the cold build being ~30-37 s.
 */
import { expect, test, type Page } from '@playwright/test';
import { waitSaved } from './helpers.js';

test.skip(!process.env.TBI_S18_REAL, 'heavy: needs the real build service (TBI_S18_REAL=1)');
test.setTimeout(600_000);

async function timedBuild(page: Page): Promise<number> {
  await page.getByTestId('view-code').click();
  const t0 = Date.now();
  await page.getByTestId('build-button').click();
  await expect(page.getByTestId('build-phase')).toHaveAttribute('data-phase', 'current', {
    timeout: 300_000,
  });
  return Date.now() - t0;
}

test('Servo Sweep: shared build a cache hit; an edit builds from the core seed (< 25 s)', async ({
  page,
}, info) => {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) {
    await page.getByTestId('app-menu-button').click();
    await page.getByTestId('menu-projects').click();
  }
  await page.getByTestId('open-example-esp32-servo-sweep').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  const curated = await timedBuild(page);
  expect(curated).toBeLessThan(5_000);

  const code = page.getByTestId('code-text');
  const text = await code.inputValue();
  const stamp = `// S18F benchmark ${Date.now()}\n`;
  await code.fill(stamp + text.replace('delay(1000);', 'delay(900);'));
  await waitSaved(page);
  await page.getByTestId('view-code').click();
  const t0 = Date.now();
  await page.getByTestId('build-button').click();
  // The elapsed seconds appear while it builds (a real clock, from 2 s on).
  await expect(page.getByTestId('code-view').getByTestId('build-elapsed')).toHaveText(/^\d+ s$/, {
    timeout: 10_000,
  });
  await expect(page.getByTestId('build-phase')).toHaveAttribute('data-phase', 'current', {
    timeout: 300_000,
  });
  const edited = Date.now() - t0;
  await expect(page.getByTestId('code-view').getByTestId('build-elapsed')).toHaveCount(0);
  const unchanged = await timedBuild(page);
  expect(unchanged).toBeLessThan(5_000);

  await code.fill(
    `// S18F benchmark ${Date.now()}\nvoid setup() { pinMode(2, OUTPUT); }\nvoid loop() { digitalWrite(2, !digitalRead(2)); delay(500); }\n`,
  );
  await waitSaved(page);
  const other = await timedBuild(page);
  const timings = {
    curatedMs: curated,
    editedMs: edited,
    unchangedMs: unchanged,
    otherUserMs: other,
  };
  await info.attach('s18f-build-timings.json', {
    body: JSON.stringify(timings, null, 2),
    contentType: 'application/json',
  });
  console.log(`S18F build timings ${JSON.stringify(timings)}`);
  expect(edited).toBeLessThan(25_000);
  expect(other).toBeLessThan(25_000);
});
