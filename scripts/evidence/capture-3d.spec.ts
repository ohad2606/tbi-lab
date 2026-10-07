/**
 * 3D evidence capture: the same benches and cameras every time (see playwright.evidence.config.ts).
 * Each shot is the 3D canvas only, plus the viewer's own counters (draw calls, triangles, GPU
 * memory estimate) written next to the images as stats.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createPackage, serializePackage } from '../../packages/domain/src/index.js';
import { partsBench } from './benches.js';

const OUT = process.env.EVIDENCE_OUT ?? 'evidence-out';
const QUALITY = process.env.EVIDENCE_QUALITY ?? 'full';
type V = [number, number, number];
const stats: Record<string, unknown> = {};

async function openDoc(page: Page, text: string) {
  await page.goto('/');
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) {
    await page.getByTestId('app-menu-button').click();
    await page.getByTestId('menu-projects').click();
  }
  await page.getByTestId('import-file').setInputFiles({
    name: 'bench.tbilab',
    mimeType: 'application/json',
    buffer: Buffer.from(text, 'utf8'),
  });
  await expect(page.getByTestId('canvas')).toBeVisible();
}

async function open3d(page: Page) {
  await page.getByTestId('view-3d').click();
  const view = page.getByTestId('view3d');
  await expect(view).toHaveAttribute('data-status', 'ready', { timeout: 120_000 });
  await expect
    .poll(async () => Number(await view.getAttribute('data-draw-calls')), { timeout: 120_000 })
    .toBeGreaterThan(0);
}

/** Switch the 3D view's visualization layers to a preset (layers.ts) and close the panel. */
async function setPreset(page: Page, preset: 'realistic' | 'engineering') {
  await page.getByTestId('view3d-layers').click();
  await page.getByTestId(`view3d-preset-${preset}`).check();
  await page.getByTestId('view3d-layers').click();
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-preset', preset);
}

async function shot(page: Page, name: string, cam?: { target: V; from: V }) {
  if (cam)
    await page.evaluate(({ target, from }) => {
      const host = document.querySelector('[data-testid="view3d-host"]') as unknown as {
        tbiViewer: { inspect(t: V, f: V): void };
      };
      host.tbiViewer.inspect(target, from);
    }, cam);
  await page.waitForTimeout(400);
  const view = page.getByTestId('view3d');
  stats[name] = {
    drawCalls: Number(await view.getAttribute('data-draw-calls')),
    triangles: Number(await view.getAttribute('data-triangles')),
    materials: Number(await view.getAttribute('data-materials')),
    geometries: Number(await view.getAttribute('data-geometries')),
    textures: Number(await view.getAttribute('data-textures')),
    gpuBytes: Number(await view.getAttribute('data-gpu-bytes')),
    renderMs: Number(await view.getAttribute('data-render-ms')),
    quality: await view.getAttribute('data-quality'),
  };
  await page
    .getByTestId('view3d-host')
    .screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
}

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));
test.afterAll(() => writeFileSync(join(OUT, 'stats.json'), JSON.stringify(stats, null, 2)));

test.beforeEach(async ({ page }) => {
  await page.addInitScript((q) => {
    localStorage.setItem('tbi-lab.3d.inspect', '1');
    localStorage.setItem('tbi-lab.3d.quality', q);
  }, QUALITY);
});

test('ESP32 bench (esp32-blink example)', async ({ page }) => {
  const doc = JSON.parse(
    readFileSync(new URL('../../app/src/examples/data/esp32-blink.json', import.meta.url), 'utf8'),
  );
  doc.projectId = 'prj_evidenceesp32';
  await openDoc(
    page,
    serializePackage(
      createPackage(doc, { appVersion: '0.1.0', exportedAt: '2026-10-06T00:00:00.000Z' }),
    ),
  );
  await open3d(page);
  await shot(page, 'esp32-overview');
  await shot(page, 'esp32-three-quarter', { target: [12, 6, 0], from: [62, 48, 62] });
  await shot(page, 'esp32-usb-buttons', { target: [9.5, 10.5, 20], from: [26, 24, 48] });
  await shot(page, 'esp32-wroom-antenna', { target: [9.5, 11, -22], from: [-8, 30, -46] });
  await shot(page, 'esp32-header-pins', { target: [22.2, 8, -8], from: [44, 13, 6] });
  await shot(page, 'esp32-wire-to-header', { target: [22.2, 14, -21], from: [42, 28, -4] });
  await shot(page, 'esp32-underside', { target: [9.5, 3, 0], from: [-32, 3.2, -26] });
  await shot(page, 'esp32-top', { target: [9.5, 10, 0], from: [9.5, 75, 0.05] });
});

test('parts bench (toggle, button, resistor, LED, 1N4148, contact)', async ({ page }) => {
  const doc = partsBench();
  doc.projectId = 'prj_evidenceparts';
  await openDoc(
    page,
    serializePackage(
      createPackage(doc, { appVersion: '0.1.0', exportedAt: '2026-10-06T00:00:00.000Z' }),
    ),
  );
  await open3d(page);
  await shot(page, 'parts-overview');
  await shot(page, 'resistor-bands', { target: [6.3, 2, -12.7], from: [10.5, 9, 1.5] });
  await shot(page, 'diode-glass', { target: [25.4, 1.9, 19.1], from: [35, 7, 24] });
  await shot(page, 'direct-contact', { target: [16, 1.5, 34.9], from: [22, 8, 47] });
  await shot(page, 'push-button', { target: [-15.9, 3, 9.5], from: [-6, 14, 25] });
  await shot(page, 'toggle-switch', { target: [-15.9, 7, -12.7], from: [-2, 16, 5] });
  await shot(page, 'psu', { target: [-41.3, 5, 0], from: [-6, 20, 25] });
  await shot(page, 'ground-post', { target: [25.4, 2.5, 33], from: [35, 10, 45] });
  const led = { target: [25.4, 6, -3.2] as V, from: [39, 12, 13] as V };
  await shot(page, 'led-unlit', led);
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('view3d')).toHaveAttribute('data-lit', /D1/, { timeout: 60_000 });
  await shot(page, 'led-lit', led);
  await shot(page, 'parts-lit-overview', { target: [-8, 4, 10], from: [30, 55, 80] });
  await page.getByTestId('sim-stop').click();
});

