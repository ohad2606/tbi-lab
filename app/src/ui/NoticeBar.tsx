import { useEffect, useRef } from 'preact/hooks';
import { simLimitText, simLimitUi } from '../runtime/limits.js';
import { LearnMore, sectionForFailure } from './Capabilities.js';
import { PREVIEW_NAME } from '../deployment.js';
import { isolateLtr } from '../i18n/i18n.js';
import type { SimFailure } from '../sim/controller.js';
import type { RatingWarning } from '@tbi-lab/engine';
import { engineErrorParts, groupByComponent, ratingRow, simFailureMessage } from '../sim/format.js';
import { warningsFor } from '../sim/ratings.js';
import { useAppState, useStore, useT } from './context.js';
import { TOOLBAR_BUILD_ID, programBoardOf, requestCodeView } from './buildAction.js';
import { ExportReminder, TabOutdatedBanner } from './StorageNotices.js';

const damage = (w: RatingWarning[]) => w.filter((x) => x.kind === 'absolute');
const operating = (w: RatingWarning[]) => w.filter((x) => x.kind !== 'absolute');
/** One group per component and kind (a part can be both `operating` and `unrated`). */
const byComponentAndKind = (w: RatingWarning[]) =>
  groupByComponent(w).flatMap(([id, rows]) =>
    (['operating', 'unrated'] as const)
      .map((k) => [id, rows.filter((r) => r.kind === k)] as const)
      .filter(([, g]) => g.length),
  );

