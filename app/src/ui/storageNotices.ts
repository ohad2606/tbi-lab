/**
 * K11 slice 2: logic behind two small storage notices (the components are thin).
 *  - "This tab is out of date": another tab upgraded the database and this tab's connection is
 *    closed (event `tbi:storage-versionchange`, dispatched from main.tsx). The event can fire
 *    before the UI mounts, so it is latched here.
 *  - Export reminder: shown at most once per browser session, after the user edited, when the
 *    browser has not promised to keep our storage (persist status other than 'granted').
 */
import type { PersistResult } from '../persistence/persist.js';

export const VERSION_CHANGE_EVENT = 'tbi:storage-versionchange';
export const REMINDER_SEEN_KEY = 'tbi-lab.exportReminder.seen';

let versionChanged = false;
const versionListeners = new Set<() => void>();

/** Latch the event for the lifetime of the page. Call once, before storage is opened. */
export function installVersionChangeLatch(target: Pick<Window, 'addEventListener'>): void {
  target.addEventListener(VERSION_CHANGE_EVENT, () => {
    versionChanged = true;
    for (const fn of [...versionListeners]) fn();
  });
}
export const isVersionChanged = (): boolean => versionChanged;
export function onVersionChanged(fn: () => void): () => void {
  versionListeners.add(fn);
  return () => void versionListeners.delete(fn);
}
export function resetVersionChangeLatch(): void {
  versionChanged = false;
  versionListeners.clear();
}

/** Reload this tab; the reload function is injectable for tests. */
export function reloadTab(reload: () => void = () => location.reload()): void {
  reload();
}

export interface ReminderInput {
  persist: PersistResult | null;
  edited: boolean;
  seenThisSession: boolean;
  /** Storage could not be opened or this tab lost its connection. */
  storageUnavailable?: boolean;
}

/** Pure rule. Unknown persist status (still asking) never shows it. */
export function shouldShowExportReminder(i: ReminderInput): boolean {
  if (!i.edited || i.seenThisSession) return false;
  if (i.storageUnavailable) return true;
  return i.persist !== null && i.persist !== 'granted';
}

/** In-memory fallback so a dismissed reminder stays dismissed when sessionStorage is unavailable. */
let seenInMemory = false;
export function resetReminderMemory(): void {
  seenInMemory = false;
}
export function reminderSeen(storage: Pick<Storage, 'getItem'> | null): boolean {
  if (seenInMemory) return true;
  try {
    return storage?.getItem(REMINDER_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}
export function markReminderSeen(storage: Pick<Storage, 'setItem'> | null): void {
  seenInMemory = true;
  try {
    storage?.setItem(REMINDER_SEEN_KEY, '1');
  } catch {
    /* per-session convenience only */
  }
}
