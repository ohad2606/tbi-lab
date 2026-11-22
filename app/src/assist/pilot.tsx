/**
 * TBI-017 slice 1 (DEV-Lab builds only; was the Sprint 28 owner pilot): the AI explanation inside
 * the Circuit Debugger, action A "Explain this circuit". Design: docs/design/TBI-017-ai-assistant-ui.md.
 *
 * - Talks only to the TBI Lab AI service through the typed client (client.ts): no provider key
 *   or provider call in the browser.
 * - OFF unless the service status says active + allowed (aiEnabled). Off: findings-only mode with
 *   one sentence why, announced once.
 * - Nothing is sent on opening, on analysing, on a language change or on dismissing the dialog.
 *   Sending needs the consent of the service's current version: asked in a modal dialog (focus on
 *   its heading, the safe place; "Show exactly what would be sent" previews the payload), then
 *   remembered per account + version (consent.ts) and sent with every request.
 * - States: idle, not available, consent needed, sending (+ Cancel), success, error. Status
 *   changes go to the panel's one polite live region; errors are role=alert.
 * - The answer never changes the project; the simulator findings above it stay the truth.
 */
import type { ComponentChild } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { EngineeringContext, Finding, GatewayResult } from '@tbi-lab/assist';
import { isMessageKey, isolateLtr } from '../i18n/i18n.js';
import type { MessageKey } from '../i18n/messages.en.js';
import { useT } from '../ui/context.js';
import {
  explainBody,
  postExplain,
  postPreview,
  previewText,
  retryable,
  type ClientError,
  type ExplainOk,
  type ServiceStatus,
  type StatusResult,
} from './client.js';
import { ConsentStore } from './consent.js';

export type AiPhase =
  | { kind: 'idle' }
  | { kind: 'consent'; context: EngineeringContext }
  | { kind: 'sending'; ctl: AbortController }
  | { kind: 'success'; result: ExplainOk }
  | { kind: 'error'; error: ClientError; n: number; retryAt: number };

/** A reason id from the service as a translation key (unknown ids fall back to the generic one). */
export const reasonKey = (r: string): MessageKey => {
  const k = `assist.pilot.reason.${r.replace(':', '.')}`;
  return isMessageKey(k) ? k : 'assist.pilot.reason.other';
};

/** A data category id as text; an unknown category is shown by its id (never hidden). */
function dataText(t: ReturnType<typeof useT>, id: string): string {
  const k = `assist.pilot.data.${id}`;
  return isMessageKey(k) ? t(k) : t('assist.ai.data.unknown', { id: isolateLtr(id) });
}

export const errorKey = (e: ClientError['error']): MessageKey => {
  const k = `assist.ai.error.${e}`;
  return isMessageKey(k) ? k : 'assist.ai.error.other';
};

/** Why the AI is not offered, as one sentence key (state "not available"). */
export function notAvailableKey(s: StatusResult): MessageKey {
  if (s.kind !== 'ok') return 'assist.ai.na.unavailable';
  if (s.status.state !== 'active') return 'assist.ai.na.disabled';
  return 'assist.ai.na.notAllowed';
}

export interface AiController {
  phase: AiPhase;
  consented: boolean;
  /** The user's "Explain this circuit". */
  ask: () => void;
  cancel: () => void;
  agree: () => void;
  decline: () => void;
  withdraw: () => void;
  /** A new local analysis or panel close: whatever was in flight is for another context. */
  reset: () => void;
  askRef: { current: HTMLButtonElement | null };
}

/**
 * The AI flow's state machine. `ensureContext` returns the context of the current analysis,
 * running the (local, deterministic) analysis first when there is none; null when it was too
 * large or could not be built (then nothing is sent).
 */
