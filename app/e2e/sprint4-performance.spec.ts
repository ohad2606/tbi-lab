/**
 * Sprint 4 performance, measured not promised. Compared in docs/sprints/SPRINT-4.md with the
 * Sprint 3 figures (sim-performance.spec.ts, still run and recorded separately).
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
import { component, waitForStoredProject } from './helpers.js';

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;

/** 30 parts: PSU, GND, 6 legs of toggle -> resistor -> (diode|LED|resistor), 5 button legs. */
function thirtyParts(): ProjectDocument {
  const ok = <T extends { ok: boolean }>(r: T) => {
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r as Extract<T, { ok: true }> & { doc: ProjectDocument };
  };
  let doc = createProject({
    projectId: 'prj_s4perf',
    deviceId: 'p',
    name: 'S4 perf 30',
    appVersion: '0',
  });
  const t = (c: string, term: string) => ({
    kind: 'terminal' as const,
    component: c,
    terminal: term,
  });
  doc = ok(addWire(doc, t('PSU1', 'negative'), t('GND1', 'ref'))).doc;
  for (let leg = 0; leg < 6; leg++) {
    const x = 200 + leg * 140;
    const sw = ok(addComponent(doc, 'component.toggle_switch', { x, y: 0 }));
    doc = sw.doc;
    const r = ok(addComponent(doc, 'component.resistor', { x, y: 120 }));
    doc = r.doc;
    const kind =
      leg % 3 === 0 ? 'component.diode' : leg % 3 === 1 ? 'component.led' : 'component.resistor';
    const last = ok(addComponent(doc, kind, { x, y: 240 }));
    doc = last.doc;
    const [p, n] = kind === 'component.resistor' ? ['a', 'b'] : ['anode', 'cathode'];
    doc = ok(addWire(doc, t('PSU1', 'positive'), t(sw.id, 'a'))).doc;
    doc = ok(addWire(doc, t(sw.id, 'b'), t(r.id, 'a'))).doc;
    doc = ok(addWire(doc, t(r.id, 'b'), t(last.id, p))).doc;
    doc = ok(addWire(doc, t(last.id, n), t('GND1', 'ref'))).doc;
    doc = ok(setParam(doc, sw.id, 'closed', leg % 2 === 0)).doc;
  }
  for (let b = 0; b < 5; b++) {
    const btn = ok(addComponent(doc, 'component.push_button', { x: 200 + b * 140, y: 400 }));
    doc = btn.doc;
    const r = ok(addComponent(doc, 'component.resistor', { x: 200 + b * 140, y: 520 }));
    doc = r.doc;
    doc = ok(addWire(doc, t('PSU1', 'positive'), t(btn.id, 'a'))).doc;
    doc = ok(addWire(doc, t(btn.id, 'b'), t(r.id, 'a'))).doc;
    doc = ok(addWire(doc, t(r.id, 'b'), t('GND1', 'ref'))).doc;
  }
  doc = ok(setParam(doc, 'PSU1', 'currentLimit', { value: 5, unit: 'ampere' })).doc;
  return ok(setParam(doc, 'PSU1', 'outputEnabled', true)).doc;
}

async function inject(page: Page, doc: ProjectDocument) {
  await page.goto('/');
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
  await page.reload();
  const projects = page.getByRole('button', { name: /^Projects$/ });
  if (await projects.isVisible()) await projects.click();
  await page.getByRole('button', { name: new RegExp(doc.name) }).click();
}

const solves = async (page: Page) =>
  Number(await page.getByTestId('sim-status').getAttribute('data-solves'));

test('Sprint 4: interaction and re-solve measurements on a 30-part circuit', async ({ page }) => {
  test.setTimeout(240_000);
  const doc = thirtyParts();
  expect(doc.components).toHaveLength(30);
  await inject(page, doc);
  await expect(component(page, 'SW11')).toBeVisible();
  const results: Record<string, unknown> = {
    measuredAt: new Date().toISOString(),
    host: 'dev host (1-core ARM64, 4 GB) unless run elsewhere',
    parts: doc.components.length,
    wires: doc.layout.wires.length,
  };

  // Run -> result (cold worker, then warm), with the Sprint 3 breakdown attributes.
  const runs: number[] = [];
  const solveMs: number[] = [];
  for (let i = 0; i < 6; i++) {
    await page.getByTestId('sim-run').click();
    await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
    runs.push(Number(await page.getByTestId('sim-status').getAttribute('data-total-ms')));
    solveMs.push(Number(await page.getByTestId('sim-status').getAttribute('data-solve-ms')));
    if (i < 5) await page.getByTestId('sim-stop').click();
  }
  results.runToResult = {
    firstMs: runs[0],
    warmMedianMs: median(runs.slice(1)),
    warmMedianSolveMs: median(solveMs.slice(1)),
  };

  // Repeated push-button transitions: press and release, each a real worker re-solve.
  const button = page.getByTestId('actuator-SW7');
  const box = (await button.boundingBox())!;
  const btn: number[] = [];
  for (let i = 0; i < 20; i++) {
    const before = await solves(page);
    const t0 = Date.now();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(() => solves(page)).toBe(before + 1);
    btn.push(Date.now() - t0);
    const t1 = Date.now();
    await page.mouse.up();
    await expect.poll(() => solves(page)).toBe(before + 2);
    btn.push(Date.now() - t1);
  }
  results.buttonTransition = { transitions: btn.length, medianMs: median(btn), p95Ms: p95(btn) };

  // Repeated toggle transitions while running: persisted first, then mirrored and re-solved.
  const tog: number[] = [];
  for (let i = 0; i < 20; i++) {
    const before = await solves(page);
    const t0 = Date.now();
    await page.getByTestId('actuator-SW1').click();
    await expect.poll(() => solves(page)).toBe(before + 1);
    tog.push(Date.now() - t0);
  }
  results.toggleTransitionWhileRunning = {
    transitions: tog.length,
    medianMs: median(tog),
    p95Ms: p95(tog),
  };
  await page.getByTestId('sim-stop').click();

  // Undo / redo round trips on the 30-part document (to the new stored revision).
  const undo: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('redo')).toBeEnabled();
    undo.push(Date.now() - t0);
  }
  await waitForStoredProject(page, () => true, 'any', 'S4 perf 30');
  results.undo = { operations: undo.length, medianMs: median(undo), p95Ms: p95(undo) };

  console.log('sprint4 performance', JSON.stringify(results));
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/sprint4-performance.json', JSON.stringify(results, null, 2));
  expect((results.runToResult as { warmMedianSolveMs: number }).warmMedianSolveMs).toBeLessThan(16); // sanity
});
