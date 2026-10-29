/**
 * "Report a problem" (Sprint 14): a short description, an area and an optional "blocking" flag,
 * sent to the deployment's Session Host. Opened from the application menu; present only when the
 * deployment enables reports (PROBLEM_REPORTS). The logic lives in problemReport.ts.
 *
 * The confirmation (with the report id) appears only after the server has durably stored the
 * report; any failure keeps the text and says what to do. The draft survives closing the dialog
 * until it is sent. The description is the tester's own text: shown as written (`dir="auto"`),
 * never translated or rewritten. Keyboard: the description has focus on open, Tab stays inside
 * the dialog, Escape closes it, and focus returns to the control that opened it.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { BUILD_INFO } from '../buildInfo.js';
import { PROBLEM_REPORTS } from '../deployment.js';
import { gateFetch } from '../gate.js';
import type { MessageKey } from '../i18n/i18n.js';
import { useAppState, useT } from './context.js';
import { probeRuntime } from '../runtimeInfo.js';
import {
  MAX_COMPONENT_NAME_CHARS,
  MAX_DESCRIPTION_CHARS,
  REPORT_CATEGORIES,
  REPORT_KINDS,
  buildRequest,
  componentLength,
  descriptionLength,
  deviceClass,
  emptyDraft,
  nextPhase,
  sendReport,
  validateDraft,
  waitMinutes,
  type ReportDraft,
  type ReportPhase,
  type SendError,
} from './problemReport.js';

const listeners = new Set<(trigger: HTMLElement | null) => void>();
/** Open the dialog; focus returns to `trigger` when it closes. */
export function openProblemReport(trigger: HTMLElement | null): void {
  for (const l of listeners) l(trigger);
}

/** Mounted once (App): holds the draft and the send state, renders the dialog while open. */
export function ProblemReportHost() {
  const [trigger, setTrigger] = useState<{ el: HTMLElement | null } | null>(null);
  const [draft, setDraft] = useState<ReportDraft>(emptyDraft);
  const [phase, setPhase] = useState<ReportPhase>({ kind: 'editing', error: null });
  useEffect(() => {
    const open = (el: HTMLElement | null) => setTrigger({ el });
    listeners.add(open);
    return () => void listeners.delete(open);
  }, []);
  if (!PROBLEM_REPORTS || !trigger) return null;
  const close = () => {
    // A send in flight keeps its state: reopening shows its outcome.
    if (phase.kind === 'sent') {
      setDraft(emptyDraft());
      setPhase({ kind: 'editing', error: null });
    } else if (phase.kind === 'editing') setPhase({ kind: 'editing', error: null });
    setTrigger(null);
  };
  return (
    <ReportDialog
      draft={draft}
      setDraft={setDraft}
      phase={phase}
      setPhase={setPhase}
      onClose={close}
      trigger={trigger.el}
    />
  );
}

const FOCUSABLE =
  'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function errorText(t: ReturnType<typeof useT>, e: SendError): string {
  if (e.code === 'rate_limited')
    return t('report.failed.rate_limited', { minutes: waitMinutes(e.retryAfterS) });
  return t(`report.failed.${e.code}` as MessageKey);
}

