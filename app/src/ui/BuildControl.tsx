import { useEffect, useState } from 'preact/hooks';
import { useAppState, useStore, useT } from './context.js';
import { TOOLBAR_BUILD_ID, buildBlocker, programBoardOf, requestCodeView } from './buildAction.js';
import type { MessageKey } from '../i18n/messages.en.js';

/**
 * Alpha UX-P1: the Build action in the main toolbar, next to Run, in every editor view (the top
 * bar is shared by Circuit, Schematic, 3D and Code). Shown when the project has a board that runs
 * its own program, exactly when the Code view exists.
 *
 * It is the code view's Build (store.buildProgram: same service, permissions, queue, errors), with
 * the same unavailability rules. Build never runs the simulation, and Run never builds.
 *
 * Accessibility: an unavailable or busy Build is aria-disabled (not disabled), so it keeps keyboard
 * focus and screen readers can reach it and its reason; activating it then does nothing. The
 * state beside it is a polite live region (Build required / Building… / Built / Build failed).
 */
export function BuildControl() {
  const { doc, sim, readOnly, notice } = useAppState();
  const store = useStore();
  const t = useT();
  const builds = store.builds;
  const [, force] = useState(0);
  useEffect(() => builds?.subscribe(() => force((n) => n + 1)), [builds]);
  const boardId = programBoardOf(doc);
  if (!doc || !boardId || !builds) return null;
  const program = doc.programs[boardId]!;
  const view = builds.view(doc.projectId, boardId, program);
  const simulating =
    sim.status === 'running' || sim.status === 'starting' || sim.status === 'stopping';
  const building = view.phase === 'building';
  const blocker = buildBlocker({
    available: builds.available,
    readOnly: !!readOnly,
    simulating,
    view,
  });
  const unavailable = building || !!blocker;
  // A transport/service refusal leaves the phase `required` with an error code.
  const failed = view.phase === 'failed' || (view.phase === 'required' && !!view.error);
  const stateKey: MessageKey =
    view.phase === 'required' && view.error
      ? 'toolbar.build.error'
      : (`build.phase.${view.phase}` as MessageKey);
  return (
    <div class="build-control" role="group" aria-label={t('toolbar.build.group')}>
      <button
        type="button"
        id={TOOLBAR_BUILD_ID}
        class={`button toolbar-build${building ? ' is-building' : ''}`}
        data-testid="toolbar-build"
        data-phase={view.phase}
        aria-disabled={unavailable ? 'true' : undefined}
        aria-busy={building ? 'true' : undefined}
        aria-describedby={`toolbar-build-state${blocker ? ' toolbar-build-blocked' : ''}`}
        title={blocker ? t(blocker) : undefined}
        onClick={() => {
          if (unavailable) return; // also prevents a duplicate submission while building
          // A "build first" notice from an earlier Run is answered by this Build.
          if (notice?.key.startsWith('run.blocked.build')) store.dismissNotice();
          void store.buildProgram(boardId);
        }}
      >
        <svg
          viewBox="0 0 12 12"
          width="12"
          height="12"
          aria-hidden="true"
          class={`build-icon${building ? ' spinning' : ''}`}
        >
          {building ? (
            <path
              d="M6 1.5 A4.5 4.5 0 1 1 1.5 6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
            />
          ) : (
            <path
              d="M2 2 H10 V10 H2 Z M4 5 H8 M4 7 H8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
            />
          )}
        </svg>
        {t('toolbar.build')}
      </button>
      {/* The phase dot and text (a polite live region: one phrase per change). On failure the
          text is visually replaced by "Show problems" (it stays in the live region). */}
      <span
        class={`build-phase toolbar-build-phase phase-${failed ? 'failed' : view.phase}`}
        title={t(stateKey)}
      >
        <span class="build-dot" aria-hidden="true" />
        <span class="toolbar-build-state-value">
          <span
            id="toolbar-build-state"
            class="toolbar-build-state"
            role="status"
            aria-live="polite"
            data-testid="toolbar-build-state"
            data-phase={view.phase}
          >
            {t(stateKey)}
          </span>
        </span>
      </span>
      {blocker && (
        <span
          id="toolbar-build-blocked"
          class="visually-hidden"
          data-testid="toolbar-build-blocked"
        >
          {t(blocker)}
        </span>
      )}
      {failed && (
        <button
          type="button"
          class="link-button toolbar-build-problems"
          data-testid="toolbar-build-problems"
          onClick={() => requestCodeView()}
        >
          {t('toolbar.build.showProblems')}
        </button>
      )}
    </div>
  );
}