export function useAiController({
  status,
  locale,
  ensureContext,
  announce,
  store,
}: {
  status: ServiceStatus | null;
  locale: string;
  ensureContext: () => Promise<EngineeringContext | null | 'busy'>;
  announce: (text: string) => void;
  store?: ConsentStore;
}): AiController {
  const t = useT();
  const consent = useRef(store ?? new ConsentStore()).current;
  const [phase, setPhase] = useState<AiPhase>({ kind: 'idle' });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const errors = useRef(0);
  const askRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const [consented, setConsented] = useState(false);
  const account = status?.account;
  const version = status?.consentVersion ?? '';
  useEffect(() => {
    setConsented(!!status && consent.has(account, version));
  }, [status, account, version, consent]);
  // Focus never falls to the page: when the control that had it goes away (Cancel, the dialog,
  // Withdraw), it goes to the Ask button.
  useEffect(() => {
    if (refocus.current && phase.kind !== 'sending' && phase.kind !== 'consent') {
      refocus.current = false;
      askRef.current?.focus();
    }
  });
  useEffect(() => () => abortInFlight(), []);

  function abortInFlight() {
    const p = phaseRef.current;
    if (p.kind === 'sending') p.ctl.abort();
  }
  const focusLost = () => {
    const a = document.activeElement;
    return !a || a === document.body || !!a.closest('[data-ai-transient]');
  };

  function fail(error: ClientError) {
    errors.current += 1;
    const retryAt = error.retryAfterMs ? Date.now() + error.retryAfterMs : 0;
    setPhase({ kind: 'error', error, n: errors.current, retryAt });
  }

  async function send(context: EngineeringContext) {
    if (!status) return;
    const ctl = new AbortController();
    setPhase({ kind: 'sending', ctl });
    announce(t('assist.ai.sending'));
    const r = await postExplain(explainBody(locale, version, context), ctl.signal);
    const current = phaseRef.current;
    if (current.kind !== 'sending' || current.ctl !== ctl) return; // superseded
    if (focusLost()) refocus.current = true;
    if (r.ok) {
      setPhase({ kind: 'success', result: r });
      announce(t('assist.ai.ready', { count: String(r.response.explanations.length) }));
    } else if (r.error === 'cancelled') {
      setPhase({ kind: 'idle' });
      announce(t('assist.ai.cancelled'));
    } else {
      // The service no longer accepts the remembered version: forget it, ask again next time.
      if (r.error === 'consent_required') {
        consent.withdraw(account);
        setConsented(false);
      }
      fail(r);
    }
  }

  const ask = () => {
    const p = phaseRef.current;
    if (!status || p.kind === 'sending' || p.kind === 'consent') return;
    if (p.kind === 'error' && p.retryAt > Date.now()) return;
    void (async () => {
      const context = await ensureContext();
      if (context === 'busy') return;
      if (!context) {
        fail({ ok: false, status: 0, error: 'context_too_large' });
        return;
      }
      if (consent.has(account, version)) void send(context);
      else setPhase({ kind: 'consent', context });
    })();
  };

  return {
    phase,
    consented,
    ask,
    askRef,
    cancel: () => {
      const p = phaseRef.current;
      if (p.kind === 'sending') p.ctl.abort();
    },
    agree: () => {
      const p = phaseRef.current;
      if (p.kind !== 'consent') return;
      // Remembered when the browser allows it; sent with this request either way.
      setConsented(consent.grant(account, version));
      void send(p.context);
    },
    decline: () => {
      if (phaseRef.current.kind !== 'consent') return;
      refocus.current = true;
      setPhase({ kind: 'idle' });
      announce(t('assist.ai.consent.declined'));
    },
    withdraw: () => {
      abortInFlight();
      consent.withdraw(account);
      setConsented(false);
      refocus.current = true;
      if (phaseRef.current.kind === 'sending') setPhase({ kind: 'idle' });
      announce(t('assist.ai.consent.withdrawn'));
    },
    reset: () => {
      abortInFlight();
      setPhase({ kind: 'idle' });
    },
  };
}

