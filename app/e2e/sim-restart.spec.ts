/**
 * A12: closing the browser while a simulation runs and reopening it restores the project in
 * STOPPED state: runtime results are never persisted and never resurrect as "running".
 */
import { chromium, expect, test } from '@playwright/test';
import { validateProject } from '@tbi-lab/domain';
import { drawLoop, run } from './circuits.js';
import { component, reopenFromLibrary, storedProject } from './helpers.js';
import { ownedTempDir, removeOwnedTempDir } from './fixtures/temp-dirs.js';

test('A12: browser restart during a run reopens stopped, intact, and able to run again', async ({
  baseURL,
}) => {
  const profile = ownedTempDir('tbi-lab-sim-restart-'); // removed below, at exit, or by the next run
  const viewport = { width: 1400, height: 860 };
  try {
    let context = await chromium.launchPersistentContext(profile, { baseURL: baseURL!, viewport });
    let page = context.pages()[0] ?? (await context.newPage());
    await drawLoop(page, { ohms: '220', led: true }, 'Restart bench');
    await run(page);
    await component(page, 'D1').locator('.component-hit').click();
    await expect(page.getByTestId('result-D1')).toHaveText('1.982 V · 13.72 mA');
    const before = await storedProject(page);
    await context.close(); // the browser process ends while "running"

    context = await chromium.launchPersistentContext(profile, { baseURL: baseURL!, viewport });
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto('/');
    await reopenFromLibrary(page); // the app opens on Projects (S6)
    await expect(page.getByTestId('project-name')).toHaveValue('Restart bench');
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'stopped');
    await expect(page.locator('.runtime-label')).toHaveCount(0);
    const after = await storedProject(page);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(validateProject(after)).toEqual([]);
    expect(JSON.stringify(after)).not.toMatch(/"(running|outcome|netVoltages|current)"/);
    await run(page);
    await component(page, 'D1').locator('.component-hit').click();
    await expect(page.getByTestId('result-D1')).toHaveText('1.982 V · 13.72 mA');
    await context.close();
  } finally {
    removeOwnedTempDir(profile);
  }
});
