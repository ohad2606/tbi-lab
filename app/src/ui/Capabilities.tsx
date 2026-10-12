/**
 * "What runs on the ESP32" (Sprint 13 H1): the supported / limited / refused capabilities,
 * generated from the domain registry (packages/domain/src/capabilities.ts) and the catalog, never
 * written by hand. Opened from the application menu and from every refusal that has an entry
 * (palette notes, Run errors), scrolled to the relevant section.
 */
import {
  CATALOG,
  FIRMWARE_FACILITIES,
  SESSION_LIMITS,
  TIMING_CONTRACT,
  partCapabilities,
  type CapabilityStatus,
} from '@tbi-lab/domain';
import { useEffect, useRef, useState } from 'preact/hooks';
import { catalogText, type MessageKey } from '../i18n/i18n.js';
import { useAppState, useT } from './context.js';

export type CapabilitySection = 'firmware' | 'parts' | 'timing' | 'limits';

const listeners = new Set<(s: CapabilitySection | null) => void>();
/** Open the panel (optionally at a section). */
export function openCapabilities(section: CapabilitySection = 'firmware'): void {
  for (const l of listeners) l(section);
}

/** The failure codes whose explanation lives in the panel, and where. */
export function sectionForFailure(code: string | undefined): CapabilitySection | null {
  if (!code) return null;
  if (SESSION_LIMITS.includes(code)) return 'limits';
  if (code === 'mcu_unsupported_features' || code === 'unsupported_feature') return 'firmware';
  if (
    code === 'unsupported_component' ||
    code === 'mcu_component_unsupported' ||
    code === 'mcu_component_time_dependent'
  )
    return 'parts';
  return null;
}

/** The small link shown next to a refusal. */
export function LearnMore({ section }: { section: CapabilitySection }) {
  const t = useT();
  return (
    <button
      type="button"
      class="link-button capabilities-link"
      data-testid={`capabilities-link-${section}`}
      onClick={() => openCapabilities(section)}
    >
      {t('capabilities.learnMore')}
    </button>
  );
}

/** Mounted once (App): renders the dialog while it is open. */
export function CapabilitiesHost() {
  const [section, setSection] = useState<CapabilitySection | null>(null);
  useEffect(() => {
    listeners.add(setSection);
    return () => void listeners.delete(setSection);
  }, []);
  return section ? <CapabilitiesDialog section={section} onClose={() => setSection(null)} /> : null;
}

function Status({ status }: { status: CapabilityStatus }) {
  const t = useT();
  return (
    <span class={`capability-status status-${status}`} data-status={status}>
      {t(`capabilities.status.${status}`)}
    </span>
  );
}

function CapabilitiesDialog({
  section,
  onClose,
}: {
  section: CapabilitySection;
  onClose: () => void;
}) {
  const t = useT();
  const { locale } = useAppState();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    d?.querySelector(`#capabilities-${section}`)?.scrollIntoView({ block: 'start' });
    return () => d?.close();
  }, [section]);
  const key = (k: string) => k as MessageKey;
  return (
    <dialog
      ref={dialog}
      class="dialog capabilities-dialog"
      dir={locale.dir}
      data-testid="capabilities-dialog"
      data-section={section}
      aria-labelledby="capabilities-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="capabilities-title">{t('capabilities.title')}</h2>
      <p>{t('capabilities.intro')}</p>

      <section id="capabilities-firmware" aria-labelledby="capabilities-h-firmware">
        <h3 id="capabilities-h-firmware">{t('capabilities.section.firmware')}</h3>
        <ul class="capability-list">
          {FIRMWARE_FACILITIES.map((f) => (
            <li key={f.id} data-testid={`capability-facility-${f.id}`} data-status={f.status}>
              <strong>{t(key(`capabilities.facility.${f.id}.name`))}</strong>{' '}
              <Status status={f.status} />
              <div class="small">{t(key(`capabilities.facility.${f.id}.body`))}</div>
            </li>
          ))}
        </ul>
      </section>

      <section id="capabilities-parts" aria-labelledby="capabilities-h-parts">
        <h3 id="capabilities-h-parts">{t('capabilities.section.parts')}</h3>
        <ul class="capability-list">
          {partCapabilities().map((p) => (
            <li key={p.type} data-testid={`capability-part-${p.type}`} data-status={p.status}>
              <strong>{catalogText(locale, CATALOG[p.type].nameKey)}</strong>{' '}
              <Status status={p.status} />
              <div class="small">
                {p.reason
                  ? t(key(`palette.unavailable.${p.reason}`))
                  : t('capabilities.parts.supported')}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section id="capabilities-timing" aria-labelledby="capabilities-h-timing">
        <h3 id="capabilities-h-timing">{t('capabilities.section.timing')}</h3>
        <ul class="capability-list">
          {TIMING_CONTRACT.map((id) => (
            <li key={id} data-testid={`capability-timing-${id}`}>
              {t(key(`capabilities.timing.${id}`))}
            </li>
          ))}
        </ul>
      </section>

      <section id="capabilities-limits" aria-labelledby="capabilities-h-limits">
        <h3 id="capabilities-h-limits">{t('capabilities.section.limits')}</h3>
        <ul class="capability-list">
          {SESSION_LIMITS.map((id) => (
            <li key={id} data-testid={`capability-limit-${id}`}>
              {t(key(`capabilities.limit.${id}`))}
            </li>
          ))}
        </ul>
      </section>

      <div class="dialog-actions">
        <button
          type="button"
          class="button"
          data-testid="capabilities-close"
          autofocus
          onClick={onClose}
        >
          {t('capabilities.close')}
        </button>
      </div>
    </dialog>
  );
}
