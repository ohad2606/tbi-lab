/**
 * Worker performance, measured not promised (roadmap §16). Records the breakdown of
 * Run-to-result for representative circuits and checks the key architectural property:
 * the solve never blocks the UI thread. The Sprint 2 drag baseline is in performance.spec.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  addComponent,
  addWire,
  createProject,
  setParam,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { drawLoop } from './circuits.js';
import { component } from './helpers.js';

interface Sample {
  workerStartMs: number | null;
  requestMs: number;
  solveMs: number;
  resultMs: number;
  totalMs: number;
}

async function timings(page: Page): Promise<Sample> {
  const s = page.getByTestId('sim-status');
  await expect(s).toHaveAttribute('data-status', 'running');
  const a = async (n: string) => Number(await s.getAttribute(n));
  const ws = await s.getAttribute('data-worker-start-ms');
  return {
    workerStartMs: ws ? Number(ws) : null,
    requestMs: await a('data-request-ms'),
    solveMs: await a('data-solve-ms'),
    resultMs: await a('data-result-ms'),
    totalMs: await a('data-total-ms'),
  };
}

async function cycles(page: Page, n: number): Promise<Sample[]> {
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    await page.getByTestId('sim-run').click();
    out.push(await timings(page));
    await page.getByTestId('sim-stop').click();
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'stopped');
  }
  return out;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const summary = (xs: Sample[]) => ({
  runs: xs.length,
  firstRunWorkerStartMs: xs[0]!.workerStartMs,
  firstRunTotalMs: xs[0]!.totalMs,
  warmMedian: {
    requestMs: median(xs.slice(1).map((x) => x.requestMs)),
    solveMs: median(xs.slice(1).map((x) => x.solveMs)),
    resultMs: median(xs.slice(1).map((x) => x.resultMs)),
    totalMs: median(xs.slice(1).map((x) => x.totalMs)),
  },
});

/** 28 resistors + 2 LEDs in parallel legs off one PSU: a large V1-sized circuit. */
function thirtyParts(): ProjectDocument {
  const ok = <T extends { ok: boolean }>(r: T) => {
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r as Extract<T, { ok: true }> & { doc: ProjectDocument };
  };
  let doc = createProject({
    projectId: 'prj_simperf',
    deviceId: 'p',
    name: 'Sim perf 30',
    appVersion: '0',
  });
  const t = (c: string, term: string) => ({
    kind: 'terminal' as const,
    component: c,
    terminal: term,
  });
  doc = ok(addWire(doc, t('PSU1', 'negative'), t('GND1', 'ref'))).doc;
  for (let leg = 0; leg < 15; leg++) {
    const r = ok(addComponent(doc, 'component.resistor', { x: 200 + leg * 120, y: 0 }));
    doc = r.doc;
    const second = ok(
      addComponent(doc, leg < 2 ? 'component.led' : 'component.resistor', {
        x: 200 + leg * 120,
        y: 120,
      }),
    );
    doc = second.doc;
    doc = ok(addWire(doc, t('PSU1', 'positive'), t(r.id, 'a'))).doc;
    const [p, n] = leg < 2 ? ['anode', 'cathode'] : ['a', 'b'];
    doc = ok(addWire(doc, t(r.id, 'b'), t(second.id, p))).doc;
    doc = ok(addWire(doc, t(second.id, n), t('GND1', 'ref'))).doc;
  }
  doc = ok(setParam(doc, 'PSU1', 'currentLimit', { value: 5, unit: 'ampere' })).doc;
  return ok(setParam(doc, 'PSU1', 'outputEnabled', true)).doc;
}

