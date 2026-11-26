/**
 * The keyboard shortcuts registry (TBI-020 slice 2): ONE typed list of the keys the real handlers
 * act on, from which the shortcuts dialog is generated. Every entry (but the dialog's own `?`)
 * was read from a handler and is listed in docs/product/user-guide-design.md section 1, which
 * `tests/shortcuts.test.ts` checks both ways. Nothing here adds or changes a shortcut: Run, Stop
 * and Build deliberately have none. Texts: `shortcut.<id>.action` and `.when` in both catalogues.
 */

export type ShortcutScope =
  'global' | 'circuit' | 'wiring' | 'schematic' | 'view3d' | 'menus' | 'editor';

/** The order the dialog shows the areas in. */
export const SHORTCUT_SCOPES: readonly ShortcutScope[] = [
  'global',
  'circuit',
  'wiring',
  'schematic',
  'view3d',
  'menus',
  'editor',
];

export type ShortcutDef = {
  /** camelCase; the message keys are `shortcut.<id>.action` and `shortcut.<id>.when`. */
  readonly id: string;
  readonly scope: ShortcutScope;
  /**
   * Alternatives (any one works). Each is a chord of key names joined by " + " (so the key "+"
   * itself is written "+"). `Mod` is Ctrl or Cmd. Key names are physical key caps, never translated.
   */
  readonly keys: readonly string[];
  /** The handler's file under app/src/ui (as named in the inventory). */
  readonly file: string;
};

