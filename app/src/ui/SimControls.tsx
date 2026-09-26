import { useAppState, useStore, useT } from './context.js';

/**
 * One stateful simulation control (Product Alpha maintenance). Stopped (or after a failed run):
 * "Run" with a play icon, green. Running or starting: the SAME button reads "Stop" with a stop
 * icon, red. Run solves the project in the Worker; Stop discards runtime results. There is no
 * Pause: a DC operating point has no time to pause (roadmap Sprint 3).
 *
 * Both faces are rendered in one grid cell and the inactive one is hidden, so the button always
 * has the width of its longer label in the current locale: toggling never moves the toolbar, and
 * no width is tuned to English. The hidden face is aria-hidden, so the accessible name is the
 * visible label. The element itself never changes, so keyboard focus stays on it.
 */
/** Status labels, including the ESP32 running label (Sprint 6): all of them size the pill. */
const LABELS = [
  'sim.status.stopped',
  'sim.status.starting',
  'sim.status.running',
  'sim.status.runningMcu',
  'sim.status.stopping',
  'sim.status.failed',
] as const;

export function SimControls() {
  const { sim } = useAppState();
  const store = useStore();
  const t = useT();
  const active = sim.status === 'running' || sim.status === 'starting' || sim.status === 'stopping';
  const action = active ? 'stop' : 'run';
  // An ESP32 session is ending: the control stays "Stop" but is busy until it has ended.
  const busy = sim.status === 'stopping';
  const mcu = 'runtime' in sim && sim.runtime !== undefined;
  const label =
    sim.status === 'running' && mcu
      ? 'sim.status.runningMcu'
      : (`sim.status.${sim.status}` as const);
  return (
    <div class="sim-controls" role="group" aria-label={t('sim.controls')}>
      <button
        type="button"
        class={`button sim-toggle sim-toggle-${action}`}
        data-testid={`sim-${action}`}
        data-action={action}
        data-engine={mcu ? 'mcu' : 'local'}
        disabled={busy}
        aria-busy={busy ? 'true' : undefined}
        onClick={() => (active ? store.stop() : store.run())}
      >
        <span class="sim-toggle-face" data-face="run" aria-hidden={active ? 'true' : undefined}>
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" class="sim-icon">
            <path d="M2 1 L11 6 L2 11 Z" />
          </svg>
          {t('sim.run')}
        </span>
        <span class="sim-toggle-face" data-face="stop" aria-hidden={active ? undefined : 'true'}>
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" class="sim-icon">
            <rect x="2" y="2" width="8" height="8" />
          </svg>
          {t('sim.stop')}
        </span>
      </button>
      <span
        class={`sim-status sim-${sim.status}`}
        role="status"
        aria-live="polite"
        data-testid="sim-status"
        data-status={sim.status}
        {...(mcu && 'runtime' in sim && sim.runtime
          ? {
              'data-engine': 'mcu',
              'data-session-state': sim.runtime.sessionState,
              'data-sim-ns': sim.runtime.simNs,
              'data-connection': sim.runtime.connection,
              // Determinism evidence: canonical hash of the runtime events so far, and its
              // per-simulated-second checkpoints (see runtime/view.ts).
              'data-trace-events': sim.runtime.trace.events,
              'data-trace-hash': sim.runtime.trace.hash,
              'data-trace-checkpoints': JSON.stringify(sim.runtime.trace.checkpoints),
            }
          : {})}
        // Measured timings of the latest solve, for performance evidence (not displayed).
        {...(sim.status === 'running'
          ? {
              'data-solves': sim.solves,
              'data-worker-start-ms': sim.timings.workerStartMs ?? '',
              'data-request-ms': sim.timings.requestTransferMs,
              'data-solve-ms': sim.timings.solveMs,
              'data-result-ms': sim.timings.resultTransferMs,
              'data-total-ms': sim.timings.totalMs,
              'data-applied-revision': sim.outcome.appliedRevision,
            }
          : {})}
      >
        <span class="sim-status-label" data-testid="sim-status-label">
          {t(label)}
        </span>
        {/* Every status label, invisible, in the same grid cell, in BOTH font weights the pill
            uses (running/starting are bold): the pill always has the width of the longest label
            at its widest weight in this locale and font, whatever the current state, so a status
            change never moves the toolbar. */}
        {LABELS.flatMap((s) =>
          (['regular', 'bold'] as const).map((w) => (
            <span
              key={`${s}-${w}`}
              class={`sim-status-sizer sim-status-sizer-${w}`}
              aria-hidden="true"
            >
              {t(s)}
            </span>
          )),
        )}
      </span>
    </div>
  );
}
