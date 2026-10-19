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
  PROGRAM_FIRMWARE,
  firmwareBySha,
  type BoardPin,
  type ComponentInstance,
} from '@tbi-lab/domain';
import { formatQuantity, isolateLtr, translate, type LocaleInfo } from '../i18n/i18n.js';
import type { MessageKey } from '../i18n/messages.en.js';
import type { GpioLevel, RuntimeView, RuntimeWarning } from '../runtime/view.js';
import { formatDuty, formatFrequency } from '../sim/format.js';
import { useRef } from 'preact/hooks';
import { useAppState, useStore, useT } from './context.js';

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
  const { sim, locale, readOnly } = useAppState();
  const store = useStore();
  const t = useT();
  const fw = typeof c.params.firmware === 'string' ? firmwareBySha(c.params.firmware) : undefined;
  const active = sim.status === 'starting' || sim.status === 'running' || sim.status === 'stopping';
  const prebuiltInput = useRef<HTMLInputElement>(null);
  const runtime: RuntimeView | undefined =
    'runtime' in sim && sim.runtime?.board === c.id ? sim.runtime : undefined;
  const pins =
    sim.status === 'running' && runtime && sim.outcome.ok ? (sim.outcome.pins ?? []) : [];
  const voltageOf = (gpio: number) => pins.find((p) => p.gpio === gpio)?.voltage;

  return (
    <section class="mcu-panel" data-testid="mcu-panel" aria-labelledby="mcu-panel-heading">
      <h3 id="mcu-panel-heading">{t('mcu.heading')}</h3>
      {/* What the board runs (Sprint 7): its code (the normal workflow), or a reference image. */}
      {c.params.firmware === PROGRAM_FIRMWARE ? (
        <p class="small" data-testid="mcu-runs" data-runs="program">
          {t('mcu.runs.program')}
        </p>
      ) : (
        fw && (
          <div data-testid="mcu-runs" data-runs="reference">
            <p class="small">{t('mcu.runs.reference', { name: t(fw.nameKey as MessageKey) })}</p>
            <p class="muted small" data-testid="mcu-firmware-description">
              {t(fw.descriptionKey as MessageKey)}
            </p>
            {!readOnly && (
              <button
                type="button"
                class="button button-small"
                data-testid="mcu-use-program"
                disabled={active}
                onClick={() => store.useBoardProgram(c.id)}
              >
                {t('mcu.runs.useProgram')}
              </button>
            )}
          </div>
        )
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
                  data-pwm={live?.pwm?.kind}
                >
                  <td class="technical" dir="ltr">{`GPIO${gpio}`}</td>
                  <td class="technical" dir="ltr">
                    {live ? liveLevelText(locale, live) : ''}
                    {v !== undefined
                      ? `${live ? ' · ' : ''}${pinVoltageText(locale, live, v)}`
                      : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {/* Serial output: the ESP32 terminal under the properties (McuTerminal). */}
      {store.builds?.available && (
        <details class="mcu-advanced" data-testid="mcu-advanced">
          <summary>{t('mcu.advanced.heading')}</summary>
          <p class="muted small">{t('mcu.advanced.note')}</p>
          <input
            ref={prebuiltInput}
            type="file"
            class="visually-hidden"
            tabIndex={-1}
            accept=".bin,application/octet-stream"
            aria-label={t('mcu.advanced.runPrebuilt')}
            data-testid="mcu-prebuilt-file"
            onChange={(e) => {
              const el = e.currentTarget;
              const file = el.files?.[0];
              el.value = '';
              if (file) void store.runPrebuilt(file);
            }}
          />
          <button
            type="button"
            class="button button-small"
            data-testid="mcu-run-prebuilt"
            disabled={active}
            onClick={() => prebuiltInput.current?.click()}
          >
            {t('mcu.advanced.runPrebuilt')}
          </button>
        </details>
      )}
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
                  data-pwm={live?.pwm?.kind}
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
                    {live ? liveLevelText(locale, live) : ''}
                    {v !== undefined ? ` · ${pinVoltageText(locale, live, v)}` : ''}
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

/**
 * A pad's live state: "HIGH · output", or for an LEDC (PWM) output (Sprint 15, R4) its waveform as
 * the host reports it: "PWM 1 kHz · 25 %"; duty 0 (its level is not established, O-R4-1); a
 * steady level (0 % or 100 %); or a configuration the simulator does not support.
 */
export function liveLevelText(locale: LocaleInfo, live: GpioLevel): string {
  const t = (key: MessageKey, params?: Record<string, string>) => translate(locale, key, params);
  const level = (l: 0 | 1) => t(l ? 'mcu.level.high' : 'mcu.level.low');
  const pwm = live.pwm;
  if (!pwm) return `${level(live.level)} · ${t(live.drive ? 'mcu.mode.output' : 'mcu.mode.input')}`;
  switch (pwm.kind) {
    case 'wave':
      return t('mcu.pwm.wave', {
        frequency: isolateLtr(formatFrequency(locale, 1e9 / pwm.periodNs)),
        duty: isolateLtr(formatDuty(locale, pwm.duty)),
      });
    case 'zero':
      return t('mcu.pwm.zero');
    case 'static':
      return t('mcu.pwm.static', { level: level(pwm.level) });
    case 'unsupported':
      return t('mcu.pwm.unsupported');
  }
}

/**
 * A pad's solved voltage; a switching PWM pad's is its time-average over the waveform. Sprint 17C:
 * a duty-0 or unsupported PWM pad has no established level (O-R4-1), so no voltage is shown as fact.
 */
export function pinVoltageText(
  locale: LocaleInfo,
  live: GpioLevel | undefined,
  volts: number,
): string {
  if (live?.pwm?.kind === 'zero' || live?.pwm?.kind === 'unsupported')
    return translate(locale, 'mcu.pwm.levelUnknown');
  const v = formatQuantity(locale, { value: volts, unit: 'volt' });
  return live?.pwm?.kind === 'wave' ? translate(locale, 'mcu.pwm.average', { voltage: v }) : v;
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
  if (w.code === 'servo_signal_undefined') {
    const component = (w.detail as { component?: string } | undefined)?.component;
    return t('mcu.warning.servo_signal_undefined', { component: isolateLtr(component ?? '') });
  }
  const i2c = i2cWarningText(t, w);
  if (i2c) return i2c;
  return t('mcu.warning.generic', { code: isolateLtr(w.code) });
}

/**
 * Sprint 13 OS-09: the I2C diagnostics of the Session Host (runtime/host/i2cDevices.ts), each
 * with what is wrong and where, instead of the bare code. Unknown shapes fall back to the code.
 */
export function i2cWarningText(t: ReturnType<typeof useT>, w: RuntimeWarning): string | null {
  const d = (w.detail ?? {}) as {
    component?: string;
    reason?: string;
    line?: string;
    gpio?: number;
    terminal?: string;
    sda?: number;
    scl?: number;
    lines?: { line: string; gpio: number }[];
  };
  const component = isolateLtr(d.component ?? '');
  const io = (g: number | undefined) => isolateLtr(g === undefined ? '' : `GPIO${g}`);
  const lineName = (l: string | undefined) => isolateLtr((l ?? '').toUpperCase());
  if (w.code === 'i2c_wiring' && d.reason === 'supply_pin')
    return t('mcu.warning.i2c_wiring.supply_pin', {
      component,
      gpio: io(d.gpio),
      line: lineName(d.line),
      terminal: lineName(d.terminal),
    });
  if (w.code === 'i2c_wiring' && d.reason === 'swapped')
    return t('mcu.warning.i2c_wiring.swapped', { component, sda: io(d.sda), scl: io(d.scl) });
  const lines = isolateLtr((d.lines ?? []).map((l) => l.line.toUpperCase()).join(', '));
  if (w.code === 'i2c_no_pullup') return t('mcu.warning.i2c_no_pullup', { component, lines });
  if (w.code === 'i2c_logic_level') return t('mcu.warning.i2c_logic_level', { component, lines });
  if (w.code === 'i2c_rate_exceeded') return t('mcu.warning.i2c_rate_exceeded');
  return null;
}
