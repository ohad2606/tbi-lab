/** BETA-G3: the rules for building a selection of several items from the keyboard. */
import { createProject, emptySelection, addComponent } from '@tbi-lab/domain';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import {
  multiSelectKey,
  selectEverything,
  selectionCountMessage,
  toggleFromList,
  toggleItem,
} from '../src/ui/multiSelect.js';
import { getLocale, isolateLtr, translate, type MessageKey } from '../src/i18n/i18n.js';

const key = (k: string, code: string, mods: Partial<Record<string, boolean>> = {}) => ({
  key: k,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('toggleItem', () => {
  const one = { ...emptySelection(), components: ['R1'] };

  it('adds a second item and takes it out again, leaving the others', () => {
    const two = toggleItem(one, 'components', 'R2');
    expect(two.components).toEqual(['R1', 'R2']);
    expect(toggleItem(two, 'components', 'R2')).toEqual(one);
    expect(one.components).toEqual(['R1']);
  });

  it('addOnly never removes (the first Shift+Enter on a focused, already selected part)', () => {
    expect(toggleItem(one, 'components', 'R1', true)).toEqual(one);
    expect(toggleItem(one, 'junctions', 'J1', true).junctions).toEqual(['J1']);
  });
});

describe('selectEverything', () => {
  it('takes every part, wire and junction', () => {
    const base = createProject({
      projectId: 'prj_multi',
      deviceId: 'device-test',
      name: 'multi',
      appVersion: '0.1.0',
      clock: { now: () => new Date('2026-11-28T00:00:00.000Z') },
    });
    const r = addComponent(base, 'component.resistor', { x: 0, y: 0 });
    if (!r.ok) throw new Error('add');
    expect(selectEverything(r.doc)).toEqual({
      components: r.doc.components.map((c) => c.id),
      wires: [],
      junctions: [],
    });
  });
});

describe('selectionCountMessage', () => {
  it('has its own text for none and one, and counts several', () => {
    const of = (n: number) =>
      selectionCountMessage({
        ...emptySelection(),
        components: Array.from({ length: n }, (_, i) => `R${i + 1}`),
      });
    expect(of(0).key).toBe('multi.count.none');
    expect(of(1).key).toBe('multi.count.one');
    expect(of(3)).toEqual({ key: 'inspector.multi', params: { count: 3 } });
    for (const m of [en, he] as Record<string, string>[])
      for (const k of [
        'multi.count.none',
        'multi.count.one',
        'multi.on',
        'multi.off',
        'multi.cleared',
        'multi.tool',
        'canvas.hint.several',
        'multi.offThen',
        'multi.part.selected',
        'multi.part.notSelected',
      ])
        expect(m[k], k).toBeTruthy();
  });
});

describe('multiSelectKey', () => {
  it('Shift+Enter toggles; plain Enter only while several-selection is on', () => {
    expect(multiSelectKey(key('Enter', 'Enter', { shiftKey: true }), false)).toBe('toggle');
    expect(multiSelectKey(key('Enter', 'Enter'), false)).toBeNull();
    expect(multiSelectKey(key('Enter', 'Enter'), true)).toBe('toggle');
  });

  it('Ctrl or Cmd with the physical A key selects all, on any keyboard layout', () => {
    expect(multiSelectKey(key('a', 'KeyA', { ctrlKey: true }), false)).toBe('all');
    expect(multiSelectKey(key('ש', 'KeyA', { metaKey: true }), false)).toBe('all');
  });

  it('Ctrl+A also by the produced letter, wherever the layout puts it', () => {
    expect(multiSelectKey(key('a', 'KeyQ', { ctrlKey: true }), false)).toBe('all');
    expect(multiSelectKey(key('b', 'KeyB', { ctrlKey: true }), false)).toBeNull();
  });

  it('ignores a bare letter, AltGr chords and other chords', () => {
    expect(multiSelectKey(key('a', 'KeyA'), true)).toBeNull();
    expect(multiSelectKey(key('a', 'KeyA', { ctrlKey: true, altKey: true }), true)).toBeNull();
    expect(multiSelectKey(key('A', 'KeyA', { ctrlKey: true, shiftKey: true }), true)).toBeNull();
    expect(multiSelectKey(key('Enter', 'Enter', { ctrlKey: true }), true)).toBeNull();
    expect(multiSelectKey(key(' ', 'Space', { shiftKey: true }), true)).toBeNull();
  });
});

describe('toggleFromList (Wires and Junctions lists while selecting several)', () => {
  const start = { ...emptySelection(), components: ['R1'], wires: ['w1'] };
  const run = (code: 'en' | 'he') => {
    const t = (k: MessageKey, p?: Record<string, string | number>) =>
      translate(getLocale(code), k, p);
    const wire = t('kbwire.list.name', { n: 2 });
    const added = toggleFromList(start, 'wires', 'w2', wire, t);
    const junction = t('junctions.list.name', { id: isolateLtr('J1') });
    const both = toggleFromList(added.next, 'junctions', 'J1', junction, t);
    const removed = toggleFromList(both.next, 'wires', 'w2', wire, t);
    const only = { ...emptySelection(), junctions: ['J1'] };
    const none = toggleFromList(only, 'junctions', 'J1', junction, t);
    return { added, both, removed, none, wire, junction };
  };

  it('adds and removes one item, leaving the rest of the selection', () => {
    const r = run('en');
    expect(r.added).toMatchObject({ added: true, next: { components: ['R1'] } });
    expect(r.both.next).toEqual({ components: ['R1'], wires: ['w1', 'w2'], junctions: ['J1'] });
    expect(r.removed).toMatchObject({ added: false });
    expect(r.removed.next).toEqual({ components: ['R1'], wires: ['w1'], junctions: ['J1'] });
    expect(r.none.next).toEqual(emptySelection());
    expect(start.wires).toEqual(['w1']);
  });

  it('says what changed and the new count (en)', () => {
    const r = run('en');
    expect(r.added.said).toBe('Wire W2 added to the selection. 3 items selected');
    expect(r.both.said).toBe(`${r.junction} added to the selection. 4 items selected`);
    expect(r.removed.said).toBe('Wire W2 removed from the selection. 3 items selected');
    expect(r.none.said).toBe(`${r.junction} removed from the selection. No items selected`);
    expect(r.junction).toContain(isolateLtr('J1'));
  });

  it('says what changed and the new count (he)', () => {
    const r = run('he');
    expect(r.added.said).toBe('חוט 2 נוסף לבחירה. 3 פריטים נבחרו');
    expect(r.removed.said).toBe('חוט 2 הוסר מהבחירה. 3 פריטים נבחרו');
    expect(r.none.said).toBe(`${r.junction} הוסר מהבחירה. לא נבחרו פריטים`);
    expect(r.junction).toContain(isolateLtr('J1'));
  });

  it('no help text still says selecting several needs a mouse', () => {
    expect(en['inspector.shortcuts']).not.toMatch(/needs a mouse/);
    expect(he['inspector.shortcuts']).not.toContain('עכבר');
    for (const m of [en, he] as Record<string, string>[]) expect(m['multi.list.hint']).toBeTruthy();
  });
});
