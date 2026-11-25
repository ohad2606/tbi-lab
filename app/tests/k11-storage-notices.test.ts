import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import {
  onPersistStatus,
  persistStatus,
  requestPersistentStorage,
  resetPersistStatus,
} from '../src/persistence/persist.js';
import {
  installVersionChangeLatch,
  isVersionChanged,
  markReminderSeen,
  onVersionChanged,
  reloadTab,
  reminderSeen,
  resetReminderMemory,
  resetVersionChangeLatch,
  shouldShowExportReminder,
  VERSION_CHANGE_EVENT,
} from '../src/ui/storageNotices.js';

afterEach(() => {
  resetVersionChangeLatch();
  resetPersistStatus();
  resetReminderMemory();
});

describe('version-change latch', () => {
  it('latches the event and notifies listeners', () => {
    const target = new EventTarget();
    installVersionChangeLatch(target as unknown as Window);
    const seen = vi.fn();
    onVersionChanged(seen);
    expect(isVersionChanged()).toBe(false);
    target.dispatchEvent(new Event(VERSION_CHANGE_EVENT));
    expect(isVersionChanged()).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
  });
  it('reload uses the injected function', () => {
    const reload = vi.fn();
    reloadTab(reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('export reminder rule', () => {
  const base = { persist: 'denied' as const, edited: true, seenThisSession: false };
  it('shows after edits when persistence was not granted', () => {
    expect(shouldShowExportReminder(base)).toBe(true);
    expect(shouldShowExportReminder({ ...base, persist: 'unsupported' })).toBe(true);
  });
  it('not when granted, unknown, unedited or already seen', () => {
    expect(shouldShowExportReminder({ ...base, persist: 'granted' })).toBe(false);
    expect(shouldShowExportReminder({ ...base, persist: null })).toBe(false);
    expect(shouldShowExportReminder({ ...base, edited: false })).toBe(false);
    expect(shouldShowExportReminder({ ...base, seenThisSession: true })).toBe(false);
  });
  it('shows when storage is unavailable, even if persist is granted', () => {
    expect(
      shouldShowExportReminder({ ...base, persist: 'granted', storageUnavailable: true }),
    ).toBe(true);
  });
  it('session flag round-trips and tolerates broken storage', () => {
    const d: Record<string, string> = {};
    const s = {
      getItem: (k: string) => d[k] ?? null,
      setItem: (k: string, v: string) => void (d[k] = v),
    };
    expect(reminderSeen(s)).toBe(false);
    markReminderSeen(s);
    expect(reminderSeen(s)).toBe(true);
    const bad = {
      getItem: () => {
        throw new Error('x');
      },
      setItem: () => {
        throw new Error('x');
      },
    };
    resetReminderMemory();
    expect(reminderSeen(bad)).toBe(false);
    expect(() => markReminderSeen(bad)).not.toThrow();
    resetReminderMemory();
    expect(reminderSeen(null)).toBe(false);
  });
});

describe('persist status recording', () => {
  it('records and announces the answer', async () => {
    const seen = vi.fn();
    onPersistStatus(seen);
    expect(persistStatus()).toBeNull();
    await requestPersistentStorage({ persist: async () => false });
    expect(persistStatus()).toBe('denied');
    expect(seen).toHaveBeenCalledWith('denied');
  });
});

describe('messages', () => {
  it('exist in HE and EN', () => {
    for (const k of [
      'storage.tabOutdated',
      'storage.reload',
      'storage.exportReminder',
      'storage.exportAction',
      'storage.exportDismiss',
    ] as const) {
      expect(en[k].length).toBeGreaterThan(3);
      expect(he[k].length).toBeGreaterThan(3);
      expect(he[k]).not.toBe(en[k]);
    }
  });
});

describe('reminder seen flag without sessionStorage', () => {
  afterEach(() => resetReminderMemory());
  it('stays seen in memory when storage is null or throws', () => {
    const bad = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    resetReminderMemory();
    expect(reminderSeen(null)).toBe(false);
    markReminderSeen(null);
    expect(reminderSeen(null)).toBe(true);
    resetReminderMemory();
    markReminderSeen(bad);
    expect(reminderSeen(bad)).toBe(true);
  });
});
