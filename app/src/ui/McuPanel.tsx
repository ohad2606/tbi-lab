/**
 * Classic ESP32 panel in the inspector (Sprint 6): what the selected firmware does, the board's
 * pin capabilities as the simulator supports them (R1 capability map, nothing inferred), and,
 * while a session runs, live pin levels and runtime warnings. Serial output is in the ESP32
 * terminal under the properties (McuTerminal).
 *
 * Runtime values come only from the ephemeral runtime view; nothing here is project data.
 * Pin names, GPIO numbers, levels, voltages and serial text are technical content: always LTR.
 */
import {
  ESP32_DEVKITC_WROOM32,
  firmwareBySha,
  type BoardPin,
  type ComponentInstance,
} from '@tbi-lab/domain';
import { formatQuantity, isolateLtr } from '../i18n/i18n.js';
import type { MessageKey } from '../i18n/messages.en.js';
import type { RuntimeView, RuntimeWarning } from '../runtime/view.js';
import { useAppState, useT } from './context.js';

function caveatKey(pin: BoardPin): MessageKey | null {
  if (pin.role === 'flash') return 'mcu.caveat.flash';
  if (pin.role === 'console-uart') return 'mcu.caveat.console';
  if (pin.role === 'enable') return 'mcu.caveat.enable';
  if (pin.role === 'power') return 'mcu.caveat.power';
  if (pin.role === 'ground') return null;
  if (pin.simulatorSupport === 'digital-input') return 'mcu.caveat.inputOnly';
  if (pin.strapping) return 'mcu.caveat.strapping';
  return null;
}

export function McuPanel({ component: c }: { component: ComponentInstance }) {
  const { sim, locale } = useAppState();
  const t = useT();
  const fw = typeof c.params.firmware === 'string' ? firmwareBySha(c.params.firmware) : undefined;
  const runtime: RuntimeView | undefined =
    'runtime' in sim && sim.runtime?.board === c.id ? sim.runtime : undefined;
  const pins =
    sim.status === 'running' && runtime && sim.outcome.ok ? (sim.outcome.pins ?? []) : [];
  const voltageOf = (gpio: number) => pins.find((p) => p.gpio === gpio)?.voltage;

  return (
    <section class="mcu-panel" data-testid="mcu-panel" aria-labelledby="mcu-panel-heading">
      <h3 id="mcu-panel-heading">{t('mcu.heading')}</h3>
      {fw && (
        <p class="muted small" data-testid="mcu-firmware-description">
          {t(fw.descriptionKey as MessageKey)}
        </p>
      )}
      {!runtime && <p class="muted small">{t('mcu.notRunning')}</p>}
      {runtime?.connection === 'reconnecting' && (
        <p class="small" role="status" data-testid="mcu-reconnecting">
          {t('mcu.connection.reconnecting')}
        </p>
      )}
      {runtime && runtime.missedEvents > 0 && (
        <p class="small" role="status" data-testid="mcu-resync">
          {t('mcu.resync', { count: isolateLtr(String(runtime.missedEvents)) })}
        </p>
      )}
      {runtime && runtime.warnings.length > 0 && (
        <div class="mcu-warnings" role="status" data-testid="mcu-warnings">
          <strong>{t('mcu.warnings.heading')}</strong>
          <ul>
            {runtime.warnings.map((w, i) => (
              <li key={i} data-code={w.code}>
                {warningText(t, w)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {runtime && (
        <table class="mcu-pin-table mcu-live" data-testid="mcu-live-pins">
          <thead>
            <tr>
              <th scope="col">{t('mcu.pins.pin')}</th>
              <th scope="col">{t('mcu.pins.state')}</th>
            </tr>
          </thead>
          <tbody>
            {activePins(runtime, pins).map((gpio) => {
              const live = runtime.gpio[gpio];
              const v = voltageOf(gpio);
              return (
                <tr
                  key={gpio}
                  data-testid={`mcu-live-${gpio}`}
                  data-level={live ? String(live.level) : undefined}
                >
                  <td class="technical" dir="ltr">{`GPIO${gpio}`}</td>
                  <td class="technical" dir="ltr">
                    {live
                      ? `${t(live.level ? 'mcu.level.high' : 'mcu.level.low')} · ${t(live.drive ? 'mcu.mode.output' : 'mcu.mode.input')}`
                      : ''}
                    {v !== undefined
                      ? `${live ? ' · ' : ''}${formatQuantity(locale, { value: v, unit: 'volt' })}`
                      : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {/* Serial output: the ESP32 terminal under the properties (McuTerminal). */}
      <details class="mcu-pins" data-testid="mcu-pins">
        <summary>{t('mcu.pins.heading')}</summary>
        <table class="mcu-pin-table">
          <thead>
            <tr>
              <th scope="col">{t('mcu.pins.pin')}</th>
              <th scope="col">{t('mcu.pins.support')}</th>
              <th scope="col">{t('mcu.pins.state')}</th>
            </tr>
          </thead>
          <tbody>
            {ESP32_DEVKITC_WROOM32.pins.map((pin) => {
              const gpio = pin.gpio;
              const live = gpio !== null ? runtime?.gpio[gpio] : undefined;
              const v = gpio !== null ? voltageOf(gpio) : undefined;
              const caveat = caveatKey(pin);
              return (
                <tr
                  key={`${pin.header}${pin.position}`}
                  data-testid={gpio !== null ? `mcu-pin-${gpio}` : undefined}
                  data-support={pin.simulatorSupport}
                  data-level={live ? String(live.level) : undefined}
                  data-drive={live ? String(live.drive) : undefined}
                >
                  <td class="technical" dir="ltr">
                    {pin.headerLabel}
                    {gpio !== null && pin.headerLabel !== `IO${gpio}` ? ` (GPIO${gpio})` : ''}
                  </td>
                  <td>
                    {t(`mcu.support.${pin.simulatorSupport}`)}
                    {caveat && <span class="muted small block">{t(caveat)}</span>}
                  </td>
                  <td class="technical" dir="ltr">
                    {live
                      ? `${t(live.level ? 'mcu.level.high' : 'mcu.level.low')} · ${t(live.drive ? 'mcu.mode.output' : 'mcu.mode.input')}`
                      : ''}
                    {v !== undefined
                      ? ` · ${formatQuantity(locale, { value: v, unit: 'volt' })}`
                      : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p class="muted small">{t('mcu.note.unsupported')}</p>
      </details>
    </section>
  );
}

/** Pads with live activity or an electrical attachment, in GPIO order. */
function activePins(runtime: RuntimeView, pins: { gpio: number }[]): number[] {
  const set = new Set<number>([
    ...Object.keys(runtime.gpio).map(Number),
    ...pins.map((p) => p.gpio),
  ]);
  return [...set].sort((a, b) => a - b);
}

function warningText(t: ReturnType<typeof useT>, w: RuntimeWarning): string {
  if (w.code === 'output_on_input_only_pad') {
    const gpio = (w.detail as { gpio?: number } | undefined)?.gpio;
    return t('mcu.warning.output_on_input_only_pad', { gpio: isolateLtr(String(gpio ?? '')) });
  }
  if (w.code === 'transient_rejected') return t('mcu.warning.transient_rejected');
  return t('mcu.warning.generic', { code: isolateLtr(w.code) });
}
