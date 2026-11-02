/**
 * Sprint 28 (DEV-Lab builds only): the owner-only AI model pilot, inside the Circuit Debugger.
 *
 * It talks only to the TBI Lab AI provider service behind the same gate (/assist/v1/*, server
 * side): the browser never holds a provider key or calls a provider. The section:
 * - shows whether the pilot is active, and if not, which owner approvals are missing;
 * - for a pilot user of an active service: shows EXACTLY what would be sent (the service's own
 *   preview of the provider payload) and asks for explicit consent of the current version before
 *   anything is sent; nothing is sent on opening, on analysing or on a locale change;
 * - shows the reply as the deterministic panel does: findings (recomputed by the service) are the
 *   truth, the explanation is labelled with its model and cost, every statement cites evidence.
 * No reply is ever applied to the project (there is no write action).
 */
import { useEffect, useState } from 'preact/hooks';
import type { EngineeringContext, Finding, GatewayResult } from '@tbi-lab/assist';
import { EXPLAIN_CONTRACT } from '@tbi-lab/assist';
import { isolateLtr } from '../i18n/i18n.js';
import type { MessageKey } from '../i18n/messages.en.js';
import { useT } from '../ui/context.js';

const BASE = '/assist/v1';

export interface PilotStatus {
  state: 'active' | 'disabled';
  reasons?: string[];
  mode?: 'live' | 'mock';
  provider?: string;
  model?: string;
  pilot: boolean;
  consentVersion: string;
  data: { sent: string[]; neverSent: string[]; auditRetentionDays: number };
}

type Status = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ok'; s: PilotStatus };

async function json(r: Response): Promise<Record<string, unknown>> {
  if (!/^application\/json/.test(r.headers.get('content-type') ?? '')) throw new Error('not json');
  return (await r.json()) as Record<string, unknown>;
}

