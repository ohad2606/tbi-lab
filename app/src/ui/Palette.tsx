import { CATALOG, type ComponentTypeId } from '@tbi-lab/domain';
import { catalogText } from '../i18n/i18n.js';
import type { MessageKey } from '../i18n/messages.en.js';
import { useAppState, useT } from './context.js';
import { SYMBOLS } from './symbols.js';

/**
 * Visual grouping of the V1 catalog (approved families, product scope §6.0). Every catalog type appears in exactly one group
 * (tests/palette.test.ts), in CATALOG_ORDER.
 */
export const PALETTE_GROUPS: readonly { key: MessageKey; types: readonly ComponentTypeId[] }[] = [
  { key: 'palette.group.sources', types: ['instrument.lab_psu', 'component.ground'] },
  { key: 'palette.group.passive', types: ['component.resistor'] },
  {
    key: 'palette.group.semiconductors',
    types: ['component.led', 'component.rgb_led', 'component.diode'],
  },
  {
    key: 'palette.group.switches',
    types: ['component.push_button', 'component.toggle_switch', 'component.relay'],
  },
  { key: 'palette.group.sensors', types: ['component.photoresistor'] },
  { key: 'palette.group.output', types: ['component.buzzer'] },
  { key: 'palette.group.mcu', types: ['board.esp32_devkitc_wroom32'] },
];
const GROUPS = PALETTE_GROUPS;

interface Props {
  placing: ComponentTypeId | null;
  onPick(type: ComponentTypeId, viaKeyboard: boolean): void;
}

export function Palette({ placing, onPick }: Props) {
  const { locale, readOnly, sim } = useAppState();
  // Placing is structural: not while a simulation holds the current topology.
  const locked =
    !!readOnly ||
    sim.status === 'running' ||
    sim.status === 'starting' ||
    sim.status === 'stopping';
  const t = useT();
  return (
    <aside class="palette" aria-labelledby="palette-heading">
      <h2 id="palette-heading">{t('palette.heading')}</h2>
      {GROUPS.map((group) => (
        <div
          class="palette-group"
          key={group.key}
          role="group"
          aria-labelledby={`palette-${group.key}`}
        >
          <h3 id={`palette-${group.key}`} class="palette-group-heading">
            {t(group.key)}
          </h3>
          <ul>
            {group.types.map((type) => {
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
        </div>
      ))}
      <p class="muted small">{t('palette.hint')}</p>
    </aside>
  );
}
