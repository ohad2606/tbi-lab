import { CATALOG, CATALOG_ORDER, type ComponentTypeId } from '@tbi-lab/domain';
import { catalogText } from '../i18n/i18n.js';
import { useAppState, useT } from './context.js';
import { SYMBOLS } from './symbols.js';

interface Props {
  placing: ComponentTypeId | null;
  onPick(type: ComponentTypeId, viaKeyboard: boolean): void;
}

export function Palette({ placing, onPick }: Props) {
  const { locale, readOnly, sim } = useAppState();
  // Placing is structural: not while a simulation holds the current topology.
  const locked = !!readOnly || sim.status === 'running' || sim.status === 'starting';
  const t = useT();
  return (
    <aside class="palette" aria-labelledby="palette-heading">
      <h2 id="palette-heading">{t('palette.heading')}</h2>
      <ul>
        {CATALOG_ORDER.map((type) => {
          const [x0, y0, x1, y1] = SYMBOLS[type].bbox;
          return (
            <li key={type}>
              <button
                type="button"
                class={placing === type ? 'palette-item active' : 'palette-item'}
                data-testid={`palette-${type}`}
                aria-pressed={placing === type}
                disabled={locked}
                // A keyboard activation has detail 0: place immediately at the view centre.
                onClick={(e) => onPick(type, e.detail === 0)}
              >
                <svg
                  class="palette-icon"
                  viewBox={`${x0 - 6} ${y0 - 6} ${x1 - x0 + 12} ${y1 - y0 + 12}`}
                  aria-hidden="true"
                >
                  <g class="symbol">{SYMBOLS[type].draw()}</g>
                </svg>
                <span>{catalogText(locale, CATALOG[type].nameKey)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p class="muted small">{t('palette.hint')}</p>
    </aside>
  );
}
