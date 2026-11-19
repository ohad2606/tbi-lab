/**
 * Wires list (A11Y-002, TBI-001 slice 3): an accessible alternative to clicking a wire. One button
 * per wire; activating it calls the normal `store.select`, so Inspector, highlight and Delete work
 * as for a pointer selection. It never moves focus by itself.
 */
import { CATALOG, emptySelection, type Wire } from '@tbi-lab/domain';
import { catalogText, isolateLtr } from '../i18n/i18n.js';
import { useAppState, useStore, useT } from './context.js';
import { wireListEntries } from './wireKeyboard.js';

export function WiresList() {
  const { doc, selection, locale } = useAppState();
  const store = useStore();
  const t = useT();
  if (!doc) return null;
  const endName = (end: Wire['from']) => {
    if (end.kind !== 'terminal') return t('kbwire.endJunction', { id: isolateLtr(end.junction) });
    const c = doc.components.find((x) => x.id === end.component);
    const def = c ? CATALOG[c.type].terminals.find((x) => x.id === end.terminal) : undefined;
    const pin = def ? catalogText(locale, def.labelKey) : end.terminal;
    return `${isolateLtr(end.component)} ${pin}`;
  };
  const rows = wireListEntries(doc, endName);
  const only =
    selection.wires.length === 1 && !selection.components.length && !selection.junctions.length
      ? selection.wires[0]
      : undefined;
  return (
    <section class="wires-list" aria-labelledby="wires-list-heading" data-testid="wires-list">
      <h2 id="wires-list-heading">{t('kbwire.list.title')}</h2>
      {rows.length === 0 ? (
        <p class="wires-list-empty">{t('kbwire.list.empty')}</p>
      ) : (
        <ul>
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                class="wires-list-item"
                data-wire={r.id}
                aria-pressed={only === r.id}
                onClick={() => store.select({ ...emptySelection(), wires: [r.id] })}
              >
                {t('kbwire.list.item', { n: r.n, from: r.from, to: r.to })}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