test('wiring and LED colours (esp32-input-echo, led-colours)', async ({ page }) => {
  for (const [id, shots] of [
    ['esp32-input-echo', ['echo-overview', 'echo-wires']],
    ['led-colours', ['leds-overview', 'leds-close']],
  ] as const) {
    const doc = JSON.parse(
      readFileSync(new URL(`../../app/src/examples/data/${id}.json`, import.meta.url), 'utf8'),
    );
    doc.projectId = `prj_evidence${id.replace(/-/g, '')}`;
    await openDoc(
      page,
      serializePackage(
        createPackage(doc, { appVersion: '0.1.0', exportedAt: '2026-10-06T00:00:00.000Z' }),
      ),
    );
    await open3d(page);
    await shot(page, shots[0]);
    if (id === 'esp32-input-echo') {
      await shot(page, shots[1], { target: [-10, 6, 0], from: [30, 30, 55] });
      // Layers (Sprint 10): the default Realistic view, then the Engineering preset.
      await shot(page, 'echo-overview-realistic');
      await setPreset(page, 'engineering');
      await shot(page, 'echo-overview-engineering');
      await setPreset(page, 'realistic');
    } else {
      await shot(page, shots[1], { target: [8, 6, 5], from: [30, 22, 40] });
      await page.getByTestId('sim-run').click();
      await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
      await expect(page.getByTestId('view3d')).toHaveAttribute('data-lit', /D1/, {
        timeout: 60_000,
      });
      await shot(page, 'leds-lit-overview');
      await shot(page, 'leds-lit-close', { target: [8, 6, 5], from: [30, 22, 40] });
      await page.getByTestId('sim-stop').click();
    }
  }
});

test('component audit: the examples with the older parts', async ({ page }) => {
  for (const id of [
    'relay-load',
    'pir-alarm',
    'led-matrix',
    'night-light',
    'rc-fade',
    'rgb-mixer',
  ]) {
    const doc = JSON.parse(
      readFileSync(new URL(`../../app/src/examples/data/${id}.json`, import.meta.url), 'utf8'),
    );
    doc.projectId = `prj_audit${id.replace(/-/g, '')}`;
    await openDoc(
      page,
      serializePackage(
        createPackage(doc, { appVersion: '0.1.0', exportedAt: '2026-10-06T00:00:00.000Z' }),
      ),
    );
    await open3d(page);
    await shot(page, `audit-${id}`);
  }
});

// Visual-only body separation (Sprint 10 owner review): projects and cameras written by the
// generator (EVIDENCE_SEPARATION=<dir> with cameras.json); the same cameras before and after.
const SEP = process.env.EVIDENCE_SEPARATION;
test('body separation: PIR + matrix, ESP32 + module, dense mixed (top and angled)', async ({
  page,
}) => {
  test.skip(!SEP, 'EVIDENCE_SEPARATION not set');
  const { list, cams } = JSON.parse(readFileSync(join(SEP!, 'cameras.json'), 'utf8')) as {
    list: Record<string, { file: string }>;
    cams: Record<string, Record<'top' | 'angled', { target: V; from: V }>>;
  };
  for (const [id, e] of Object.entries(list)) {
    await openDoc(page, readFileSync(join(SEP!, e.file), 'utf8'));
    await open3d(page);
    const view = page.getByTestId('view3d');
    stats[`sep-${id}:moved`] = await view.getAttribute('data-moved');
    for (const k of ['top', 'angled'] as const) await shot(page, `sep-${id}-${k}`, cams[id]![k]);
  }
});

// Listed shots (Sprint 10 wire routing): EVIDENCE_SHOTS=<json> with
// [{ example: '<id>', run?: true, preset?: 'engineering', shots: [{ name, target, from }] }].
// `run`: start the (local) simulation first, so lit LEDs show (circuits without a board).
const SHOTS = process.env.EVIDENCE_SHOTS;
test('listed shots of curated examples', async ({ page }) => {
  test.skip(!SHOTS, 'EVIDENCE_SHOTS not set');
  const list = JSON.parse(readFileSync(SHOTS!, 'utf8')) as {
    example: string;
    run?: boolean;
    preset?: 'realistic' | 'engineering';
    shots: { name: string; target: V; from: V }[];
  }[];
  for (const e of list) {
    const doc = JSON.parse(
      readFileSync(
        new URL(`../../app/src/examples/data/${e.example}.json`, import.meta.url),
        'utf8',
      ),
    );
    await openDoc(
      page,
      serializePackage(
        createPackage(doc, { appVersion: 'evidence', exportedAt: '2026-10-07T00:00:00Z' }),
      ),
    );
    if (e.run) {
      await page.getByTestId('sim-run').click();
      await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
    }
    await open3d(page);
    if (e.preset) await setPreset(page, e.preset);
    if (e.run) await page.waitForTimeout(1500);
    const suffix = `${e.run ? '-lit' : ''}${e.preset ? `-${e.preset}` : ''}`;
    for (const s of e.shots) await shot(page, `${e.example}-${s.name}${suffix}`, s);
    if (e.preset) await setPreset(page, 'realistic');
    if (e.run) await page.getByTestId('sim-stop').click();
  }
});
