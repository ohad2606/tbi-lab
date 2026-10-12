/**
 * Local project store on IndexedDB.
 *
 * Promoted from experiments/gate-d-persistence/src/store.ts (proven across a real full-browser
 * restart), extended with a project index for the recent list and atomic document + index
 * writes. Documents are stored exactly as produced by the domain layer; opening them goes
 * through the domain's version check and migration registry (see state/app.ts).
 */

import type { ProjectDocument } from '@tbi-lab/domain';

export const DB_NAME = 'tbi-lab';
export const DB_VERSION = 1;
const PROJECTS = 'projects';
const INDEX = 'projectIndex';
const META = 'meta';

/** What the recent-projects list needs, without loading whole documents. */
export interface ProjectIndexEntry {
  projectId: string;
  /** User-authored, verbatim. */
  name: string;
  updatedAt: string;
  schemaVersion: number;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function openDatabase(
  factory: IDBFactory = indexedDB,
  name: string = DB_NAME,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECTS))
        db.createObjectStore(PROJECTS, { keyPath: 'projectId' });
      if (!db.objectStoreNames.contains(INDEX))
        db.createObjectStore(INDEX, { keyPath: 'projectId' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** What identifies one stored version of a project (Sprint 13 Task D: multi-tab safety). */
export interface StoredVersion {
  localRevision: number;
  updatedAt: string;
}
export const versionOf = (doc: Pick<ProjectDocument, 'revision'>): StoredVersion => ({
  localRevision: doc.revision.localRevision,
  updatedAt: doc.revision.updatedAt,
});

export interface ProjectStorage {
  /**
   * Write a project. With `expected` (Sprint 13 Task D), only if the stored project is still
   * exactly that version: if another tab or window changed or deleted it meanwhile, nothing is
   * written and `ProjectConflictError` is thrown, never a silent overwrite or resurrection.
   */
  save(doc: ProjectDocument, expected?: StoredVersion): Promise<void>;
  /**
   * Insert a NEW project: fails with `ProjectExistsError` if the id is already stored, so an
   * import or duplicate can never overwrite an existing project, even under a race.
   */
  add(doc: ProjectDocument): Promise<void>;
  load(projectId: string): Promise<unknown>;
  /** Remove one project (document and index entry together). Other projects are untouched. */
  delete(projectId: string): Promise<void>;
  list(): Promise<ProjectIndexEntry[]>;
  getOrCreateDeviceId(generate: () => string): Promise<string>;
}

/** `add` found a project with the same id. Nothing was written. */
export class ProjectConflictError extends Error {
  constructor(
    readonly projectId: string,
    /** `changed`: a different version is stored; `deleted`: the project is gone. */
    readonly kind: 'changed' | 'deleted',
  ) {
    super(`project ${kind} elsewhere`);
    this.name = 'ProjectConflictError';
  }
}

export class ProjectExistsError extends Error {
  constructor(readonly projectId: string) {
    super('project exists');
    this.name = 'ProjectExistsError';
  }
}

/** The error name browsers use when the storage quota is exhausted. */
export function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

const indexEntry = (doc: ProjectDocument): ProjectIndexEntry => ({
  projectId: doc.projectId,
  name: doc.name,
  updatedAt: doc.revision.updatedAt,
  schemaVersion: doc.schemaVersion,
});

export class ProjectStore implements ProjectStorage {
  constructor(private readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB, name?: string): Promise<ProjectStore> {
    return new ProjectStore(await openDatabase(factory, name));
  }

  /**
   * Document and index entry are written in one transaction: both land or neither does. With
   * `expected`, the version check happens in the same transaction (no window for another tab).
   */
  async save(doc: ProjectDocument, expected?: StoredVersion): Promise<void> {
    const tx = this.db.transaction([PROJECTS, INDEX], 'readwrite');
    const done = transactionDone(tx);
    let conflict: ProjectConflictError | null = null;
    const write = () => {
      tx.objectStore(PROJECTS).put(doc);
      tx.objectStore(INDEX).put(indexEntry(doc));
    };
    if (!expected) write();
    else {
      const get = tx.objectStore(PROJECTS).get(doc.projectId);
      get.onsuccess = () => {
        const stored = get.result as ProjectDocument | undefined;
        if (!stored) conflict = new ProjectConflictError(doc.projectId, 'deleted');
        else if (
          stored.revision?.localRevision !== expected.localRevision ||
          stored.revision?.updatedAt !== expected.updatedAt
        )
          conflict = new ProjectConflictError(doc.projectId, 'changed');
        if (conflict) tx.abort();
        else write();
      };
    }
    try {
      await done;
    } catch (e) {
      throw conflict ?? e;
    }
  }

  async add(doc: ProjectDocument): Promise<void> {
    const tx = this.db.transaction([PROJECTS, INDEX], 'readwrite');
    // `add` (not `put`) aborts the whole transaction with ConstraintError if the key exists.
    const request = tx.objectStore(PROJECTS).add(doc);
    request.onerror = (e) => e.preventDefault(); // reported through the transaction below
    tx.objectStore(INDEX).put(indexEntry(doc));
    try {
      await transactionDone(tx);
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'ConstraintError') {
        throw new ProjectExistsError(doc.projectId);
      }
      throw e;
    }
  }

  async delete(projectId: string): Promise<void> {
    const tx = this.db.transaction([PROJECTS, INDEX], 'readwrite');
    tx.objectStore(PROJECTS).delete(projectId);
    tx.objectStore(INDEX).delete(projectId);
    await transactionDone(tx);
  }

  /** Raw stored value: it has not been validated or migrated yet. */
  async load(projectId: string): Promise<unknown> {
    const tx = this.db.transaction(PROJECTS, 'readonly');
    const result = await promisify(tx.objectStore(PROJECTS).get(projectId));
    await transactionDone(tx);
    return result;
  }

  /** Most recently changed first. */
  async list(): Promise<ProjectIndexEntry[]> {
    const tx = this.db.transaction(INDEX, 'readonly');
    const all = (await promisify(tx.objectStore(INDEX).getAll())) as ProjectIndexEntry[];
    await transactionDone(tx);
    return all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  /** A stable identifier for this browser profile, created once and then reused. */
  async getOrCreateDeviceId(generate: () => string): Promise<string> {
    const readTx = this.db.transaction(META, 'readonly');
    const existing = (await promisify(readTx.objectStore(META).get('deviceId'))) as
      string | undefined;
    await transactionDone(readTx);
    if (existing) return existing;
    const created = generate();
    const writeTx = this.db.transaction(META, 'readwrite');
    writeTx.objectStore(META).put(created, 'deviceId');
    await transactionDone(writeTx);
    return created;
  }

  close(): void {
    this.db.close();
  }
}
