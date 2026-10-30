import { LearnMore } from './Capabilities.js';
import { CATALOG, CATALOG_ORDER, placementBlock, type ComponentTypeId } from '@tbi-lab/domain';
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
  {
    key: 'palette.group.passive',
    types: ['component.resistor', 'component.capacitor', 'component.potentiometer'],
  },
  {
    key: 'palette.group.semiconductors',
    types: ['component.led', 'component.rgb_led', 'component.diode', 'component.bjt_npn'],
  },
  {
    key: 'palette.group.switches',
    types: ['component.push_button', 'component.toggle_switch', 'component.relay'],
  },
  {
    key: 'palette.group.sensors',
    types: ['component.photoresistor', 'sensor.pir_hc_sr501', 'sensor.hc_sr04', 'sensor.dht22'],
  },
  {
    key: 'palette.group.output',
    types: [
      'component.buzzer',
      'display.led_matrix_8x8',
      'display.lcd1602_i2c',
      'component.servo_sg90',
    ],
  },
  {
    key: 'palette.group.logic',
    types: [
      'logic.gate_and',
      'logic.gate_nand',
      'logic.gate_or',
      'logic.gate_not',
      'logic.quad_and',
    ],
  },
  { key: 'palette.group.mcu', types: ['board.esp32_devkitc_wroom32'] },
];
const GROUPS = PALETTE_GROUPS;

interface Props {
  placing: ComponentTypeId | null;
  onPick(type: ComponentTypeId, viaKeyboard: boolean): void;
}

export function Palette({ placing, onPick }: Props) {
  const { locale, readOnly, sim, doc } = useAppState();
  // Placing is structural: not while a simulation holds the current topology.
  const locked =
    !!readOnly ||
    sim.status === 'running' ||
    sim.status === 'starting' ||
    sim.status === 'stopping';
  const t = useT();
  const blocks = doc
    ? [...new Set(CATALOG_ORDER.map((type) => placementBlock(doc, type)).filter((b) => b !== null))]
    : [];
  return (
    <aside class="palette" aria-labelledby="palette-heading">
      <h2 id="palette-heading">{t('palette.heading')}</h2>
      {/* One note per reason a part is not offered for this project's board (Sprint 10). */}
      {blocks.map((block) => (
        <p
          key={block}
          class="palette-unavailable muted small"
          id={`palette-note-${block}`}
          data-testid={`palette-note-${block}`}
        >
          <span data-testid={`palette-note-text-${block}`}>
            {t(`palette.unavailable.${block}`)}
          </span>{' '}
          <LearnMore section="parts" />
        </p>
      ))}
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
              // Sprint 10: not offered when the project's board runtime cannot simulate it.
              const block = doc ? placementBlock(doc, type) : null;
              const noteId = `palette-note-${block}`;
              return (
                <li key={type}>
                  <button
                    type="button"
                    class={placing === type ? 'palette-item active' : 'palette-item'}
                    data-testid={`palette-${type}`}
                    data-unavailable={block ?? undefined}
                    aria-pressed={placing === type}
                    aria-describedby={block ? noteId : undefined}
                    title={block ? t(`palette.unavailable.${block}`) : undefined}
                    disabled={locked || !!block}
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
                    {/* Sprint 13 OS-10: a non-colour indicator of the armed placement. */}
                    {placing === type && (
                      <svg
                        class="palette-check"
                        viewBox="0 0 16 16"
                        aria-hidden="true"
                        data-testid="palette-check"
                      >
                        <path d="M3 8.5 6.5 12 13 4.5" />
                      </svg>
                    )}
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
