/**
 * Gate D acceptance proof: real IndexedDB in real Chromium.
 *
 * `fake-indexeddb` is used only for supplemental fast unit tests (tests/state.test.ts).
 * The acceptance evidence is this file: a genuine browser engine, a genuine IndexedDB, a
 * genuine page reload, and a genuine browser-restart via a persistent profile directory.
 *
 * No cloud sync, no CRDT, no authentication, no backend. The sync-ready metadata fields are
 * asserted to round trip; nothing acts on them.
 */

import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist-browser');
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

const PROJECT_ID = 'gate-d-project-0001';

interface ProjectState {
  projectId: string;
  schemaVersion: number;
  localRevision: number;
  cloudRevision: number | null;
  baseRevision: number | null;
  updatedAt: string;
  deviceId: string;
  name: string;
  components: unknown[];
  connections: unknown[];
  psu: { setpointV: number; currentLimitA: number; enabled: boolean };
}

/** Every field the PM brief requires must be present, not merely most of them. */
function assertRequiredShape(state: ProjectState): void {
  for (const field of [
    'projectId',
    'schemaVersion',
    'localRevision',
    'cloudRevision',
    'baseRevision',
    'updatedAt',
    'deviceId',
    'components',
    'connections',
    'psu',
  ]) {
    expect(Object.keys(state), `required field ${field}`).toContain(field);
  }
  expect(state.psu).toHaveProperty('setpointV');
  expect(state.psu).toHaveProperty('currentLimitA');
  expect(state.psu).toHaveProperty('enabled');
  expect(new Date(state.updatedAt).toISOString(), 'updatedAt is ISO-8601').toBe(state.updatedAt);
}

test('create, autosave, reload and restore exactly from real IndexedDB', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`${baseUrl}/browser/index.html`);
  await page.waitForFunction(() => (window as any).__gateDReady === true);

  // 1. create a minimal project
  const created = await page.evaluate(async (id) => {
    await (window as any).__gateD.init();
    return await (window as any).__gateD.create(id, 'LED test bench');
  }, PROJECT_ID);
  expect(created.localRevision).toBe(1);
  assertRequiredShape(created);

  // 2. modify it and let autosave persist the change
  const edited: ProjectState = await page.evaluate(async () => {
    await (window as any).__gateD.editAll();
    const renamed = await (window as any).__gateD.renameTo('LED test bench v2');
    await (window as any).__gateD.flush();
    return renamed;
  });
  expect(edited.localRevision).toBe(3); // create -> editAll -> rename
  expect(edited.components).toHaveLength(4);
  expect(edited.connections).toHaveLength(4);
  expect(edited.psu).toEqual({ setpointV: 3.3, currentLimitA: 0.25, enabled: true });
  assertRequiredShape(edited);

  // Autosave must have coalesced the burst rather than writing once per keystroke.
  const { writeCount } = await page.evaluate(async () => await (window as any).__gateD.flush());
  expect(writeCount, 'physical writes are debounced').toBeLessThan(4);

  // 3. reload the page: everything is re-read from IndexedDB, nothing from memory
  await page.reload();
  await page.waitForFunction(() => (window as any).__gateDReady === true);
  const restored: ProjectState = await page.evaluate(async (id) => {
    await (window as any).__gateD.init();
    return await (window as any).__gateD.load(id);
  }, PROJECT_ID);

  // 4. restore EXACTLY
  expect(restored).toEqual(edited);
  assertRequiredShape(restored);
  expect(errors, 'page errors').toEqual([]);

  console.log(
    `Gate D reload: rev ${restored.localRevision}, ${restored.components.length} components, ` +
      `${restored.connections.length} connections, PSU ${restored.psu.setpointV} V / ` +
      `${restored.psu.currentLimitA} A, deviceId ${restored.deviceId}`,
  );
});

test('state and deviceId survive closing and reopening the browser', async () => {
  // A page reload keeps the same browser process. This test closes the browser entirely and
  // reopens it against the same profile directory, which is the real "reopen the app" case.
  const userDataDir = await mkdtemp(join(tmpdir(), 'tbi-gate-d-'));
  const projectId = 'gate-d-restart-0002';

  let context: BrowserContext | null = null;
  let firstDeviceId = '';
  let saved: ProjectState;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {});
    const page = await context.newPage();
    await page.goto(`${baseUrl}/browser/index.html`);
    await page.waitForFunction(() => (window as any).__gateDReady === true);

    const init = await page.evaluate(async () => await (window as any).__gateD.init());
    firstDeviceId = init.deviceId;
    expect(firstDeviceId).toMatch(/^[0-9a-f-]{36}$/);

    saved = await page.evaluate(async (id) => {
      await (window as any).__gateD.create(id, 'Persistent bench');
      await (window as any).__gateD.editAll();
      await (window as any).__gateD.flush();
      return (window as any).__gateD.current();
    }, projectId);
    assertRequiredShape(saved);

    await context.close();
    context = null;

    // Reopen the same profile: a cold browser start, same on-disk IndexedDB.
    context = await chromium.launchPersistentContext(userDataDir, {});
    const page2 = await context.newPage();
    await page2.goto(`${baseUrl}/browser/index.html`);
    await page2.waitForFunction(() => (window as any).__gateDReady === true);

    const reopened = await page2.evaluate(async (id) => {
      const { deviceId } = await (window as any).__gateD.init();
      const loaded = await (window as any).__gateD.load(id);
      const ids = await (window as any).__gateD.listProjectIds();
      return { deviceId, loaded, ids };
    }, projectId);

    expect(reopened.loaded, 'project restored after browser restart').toEqual(saved);
    expect(reopened.deviceId, 'deviceId is stable across browser restarts').toBe(firstDeviceId);
    expect(reopened.ids).toContain(projectId);

    console.log(
      `Gate D restart: restored rev ${reopened.loaded.localRevision} with stable deviceId ` +
        `${reopened.deviceId}`,
    );
  } finally {
    if (context) await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
