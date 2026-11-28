/** BETA-G3 follow-ups: stale segment pick, removal messages, a refusal announced once. */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { addComponent, type Selection } from '@tbi-lab/domain';
import { getLocale, translate } from '../src/i18n/i18n.js';
import { ProjectStore } from '../src/persistence/store.js';
import { AppStore } from '../src/state/app.js';
import { removalMessage } from '../src/ui/removal.js';
import { pickedSegment, routeKey } from '../src/ui/segments.js';

const p = (x: number, y: number) => ({ x, y });
const route = [p(0, 0), p(40, 0), p(40, 60), p(100, 60), p(100, 80)];

describe('pickedSegment', () => {
  const pick = { wire: 'W1', index: 2, route: routeKey(route) };
  it('keeps the pick on the route it was made on', () => {
    expect(pickedSegment(pick, 'W1', route)).toBe(2);
  });
  it('drops it when the route changed, even if the index still exists', () => {
    const moved = [p(0, 0), p(60, 0), p(60, 60), p(100, 60), p(100, 80)];
    expect(pickedSegment(pick, 'W1', moved)).toBeNull();
    expect(pickedSegment(pick, 'W1', route.slice(0, 3))).toBeNull();
  });
  it('is valid again when undo and redo bring the same route back', () => {
    expect(pickedSegment(pick, 'W1', [...route])).toBe(2);
  });
  it('starts on the middle segment for a wire without a pick', () => {
    expect(pickedSegment(null, 'W1', route)).toBe(1);
    expect(pickedSegment(pick, 'W2', route)).toBe(1);
  });
});

describe('removalMessage', () => {
  const sel = (s: Partial<Selection>): Selection => ({
    components: [],
    wires: [],
    junctions: [],
    ...s,
  });
  it('names a single part or junction', () => {
    expect(removalMessage(sel({ components: ['R1'] })).key).toBe('inspector.partRemoved');
    expect(removalMessage(sel({ junctions: ['J1'] })).key).toBe('junctions.removed');
  });
  it.each(['en', 'he'] as const)('counts a multi-selection (%s)', (lang) => {
    const m = removalMessage(sel({ components: ['R1', 'R2'], wires: ['W1'] }));
    expect(m.params).toEqual({ count: 3 });
    expect(translate(getLocale(lang), m.key, m.params)).toMatch(
      lang === 'en' ? /^3 selected items removed$/ : /^3 פריטים שנבחרו הוסרו$/,
    );
  });
});

describe('a refused edit the caller announces itself', () => {
  it('marks only that notice quiet', async () => {
    const app = new AppStore({
      storage: await ProjectStore.open(new IDBFactory()),
      prefs: { get: () => null, set: () => {} },
      languages: ['en-US'],
      newId: () => 'id1',
      autosaveDebounceMs: 1,
    });
    await app.init();
    await app.newProject('Q');
    const refused = addComponent(app.state.doc!, 'component.resistor', { x: 0, y: 0 });
    if (!refused.ok) throw new Error('setup');
    expect(app.apply(refused)).toBe(true);
    const bad = { ok: false, error: 'unknown_component' } as const;
    expect(app.apply(bad)).toBe(false);
    expect(app.state.notice!.quiet).toBeUndefined();
    expect(app.apply(bad, undefined, { quiet: true })).toBe(false);
    expect(app.state.notice!.quiet).toBe(true);
  });
});
