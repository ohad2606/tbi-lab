import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import { FIRST_RUN_EXAMPLE } from '../src/ui/firstRun.js';
import { shouldShowNextStep } from '../src/ui/nextStep.js';
import { AppStore, type Preferences } from '../src/state/app.js';
import { ProjectStore } from '../src/persistence/store.js';

const base = {
  screen: 'editor',
  exampleId: FIRST_RUN_EXAMPLE as string | null,
  sameProject: true,
  simStatus: 'running',
  solved: true,
  mcu: false,
  seen: false,
};

describe('next-step card decision', () => {
  it('shows after the first successful run of the first-run example', () => {
    expect(shouldShowNextStep(base)).toBe(true);
  });
  it.each([
    ['already seen', { seen: true }],
    ['not the editor', { screen: 'home' }],
    ['another example', { exampleId: 'led-colours' }],
    ['a project not from an example', { exampleId: null }],
    ['a different project', { sameProject: false }],
    ['not running yet', { simStatus: 'starting' }],
    ['stopped', { simStatus: 'stopped' }],
    ['failed', { simStatus: 'failed' }],
    ['no live values', { solved: false }],
    ['ESP32 / build flow', { mcu: true }],
  ])('does not show: %s', (_n, patch) => {
    expect(shouldShowNextStep({ ...base, ...patch })).toBe(false);
  });
  it('has its strings in both languages', () => {
    const keys = Object.keys(en).filter((k) => k.startsWith('nextStep.'));
    expect(keys.length).toBeGreaterThan(4);
    for (const k of keys) expect(he[k as keyof typeof he], k).toBeTruthy();
  });
});

describe('next-step flag in the store', () => {
  it('is remembered per device, separately from the first-run flag', async () => {
    const data: Record<string, string> = {};
    const prefs: Preferences = { get: (k) => data[k] ?? null, set: (k, v) => void (data[k] = v) };
    const app = new AppStore({
      storage: await ProjectStore.open(new IDBFactory()),
      prefs,
      languages: ['en-US'],
      newId: () => 'x',
    });
    expect(app.nextStepSeen()).toBe(false);
    app.setNextStepSeen(true);
    expect(app.nextStepSeen()).toBe(true);
    expect(app.firstRunSeen()).toBe(false);
    expect(Object.keys(data).some((k) => k.endsWith('nextStep.v1'))).toBe(true);
  });
});
