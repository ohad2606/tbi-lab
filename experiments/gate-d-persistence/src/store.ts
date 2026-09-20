/**
 * Minimal IndexedDB wrapper for the Gate D proof.
 *
 * Not a product repository abstraction: no migrations framework, no caching layer, no
 * query API. Two object stores and enough promise plumbing to make IndexedDB testable.
 */

import type { ProjectState } from './projectState.js';

export const DB_NAME = 'tbi-lab-gate-d';
export const DB_VERSION = 1;
export const PROJECT_STORE = 'projects';
export const META_STORE = 'meta';

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function openDatabase(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        db.createObjectStore(PROJECT_STORE, { keyPath: 'projectId' });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export class ProjectStore {
  constructor(private readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB): Promise<ProjectStore> {
    return new ProjectStore(await openDatabase(factory));
  }

  async save(state: ProjectState): Promise<void> {
    const tx = this.db.transaction(PROJECT_STORE, 'readwrite');
    tx.objectStore(PROJECT_STORE).put(state);
    await transactionDone(tx);
  }

  async load(projectId: string): Promise<ProjectState | undefined> {
    const tx = this.db.transaction(PROJECT_STORE, 'readonly');
    const result = await promisify<ProjectState | undefined>(
      tx.objectStore(PROJECT_STORE).get(projectId) as IDBRequest<ProjectState | undefined>,
    );
    await transactionDone(tx);
    return result;
  }

  async listProjectIds(): Promise<string[]> {
    const tx = this.db.transaction(PROJECT_STORE, 'readonly');
    const keys = await promisify(tx.objectStore(PROJECT_STORE).getAllKeys());
    await transactionDone(tx);
    return keys.map(String);
  }

  /**
   * A stable identifier for this browser profile, created once and then reused. It must
   * survive reloads and browser restarts, which is exactly what Gate D tests.
   */
  async getOrCreateDeviceId(generate: () => string): Promise<string> {
    const readTx = this.db.transaction(META_STORE, 'readonly');
    const existing = await promisify<string | undefined>(
      readTx.objectStore(META_STORE).get('deviceId') as IDBRequest<string | undefined>,
    );
    await transactionDone(readTx);
    if (existing) return existing;

    const created = generate();
    const writeTx = this.db.transaction(META_STORE, 'readwrite');
    writeTx.objectStore(META_STORE).put(created, 'deviceId');
    await transactionDone(writeTx);
    return created;
  }

  close(): void {
    this.db.close();
  }
}
