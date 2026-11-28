import { Fragment } from 'preact';
import { useContext, useEffect, useRef } from 'preact/hooks';
import { catalogText, formatQuantity, isolateLtr } from '../i18n/i18n.js';
import { emptySelection } from '@tbi-lab/domain';
import { useAppState, useStore, useT } from './context.js';
import { describeConnections } from './connectionsText.js';
import { EndSeveralContext } from './selectionKeys.js';

/**
 * A11Y-028: a text alternative to the canvas — every part, and every net with the pins on it.
 * A native disclosure (keyboard and screen-reader operable, no focus trap); the content is
 * rendered only while open and is derived from the netlist, never stored.
 */
export function ConnectionsPanel() {
  const { doc } = useAppState();
  const t = useT();
  if (!doc) return null;
  return (
    <details class="connections" data-testid="connections">
      <summary data-testid="connections-toggle">{t('connections.title')}</summary>
      <ConnectionsBody />
    </details>
  );
}

function ConnectionsBody() {
  const { doc, locale, selection } = useAppState();
  const store = useStore();
  const t = useT();
  const endSeveral = useContext(EndSeveralContext);
  const tableRef = useRef<HTMLTableElement>(null);
  const selectedRef = selection.components.length === 1 ? selection.components[0]! : null;
  // Canvas -> list: bring the selected part's row into view (never moves focus).
  useEffect(() => {
    if (selectedRef === null) return;
    const row = tableRef.current?.querySelector('tr[data-selected="true"]');
    (row as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedRef]);
  if (!doc) return null;
  const text = describeConnections(doc, (q) => formatQuantity(locale, q));
  const isSelected = (ref: string) => selection.components.includes(ref);
  // Part names and pin ids are technical (LTR); pin labels follow their own text direction.
  const pinList = (pins: { ref: string; terminalKey: string }[]) =>
    pins.map((e, i) => (
      <Fragment key={`${e.ref}.${e.terminalKey}`}>
        {i > 0 && ', '}
        <span class={isSelected(e.ref) ? 'conn-pin selected' : 'conn-pin'}>
          <bdi dir="ltr">{e.ref}</bdi> <bdi dir="auto">{catalogText(locale, e.terminalKey)}</bdi>
        </span>
      </Fragment>
    ));
  return (
    <div
      class="connections-body"
      role="region"
      tabIndex={0}
      aria-label={t('connections.region')}
      data-testid="connections-region"
    >
      <h3 id="connections-parts">{t('connections.parts')}</h3>
      {text.parts.length === 0 ? (
        <p>{t('connections.noParts')}</p>
      ) : (
        <table ref={tableRef} data-testid="connections-parts">
          <caption class="visually-hidden">
            {t('connections.partsCaption', { n: text.parts.length })}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('connections.col.part')}</th>
              <th scope="col">{t('connections.col.type')}</th>
              <th scope="col">{t('connections.col.value')}</th>
              <th scope="col">{t('connections.col.unconnected')}</th>
            </tr>
          </thead>
          <tbody>
            {text.parts.map((p) => (
              <tr key={p.ref} data-selected={isSelected(p.ref) ? 'true' : 'false'}>
                <th scope="row">
                  <button
                    type="button"
                    class="conn-select"
                    data-testid={`connections-select-${p.ref}`}
                    aria-pressed={isSelected(p.ref) ? 'true' : 'false'}
                    aria-label={t('connections.select', { ref: p.ref })}
                    onClick={() => {
                      store.select({ ...emptySelection(), components: [p.ref] });
                      endSeveral(t('multi.partChosen', { ref: isolateLtr(p.ref) }));
                    }}
                  >
                    <bdi dir="ltr">{p.ref}</bdi>
                  </button>
                </th>
                <td>{catalogText(locale, p.typeNameKey)}</td>
                <td>
                  <bdi dir="ltr">{p.values.join(' · ')}</bdi>
                </td>
                <td>
                  {p.unconnected.length === 0 ? t('connections.none') : pinList(p.unconnected)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 id="connections-nets">{t('connections.nets')}</h3>
      {text.nets.length === 0 ? (
        <p>{t('connections.noNets')}</p>
      ) : (
        <ul
          aria-label={t('connections.netsLabel', { n: text.nets.length })}
          data-testid="connections-nets"
        >
          {text.nets.map((n) => (
            <li key={n.id} data-testid={`connections-net-${n.ground ? 'gnd' : n.index}`}>
              <strong>
                {n.ground
                  ? t('connections.ground')
                  : t(n.supplyRefs.length > 0 ? 'connections.netSupply' : 'connections.net', {
                      n: n.index,
                    })}
                {n.userName !== null && <bdi dir="auto"> ({n.userName})</bdi>}
              </strong>
              {': '}
              {pinList(n.endpoints)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
