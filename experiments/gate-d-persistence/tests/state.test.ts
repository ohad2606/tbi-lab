/**
 * Supplemental fast tests for Gate D.
 *
 * These are NOT the Gate D acceptance evidence. `fake-indexeddb` is an in-memory
 * reimplementation, so it cannot prove that data survives a real browser reload. The
 * acceptance proof is `browser/persistence.spec.ts` running in real Chromium. These tests
 * exist to pin down semantics quickly: revision bookkeeping, debouncing, and round trips.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { applyLocalChange, createProject, SCHEMA_VERSION } from '../src/projectState.js';
import { ProjectStore } from '../src/store.js';
import { Autosave } from '../src/autosave.js';

const fixedClock = { now: () => new Date('2026-09-20T12:00:00.000Z') };

let store: ProjectStore;

beforeEach(async () => {
  // A fresh in-memory IndexedDB per test.
  store = await ProjectStore.open(new IDBFactory());
});

describe('project state', () => {
  it('creates a project carrying every sync-ready field', () => {
    const p = createProject('p1', 'device-1', 'Bench', fixedClock);
    expect(p.projectId).toBe('p1');
    expect(p.schemaVersion).toBe(SCHEMA_VERSION);
    expect(p.localRevision).toBe(1);
    expect(p.cloudRevision).toBeNull();
    expect(p.baseRevision).toBeNull();
    expect(p.deviceId).toBe('device-1');
    expect(p.updatedAt).toBe('2026-09-20T12:00:00.000Z');
    expect(p.components).toEqual([]);
    expect(p.connections).toEqual([]);
    expect(p.psu).toEqual({ setpointV: 5, currentLimitA: 0.1, enabled: false });
  });

  it('advances localRevision on every local change and leaves cloud fields alone', () => {
    const a = createProject('p1', 'device-1', 'Bench', fixedClock);
    const b = applyLocalChange(a, (d) => {
      d.name = 'Renamed';
    }, fixedClock);
    const c = applyLocalChange(b, (d) => {
      d.psu.setpointV = 3.3;
    }, fixedClock);

    expect(b.localRevision).toBe(2);
    expect(c.localRevision).toBe(3);
    expect(c.cloudRevision).toBeNull();
    expect(c.baseRevision).toBeNull();
    // No cloud sync exists, so nothing may claim otherwise.
    expect(c.psu.setpointV).toBe(3.3);
  });

  it('does not mutate the previous state object', () => {
    const a = createProject('p1', 'device-1', 'Bench', fixedClock);
    const b = applyLocalChange(a, (d) => {
      d.components.push({ id: 'R1', type: 'resistor', value: 220, position: { x: 1, y: 2 } });
    }, fixedClock);
    expect(a.components).toHaveLength(0);
    expect(b.components).toHaveLength(1);
  });
});

describe('store round trip', () => {
  it('returns a deeply equal project', async () => {
    const p = applyLocalChange(
      createProject('p1', 'device-1', 'Bench', fixedClock),
      (d) => {
        d.components = [{ id: 'R1', type: 'resistor', value: 220, position: { x: 1, y: 2 } }];
        d.connections = [{ id: 'W1', from: 'R1.a', to: 'PSU1.+', net: 'vcc' }];
        d.psu = { setpointV: 3.3, currentLimitA: 0.25, enabled: true };
      },
      fixedClock,
    );
    await store.save(p);
    expect(await store.load('p1')).toEqual(p);
  });

  it('returns undefined for an unknown project rather than throwing', async () => {
    expect(await store.load('missing')).toBeUndefined();
  });

  it('creates a device id once and then reuses it', async () => {
    let calls = 0;
    const generate = (): string => `device-${++calls}`;
    const first = await store.getOrCreateDeviceId(generate);
    const second = await store.getOrCreateDeviceId(generate);
    expect(first).toBe('device-1');
    expect(second).toBe('device-1');
    expect(calls, 'generator called only once').toBe(1);
  });
});

describe('autosave', () => {
  it('coalesces a burst of edits into a single write', async () => {
    const autosave = new Autosave(store, { debounceMs: 5 });
    let state = createProject('p1', 'device-1', 'Bench', fixedClock);
    for (let i = 0; i < 10; i++) {
      state = applyLocalChange(state, (d) => {
        d.name = `edit-${i}`;
      }, fixedClock);
      autosave.queue(state);
    }
    await autosave.flush();
    expect(autosave.writeCount, 'ten edits, one physical write').toBe(1);
    expect((await store.load('p1'))!.name).toBe('edit-9');
  });

  it('persists the latest state, not the first queued one', async () => {
    const autosave = new Autosave(store, { debounceMs: 5 });
    const a = createProject('p1', 'device-1', 'first', fixedClock);
    const b = applyLocalChange(a, (d) => {
      d.name = 'second';
    }, fixedClock);
    autosave.queue(a);
    autosave.queue(b);
    await autosave.flush();
    const loaded = (await store.load('p1'))!;
    expect(loaded.name).toBe('second');
    expect(loaded.localRevision).toBe(2);
  });

  it('flushing with nothing queued is a no-op', async () => {
    const autosave = new Autosave(store, { debounceMs: 5 });
    await autosave.flush();
    expect(autosave.writeCount).toBe(0);
  });
});