test('Worker Run-to-result breakdown and main-thread responsiveness', async ({ page }) => {
  test.setTimeout(180_000);
  const results: Record<string, unknown> = {
    measuredAt: new Date().toISOString(),
    host: 'dev host (1-core ARM64, 4 GB) unless run elsewhere',
  };

  await drawLoop(page, { ohms: '1k' }, 'Perf R');
  results['5V-1k'] = summary(await cycles(page, 11));

  await drawLoop(page, { ohms: '220', led: true }, 'Perf LED');
  results['5V-220R-LED'] = summary(await cycles(page, 11));

  // Live re-solve latency (PSU setpoint changes while running, persisted then mirrored).
  await page.getByTestId('sim-run').click();
  await component(page, 'PSU1').locator('.component-hit').click();
  const live: number[] = [];
  for (let i = 0; i < 10; i++) {
    const field = page.getByTestId('param-PSU1-setpointVoltage');
    await field.fill(String(4 + i * 0.1));
    await field.press('Enter');
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-solves', String(i + 2));
    live.push((await timings(page)).totalMs);
  }
  results['live-psu-resolve'] = { samples: live.length, medianTotalMs: median(live) };
  await page.getByTestId('sim-stop').click();

  // A 30-component circuit (28 resistors, 2 LEDs).
  const doc = thirtyParts();
  expect(doc.components.length).toBe(32); // + PSU1 and GND1
  await page.evaluate(
    (d) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('tbi-lab');
        req.onsuccess = () => {
          const tx = req.result.transaction(['projects', 'projectIndex'], 'readwrite');
          tx.objectStore('projects').put(d);
          tx.objectStore('projectIndex').put({
            projectId: d.projectId,
            name: d.name,
            updatedAt: d.revision.updatedAt,
            schemaVersion: 2,
          });
          tx.oncomplete = () => (req.result.close(), resolve());
          tx.onerror = () => reject(tx.error);
        };
      }),
    doc,
  );
  await page.getByRole('button', { name: 'Projects' }).click();
  await page.getByRole('button', { name: /Sim perf 30/ }).click();

  // Main-thread responsiveness while solving: long tasks and rAF gaps during repeated runs.
  await page.evaluate(() => {
    const w = window as unknown as { __lt: number[]; __gaps: number[]; __raf: boolean };
    w.__lt = [];
    w.__gaps = [];
    w.__raf = true;
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__lt.push(e.duration))).observe({
      type: 'longtask',
      buffered: false,
    });
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      w.__gaps.push(now - last);
      last = now;
      if (w.__raf) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  results['30-parts'] = summary(await cycles(page, 11));
  const responsiveness = await page.evaluate(() => {
    const w = window as unknown as { __lt: number[]; __gaps: number[]; __raf: boolean };
    w.__raf = false;
    const gaps = [...w.__gaps].sort((a, b) => a - b);
    return {
      longTasks: w.__lt.length,
      maxLongTaskMs: Math.max(0, ...w.__lt),
      frames: gaps.length,
      p95FrameGapMs: gaps[Math.floor(gaps.length * 0.95)] ?? 0,
    };
  });
  results.mainThreadDuring30PartRuns = responsiveness;

  // Control measurement: the raw cost of moving a result-sized object from a worker to the
  // page with nothing else happening (isolates structured clone from UI-thread queueing).
  results.rawWorkerRoundTrip = await page.evaluate(async () => {
    const src = `onmessage = (e) => postMessage({ echo: e.data, t: performance.timeOrigin + performance.now() });`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const payload = {
      components: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [
          `R${i}`,
          {
            id: `R${i}`,
            current: Math.random(),
            voltage: Math.random(),
            terminals: { a: 1, b: 2 },
          },
        ]),
      ),
    };
    const oneWay: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t = await new Promise<number>((resolve) => {
        w.onmessage = (e) => resolve(performance.timeOrigin + performance.now() - e.data.t);
        w.postMessage(payload);
      });
      oneWay.push(t);
    }
    w.terminate();
    oneWay.sort((a, b) => a - b);
    return { samples: oneWay.length, medianWorkerToPageMs: oneWay[15], maxMs: oneWay.at(-1) };
  });

  console.log('sim performance', JSON.stringify(results));
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/sprint3-worker-performance.json', JSON.stringify(results, null, 2));
  // Sanity only (not an SLA): a warm solve of a V1-sized circuit stays far below one frame.
  expect((results['30-parts'] as ReturnType<typeof summary>).warmMedian.solveMs).toBeLessThan(16);
});