export async function pilotStatus(signal?: AbortSignal): Promise<Status> {
  try {
    const r = await fetch(`${BASE}/status`, { signal, credentials: 'same-origin' });
    if (!r.ok) return { kind: 'unavailable' };
    const b = (await json(r)) as unknown as PilotStatus;
    if (b.state !== 'active' && b.state !== 'disabled') return { kind: 'unavailable' };
    return { kind: 'ok', s: b };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** A reason id from the service as a translation key (unknown ids fall back to the generic one). */
const reasonKey = (r: string, has: (k: string) => boolean): MessageKey => {
  const k = `assist.pilot.reason.${r.replace(':', '.')}`;
  return (has(k) ? k : 'assist.pilot.reason.other') as MessageKey;
};

export function PilotSection({
  context,
  locale,
  findings,
  has,
  renderReply,
}: {
  context: EngineeringContext;
  locale: string;
  findings: Finding[];
  has: (key: string) => boolean;
  renderReply: (r: GatewayResult, serverFindings: Finding[]) => preact.ComponentChild;
}) {
  const t = useT();
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [preview, setPreview] = useState<{ bytes: number; tokens: number; text: string } | null>(
    null,
  );
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<{ r: GatewayResult; findings: Finding[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    void pilotStatus(ctl.signal).then(setStatus);
    return () => ctl.abort();
  }, []);
  // A new analysis: whatever was previewed or consented to was for another context.
  useEffect(() => {
    setPreview(null);
    setConsent(false);
    setReply(null);
    setError(null);
  }, [context]);

  const s = status.kind === 'ok' ? status.s : null;
  const usable = !!s && s.state === 'active' && s.pilot;

  const doPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${BASE}/preview`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale, context }),
      });
      const b = await json(r);
      if (!r.ok) throw new Error(String(b.error ?? r.status));
      const p = b.payload as { system: string; user: string };
      setPreview({
        bytes: b.bytes as number,
        tokens: b.estimatedInputTokens as number,
        text: `${p.system}\n\n${JSON.stringify(JSON.parse(p.user), null, 2)}`,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doExplain = async () => {
    if (!s || !consent) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${BASE}/explain`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contract: EXPLAIN_CONTRACT,
          locale,
          consent: { version: s.consentVersion, accepted: true },
          context,
        }),
      });
      const b = await json(r);
      if (r.ok)
        setReply({
          r: {
            ok: true,
            response: b.response,
            unexplained: b.unexplained,
            accounting: b.accounting,
          } as GatewayResult,
          findings: b.findings as Finding[],
        });
      else setError(String(b.error ?? r.status));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      class="assist-section assist-pilot"
      aria-labelledby="assist-pilot-h"
      data-testid="assist-pilot"
      data-state={s?.state ?? status.kind}
    >
      <h3 id="assist-pilot-h">{t('assist.pilot.heading')}</h3>
      {status.kind === 'loading' && <p class="small muted">{t('assist.pilot.loading')}</p>}
      {status.kind === 'unavailable' && (
        <p class="small muted" data-testid="assist-pilot-unavailable">
          {t('assist.pilot.unavailable')}
        </p>
      )}
      {s && s.state === 'disabled' && (
        <>
          <p class="small" data-testid="assist-pilot-disabled">
            {t('assist.pilot.disabled')}
          </p>
          <ul class="small" data-testid="assist-pilot-reasons">
            {(s.reasons ?? []).map((r) => (
              <li key={r} data-reason={r}>
                {t(reasonKey(r, has))}
              </li>
            ))}
          </ul>
        </>
      )}
      {s && s.state === 'active' && !s.pilot && (
        <p class="small muted" data-testid="assist-pilot-not-pilot">
          {t('assist.pilot.notPilot')}
        </p>
      )}
      {usable && s && (
        <>
          <p class="small" data-testid="assist-pilot-model">
            {t(s.mode === 'live' ? 'assist.pilot.model.live' : 'assist.pilot.model.mock', {
              provider: isolateLtr(s.provider ?? ''),
              model: isolateLtr(s.model ?? ''),
            })}
          </p>
          <details class="small">
            <summary>{t('assist.pilot.data.heading')}</summary>
            <p>{t('assist.pilot.data.sent')}</p>
            <ul data-testid="assist-pilot-sent">
              {s.data.sent.map((d) => (
                <li key={d}>{t(`assist.pilot.data.${d}` as MessageKey)}</li>
              ))}
            </ul>
            <p>{t('assist.pilot.data.never')}</p>
            <ul data-testid="assist-pilot-never">
              {s.data.neverSent.map((d) => (
                <li key={d}>{t(`assist.pilot.data.${d}` as MessageKey)}</li>
              ))}
            </ul>
          </details>
          <div class="assist-actions">
            <button
              type="button"
              class="button"
              data-testid="assist-pilot-preview"
              disabled={busy}
              onClick={() => void doPreview()}
            >
              {t('assist.pilot.preview')}
            </button>
          </div>
          {preview && (
            <div data-testid="assist-pilot-payload">
              <p class="small">
                {t('assist.pilot.preview.size', {
                  bytes: isolateLtr(String(preview.bytes)),
                  tokens: isolateLtr(String(preview.tokens)),
                })}
              </p>
              <pre class="assist-payload technical" dir="ltr" tabIndex={0}>
                {preview.text}
              </pre>
              <label class="assist-consent">
                <input
                  type="checkbox"
                  data-testid="assist-pilot-consent"
                  checked={consent}
                  onChange={(e) => setConsent((e.target as HTMLInputElement).checked)}
                />{' '}
                {t('assist.pilot.consent', { version: isolateLtr(s.consentVersion) })}
              </label>
              <div class="assist-actions">
                <button
                  type="button"
                  class="button button-primary"
                  data-testid="assist-pilot-send"
                  disabled={!consent || busy}
                  onClick={() => void doExplain()}
                >
                  {t('assist.pilot.send')}
                </button>
              </div>
            </div>
          )}
          {error && (
            <p class="field-error" role="alert" data-testid="assist-pilot-error" data-error={error}>
              {t(
                (has(`assist.pilot.error.${error}`)
                  ? `assist.pilot.error.${error}`
                  : 'assist.pilot.error.other') as MessageKey,
              )}
            </p>
          )}
          {reply && (
            <div
              data-testid="assist-pilot-reply"
              data-same-findings={String(sameFindings(reply.findings, findings))}
            >
              {renderReply(reply.r, reply.findings)}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Whether the service's recomputed findings equal the panel's (they should: same code). */
function sameFindings(a: Finding[], b: Finding[]): boolean {
  return JSON.stringify(a.map((f) => f.key)) === JSON.stringify(b.map((f) => f.key));
}
