import { useAppState, useStore, useT } from './context.js';

/**
 * Run and Stop. They exist because they now do real work: Run solves the project in the
 * Worker; Stop discards runtime results. There is no Pause: a DC operating point has no
 * time to pause (roadmap Sprint 3).
 */
export function SimControls() {
  const { sim } = useAppState();
  const store = useStore();
  const t = useT();
  const active = sim.status === 'running' || sim.status === 'starting';
  return (
    <div class="sim-controls" role="group" aria-label={t('sim.controls')}>
      <button
        type="button"
        class="button button-run"
        data-testid="sim-run"
        disabled={active}
        onClick={() => store.run()}
      >
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" class="sim-icon">
          <path d="M2 1 L11 6 L2 11 Z" />
        </svg>{' '}
        {t('sim.run')}
      </button>
      <button
        type="button"
        class="button"
        data-testid="sim-stop"
        disabled={sim.status === 'stopped'}
        onClick={() => store.stop()}
      >
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" class="sim-icon">
          <rect x="2" y="2" width="8" height="8" />
        </svg>{' '}
        {t('sim.stop')}
      </button>
      <span
        class={`sim-status sim-${sim.status}`}
        role="status"
        aria-live="polite"
        data-testid="sim-status"
        data-status={sim.status}
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
        {t(`sim.status.${sim.status}`)}
      </span>
    </div>
  );
}
