/**
 * Junctions list (BETA-G3; WCAG 2.1.1): the keyboard and single-click way to select an existing
 * junction. Selecting goes through the normal `store.select`, so the Inspector's Move and Delete
 * work on it; the Circuit view is panned to show it. Nothing is shown when there are no junctions.
 * Wires are named by their number in the Wires list.
 */
import { emptySelection, type Point } from '@tbi-lab/domain';
import { isolateLtr } from '../i18n/i18n.js';
import { useAppState, useStore, useT } from './context.js';
import { useAnnounce } from './useAnnounce.js';

export function JunctionsList({ onReveal }: { onReveal(at: Point): void }) {
  const { doc, selection, locale } = useAppState();
  const store = useStore();
  const t = useT();
  const [msg, announce] = useAnnounce();
  if (!doc) return null;
  const only =
    selection.junctions.length === 1 && !selection.components.length && !selection.wires.length
      ? selection.junctions[0]
      : undefined;
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
          <ul>
            {doc.layout.junctions.map((j) => (
              <li key={j.id}>
                <button
                  type="button"
                  class="junctions-list-item"
                  data-junction={j.id}
                  aria-pressed={only === j.id}
                  onClick={() => {
                    store.select({ ...emptySelection(), junctions: [j.id] });
                    onReveal(j);
                    announce(t('junctions.list.selected', { id: isolateLtr(j.id) }));
                  }}
                >
                  <span aria-hidden="true">{only === j.id ? '✓ ' : ''}</span>
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
