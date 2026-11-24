/** Ask the browser to keep this origin's storage (projects) from being evicted under pressure. */

export type PersistResult = 'granted' | 'denied' | 'unsupported';

export interface StorageLike {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

/** Never throws; safe to call once at startup without awaiting. */
export async function requestPersistentStorage(
  storage: StorageLike | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.storage,
): Promise<PersistResult> {
  try {
    if (!storage || typeof storage.persist !== 'function') return 'unsupported';
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return 'granted';
    return (await storage.persist()) ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}
