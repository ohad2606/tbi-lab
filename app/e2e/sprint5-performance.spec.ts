/**
 * Sprint 5 performance MEASUREMENTS (no SLA is asserted): project library with 50 projects,
 * duplicate, export, import, example instantiation and editor reopen. Timings are taken in
 * the page (performance.now, completion observed per animation frame) where the action can be
 * triggered from the page; export and import go through Playwright's download/file APIs, so
 * their figures include that round trip. Results: test-results/sprint5-performance.json.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ProjectDocument } from '@tbi-lab/domain';

const EXAMPLES = [
  'ohms-law',
  'voltage-divider',
  'led-current',
  'diode-polarity',
  'push-button',
  'cc-mode',
];
const exampleDoc = (id: string) =>
  JSON.parse(
    readFileSync(new URL(`../src/examples/data/${id}.json`, import.meta.url), 'utf8'),
  ) as ProjectDocument;

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return {
    samples: s.length,
    medianMs: Math.round(q(0.5) * 10) / 10,
    p95Ms: Math.round(q(0.95) * 10) / 10,
    maxMs: Math.round(s.at(-1)! * 10) / 10,
  };
}

/** Click `clickSelector` in the page and time until `done()` holds (checked every frame). */
function timeInPage(page: Page, clickSelector: string, doneCondition: string): Promise<number> {
  return page.evaluate(
    async ({ clickSelector, doneCondition }) => {
      const done = new Function(`return (${doneCondition});`) as () => boolean;
      const t0 = performance.now();
      (document.querySelector(clickSelector) as HTMLElement).click();
      await new Promise<void>((resolve) => {
        const check = () => (done() ? resolve() : requestAnimationFrame(check));
        check();
      });
      return performance.now() - t0;
    },
    { clickSelector, doneCondition },
  );
}

async function seed(page: Page, docs: ProjectDocument[]) {
  await page.evaluate(
    (docs) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('tbi-lab');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['projects', 'projectIndex'], 'readwrite');
          for (const d of docs) {
            tx.objectStore('projects').put(d);
            tx.objectStore('projectIndex').put({
              projectId: d.projectId,
              name: d.name,
              updatedAt: d.revision.updatedAt,
              schemaVersion: d.schemaVersion,
            });
          }
          tx.oncomplete = () => (db.close(), resolve());
          tx.onerror = () => reject(tx.error);
        };
      }),
    docs,
  );
}

test('Sprint 5: project library and portability measurements', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await expect(page.getByTestId('example-list').or(page.getByTestId('canvas'))).toBeVisible();

  // 50 realistic projects (the six examples, cycled), then a cold library load.
  const docs = Array.from({ length: 50 }, (_, i) => {
    const d = exampleDoc(EXAMPLES[i % EXAMPLES.length]!);
    const at = new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString();
    return {
      ...d,
      projectId: `prj_perf${String(i).padStart(2, '0')}`,
      name: `Perf ${String(i).padStart(2, '0')} ${d.name}`,
      revision: { ...d.revision, updatedAt: at },
    };
  });
  await seed(page, docs);
  await page.evaluate(() => localStorage.removeItem('tbi-lab.lastProject'));

  const coldLoads: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await page.reload();
    await expect(page.locator('.project-row')).toHaveCount(50);
    coldLoads.push(Date.now() - t0);
  }

  // Duplicate: click -> the new row is rendered (the store awaits the IndexedDB commit first).
  const duplicate: number[] = [];
  for (let i = 0; i < 10; i++) {
    const count = await page.locator('.project-row').count();
    duplicate.push(
      await timeInPage(
        page,
        `[data-testid="project-prj_perf0${i % 6}"] [data-testid="duplicate-project"]`,
        `document.querySelectorAll('.project-row').length === ${count + 1}`,
      ),
    );
  }

  // Editor reopen from the library, and back.
  const reopen: number[] = [];
  const library: number[] = [];
  for (let i = 0; i < 10; i++) {
    reopen.push(
      await timeInPage(
        page,
        `[data-testid="project-prj_perf0${i % 6}"] [data-testid="open-project"]`,
        `!!document.querySelector('[data-hit="component"][data-id="R1"]')`,
      ),
    );
    library.push(
      await timeInPage(
        page,
        '.topbar-nav .button',
        `document.querySelectorAll('.project-row').length >= 50`,
      ),
    );
  }

  // Example instantiation: click -> editor with the new project's parts (stored first).
  const example: number[] = [];
  for (let i = 0; i < 6; i++) {
    example.push(
      await timeInPage(
        page,
        `[data-testid="open-example-${EXAMPLES[i]}"]`,
        `!!document.querySelector('[data-hit="component"][data-id="R1"]')`,
      ),
    );
    await page.locator('.topbar-nav .button').click();
    await expect(page.getByTestId('example-list')).toBeVisible();
  }

  // Export (Playwright download round trip) and import (file chooser round trip).
  await page.locator('[data-testid="project-prj_perf03"] [data-testid="open-project"]').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  const exportTimes: number[] = [];
  let text = '';
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-current').click(),
    ]);
    exportTimes.push(Date.now() - t0);
    text = readFileSync((await download.path())!, 'utf8');
  }
  await page.locator('.topbar-nav .button').click();
  await expect(page.getByTestId('example-list')).toBeVisible();
  const importTimes: number[] = [];
  const importInApp: number[] = [];
  for (let i = 0; i < 10; i++) {
    // The app's own cost: from the file input's change event to the imported project on screen.
    await page.evaluate(() => {
      const w = window as unknown as { __importMs?: Promise<number> };
      w.__importMs = new Promise((resolve) => {
        document.querySelector('[data-testid="import-file"]')!.addEventListener(
          'change',
          () => {
            const t0 = performance.now();
            const check = () =>
              document.querySelector('[data-testid="canvas"]')
                ? resolve(performance.now() - t0)
                : requestAnimationFrame(check);
            check();
          },
          { once: true },
        );
      });
    });
    const t0 = Date.now();
    await page.getByTestId('import-file').setInputFiles({
      name: 'perf.tbilab',
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    });
    await expect(page.getByTestId('canvas')).toBeVisible();
    importTimes.push(Date.now() - t0);
    importInApp.push(
      await page.evaluate(() => (window as unknown as { __importMs: Promise<number> }).__importMs),
    );
    await page.locator('.topbar-nav .button').click();
    await expect(page.getByTestId('example-list')).toBeVisible();
  }

  const results = {
    measuredAt: new Date().toISOString(),
    host: 'dev host (1-core ARM64, 4 GB) unless run elsewhere',
    projectsInLibrary: 50,
    packageBytes: Buffer.byteLength(text),
    libraryColdLoadInclReloadMs: stats(coldLoads),
    libraryFromEditorMs: stats(library),
    duplicateMs: stats(duplicate),
    editorReopenMs: stats(reopen),
    exampleInstantiationMs: stats(example),
    exportInclDownloadMs: stats(exportTimes),
    importInclFileChooserMs: stats(importTimes),
    importInAppMs: stats(importInApp),
  };
  console.log('sprint5 performance', JSON.stringify(results));
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/sprint5-performance.json', JSON.stringify(results, null, 2));
  expect(results.duplicateMs.samples).toBe(10);
});
