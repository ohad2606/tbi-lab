/**
 * OS-11 (P1): after the gate's sign-in expires, the app's background requests must not start a
 * login (they carry Accept application/json, so the gate answers 401), the user is told plainly,
 * and "Sign in again" saves first, then reloads once: the project is intact. The gate itself is
 * covered against the real oauth2-proxy in runtime/tests/os11-gate.runtime.test.ts.
 */
import { expect, test } from '@playwright/test';
import { createProject, storedProject } from './helpers.js';

test('OS-11: an expired sign-in is explained; Sign in again saves, reloads once, the project is intact', async ({
  page,
}) => {
  await createProject(page, 'OS-11 project');
  const accepts: string[] = [];
  // The gate after expiry: 401 for a request that accepts JSON (oauth2-proxy v7.15.4 behaviour).
  await page.route('**/version.json', (route) => {
    accepts.push(route.request().headers()['accept'] ?? '');
    return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
  });
  // An edit just before the user returns (saved before the reload).
  await page.getByTestId('project-name').fill('OS-11 edited');
  await page.getByTestId('project-name').press('Enter');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); // the user returns
  const banner = page.getByTestId('signin-expired');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Your sign-in has expired');
  expect(accepts.length).toBeGreaterThan(0);
  for (const a of accepts) expect(a.split(/,\s*/)).toContain('application/json');

  await page.unroute('**/version.json'); // signed in again: the gate lets requests through
  const reloads: string[] = [];
  page.on('framenavigated', (f) => f === page.mainFrame() && reloads.push(f.url()));
  await page.getByTestId('signin-again').click();
  // After the reload the app opens as usual (home or the last project).
  await expect(page.getByTestId('canvas').or(page.getByTestId('new-project-name'))).toBeVisible();
  await expect(page.getByTestId('signin-expired')).toHaveCount(0);
  expect(reloads).toHaveLength(1); // one navigation, no loop
  const doc = await storedProject(page);
  expect(doc.name).toBe('OS-11 edited');
  expect(doc.components.map((c) => c.id).sort()).toEqual(['GND1', 'PSU1']);
});
