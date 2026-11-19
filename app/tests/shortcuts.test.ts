/**
 * TBI-020 slice 2: the keyboard shortcuts registry. Every entry has Hebrew and English text,
 * ids are unique, and every registered key really appears in the inventory (the handler table in
 * docs/product/user-guide-design.md section 1) for the handler file it names. The dialog's
 * focus behaviour is a browser matter: e2e/a11y-shortcuts-dialog.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import {
  NEW_IN_SLICE_2,
  SHORTCUTS,
  SHORTCUT_SCOPES,
  chordKeys,
  isHelpKey,
  shortcutsIn,
} from '../src/ui/shortcuts.js';

const DOC = fileURLToPath(new URL('../../docs/product/user-guide-design.md', import.meta.url));
const inventory = readFileSync(DOC, 'utf8')
  .split('\n')
  .filter((l) => l.startsWith('|') && !l.startsWith('|---'))
  .map((l) =>
    l
      .replace(/`/g, '')
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim()),
  )
  // Handler tables have five columns: key, context, action, file:line, test.
  .filter((cells) => cells.length === 5);

const norm = (s: string) => s.toLowerCase().replace(/arrow keys|arrows/g, 'arrows');

/** Does this key name appear in the inventory row's key cell (modifiers: anywhere in the row)? */
function inRow(name: string, cells: string[]): boolean {
  const keyCell = norm(cells[0]!);
  const row = norm(cells.join(' '));
  if (['Mod', 'Shift', 'Ctrl'].includes(name)) return row.includes(name.toLowerCase());
  const arrow = /^Arrow (Up|Down|Left|Right)$/.exec(name);
  if (arrow) return keyCell.includes('arrow') && keyCell.includes(arrow[1]!.toLowerCase());
  return keyCell.includes(norm(name));
}

describe('registry', () => {
  it('has unique ids and known scopes, and every scope is used', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SHORTCUTS) expect(SHORTCUT_SCOPES, s.id).toContain(s.scope);
    for (const scope of SHORTCUT_SCOPES)
      expect(shortcutsIn(scope).length, scope).toBeGreaterThan(0);
  });

  it('gives every entry at least one key and a handler file', () => {
    for (const s of SHORTCUTS) {
      expect(s.keys.length, s.id).toBeGreaterThan(0);
      expect(s.file, s.id).toMatch(/\.tsx$/);
    }
  });

  for (const [code, messages] of [
    ['en', en],
    ['he', he],
  ] as const) {
    it(`${code}: every entry and area has non-empty text`, () => {
      const m = messages as Record<string, string>;
      for (const s of SHORTCUTS) {
        expect(m[`shortcut.${s.id}.action`]?.trim(), `${s.id}.action`).toBeTruthy();
        expect(m[`shortcut.${s.id}.when`]?.trim(), `${s.id}.when`).toBeTruthy();
      }
      for (const scope of SHORTCUT_SCOPES)
        expect(m[`shortcuts.scope.${scope}`]?.trim(), scope).toBeTruthy();
    });
  }

  it('has no orphan shortcut texts in either catalogue', () => {
    const ids = new Set(SHORTCUTS.map((s) => s.id));
    for (const m of [en, he] as Record<string, string>[])
      for (const k of Object.keys(m)) {
        const hit = /^shortcut\.(\w+)\.(action|when)$/.exec(k);
        if (hit) expect(ids.has(hit[1]!), k).toBe(true);
      }
  });

  it('parses chords, keeping "+" as a key', () => {
    expect(chordKeys('Mod + Shift + Z')).toEqual(['Mod', 'Shift', 'Z']);
    expect(chordKeys('+')).toEqual(['+']);
  });
});

describe('inventory parity (docs/product/user-guide-design.md section 1)', () => {
  it('reads the inventory tables', () => {
    expect(inventory.length).toBeGreaterThan(40);
  });

  for (const s of SHORTCUTS.filter((x) => !NEW_IN_SLICE_2.includes(x.id))) {
    it(`${s.id}: every key is an inventory key of ${s.file}`, () => {
      const rows = inventory.filter((c) => c[3]!.includes(s.file));
      expect(rows.length, `no inventory row names ${s.file}`).toBeGreaterThan(0);
      for (const chord of s.keys)
        for (const name of chordKeys(chord)) {
          // All the names of one chord must be on the same row.
          const row = rows.find((cells) => chordKeys(chord).every((n) => inRow(n, cells)));
          expect(row, `${chord} (${name}) is not in an inventory row of ${s.file}`).toBeDefined();
        }
    });
  }

  it('only the dialog opener is exempt, and it names its own file', () => {
    expect(NEW_IN_SLICE_2).toEqual(['help']);
    expect(SHORTCUTS.find((s) => s.id === 'help')?.file).toBe('ShortcutsDialog.tsx');
  });

  it('invents no Run, Stop or Build shortcut', () => {
    const bad = /run|stop|build|save/i;
    for (const s of SHORTCUTS)
      for (const k of s.keys) expect(`${s.id} ${k}`, s.id).not.toMatch(/ctrl\s*\+\s*(enter|s)/i);
    expect(SHORTCUTS.filter((s) => bad.test(s.id)).map((s) => s.id)).toEqual([]);
  });
});

describe('isHelpKey (when "?" opens the dialog)', () => {
  const press = (over: Partial<Parameters<typeof isHelpKey>[0]> = {}, target: unknown = body) =>
    isHelpKey({ key: '?', ctrlKey: false, metaKey: false, altKey: false, target, ...over }, false);
  const body = { closest: () => null };
  const typing = { closest: (sel: string) => (sel.includes('textarea') ? {} : null) };

  it('opens on a plain "?" with Shift', () => {
    expect(press()).toBe(true);
    expect(
      isHelpKey({ key: '?', ctrlKey: false, metaKey: false, altKey: false, target: body }, false),
    ).toBe(true);
  });
  it('is ignored in text fields and the code editor', () => {
    expect(press({}, typing)).toBe(false);
  });
  it('ignores other keys, Ctrl/Cmd/Alt chords and handled events', () => {
    expect(press({ key: '/' })).toBe(false);
    expect(press({ ctrlKey: true })).toBe(false);
    expect(press({ metaKey: true })).toBe(false);
    expect(press({ altKey: true })).toBe(false);
    expect(press({ defaultPrevented: true })).toBe(false);
  });
  it('accepts AltGr (Ctrl+Alt) and ignores a press while another dialog is open', () => {
    expect(press({ ctrlKey: true, altKey: true })).toBe(true);
    expect(
      isHelpKey({ key: '?', ctrlKey: false, metaKey: false, altKey: false, target: body }, true),
    ).toBe(false);
  });
});
