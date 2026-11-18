import { catalogText, formatQuantity, isolateLtr } from '../i18n/i18n.js';
import { useAppState, useT } from './context.js';
import { describeConnections } from './connectionsText.js';

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
  const { doc, locale } = useAppState();
  const t = useT();
  if (!doc) return null;
  const text = describeConnections(doc, (q) => formatQuantity(locale, q));
  const pin = (ref: string, key: string) => `${isolateLtr(ref)} ${catalogText(locale, key)}`;
  return (
    <div class="connections-body">
      <h3 id="connections-parts">{t('connections.parts')}</h3>
      {text.parts.length === 0 ? (
        <p>{t('connections.noParts')}</p>
      ) : (
        <table aria-labelledby="connections-parts" data-testid="connections-parts">
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
              <tr key={p.ref}>
                <th scope="row">
                  <bdi dir="ltr">{p.ref}</bdi>
                </th>
                <td>{catalogText(locale, p.typeNameKey)}</td>
                <td>
                  <bdi dir="ltr">{p.values.join(' · ')}</bdi>
                </td>
                <td>
                  {p.unconnected.length === 0
                    ? t('connections.none')
                    : p.unconnected.map((u) => catalogText(locale, u.terminalKey)).join(', ')}
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
        <ul aria-labelledby="connections-nets" data-testid="connections-nets">
          {text.nets.map((n) => (
            <li key={n.id} data-testid={`connections-net-${n.ground ? 'gnd' : n.index}`}>
              <strong>
                {n.ground ? t('connections.ground') : t('connections.net', { n: n.index })}
                {n.userName !== null && <bdi dir="auto"> ({n.userName})</bdi>}
              </strong>
              {': '}
              {n.endpoints.map((e) => pin(e.ref, e.terminalKey)).join(', ')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
