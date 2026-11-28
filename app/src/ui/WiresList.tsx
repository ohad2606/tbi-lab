/**
 * Wires list (A11Y-002, TBI-001 slice 3): an accessible alternative to clicking a wire. One button
 * per wire; activating it calls the normal `store.select`, so Inspector, highlight and Delete work
 * as for a pointer selection. While several-selection is on (BETA-G3) a button adds its wire to
 * the selection or takes it out. It never moves focus by itself.
 */
import { CATALOG, emptySelection, type Wire } from '@tbi-lab/domain';
import { catalogText, isolateLtr } from '../i18n/i18n.js';
import { useAppState, useStore, useT } from './context.js';
import { toggleFromList } from './multiSelect.js';
import { useListStatus } from './useListStatus.js';
import { wireListEntries } from './wireKeyboard.js';

export function WiresList({ severalOn, onSelect }: { severalOn: boolean; onSelect(): void }) {
  const { doc, selection, locale, readOnly } = useAppState();
  const store = useStore();
  const t = useT();
  // Live region for the selection (WCAG 4.1.3).
  const [msg, announce] = useListStatus(severalOn);
  if (!doc) return null;
  const endName = (end: Wire['from']) => {
    if (end.kind !== 'terminal') return t('kbwire.endJunction', { id: isolateLtr(end.junction) });
    const c = doc.components.find((x) => x.id === end.component);
    const def = c ? CATALOG[c.type].terminals.find((x) => x.id === end.terminal) : undefined;
    const pin = def ? catalogText(locale, def.labelKey) : end.terminal;
    return isolateLtr(`${end.component} ${pin}`);
  };
  const rows = wireListEntries(doc, endName);
  const several = severalOn && !readOnly;
  // Pressed means in the selection, in both modes.
  const pressed = (id: string) => selection.wires.includes(id);
  return (
    <section class="wires-list" aria-labelledby="wires-list-heading" data-testid="wires-list">
      <h2 id="wires-list-heading">{t('kbwire.list.title')}</h2>
      {several && rows.length > 0 && (
        <p id="wires-list-hint" class="list-several-hint">
          {t('multi.list.hint')}
        </p>
      )}
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
                aria-pressed={pressed(r.id)}
                aria-describedby={several ? 'wires-list-hint' : undefined}
                onClick={() => {
                  onSelect();
                  if (several) {
                    const name = t('kbwire.list.name', { n: r.n });
                    const r2 = toggleFromList(store.state.selection, 'wires', r.id, name, t);
                    store.select(r2.next);
                    announce(r2.said);
                    return;
                  }
                  store.select({ ...emptySelection(), wires: [r.id] });
                  announce(t('kbwire.list.selected', { n: r.n }));
                }}
              >
                <span class="wires-list-mark" aria-hidden="true">
                  {pressed(r.id) ? '\u2713 ' : ''}
                </span>
                {t('kbwire.list.item', { n: r.n, from: r.from, to: r.to })}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        class="visually-hidden"
        role="status"
        aria-live="polite"
        data-testid="wires-list-status"
        dir={locale.dir}
      >
        {msg}
      </div>
    </section>
  );
}
