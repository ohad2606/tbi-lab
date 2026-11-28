/**
 * Junctions list (BETA-G3; WCAG 2.1.1): the keyboard and single-click way to select an existing
 * junction. Selecting goes through the normal `store.select`, so the Inspector's Move and Delete
 * work on it; the Circuit view is panned to show it. Nothing is shown when there are no junctions.
 * While several-selection is on a button adds its junction to the selection or takes it out.
 * Wires are named by their number in the Wires list.
 */
import { emptySelection, type Point } from '@tbi-lab/domain';
import { isolateLtr } from '../i18n/i18n.js';
import { useAppState, useStore, useT } from './context.js';
import { toggleFromList } from './multiSelect.js';
import { useAnnounce } from './useAnnounce.js';

export function JunctionsList({
  onReveal,
  severalOn,
}: {
  onReveal(at: Point): void;
  severalOn: boolean;
}) {
  const { doc, selection, locale, readOnly } = useAppState();
  const store = useStore();
  const t = useT();
  const [msg, announce] = useAnnounce();
  if (!doc) return null;
  const only =
    selection.junctions.length === 1 && !selection.components.length && !selection.wires.length
      ? selection.junctions[0]
      : undefined;
  const several = severalOn && !readOnly;
  const pressed = (id: string) => (several ? selection.junctions.includes(id) : only === id);
  const wiresOf = (id: string) =>
    doc.layout.wires
      .flatMap((w, i) =>
        [w.from, w.to].some((e) => e.kind === 'junction' && e.junction === id)
          ? [isolateLtr(t('junctions.list.wire', { n: i + 1 }))]
          : [],
      )
      .join(', ');
  return (
    <>
      {doc.layout.junctions.length > 0 && (
        <section
          class="junctions-list"
          aria-labelledby="junctions-list-heading"
          data-testid="junctions-list"
        >
          <h2 id="junctions-list-heading">{t('junctions.list.title')}</h2>
          {several && <p class="list-several-hint">{t('multi.list.hint')}</p>}
          <ul>
            {doc.layout.junctions.map((j) => (
              <li key={j.id}>
                <button
                  type="button"
                  class="junctions-list-item"
                  data-junction={j.id}
                  aria-pressed={pressed(j.id)}
                  onClick={() => {
                    const id = isolateLtr(j.id);
                    if (several) {
                      const name = t('junctions.list.name', { id });
                      const r = toggleFromList(store.state.selection, 'junctions', j.id, name, t);
                      store.select(r.next);
                      if (r.added) onReveal(j);
                      announce(r.said);
                      return;
                    }
                    store.select({ ...emptySelection(), junctions: [j.id] });
                    onReveal(j);
                    announce(t('junctions.list.selected', { id }));
                  }}
                >
                  <span aria-hidden="true">{pressed(j.id) ? '✓ ' : ''}</span>
                  {t('junctions.list.item', { id: isolateLtr(j.id), wires: wiresOf(j.id) })}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div
        class="visually-hidden"
        role="status"
        aria-live="polite"
        data-testid="junctions-list-status"
        dir={locale.dir}
      >
        {msg}
      </div>
    </>
  );
}
