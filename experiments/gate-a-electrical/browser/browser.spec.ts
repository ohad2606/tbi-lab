/**
 * Gate A browser execution proof.
 *
 * Node-only execution is not evidence for the browser path, so this spec runs the compiled
 * solver inside a real Chromium engine, inside a Web Worker, and checks:
 *   1. all seven reference cases produce the same numbers they do under Node,
 *   2. the exact-equation residuals hold in the browser too,
 *   3. the main thread keeps running while the worker computes.
 *
 * TOLERANCES: identical to the Node suite. Relative 1e-9 for analytic cases, absolute
 * 1e-12 A for the open circuit, absolute 1e-12 A for KCL residuals. Cross-runtime
 * agreement is asserted at relative 1e-12.
 */

import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist-browser');

const REL_TOL_ANALYTIC = 1e-9;
const ABS_TOL_ZERO_CURRENT_A = 1e-12;
const ABS_TOL_KCL_A = 1e-12;
const REL_TOL_CROSS_RUNTIME = 1e-12;

/** Values produced by the Node suite, for cross-runtime comparison. */
const NODE_LED_CURRENT_A = 0.01371998936234676;
const NODE_LED_VOLTAGE_V = 1.9816023402837022;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

let server: Server;
let baseUrl: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = normalize(join(ROOT, decodeURIComponent((req.url ?? '/').split('?')[0]!)));
    if (!path.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    readFile(path)
      .then((body) => {
        res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch(() => res.writeHead(404).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no server address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface CaseResult {
  name: string;
  values: Record<string, number>;
  mode?: string;
  maxKclResidualA: number;
}

test('reference cases solve correctly inside a Web Worker in a real browser', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(`${baseUrl}/browser/index.html`);
  await page.waitForFunction(() => (window as any).__ready === true);

  const response = await page.evaluate(
    async () => await (window as any).__call({ type: 'run-reference-cases' }),
  );
  expect(consoleErrors, 'page errors').toEqual([]);
  expect(response.type).toBe('reference-results');

  const byName = new Map<string, CaseResult>(
    (response.cases as CaseResult[]).map((c) => [c.name, c]),
  );
  expect([...byName.keys()]).toHaveLength(7);

  const rel = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);

  expect(rel(byName.get('case1-5V-1k')!.values.current!, 5e-3)).toBeLessThanOrEqual(REL_TOL_ANALYTIC);
  expect(rel(byName.get('case2-divider')!.values.midVoltage!, 6)).toBeLessThanOrEqual(REL_TOL_ANALYTIC);
  expect(rel(byName.get('case3-series')!.values.current!, 3e-3)).toBeLessThanOrEqual(REL_TOL_ANALYTIC);
  expect(Math.abs(byName.get('case4-open')!.values.current!)).toBeLessThanOrEqual(ABS_TOL_ZERO_CURRENT_A);

  const case5 = byName.get('case5-psu-cc')!;
  expect(case5.mode, 'PSU mode in browser').toBe('CC');
  expect(rel(case5.values.current!, 0.1)).toBeLessThanOrEqual(REL_TOL_ANALYTIC);
  expect(rel(case5.values.loadVoltage!, 1)).toBeLessThanOrEqual(REL_TOL_ANALYTIC);

  const case6 = byName.get('case6-short')!;
  expect(case6.mode, 'PSU mode on short').toBe('CC');
  expect(rel(case6.values.current!, 0.1)).toBeLessThanOrEqual(REL_TOL_ANALYTIC);

  // Cross-runtime: the browser must reproduce the Node numbers, not merely plausible ones.
  const case7 = byName.get('case7-led')!;
  expect(rel(case7.values.current!, NODE_LED_CURRENT_A)).toBeLessThanOrEqual(REL_TOL_CROSS_RUNTIME);
  expect(rel(case7.values.ledVoltage!, NODE_LED_VOLTAGE_V)).toBeLessThanOrEqual(REL_TOL_CROSS_RUNTIME);
  console.log(
    `browser LED: I=${case7.values.current} A V=${case7.values.ledVoltage} V | ` +
      `bit-identical to Node: ${case7.values.current === NODE_LED_CURRENT_A && case7.values.ledVoltage === NODE_LED_VOLTAGE_V}`,
  );

  for (const c of byName.values()) {
    expect(c.maxKclResidualA, `KCL residual for ${c.name}`).toBeLessThanOrEqual(ABS_TOL_KCL_A);
  }
});

test('the main thread stays responsive while the worker solves', async ({ page }) => {
  await page.goto(`${baseUrl}/browser/index.html`);
  await page.waitForFunction(() => (window as any).__ready === true);

  const before = await page.evaluate(() => (window as any).__tick as number);
  const result = await page.evaluate(
    async () => await (window as any).__call({ type: 'stress', iterations: 3000 }),
  );
  const after = await page.evaluate(() => (window as any).__tick as number);

  expect(result.type).toBe('stress-done');
  expect(result.iterations).toBe(3000);
  // The worker did real work, not a no-op.
  expect(result.elapsedMs, 'worker elapsed ms').toBeGreaterThan(20);
  // And the main thread kept servicing its timer loop throughout.
  expect(after - before, 'main-thread ticks during worker computation').toBeGreaterThan(5);

  console.log(
    `worker solved ${result.iterations} nonlinear circuits in ${Math.round(result.elapsedMs)} ms ` +
      `(${(result.elapsedMs / result.iterations).toFixed(3)} ms/solve); ` +
      `main thread advanced ${after - before} ticks meanwhile`,
  );
});
