/**
 * ESP32 terminal (Sprint 6): the board's serial console (UART0) as the running session reports
 * it, from the chip's own boot ROM lines to the firmware's prints, with the session state above
 * it. Shown under the canvas for projects with a Classic ESP32 board.
 *
 * Everything here is ephemeral runtime view (bounded to the runtime view's serial window), never
 * project data. After Stop the last session's output stays readable, marked as ended, until the
 * next Run starts a fresh session or another project opens. Serial text is technical: always LTR.
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { isolateLtr } from '../i18n/i18n.js';
import type { MessageKey } from '../i18n/messages.en.js';
import type { RuntimeView } from '../runtime/view.js';
import { useAppState, useT } from './context.js';

interface Shown {
  projectId: string;
  serial: string;
  dropped: number;
}

export function McuTerminal() {
  const { sim, doc } = useAppState();
  const t = useT();
  const [open, setOpen] = useState(true);
  const out = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  const last = useRef<Shown | null>(null);

  const runtime: RuntimeView | undefined = 'runtime' in sim ? sim.runtime : undefined;
  const projectId = doc?.projectId ?? '';
  if (runtime) last.current = { projectId, serial: runtime.serial, dropped: runtime.serialDropped };
  const shown = last.current?.projectId === projectId ? last.current : null;
  const ended = !runtime && shown !== null;

  // Follow new output unless the reader has scrolled back to look at earlier lines.
  useLayoutEffect(() => {
    const el = out.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [shown?.serial, open]);

  const state = stateKey(sim.status, runtime);
  const seconds = runtime ? Number(BigInt(runtime.simNs) / 1_000_000n) / 1000 : null;

  return (
    <section
      class={`mcu-terminal ${open ? 'open' : 'collapsed'}`}
      data-testid="mcu-terminal"
      aria-labelledby="mcu-terminal-heading"
    >
      <header class="mcu-terminal-bar">
        <button
          type="button"
          class="mcu-terminal-toggle"
          aria-expanded={open}
          aria-controls="mcu-terminal-body"
          data-testid="mcu-terminal-toggle"
          onClick={() => setOpen(!open)}
        >
          <svg
            viewBox="0 0 12 12"
            width="12"
            height="12"
            aria-hidden="true"
            class={`mcu-terminal-chevron ${open ? 'open' : ''}`}
          >
            <path d="M4 2.5 L8 6 L4 9.5" />
          </svg>
          <span id="mcu-terminal-heading">{t('mcu.terminal.heading')}</span>
        </button>
        <span
          class={`mcu-terminal-state state-${state}`}
          role="status"
          aria-live="polite"
          data-testid="mcu-terminal-state"
          data-state={ended ? 'ended' : state}
        >
          <span class="mcu-terminal-dot" aria-hidden="true" />
          {t(ended ? 'mcu.terminal.state.ended' : (`mcu.terminal.state.${state}` as MessageKey))}
          {seconds !== null && state === 'running' && (
            <span class="technical">
              {' · '}
              {t('mcu.terminal.simTime', { time: isolateLtr(`${seconds.toFixed(1)} s`) })}
            </span>
          )}
        </span>
        {shown && shown.dropped > 0 && (
          <span class="muted small">
            {t('mcu.serial.dropped', { count: isolateLtr(String(shown.dropped)) })}
          </span>
        )}
      </header>
      {open && (
        <pre
          ref={out}
          id="mcu-terminal-body"
          class="mcu-terminal-output"
          dir="ltr"
          role="log"
          tabIndex={0}
          aria-label={t('mcu.terminal.heading')}
          data-testid="mcu-serial-output"
          data-ended={ended ? 'true' : undefined}
          onScroll={(e) => {
            const el = e.currentTarget;
            atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          }}
        >
          {shown?.serial ? (
            shown.serial
          ) : (
            <span class="mcu-terminal-empty">
              {t(runtime ? 'mcu.serial.empty' : 'mcu.terminal.idle')}
            </span>
          )}
        </pre>
      )}
    </section>
  );
}

type TerminalState =
  'idle' | 'starting' | 'booting' | 'running' | 'reconnecting' | 'stopping' | 'failed';

function stateKey(status: string, runtime: RuntimeView | undefined): TerminalState {
  if (status === 'failed') return 'failed';
  if (status === 'stopping') return 'stopping';
  if (!runtime) return status === 'starting' ? 'starting' : 'idle';
  if (runtime.connection === 'reconnecting') return 'reconnecting';
  if (status === 'running') return 'running';
  // The session runs (QEMU is up) before the first operating point arrives: the chip is booting.
  return runtime.sessionState === 'running' ? 'booting' : 'starting';
}