/** The Ask button and, while sending, the visible state and Cancel (top of the panel). */
export function AiControls({ ai, blocked }: { ai: AiController; blocked: boolean }) {
  const t = useT();
  const p = ai.phase;
  const [, tick] = useState(0);
  const waiting = p.kind === 'error' && p.retryAt > Date.now();
  // Re-enable the Ask button when the service's wait is over.
  useEffect(() => {
    if (p.kind !== 'error' || p.retryAt <= Date.now()) return;
    const id = setTimeout(() => tick((n) => n + 1), p.retryAt - Date.now() + 50);
    return () => clearTimeout(id);
  }, [p]);
  const inactive = blocked || p.kind === 'sending' || p.kind === 'consent' || waiting;
  const label: MessageKey =
    p.kind === 'success'
      ? 'assist.ai.action.again'
      : p.kind === 'error' && retryable(p.error.error)
        ? 'assist.ai.action.retry'
        : 'assist.ai.action.explain';
  return (
    <>
      <button
        type="button"
        class="button assist-ai-ask"
        data-testid="ai-ask"
        data-action="explain"
        ref={ai.askRef}
        aria-disabled={inactive ? 'true' : undefined}
        onClick={() => !inactive && ai.ask()}
      >
        {t(label)}
      </button>
      {p.kind === 'sending' && (
        <>
          <span data-testid="ai-sending">{t('assist.ai.sending')}</span>
          <button
            type="button"
            class="button"
            data-testid="ai-cancel"
            data-ai-transient
            onClick={ai.cancel}
          >
            {t('assist.ai.cancel')}
          </button>
        </>
      )}
    </>
  );
}

