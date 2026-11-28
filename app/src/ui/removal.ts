/** What to announce after the selection was deleted (Properties button and Delete key). */
import type { Selection } from '@tbi-lab/domain';
import { isolateLtr, type MessageKey } from '../i18n/i18n.js';

export function removalMessage(sel: Selection): {
  key: MessageKey;
  params: Record<string, string | number>;
} {
  const count = sel.components.length + sel.wires.length + sel.junctions.length;
  if (count === 1 && sel.components.length)
    return {
      key: 'inspector.partRemoved',
      params: { id: isolateLtr(sel.components[0]!) },
    };
  if (count === 1 && sel.junctions.length)
    return { key: 'junctions.removed', params: { id: isolateLtr(sel.junctions[0]!) } };
  return { key: 'inspector.selectionRemoved', params: { count } };
}
