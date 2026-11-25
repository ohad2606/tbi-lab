/** Ask the browser to keep this origin's storage (projects) from being evicted under pressure. */

export type PersistResult = 'granted' | 'denied' | 'unsupported';

export interface StorageLike {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

let lastResult: PersistResult | null = null;
const listeners = new Set<(r: PersistResult) => void>();

/** The last answer from requestPersistentStorage, or null while it is still unknown. */
export const persistStatus = (): PersistResult | null => lastResult;

/** Be told when the answer arrives; returns the unsubscribe. */
export function onPersistStatus(fn: (r: PersistResult) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Test seam: forget the recorded answer. */
export function resetPersistStatus(): void {
  lastResult = null;
}

/** Never throws; safe to call once at startup without awaiting. */
async function askPersistentStorage(
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

/** Ask once at startup (never throws) and record the answer for the export reminder. */
export async function requestPersistentStorage(
  storage?: StorageLike | undefined,
): Promise<PersistResult> {
  const r = await (storage === undefined ? askPersistentStorage() : askPersistentStorage(storage));
  lastResult = r;
  for (const fn of [...listeners]) fn(r);
  return r;
}