/** The one entry with no inventory row: it is the dialog's own opener (inventory finding 6). */
export const NEW_IN_SLICE_2: readonly string[] = ['help'];

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'undo', scope: 'global', keys: ['Mod + Z'], file: 'App.tsx' },
  { id: 'redo', scope: 'global', keys: ['Mod + Shift + Z', 'Mod + Y'], file: 'App.tsx' },
  { id: 'help', scope: 'global', keys: ['?'], file: 'ShortcutsDialog.tsx' },
  { id: 'cancelPlace', scope: 'global', keys: ['Esc'], file: 'Editor.tsx' },

  { id: 'pinMode', scope: 'circuit', keys: ['W'], file: 'Canvas.tsx' },
  { id: 'wireSelect', scope: 'circuit', keys: [']', '['], file: 'Canvas.tsx' },
  { id: 'wireRepick', scope: 'circuit', keys: ['E'], file: 'Canvas.tsx' },
  { id: 'escStep', scope: 'circuit', keys: ['Esc'], file: 'Canvas.tsx' },
  { id: 'delete', scope: 'circuit', keys: ['Delete', 'Backspace'], file: 'Canvas.tsx' },
  { id: 'rotate', scope: 'circuit', keys: ['R'], file: 'Canvas.tsx' },
  { id: 'moveSelection', scope: 'circuit', keys: ['Arrow keys'], file: 'Canvas.tsx' },
  { id: 'panView', scope: 'circuit', keys: ['Arrow keys'], file: 'Canvas.tsx' },
  { id: 'zoomIn', scope: 'circuit', keys: ['+', '='], file: 'Canvas.tsx' },
  { id: 'zoomOut', scope: 'circuit', keys: ['-'], file: 'Canvas.tsx' },
  { id: 'fit', scope: 'circuit', keys: ['F'], file: 'Canvas.tsx' },
  { id: 'toggleSwitch', scope: 'circuit', keys: ['Space'], file: 'Canvas.tsx' },

  { id: 'pinNext', scope: 'wiring', keys: ['Arrow Down', 'Arrow Right'], file: 'Canvas.tsx' },
  {
    id: 'pinPrev',
    scope: 'wiring',
    keys: ['Arrow Up', 'Arrow Left', 'Shift + Tab'],
    file: 'Canvas.tsx',
  },
  { id: 'wireStart', scope: 'wiring', keys: ['Enter'], file: 'Canvas.tsx' },
  { id: 'targetCycle', scope: 'wiring', keys: ['Arrow keys', 'Tab'], file: 'Canvas.tsx' },
  { id: 'wireConnect', scope: 'wiring', keys: ['Enter'], file: 'Canvas.tsx' },
  { id: 'repickEnd', scope: 'wiring', keys: ['1', '2'], file: 'Canvas.tsx' },
  { id: 'wireCancel', scope: 'wiring', keys: ['Esc'], file: 'Canvas.tsx' },

  {
    id: 'schematicSelect',
    scope: 'schematic',
    keys: ['Enter', 'Space'],
    file: 'SchematicView.tsx',
  },
  { id: 'panSchematic', scope: 'schematic', keys: ['Arrow keys'], file: 'SchematicView.tsx' },
  { id: 'zoomSchematic', scope: 'schematic', keys: ['+', '=', '-'], file: 'SchematicView.tsx' },
  { id: 'fitSchematic', scope: 'schematic', keys: ['Home'], file: 'SchematicView.tsx' },

  { id: 'rotate3d', scope: 'view3d', keys: ['Arrow Left', 'Arrow Right'], file: 'ThreeView.tsx' },
  { id: 'pan3d', scope: 'view3d', keys: ['Shift + Arrow keys'], file: 'ThreeView.tsx' },
  { id: 'zoom3d', scope: 'view3d', keys: ['+', '=', '-'], file: 'ThreeView.tsx' },
  { id: 'reset3d', scope: 'view3d', keys: ['Home'], file: 'ThreeView.tsx' },
  { id: 'toggle3d', scope: 'view3d', keys: ['Space', 'Enter'], file: 'ThreeView.tsx' },
  { id: 'layersClose', scope: 'view3d', keys: ['Esc'], file: 'ThreeView.tsx' },

  { id: 'tabsMove', scope: 'menus', keys: ['Arrow Left', 'Arrow Right'], file: 'Editor.tsx' },
  { id: 'menuOpen', scope: 'menus', keys: ['Arrow Down'], file: 'AppMenu.tsx' },
  {
    id: 'menuMove',
    scope: 'menus',
    keys: ['Arrow Up', 'Arrow Down', 'Home', 'End'],
    file: 'AppMenu.tsx',
  },
  { id: 'menuClose', scope: 'menus', keys: ['Esc'], file: 'AppMenu.tsx' },
  { id: 'dialogClose', scope: 'menus', keys: ['Esc'], file: 'Capabilities.tsx' },

  { id: 'editorTab', scope: 'editor', keys: ['Tab'], file: 'CodeView.tsx' },
  { id: 'editorLeave', scope: 'editor', keys: ['Esc'], file: 'CodeView.tsx' },
  { id: 'editorBack', scope: 'editor', keys: ['Shift + Tab'], file: 'CodeView.tsx' },
  { id: 'editorMode', scope: 'editor', keys: ['Ctrl + M'], file: 'CodeView.tsx' },
];

/** The entries of one area, in registry order. */
export function shortcutsIn(scope: ShortcutScope): readonly ShortcutDef[] {
  return SHORTCUTS.filter((s) => s.scope === scope);
}

/** A chord split into its key names ("Mod + Z" gives ["Mod", "Z"]; "+" stays "+"). */
export function chordKeys(chord: string): string[] {
  return chord === '+' ? ['+'] : chord.split(' + ');
}

/** A text field where `?` is a character (the code editor is a textarea). */
const TYPING_TARGET =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]';

export type HelpKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented?: boolean;
  target: unknown;
};

/**
 * Should this key press open the shortcuts dialog? The typed character `?` only (so it works on
 * any layout that types it), no Ctrl/Cmd/Alt chord (AltGr, reported as Ctrl+Alt, still counts),
 * never while typing in a field, and not while another dialog is open.
 */
export function isHelpKey(e: HelpKeyEvent, otherDialogOpen: boolean): boolean {
  if (e.key !== '?' || e.defaultPrevented || otherDialogOpen) return false;
  if (e.metaKey || e.ctrlKey !== e.altKey) return false;
  // WCAG 2.1.4 (D-1640-1): only while focus is on an element of the page, never in a text field.
  const el = e.target as { closest?: (s: string) => unknown } | null;
  if (typeof el?.closest !== 'function') return false;
  return !el.closest(TYPING_TARGET);
}
