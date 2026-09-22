/**
 * Interaction baseline for a 30-component circuit (roadmap §16.1). Sprint 2 RECORDS the
 * baseline; it is asserted as a budget from Sprint 3 on. The only assertion here is a coarse
 * sanity bound that catches a pathological regression, not a product SLA.
 */
import { expect, test } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import {
  addComponent,
  addWire,
  createProject as createDoc,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { component, storedProject, toScreen, waitSaved } from './helpers.js';

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

/** 28 resistors in a 7x4 grid plus the PSU and ground (30 components), chained by wires. */
function thirtyComponents(): ProjectDocument {
  let doc = createDoc({
    projectId: 'prj_perf30',
    deviceId: 'perf',
    name: 'Perf 30',
    appVersion: '0.1.0',
  });
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 7; col++)
      doc = ok(addComponent(doc, 'component.resistor', { x: col * 140, y: row * 100 })).doc;
  }
  const t = (component: string, terminal: string) => ({
    kind: 'terminal' as const,
    component,
    terminal,
  });
  doc = ok(addWire(doc, t('PSU1', 'positive'), t('R1', 'a'))).doc;
  doc = ok(addWire(doc, t('PSU1', 'negative'), t('GND1', 'ref'))).doc;
  for (let i = 1; i < 28; i++) doc = ok(addWire(doc, t(`R${i}`, 'b'), t(`R${i + 1}`, 'a'))).doc;
  return doc;
}

test('baseline: dragging a component in a 30-component circuit', async ({ page }) => {
  const doc = thirtyComponents();
  expect(doc.components).toHaveLength(30);
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
  await page.getByRole('button', { name: /Perf 30/ }).click();
  await expect(component(page, 'R28')).toBeVisible();

  // Measure per-move frame time while dragging R10 through 40 pointer moves.
  const start = await toScreen(page, doc.layout.components.R10!);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const samples: number[] = [];
  for (let i = 1; i <= 40; i++) {
    const t0 = Date.now();
    await page.mouse.move(start.x + i * 3, start.y + i * 2);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    samples.push(Date.now() - t0);
  }
  await page.mouse.up();
  await waitSaved(page);
  expect((await storedProject(page)).layout.components.R10).not.toEqual(doc.layout.components.R10);

  const sorted = [...samples].sort((a, b) => a - b);
  const result = {
    measuredAt: new Date().toISOString(),
    host: 'dev host (1-core ARM64, 4 GB) unless run elsewhere',
    components: 30,
    wires: doc.layout.wires.length,
    moves: samples.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    maxMs: sorted.at(-1),
  };
  console.log('interaction baseline', JSON.stringify(result));
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/sprint2-interaction-baseline.json',
    JSON.stringify(result, null, 2),
  );
  expect(result.medianMs).toBeLessThan(500); // sanity bound only
});