export function NoticeBar() {
  const { notice, readOnly, unreadable, sim, locale, doc, saveState, saveError, screen } =
    useAppState();
  const store = useStore();
  const t = useT();
  const running = sim.status === 'running' ? sim.outcome : null;
  return (
    <div class="banners">
      {/* K11 live regions live INSIDE this one grid row: as separate children of .app (an explicit
          grid-template-rows) their empty wrappers would take grid cells and push the workspace
          out of the 1fr row. Empty, they have no height; they stay in the accessibility tree. */}
      <TabOutdatedBanner />
      <ExportReminder />
      {/* A preview deployment says so on every screen (deployment.ts), never in the top bar's
          space, which the editor's controls need. */}
      {PREVIEW_NAME && (
        <div class="banner preview-strip" role="note" data-testid="preview-badge">
          <strong>{t('deployment.preview', { name: PREVIEW_NAME })}</strong>
          <span>{t('deployment.previewNote')}</span>
        </div>
      )}
      <QueueStatus />
      <LimitNotice />
      {sim.status === 'failed' && !softLimit(sim) && (
        <div
          class="banner banner-error"
          role="alert"
          data-testid="sim-error"
          data-code={failureCode(sim.failure)}
        >
          {sim.failure.kind === 'engine' ? (
            <EngineErrorText parts={engineErrorParts(locale, sim.failure.error, doc)} />
          ) : (
            simFailureMessage(locale, sim.failure, doc)
          )}
          {sectionForFailure(failureCode(sim.failure)) && (
            <>
              {' '}
              <LearnMore section={sectionForFailure(failureCode(sim.failure))!} />
            </>
          )}
        </div>
      )}
      {sim.status === 'running' && sim.runtime?.expiresSoon && (
        // Alpha: about a minute before the host's maximum session lifetime. Informational; the
        // session is never extended (the final `session_expired` message follows at the end).
        <div class="banner banner-warning" role="status" data-testid="session-expiring">
          {t('sim.runtime.expiring', {
            minutes: isolateLtr(
              String(Math.max(1, Math.ceil(sim.runtime.expiresSoon.lifetimeMs / 60_000))),
            ),
          })}
        </div>
      )}
      {running && !running.ok && (
        <div
          class="banner banner-error"
          role="alert"
          data-testid="sim-error"
          data-code={running.error.code}
        >
          <EngineErrorText parts={engineErrorParts(locale, running.error, doc)} />
        </div>
      )}
      {running?.ok && doc && damage(warningsFor(doc, running)).length > 0 && (
        // A documented ABSOLUTE MAXIMUM is exceeded: a WARNING (amber), distinct from the red
        // solver errors above. The solved values are unchanged.
        <div class="banner banner-warning banner-rating" role="status" data-testid="rating-warning">
          <strong class="rating-title">{t('rating.heading')}</strong>
          {groupByComponent(damage(warningsFor(doc, running))).map(([id, rows]) => (
            <RatingGroup key={id} component={id} rows={rows} />
          ))}
          <span class="rating-note small">{t('rating.note')}</span>
        </div>
      )}
      {running?.ok && doc && operating(warningsFor(doc, running)).length > 0 && (
        // Sprint 13 H2: outside the specified OPERATING range only, no absolute maximum published: the damage threshold is unknown (never presented as safe); the result
        // may not match a real part.
        <div
          class="banner banner-warning banner-rating banner-operating"
          role="status"
          data-testid="operating-warning"
        >
          <strong class="rating-title">{t('rating.operating.heading')}</strong>
          {byComponentAndKind(operating(warningsFor(doc, running))).map(([id, rows]) => (
            <RatingGroup key={`${id}-${rows[0]!.kind}`} component={id} rows={rows} />
          ))}
          {operating(warningsFor(doc, running)).some((w) => w.kind === 'operating') && (
            <span class="rating-note small">{t('rating.operating.note')}</span>
          )}
          {operating(warningsFor(doc, running)).some((w) => w.kind === 'unrated') && (
            <span class="rating-note small" data-testid="unrated-note">
              {t('rating.unrated.note')}
            </span>
          )}
        </div>
      )}
      {running?.ok && running.notConnected.length > 0 && (
        <div class="banner banner-info" role="status" data-testid="sim-not-connected">
          {t('sim.notConnected', { components: isolateLtr(running.notConnected.join(', ')) })}
        </div>
      )}
      {readOnly && (
        <div class="banner banner-warning" role="status" data-testid="readonly-banner">
          {t('readonly.newer', { version: isolateLtr(String(readOnly.schemaVersion)) })}
        </div>
      )}
      {unreadable && (
        <div class="banner banner-warning" role="alert">
          <bdi dir="auto">{unreadable.name}</bdi>
          {': '}
          {t('readonly.unreadable', { version: isolateLtr(String(unreadable.schemaVersion)) })}
        </div>
      )}
      {screen === 'editor' && saveState === 'error' && saveError === 'conflict' && (
        // Sprint 13 Task D: another tab or window changed or deleted this project. Retrying cannot
        // help (it would overwrite their change): keep this version by Export, then reload.
        <div class="banner banner-warning" role="alert" data-testid="save-conflict">
          <span>{t('save.error.conflictBanner')}</span>
          <button type="button" class="link-button" onClick={() => location.reload()}>
            {t('save.reload')}
          </button>
        </div>
      )}
      {screen === 'editor' && saveState === 'error' && saveError !== 'conflict' && (
        <div class="banner banner-warning" role="alert" data-testid="save-error">
          <span>{t(saveError === 'quota' ? 'save.error.quotaBanner' : 'save.error.banner')}</span>
          <button type="button" class="link-button" onClick={() => void store.retrySave()}>
            {t('save.retry')}
          </button>
        </div>
      )}
      {notice && (
        <div
          class={`banner banner-${notice.tone ?? 'error'}`}
          role={notice.tone === 'info' ? 'status' : 'alert'}
          data-testid="notice"
          data-key={notice.key}
          data-tone={notice.tone ?? 'error'}
        >
          <span>{t(notice.key, notice.params)}</span>
          {notice.also?.map((k) => (
            <span key={k} data-testid="notice-also" data-key={k}>
              {' '}
              {t(k)}
            </span>
          ))}
          {/* Alpha UX-P1: Run without a current build offers the Build itself (never automatic). */}
          {notice.key === 'run.blocked.buildRequired' && programBoardOf(doc) && (
            <button
              type="button"
              class="button notice-build"
              data-testid="notice-build"
              onClick={() => {
                const board = programBoardOf(doc)!;
                store.dismissNotice();
                // Focus follows to the toolbar Build: its live state reports progress and result.
                document.getElementById(TOOLBAR_BUILD_ID)?.focus();
                void store.buildProgram(board);
              }}
            >
              {t('toolbar.build')}
            </button>
          )}
          {notice.key === 'run.blocked.buildFailed' && programBoardOf(doc) && (
            <button
              type="button"
              class="link-button"
              data-testid="notice-build-problems"
              onClick={() => {
                store.dismissNotice();
                requestCodeView();
              }}
            >
              {t('toolbar.build.showProblems')}
            </button>
          )}
          <button type="button" class="link-button" onClick={() => store.dismissNotice()}>
            {t('notice.dismiss')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A known unsupported configuration reads as a titled explanation with guidance, not as a
 * mysterious solver failure; other errors are one sentence.
 */
function EngineErrorText({ parts }: { parts: ReturnType<typeof engineErrorParts> }) {
  if (!parts.title) return <>{parts.body}</>;
  return (
    <span class="banner-structured" data-testid="sim-error-structured">
      <strong class="banner-title">{parts.title}</strong>
      <span>{parts.body}</span>
      {parts.hint && <span class="banner-hint">{parts.hint}</span>}
    </span>
  );
}

/** Focus the Run control once it is back in the DOM (a button that unmounts must not drop focus to body). */
function focusRunSoon() {
  const until = Date.now() + 1000;
  const focusRun = () => {
    const run = document.querySelector<HTMLElement>('[data-testid="sim-run"]');
    if (run) run.focus();
    else if (Date.now() < until) requestAnimationFrame(focusRun);
  };
  requestAnimationFrame(focusRun);
}

/** Where focus should land once the restarted run has an outcome. */
function retryOutcomeTarget(status: string, retryAgain: boolean): string {
  if (status === 'running') return 'sim-stop';
  if (status === 'failed' && retryAgain) return 'limit-retry';
  return 'sim-run';
}

/** The refused-start limit of a failed run when it is a calm "try again later" (not a hard refusal). */
function softLimit(sim: ReturnType<typeof useAppState>['sim']) {
  if (sim.status !== 'failed' || sim.failure.kind !== 'runtime' || !sim.failure.limit) return null;
  const ui = simLimitUi(sim.failure.limit.code);
  return ui && ui.role === 'status' ? { limit: sim.failure.limit, ui } : null;
}

/**
 * BETA-G2 s3: the host answered a start with "try again later" (paused, queue full, no slot in time,
 * unavailable, cooldown). One polite status region (always in the DOM so the text is announced when it
 * appears; a repeat is the natural empty -> text change: store.run() clears it while starting), calm
 * info styling with the text carrying the meaning (never colour only), and a Try again button OUTSIDE
 * the region that restarts the same start. Nothing moves focus when it appears; when Try again
 * unmounts it, focus follows the outcome (Stop, the new Try again, or Run). Hard refusals (minutes used up, ...) stay the role=alert error.
 */
export function LimitNotice() {
  const { sim, locale } = useAppState();
  const store = useStore();
  const t = useT();
  const soft = softLimit(sim);
  const text = soft ? simLimitText(locale, soft.limit) : null;
  // A restart in flight: ignores further clicks; focus is settled once the outcome is known.
  const pending = useRef(false);
  useEffect(() => {
    if (!pending.current || sim.status === 'starting') return;
    pending.current = false;
    const target = retryOutcomeTarget(sim.status, !!soft?.ui.retry);
    // Only act when focus was lost (on <body> or on the removed button); never steal it. Try now (the
    // DOM is committed), then per frame for up to a second if the target is not rendered yet.
    const until = Date.now() + 1000;
    const settle = () => {
      const a = document.activeElement;
      if (a && a !== document.body && a.isConnected) return;
      const el = document.querySelector<HTMLElement>(`[data-testid="${target}"]`);
      if (el) el.focus();
      else if (Date.now() < until) requestAnimationFrame(settle);
    };
    settle();
  }, [sim]);
  return (
    <div
      class={soft ? 'banner banner-info limit-notice' : 'limit-notice-idle'}
      data-testid="limit-notice"
      data-code={soft?.limit.code}
    >
      <div role="status" aria-label={t('sim.limit.region_label')} data-testid="limit-status">
        {text}
      </div>
      {soft?.ui.retry && (
        <button
          type="button"
          class="button"
          data-testid="limit-retry"
          onClick={() => {
            if (pending.current) return; // a start is already in flight
            pending.current = true;
            store.run();
            // Blocked before starting (a notice instead): nothing will change, keep focus here.
            if (store.state.sim.status !== 'starting') pending.current = false;
          }}
        >
          {t('sim.limit.retry')}
        </button>
      )}
    </div>
  );
}

/**
 * TBI-018 s3d-5: the run waits in the host's fair queue. One polite status region (always in the
 * DOM, so a change is announced; the text changes only when the place changes, never on a poll) and
 * one Cancel button OUTSIDE the region. Nothing here moves focus; when Cancel removes itself, focus
 * goes to the Run control (never to <body>). Against a host without metering this renders nothing.
 */
export function QueueStatus() {
  const { sim, locale } = useAppState();
  const store = useStore();
  const t = useT();
  const position = sim.status === 'starting' ? sim.runtime?.queue?.position : undefined;
  const queued = position !== undefined;
  const text = queued ? simLimitText(locale, { code: 'queue', params: { n: position } }) : null;
  const cancel = () => {
    store.stop();
    // The button unmounts with the queue: keep focus on a control (the Run button).
    focusRunSoon();
  };
  return (
    <div
      class={queued ? 'banner banner-info queue-status' : 'queue-status-idle'}
      data-testid="queue-banner"
    >
      <div
        role="status"
        aria-label={t('sim.queue.waiting_label')}
        data-testid="queue-status"
        data-position={queued ? String(position) : undefined}
      >
        {text}
      </div>
      {queued && (
        <button type="button" class="button" data-testid="queue-cancel" onClick={cancel}>
          {t('sim.queue.cancel')}
        </button>
      )}
    </div>
  );
}

function failureCode(f: SimFailure): string {
  return f.kind === 'engine' ? f.error.code : f.code;
}

/** One over-stressed part: "D1 may be damaged", then one compact row per exceeded rating. */
export function RatingGroup({ component, rows }: { component: string; rows: RatingWarning[] }) {
  const { locale } = useAppState();
  const t = useT();
  return (
    <div
      class="rating-group"
      data-testid={`rating-${component}`}
      data-model={rows[0]?.model}
      data-kind={rows[0]?.kind}
    >
      <span class="rating-summary">
        {t(
          rows[0]?.kind === 'operating'
            ? 'rating.operating.summary'
            : rows[0]?.kind === 'unrated'
              ? 'rating.unrated.summary'
              : 'rating.atRisk',
          { component: isolateLtr(component) },
        )}
      </span>
      <ul class="rating-list">
        {rows.map((w) => (
          <li key={w.code} data-code={w.code} data-unreliable={w.unreliable ? 'true' : undefined}>
            {ratingRow(locale, w)}
          </li>
        ))}
      </ul>
    </div>
  );
}
