/** TBI-014: the first-run guide's starter path and its persisted dismissal. */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../src/examples/catalog.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import { ProjectStore } from '../src/persistence/store.js';
import { AppStore, PREF_ONBOARDING, type Preferences } from '../src/state/app.js';

const keys = [
  'onboarding.quick.heading',
  'onboarding.quick.body',
  'onboarding.quick.open',
] as const;

function prefs(): Preferences & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, get: (k) => data[k] ?? null, set: (k, v) => void (data[k] = v) };
}

describe('first five minutes', () => {
  it('has the starter strings in both languages, the part name kept as technical text', () => {
    for (const k of keys) {
      expect(en[k]).toBeTruthy();
      expect(he[k]).toBeTruthy();
    }
    expect(en['onboarding.quick.body']).toContain('R1');
    expect(he['onboarding.quick.body']).toContain('⁦R1⁩');
  });

  it('points to a local example that exists (no ESP32 session)', () => {
    const ex = EXAMPLES.find((e) => e.id === 'led-current');
    expect(ex).toBeDefined();
    expect(ex!.parts).toContain('component.led');
    expect(ex!.parts).toContain('component.resistor');
  });

  it('opens the starter example and remembers a dismissal per device', async () => {
    const p = prefs();
    const app = new AppStore({
      storage: await ProjectStore.open(new IDBFactory()),
      prefs: p,
      languages: ['en-US'],
      newId: (
        (n) => () =>
          `id${++n}`
      )(0),
      autosaveDebounceMs: 1,
    });
    await app.init();
    expect(app.onboardingDismissed()).toBe(false);
    app.setOnboardingDismissed(true);
    expect(p.data[PREF_ONBOARDING]).toBe('dismissed');
    expect(app.onboardingDismissed()).toBe(true);
    app.setOnboardingDismissed(false);
    expect(app.onboardingDismissed()).toBe(false);
    expect(await app.openExample('led-current')).toBe(true);
    expect(app.state.screen).toBe('editor');
  });
});
