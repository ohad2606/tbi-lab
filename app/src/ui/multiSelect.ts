/**
 * Building a selection of several items without a drag or a held modifier (BETA-G3, WCAG 2.1.1):
 * the rules only; the Circuit view applies them.
 */
import type { ProjectDocument, Selection } from '@tbi-lab/domain';
import type { MessageKey } from '../i18n/i18n.js';

export type SelectionKind = keyof Selection;

export function isSelected(sel: Selection, kind: SelectionKind, id: string): boolean {
  return sel[kind].includes(id);
}

/** Adds the item, or takes it out. With `addOnly` an item already selected stays selected. */
export function toggleItem(
  sel: Selection,
  kind: SelectionKind,
  id: string,
  addOnly = false,
): Selection {
  if (!isSelected(sel, kind, id)) return { ...sel, [kind]: [...sel[kind], id] };
  return addOnly ? sel : { ...sel, [kind]: sel[kind].filter((x) => x !== id) };
}

/**
 * A Wires or Junctions list button while several-selection is on: adds its item or takes it out,
 * leaving the rest of the selection, and gives the one message that says so with the new count.
 */
export function toggleFromList(
  sel: Selection,
  kind: SelectionKind,
  id: string,
  item: string,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
): { next: Selection; added: boolean; said: string } {
  const next = toggleItem(sel, kind, id);
  const added = isSelected(next, kind, id);
  const count = selectionCountMessage(next);
  const said = t(added ? 'multi.list.added' : 'multi.list.removed', {
    item,
    count: t(count.key, count.params),
  });
  return { next, added, said };
}

export function selectEverything(doc: ProjectDocument): Selection {
  return {
    components: doc.components.map((c) => c.id),
    wires: doc.layout.wires.map((w) => w.id),
    junctions: doc.layout.junctions.map((j) => j.id),
  };
}

export function selectionCountMessage(sel: Selection): {
  key: MessageKey;
  params: Record<string, number>;
} {
  const count = sel.components.length + sel.wires.length + sel.junctions.length;
  const key =
    count === 0 ? 'multi.count.none' : count === 1 ? 'multi.count.one' : 'inspector.multi';
  return { key, params: { count } };
}

/**
 * Ctrl/Cmd+A selects everything; Shift+Enter toggles the focused part; plain Enter does the same
 * only while several-selection is on. Never a single printable character (WCAG 2.1.4).
 */
export function multiSelectKey(
  e: {
    key: string;
    code: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  },
  several: boolean,
): 'all' | 'toggle' | null {
  if (e.altKey) return null;
  if (e.ctrlKey || e.metaKey) {
    // The physical key (any layout, Hebrew included) or the letter the layout produces.
    const isA = e.code === 'KeyA' || e.key.toLowerCase() === 'a';
    return isA && !e.shiftKey ? 'all' : null;
  }
  return e.key === 'Enter' && (e.shiftKey || several) ? 'toggle' : null;
}
