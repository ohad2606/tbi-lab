import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { requestPersistentStorage } from '../src/persistence/persist.js';
import { DatabaseBlockedError, ProjectStore, openDatabase } from '../src/persistence/store.js';

describe('requestPersistentStorage', () => {
  it('is unsupported without the API', async () => {
    expect(await requestPersistentStorage(undefined)).toBe('unsupported');
    expect(await requestPersistentStorage({})).toBe('unsupported');
  });
  it('does not re-ask when already persisted', async () => {
    const persist = vi.fn(async () => true);
    expect(await requestPersistentStorage({ persisted: async () => true, persist })).toBe(
      'granted',
    );
    expect(persist).not.toHaveBeenCalled();
  });
  it('asks and reports granted or denied', async () => {
    expect(
      await requestPersistentStorage({ persisted: async () => false, persist: async () => true }),
    ).toBe('granted');
    expect(
      await requestPersistentStorage({ persisted: async () => false, persist: async () => false }),
    ).toBe('denied');
  });
  it('never throws', async () => {
    const boom = async () => {
      throw new Error('x');
    };
    expect(await requestPersistentStorage({ persisted: boom, persist: boom })).toBe('denied');
  });
});

describe('database lifecycle hooks', () => {
  it('closes and notifies on versionchange', async () => {
    const factory = new IDBFactory();
    const onVersionChange = vi.fn();
    const db = await openDatabase(factory, 'vc', { onVersionChange });
    const close = vi.spyOn(db, 'close');
    db.onversionchange?.(new Event('versionchange') as IDBVersionChangeEvent);
    expect(close).toHaveBeenCalled();
    expect(onVersionChange).toHaveBeenCalledTimes(1);
  });
  it('a real delete request from another connection triggers the hook', async () => {
    const factory = new IDBFactory();
    const onVersionChange = vi.fn();
    await ProjectStore.open(factory, 'vc2', { onVersionChange });
    await new Promise<void>((res) => {
      const r = factory.deleteDatabase('vc2');
      r.onsuccess = () => res();
      r.onerror = () => res();
    });
    expect(onVersionChange).toHaveBeenCalledTimes(1);
  });
  it('rejects with DatabaseBlockedError when blocked instead of hanging', async () => {
    const request: Record<string, unknown> = {};
    const factory = { open: () => request } as unknown as IDBFactory;
    const p = openDatabase(factory, 'b');
    (request.onblocked as () => void)();
    await expect(p).rejects.toBeInstanceOf(DatabaseBlockedError);
    const close = vi.fn();
    request.result = { close };
    (request.onsuccess as () => void)();
    expect(close).toHaveBeenCalled();
  });
});