/** "Not available": the deterministic panel stays usable; one sentence why. */
export function AiNotAvailable({ status }: { status: StatusResult }) {
  const t = useT();
  const key = notAvailableKey(status);
  const reasons =
    status.kind === 'ok' && status.status.state !== 'active' ? status.status.reasons : [];
  return (
    <div class="small muted" data-testid="ai-not-available" data-reason={key.split('.').pop()}>
      <p>{t(key)}</p>
      {reasons.length > 0 && (
        <ul data-testid="ai-reasons">
          {reasons.map((r) => (
            <li key={r} data-reason={r}>
              {t(reasonKey(r))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The AI section (after the simulator findings): label, error or answer. */
export function AiResult({
  ai,
  findings,
  renderReply,
}: {
  ai: AiController;
  findings: Finding[] | null;
  renderReply: (r: GatewayResult, serverFindings: Finding[]) => ComponentChild;
}) {
  const t = useT();
  const p = ai.phase;
  return (
    <section
      class="assist-section assist-ai"
      aria-labelledby="ai-result-h"
      data-testid="ai-result"
      data-state={p.kind}
    >
      <h3 id="ai-result-h">{t('assist.ai.heading')}</h3>
      <p class="assist-ai-label small" data-testid="ai-label">
        {t('assist.ai.label')}
      </p>
      {(p.kind === 'idle' || p.kind === 'consent') && (
        <p class="small muted">{t('assist.ai.idle')}</p>
      )}
      {p.kind === 'error' && (
        <div
          key={p.n}
          class="field-error"
          role="alert"
          data-testid="ai-error"
          data-error={p.error.error}
        >
          <p>
            {t(errorKey(p.error.error), {
              seconds: isolateLtr(String(Math.ceil((p.error.retryAfterMs ?? 0) / 1000))),
            })}
          </p>
          <p class="small">
            {t(
              retryable(p.error.error)
                ? 'assist.ai.error.hint.retry'
                : 'assist.ai.error.hint.findings',
            )}
          </p>
        </div>
      )}
      {p.kind === 'success' && (
        <div
          data-testid="ai-answer"
          data-same-findings={String(!!findings && sameFindings(p.result.findings, findings))}
        >
          {renderReply(
            {
              ok: true,
              response: p.result.response,
              unexplained: p.result.unexplained,
              accounting: p.result.accounting,
            },
            p.result.findings,
          )}
        </div>
      )}
    </section>
  );
}

/** Panel footer: the remembered consent and "Withdraw consent". */
export function AiFooter({ ai, version }: { ai: AiController; version: string }) {
  const t = useT();
  if (!ai.consented) return null;
  return (
    <footer class="assist-footer small" data-testid="ai-footer">
      <p>{t('assist.ai.consent.remembered', { version: isolateLtr(version) })}</p>
      <button
        type="button"
        class="button"
        data-testid="ai-withdraw"
        data-ai-transient
        onClick={ai.withdraw}
      >
        {t('assist.ai.consent.withdraw')}
      </button>
    </footer>
  );
}

/**
 * The consent dialog (modal): what is sent, what is never sent, provider/model, retention, the
 * exact payload on request. Focus starts on the heading (not on "Agree"); Esc = Cancel.
 */
export function ConsentDialog({
  ai,
  status,
  locale,
}: {
  ai: AiController;
  status: ServiceStatus;
  locale: string;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [preview, setPreview] = useState<
    | { kind: 'none' }
    | { kind: 'loading' }
    | { kind: 'ok'; text: string; bytes: number; tokens: number }
    | { kind: 'error'; error: ClientError }
  >({ kind: 'none' });
  const p = ai.phase;
  const open = p.kind === 'consent';
  const context = p.kind === 'consent' ? p.context : null;
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setPreview({ kind: 'none' });
      d.showModal();
      heading.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => () => dialog.current?.close(), []);

  const showPreview = async () => {
    if (!context) return;
    setPreview({ kind: 'loading' });
    const r = await postPreview(context, locale);
    if (r.ok)
      setPreview({
        kind: 'ok',
        text: previewText(r.payload),
        bytes: r.bytes,
        tokens: r.estimatedInputTokens,
      });
    else setPreview({ kind: 'error', error: r });
  };

  const model =
    status.mode === 'live' ? 'assist.pilot.model.live' : ('assist.pilot.model.mock' as const);
  return (
    <dialog
      ref={dialog}
      class="dialog assist-consent-dialog"
      data-testid="ai-consent"
      aria-labelledby="ai-consent-h"
      aria-describedby="ai-consent-d"
      onCancel={(e) => {
        e.preventDefault();
        ai.decline();
      }}
    >
      {open && (
        <>
          <h2 id="ai-consent-h" tabIndex={-1} ref={heading}>
            {t('assist.ai.consent.title')}
          </h2>
          <p id="ai-consent-d">{t('assist.ai.consent.intro')}</p>
          <p class="small" data-testid="ai-consent-model">
            {t(model, {
              provider: isolateLtr(status.provider ?? ''),
              model: isolateLtr(status.model ?? ''),
            })}
          </p>
          <h3 class="assist-consent-h">{t('assist.pilot.data.sent')}</h3>
          <ul class="small" data-testid="ai-consent-sent">
            {status.data.sent.map((d) => (
              <li key={d} data-category={d}>
                {dataText(t, d)}
              </li>
            ))}
          </ul>
          <h3 class="assist-consent-h">{t('assist.pilot.data.never')}</h3>
          <ul class="small" data-testid="ai-consent-never">
            {status.data.neverSent.map((d) => (
              <li key={d} data-category={d}>
                {dataText(t, d)}
              </li>
            ))}
          </ul>
          <p class="small">
            {t('assist.ai.consent.retention', {
              days: isolateLtr(String(status.data.auditRetentionDays)),
            })}
          </p>
          <p class="small" data-testid="ai-consent-version">
            {t('assist.ai.consent.version', { version: isolateLtr(status.consentVersion) })}
          </p>
          <button
            type="button"
            class="button"
            data-testid="ai-preview"
            aria-disabled={preview.kind === 'loading' ? 'true' : undefined}
            onClick={() => preview.kind !== 'loading' && void showPreview()}
          >
            {t('assist.pilot.preview')}
          </button>
          <p role="status" class="small" data-testid="ai-preview-status">
            {preview.kind === 'ok'
              ? t('assist.pilot.preview.size', {
                  bytes: isolateLtr(String(preview.bytes)),
                  tokens: isolateLtr(String(preview.tokens)),
                })
              : ''}
          </p>
          {preview.kind === 'error' && (
            <p class="field-error" role="alert" data-testid="ai-preview-error">
              {t('assist.ai.preview.error')}
            </p>
          )}
          {preview.kind === 'ok' && (
            <pre
              class="assist-payload technical"
              dir="ltr"
              tabIndex={0}
              aria-label={t('assist.ai.preview.label')}
              data-testid="ai-payload"
            >
              {preview.text}
            </pre>
          )}
          <div class="dialog-actions">
            <button
              type="button"
              class="button"
              data-testid="ai-consent-cancel"
              onClick={ai.decline}
            >
              {t('assist.ai.consent.cancel')}
            </button>
            <button
              type="button"
              class="button button-primary"
              data-testid="ai-consent-agree"
              onClick={ai.agree}
            >
              {t('assist.ai.consent.agree')}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

/** Whether the service's recomputed findings equal the panel's (they should: same code). */
function sameFindings(a: Finding[], b: Finding[]): boolean {
  return JSON.stringify(a.map((f) => f.key)) === JSON.stringify(b.map((f) => f.key));
}
