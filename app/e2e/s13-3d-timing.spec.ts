/**
 * Sprint 13 OS-02 measurement (not a regression test): where the time of opening the 3D view goes
 * on a minimal circuit, cold (a fresh browser context: nothing cached), per phase (ThreeView
 * `data-open-ms`: chunk, assets, viewer, derive, update, first frame), in both quality tiers.
 * Writes JSON lines to TBI_3D_TIMING_OUT. Skipped unless TBI_3D_TIMING=1.
 */
import { appendFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { goToProjects } from './helpers.js';

test.skip(!process.env.TBI_3D_TIMING, 'measurement only (TBI_3D_TIMING=1)');
const OUT = process.env.TBI_3D_TIMING_OUT ?? 'test-results/s13-3d-timing.jsonl';
const RUNS = Number(process.env.TBI_3D_TIMING_RUNS ?? 3);

for (const quality of (process.env.TBI_3D_TIMING_TIERS ?? 'full,reduced').split(','))
  for (const example of ['ohms-law', 'esp32-blink'])
    test(`3D open, cold: ${example}, ${quality}`, async ({ browser }) => {
      test.setTimeout(600_000);
      for (let run = 0; run < RUNS; run++) {
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
        const page = await ctx.newPage();
        await page.addInitScript((q) => localStorage.setItem('tbi-lab.3d.quality', q), quality);
        await page.goto('/');
        await expect(page.getByTestId('example-list').or(page.getByTestId('canvas'))).toBeVisible();
        if (!(await page.getByTestId('example-list').isVisible())) await goToProjects(page);
        await page.getByTestId(`open-example-${example}`).click();
        await expect(page.getByTestId('canvas')).toBeVisible();
        const view = page.getByTestId('view3d');
        const t0 = Date.now();
        await page.getByTestId('view-3d').click();
        await expect(view).toHaveAttribute('data-open-ms', /firstFrame/, { timeout: 300_000 });
        const wallMs = Date.now() - t0;
        const phases = JSON.parse((await view.getAttribute('data-open-ms'))!) as Record<
          string,
          number
        >;
        const row = {
          example,
          quality,
          run,
          wallMs,
          phases,
          tier: await view.getAttribute('data-quality'),
          programs: Number(await view.getAttribute('data-programs')),
          drawCalls: Number(await view.getAttribute('data-draw-calls')),
        };
        appendFileSync(OUT, `${JSON.stringify(row)}\n`);
        await ctx.close();
      }
    });
