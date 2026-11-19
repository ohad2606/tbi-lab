import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import { findExample } from '../src/examples/catalog.js';
import { FIRST_RUN_EXAMPLE, shouldAutoShowFirstRun } from '../src/ui/firstRun.js';
import { AppStore, type Preferences } from '../src/state/app.js';
import { ProjectStore } from '../src/persistence/store.js';
import { IDBFactory } from 'fake-indexeddb';

const base = { screen: 'home', projectCount: 0, seen: false, skippedThisSession: false };

describe('first-run decision', () => {
  it('shows for a brand-new device on the Projects screen', () => {
    expect(shouldAutoShowFirstRun(base)).toBe(true);
  });
  it.each([
    ['already seen', { seen: true }],
    ['skipped this session', { skippedThisSession: true }],
    ['has projects', { projectCount: 2 }],
    ['in the editor', { screen: 'editor' }],
    ['still loading', { screen: 'loading' }],
  ])('does not show: %s', (_n, patch) => {
    expect(shouldAutoShowFirstRun({ ...base, ...patch })).toBe(false);
  });
  it('opens a real example', () => {
    expect(findExample(FIRST_RUN_EXAMPLE)).toBeDefined();
  });
  it('has its strings in both languages', () => {
    for (const k of Object.keys(en).filter((k) => k.startsWith('firstRun.'))) {
      expect(he[k as keyof typeof he], k).toBeTruthy();
    }
  });
});

describe('first-run flag in the store', () => {
  it('is remembered per device and can be cleared', async () => {
    const data: Record<string, string> = {};
    const prefs: Preferences = { get: (k) => data[k] ?? null, set: (k, v) => void (data[k] = v) };
    const app = new AppStore({
      storage: await ProjectStore.open(new IDBFactory()),
      prefs,
      languages: ['en-US'],
      newId: () => 'x',
    });
    expect(app.firstRunSeen()).toBe(false);
    app.setFirstRunSeen(true);
    expect(app.firstRunSeen()).toBe(true);
    expect(Object.values(data)).toContain('seen');
    app.setFirstRunSeen(false);
    expect(app.firstRunSeen()).toBe(false);
  });
});
