/**
 * Supplemental fast tests of the IndexedDB store on fake-indexeddb. The acceptance evidence
 * is the real-browser suite (app/e2e), including the full browser restart.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createProject, stampRevision } from '@tbi-lab/domain';
import { DB_NAME, ProjectStore } from '../src/persistence/store.js';
import { storageName } from '../src/deployment.js';

const clockAt = (iso: string) => ({ now: () => new Date(iso) });

describe('ProjectStore', () => {
  it('round-trips a document exactly and maintains the recent list', async () => {
    const factory = new IDBFactory();
    const store = await ProjectStore.open(factory);
    const a = createProject({
      projectId: 'prj_a',
      deviceId: 'd',
      name: 'אלפא',
      appVersion: '0',
      clock: clockAt('2026-01-01T00:00:00Z'),
    });
    const b = createProject({
      projectId: 'prj_b',
      deviceId: 'd',
      name: 'Beta',
      appVersion: '0',
      clock: clockAt('2026-01-02T00:00:00Z'),
    });
    await store.save(a);
    await store.save(b);
    expect(await store.load('prj_a')).toEqual(a);
    expect((await store.list()).map((p) => p.name)).toEqual(['Beta', 'אלפא']);

    const a2 = stampRevision({ ...a, name: 'אלפא 2' }, 'd', clockAt('2026-01-03T00:00:00Z'));
    await store.save(a2);
    expect((await store.list()).map((p) => [p.projectId, p.name])).toEqual([
      ['prj_a', 'אלפא 2'],
      ['prj_b', 'Beta'],
    ]);
    store.close();

    // A second connection (a reload) sees the same data.
    const again = await ProjectStore.open(factory);
    expect(await again.load('prj_a')).toEqual(a2);
    expect(await again.load('prj_missing')).toBeUndefined();
  });

  it('creates the device id once and reuses it', async () => {
    const factory = new IDBFactory();
    const s1 = await ProjectStore.open(factory);
    const id = await s1.getOrCreateDeviceId(() => 'dev_1');
    s1.close();
    const s2 = await ProjectStore.open(factory);
    expect(await s2.getOrCreateDeviceId(() => 'dev_2')).toBe(id);
  });

  it('a namespaced store (a preview on the same origin) shares nothing with the default one', async () => {
    const factory = new IDBFactory();
    const regular = await ProjectStore.open(factory);
    const preview = await ProjectStore.open(factory, storageName(DB_NAME, 's9-preview'));
    const doc = createProject({
      projectId: 'prj_p',
      deviceId: 'd',
      name: 'Preview only',
      appVersion: '0',
      clock: clockAt('2026-01-01T00:00:00Z'),
    });
    await preview.save(doc);
    expect((await preview.list()).map((p) => p.projectId)).toEqual(['prj_p']);
    expect(await regular.list()).toEqual([]);
    expect((await factory.databases()).map((d) => d.name).sort()).toEqual([
      's9-preview/tbi-lab',
      'tbi-lab',
    ]);
  });
});