function ReportDialog({
  draft,
  setDraft,
  phase,
  setPhase,
  onClose,
  trigger,
}: {
  draft: ReportDraft;
  setDraft: (d: ReportDraft) => void;
  phase: ReportPhase;
  setPhase: (update: (p: ReportPhase) => ReportPhase) => void;
  onClose: () => void;
  trigger: HTMLElement | null;
}) {
  const t = useT();
  const state = useAppState();
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const componentField = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [attempted, setAttempted] = useState(false);
  const unmounting = useRef(false);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    if (phase.kind === 'sent') closeButton.current?.focus();
    else field.current?.focus();
    return () => {
      unmounting.current = true;
      d?.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  // The outcome of a send: the confirmation takes focus; after an error focus stays in the dialog.
  useEffect(() => {
    if (phase.kind === 'sent') closeButton.current?.focus();
    else if (phase.kind === 'editing' && !dialog.current?.contains(document.activeElement))
      sendButton.current?.focus();
  }, [phase.kind]);

  const sending = phase.kind === 'sending';
  const count = descriptionLength(draft.description);
  const problems = validateDraft(draft);
  const showDescriptionProblem =
    problems.description === 'too_long' || (attempted && !!problems.description);
  const showCategoryProblem = attempted && !!problems.category;
  const showComponentProblem = !!problems.component;
  const bug = draft.kind === 'bug';
  const componentCount = componentLength(draft.component);

  const send = async () => {
    if (sending) return;
    setAttempted(true);
    if (problems.description) return field.current?.focus();
    if (problems.category)
      return dialog.current
        ?.querySelector<HTMLInputElement>('input[name="report-category"]')
        ?.focus();
    if (problems.component) return componentField.current?.focus();
    setPhase((p) => nextPhase(p, { type: 'send', draft }));
    // The optional context: looked up only when the tester keeps it included.
    const runtime = draft.includeContext ? await probeRuntime().catch(() => null) : null;
    const request = buildRequest(draft, {
      locale: state.locale.code,
      view: state.screen === 'editor' ? 'editor' : 'home',
      build: BUILD_INFO,
      sim: state.sim,
      runtimeVersion: runtime?.version ?? null,
      device: deviceClass((q) => window.matchMedia(q).matches),
      projectId: state.screen === 'editor' ? (state.doc?.projectId ?? null) : null,
    });
    const result = await sendReport(request, (input, init) => gateFetch(input, init));
    setPhase((p) => nextPhase(p, { type: 'result', result }));
  };

  // Tab and Shift+Tab cycle inside the dialog (a modal dialog would otherwise let focus leave
  // to the browser's own controls).
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const list = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!list.length) return;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={dialog}
      class="dialog report-dialog"
      dir={state.locale.dir}
      aria-labelledby="report-title"
      data-testid="report-dialog"
      data-phase={phase.kind}
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        e.preventDefault();
        if (!sending) onClose();
      }}
      // A browser may close a modal dialog itself (repeated Escape): keep the state in step.
      onClose={() => !unmounting.current && onClose()}
    >
      <h2 id="report-title">{t(`report.title.${draft.kind}` as MessageKey)}</h2>
      {phase.kind === 'sent' ? (
        <div role="status" data-testid="report-sent">
          <h3>{t('report.sent.heading')}</h3>
          <p>{t('report.sent.body')}</p>
          <p>
            <code class="report-id" dir="ltr" data-testid="report-id">
              {phase.id}
            </code>
          </p>
          <div class="dialog-actions">
            <button
              ref={closeButton}
              type="button"
              class="button button-primary"
              data-testid="report-close"
              onClick={onClose}
            >
              {t('report.close')}
            </button>
          </div>
        </div>
      ) : (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <fieldset class="report-kinds" data-testid="report-kinds">
            <legend>{t('report.kind.legend')}</legend>
            {REPORT_KINDS.map((k) => (
              <label key={k} class="report-choice">
                <input
                  type="radio"
                  name="report-kind"
                  value={k}
                  checked={draft.kind === k}
                  disabled={sending}
                  data-testid={`report-kind-${k}`}
                  onChange={() => setDraft({ ...draft, kind: k })}
                />{' '}
                {t(`report.kind.${k}` as MessageKey)}
              </label>
            ))}
          </fieldset>
          <p class="small">{t(`report.intro.${draft.kind}` as MessageKey)}</p>
          {draft.kind === 'component' && (
            <>
              <label for="report-component" class="report-label">
                {t('report.component.label')}
              </label>
              <input
                ref={componentField}
                id="report-component"
                class="report-component"
                data-testid="report-component"
                dir="auto"
                type="text"
                autoComplete="off"
                value={draft.component}
                readOnly={sending}
                aria-invalid={showComponentProblem}
                aria-describedby={
                  showComponentProblem
                    ? 'report-component-counter report-component-problem'
                    : 'report-component-counter'
                }
                onInput={(e) =>
                  setDraft({ ...draft, component: (e.target as HTMLInputElement).value })
                }
              />
              <div
                id="report-component-counter"
                class={`report-counter${showComponentProblem ? ' report-counter-over' : ''}`}
                data-testid="report-component-counter"
              >
                <span aria-hidden="true" dir="ltr">
                  {componentCount} / {MAX_COMPONENT_NAME_CHARS}
                </span>
                <span class="visually-hidden">
                  {t('report.counter.label', {
                    count: componentCount,
                    max: MAX_COMPONENT_NAME_CHARS,
                  })}
                </span>
              </div>
              {showComponentProblem && (
                <p
                  id="report-component-problem"
                  class="report-problem"
                  data-testid="report-problem-component"
                >
                  {t('report.problem.componentTooLong', { max: MAX_COMPONENT_NAME_CHARS })}
                </p>
              )}
            </>
          )}
          <label for="report-description" class="report-label">
            {t(`report.description.label.${draft.kind}` as MessageKey)}
          </label>
          <textarea
            ref={field}
            id="report-description"
            class="report-description"
            data-testid="report-description"
            dir="auto"
            rows={6}
            value={draft.description}
            readOnly={sending}
            aria-invalid={showDescriptionProblem}
            aria-describedby={
              showDescriptionProblem
                ? 'report-counter report-description-problem'
                : 'report-counter'
            }
            onInput={(e) =>
              setDraft({ ...draft, description: (e.target as HTMLTextAreaElement).value })
            }
          />
          <div
            id="report-counter"
            class={`report-counter${count > MAX_DESCRIPTION_CHARS ? ' report-counter-over' : ''}`}
            data-testid="report-counter"
          >
            <span aria-hidden="true" dir="ltr">
              {count} / {MAX_DESCRIPTION_CHARS}
            </span>
            <span class="visually-hidden">
              {t('report.counter.label', { count, max: MAX_DESCRIPTION_CHARS })}
            </span>
          </div>
          {showDescriptionProblem && (
            <p
              id="report-description-problem"
              class="report-problem"
              data-testid="report-problem-description"
            >
              {problems.description === 'too_long'
                ? t('report.problem.descriptionTooLong', { max: MAX_DESCRIPTION_CHARS })
                : bug
                  ? t('report.problem.descriptionRequired')
                  : t('report.problem.messageRequired')}
            </p>
          )}
          {bug && (
            <>
              <fieldset
                class="report-categories"
                aria-describedby={showCategoryProblem ? 'report-category-problem' : undefined}
              >
                <legend>{t('report.category.legend')}</legend>
                {REPORT_CATEGORIES.map((c) => (
                  <label key={c} class="report-choice">
                    <input
                      type="radio"
                      name="report-category"
                      value={c}
                      checked={draft.category === c}
                      disabled={sending}
                      aria-invalid={showCategoryProblem}
                      data-testid={`report-category-${c}`}
                      onChange={() => setDraft({ ...draft, category: c })}
                    />{' '}
                    {t(`report.category.${c}` as MessageKey)}
                  </label>
                ))}
              </fieldset>
              {showCategoryProblem && (
                <p
                  id="report-category-problem"
                  class="report-problem"
                  data-testid="report-problem-category"
                >
                  {t('report.problem.categoryRequired')}
                </p>
              )}
              <label class="report-choice report-blocking">
                <input
                  type="checkbox"
                  checked={draft.blocking}
                  disabled={sending}
                  data-testid="report-blocking"
                  onChange={(e) =>
                    setDraft({ ...draft, blocking: (e.target as HTMLInputElement).checked })
                  }
                />{' '}
                {t('report.blocking')}
              </label>
            </>
          )}
          <label class="report-choice report-context">
            <input
              type="checkbox"
              checked={draft.includeContext}
              disabled={sending}
              data-testid="report-context"
              aria-describedby="report-context-detail"
              onChange={(e) =>
                setDraft({ ...draft, includeContext: (e.target as HTMLInputElement).checked })
              }
            />{' '}
            {t('report.context.label')}
          </label>
          <p id="report-context-detail" class="small report-context-detail">
            {t('report.context.detail')}
          </p>
          <section
            class="report-disclosure"
            aria-labelledby="report-disclosure-heading"
            data-testid="report-disclosure"
          >
            <h3 id="report-disclosure-heading">{t('report.disclosure.heading')}</h3>
            <p>{t('report.disclosure.sent')}</p>
            <p>{t('report.disclosure.context')}</p>
            <p>{t('report.disclosure.notSent')}</p>
            <p>{t('report.disclosure.retention')}</p>
          </section>
          <div role="status" class="report-status" data-testid="report-status">
            {sending ? t('report.sending') : ''}
          </div>
          {phase.kind === 'editing' && phase.error && (
            <p
              role="alert"
              class="report-error"
              data-testid="report-error"
              data-code={phase.error.code}
            >
              {errorText(t, phase.error)}
            </p>
          )}
          <div class="dialog-actions">
            <button
              type="button"
              class="button"
              data-testid="report-cancel"
              aria-disabled={sending ? 'true' : undefined}
              onClick={() => !sending && onClose()}
            >
              {t('report.cancel')}
            </button>
            <button
              ref={sendButton}
              type="submit"
              class="button button-primary"
              data-testid="report-send"
              aria-disabled={sending ? 'true' : undefined}
            >
              {sending ? t('report.sending') : t('report.send')}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
