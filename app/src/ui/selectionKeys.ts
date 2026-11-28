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

/**
 * Ctrl/Cmd+A on a drawing or its controls must not select the page's text. Text fields keep it,
 * and selecting text with the pointer is untouched.
 */
export function keepPageUnselected(e: KeyboardEvent): void {
  if (multiSelectKey(e, false) !== 'all') return;
  const el = e.target as Element | null;
  if (!el?.closest?.('input, textarea, select, [contenteditable="true"]')) e.preventDefault();
}
