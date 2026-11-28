/**
 * Selection rules shared by the editor's views (BETA-G3).
 */
import { createContext } from 'preact';
import { multiSelectKey } from './multiSelect.js';

/**
 * Ends several-selection because a list or another view replaced the selection, and says so in one
 * message: `said` is what was selected, or null when the selection was cleared. Silent while the
 * mode is off.
 */
export const EndSeveralContext = createContext<(said: string | null) => void>(() => {});

/** Where Ctrl/Cmd+A keeps its native meaning: text entry, and the terminal's own area. */
const KEEPS_SELECT_ALL =
  'textarea, select, [contenteditable="true"], .mcu-terminal, ' +
  'input:not([type="checkbox"], [type="radio"], [type="button"], [type="range"])';

/**
 * Ctrl/Cmd+A on a drawing, its controls or the side column must not select the page's text. Text
 * fields keep it, and selecting text with the pointer is untouched.
 */
export function keepPageUnselected(e: KeyboardEvent): void {
  if (multiSelectKey(e, false) !== 'all') return;
  const el = e.target as Element | null;
  if (!el?.closest?.(KEEPS_SELECT_ALL)) e.preventDefault();
}
