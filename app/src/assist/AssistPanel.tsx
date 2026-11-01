/**
 * Sprint 27 (DEV-Lab only, experimental): the Circuit Debugger panel. A non-modal side panel, so
 * the circuit stays visible while reading. Two clearly separate parts:
 *
 * 1. Simulator findings: the deterministic debugger's findings, each in the product's OWN wording
 *    for the record it rests on (the inspector's check sentence, the engine's refusal message, the
 *    rating row, the build diagnostic), with its certainty, the action where one is justified, its
 *    limits and its evidence.
 * 2. Explanation: the provider's text (today the deterministic mock, labelled as template text,
 *    not a live AI model), each item linked to its finding and to the evidence it cites.
 *
 * The analysis starts only when the user asks. Nothing here edits the project, builds or runs.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Finding, GatewayResult } from '@tbi-lab/assist';
import { isMessageKey, isolateLtr, translate, type LocaleInfo } from '../i18n/i18n.js';
import type { MessageKey } from '../i18n/messages.en.js';
import { programBoardOf } from '../ui/buildAction.js';
import { checkIssueText } from '../ui/checks.js';
import { useAppState, useStore, useT } from '../ui/context.js';
import type { SimFailure } from '../sim/controller.js';
import {
  engineErrorMessage,
  featureName,
  formatPower,
  formatResult,
  ratingRow,
  simFailureMessage,
} from '../sim/format.js';
import { analyze, assistGateway, type Analysis } from './analyze.js';

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; ctl: AbortController }
  | { kind: 'done'; analysis: Analysis };

const refIndex = (ref: string) => Number(ref.slice(ref.indexOf(':') + 1));

/** The product's own sentence for the record a finding rests on. */
export function findingText(locale: LocaleInfo, a: Analysis, f: Finding): string {
  const t = (key: MessageKey, params?: Record<string, string>) => translate(locale, key, params);
  const doc = a.doc;
  const first = f.evidence[0] ?? '';
  if (f.source === 'check' && first.startsWith('check:')) {
    const issue = a.input.checks[refIndex(first)];
    if (issue) return checkIssueText(locale, doc, issue);
  }
  if (f.source === 'rating' && first.startsWith('rating:')) {
    const w = a.input.ratings?.[refIndex(first)];
    if (w) return `${isolateLtr(w.component)}: ${ratingRow(locale, w)}`;
  }
  if (first === 'solver:error' && a.input.failure?.kind === 'engine')
    return engineErrorMessage(locale, a.input.failure.error, doc);
  if (first === 'failure' && a.input.failure)
    return simFailureMessage(locale, a.input.failure as SimFailure, doc);
  if (f.id === 'build.compile_error' && first.startsWith('build:')) {
    const d = a.context?.build?.diagnostics[refIndex(first)];
    if (d)
      return isolateLtr(
        `${d.file ?? ''}${d.line !== undefined ? `:${d.line}` : ''}${d.column !== undefined ? `:${d.column}` : ''}: ${d.message}`,
      );
  }
  const key = `assist.analysis.${f.id}`;
  const subjects = [...f.components, ...f.pins.map((p) => `GPIO${p}`)].join(', ');
  const feature =
    typeof f.facts.feature === 'string'
      ? f.facts.feature
      : typeof f.facts.capability === 'string'
        ? f.facts.capability
        : '';
  return isMessageKey(key)
    ? t(key, {
        subjects: isolateLtr(subjects),
        feature: feature ? featureName(locale, feature) : '',
      })
    : isolateLtr(f.code);
}

/** One evidence item: its kind and the value it holds, from the context (LTR technical text). */
function EvidenceItem({
  a,
  evRef: id,
  locale,
}: {
  a: Analysis;
  evRef: string;
  locale: LocaleInfo;
}) {
  const t = useT();
  const kind = id.includes(':') ? id.slice(0, id.indexOf(':')) : id;
  const label = isMessageKey(`assist.evidence.${kind}`)
    ? t(`assist.evidence.${kind}` as MessageKey)
    : kind;
  const c = a.context;
  let detail = '';
  let code: string[] | null = null;
  if (c) {
    const A = (v: number) => formatResult(locale, v, 'ampere');
    const V = (v: number) => formatResult(locale, v, 'volt');
    const r = c.ratings.find((x) => x.ref === id);
    const res = c.solver.components?.find((x) => x.ref === id);
    const pin = c.solver.pins?.find((x) => x.ref === id);
    const ex = c.excerpts.find((x) => x.ref === id);
    const bd = c.build?.diagnostics.find((x) => x.ref === id);
    const un = c.unknowns.find((x) => x.ref === id);
    const fmt = (v: { value: number; unit: string }) =>
      v.unit === 'W'
        ? formatPower(locale, v.value)
        : v.unit === 'V'
          ? V(v.value)
          : v.unit === 'A'
            ? A(v.value)
            : `${v.value} ${v.unit}`;
    if (r) detail = `${r.component} ${r.code}: ${r.value ? fmt(r.value) : '—'} / ${fmt(r.limit)}`;
    else if (res)
      detail = `${res.id}: ${[res.current && A(res.current.value), res.voltage && V(res.voltage.value)].filter(Boolean).join(', ') || '—'}`;
    else if (pin)
      detail = `GPIO${pin.gpio} ${pin.mode}${pin.voltage ? ` ${V(pin.voltage.value)}` : ''}${pin.levelUndefined ? ` (${pin.levelUndefined})` : ''}`;
    else if (ex) {
      detail = `${ex.file}:${ex.startLine}`;
      code = ex.lines;
    } else if (bd) detail = `${bd.file ?? ''}${bd.line !== undefined ? `:${bd.line}` : ''}`;
    else if (un) detail = un.what;
    else if (id === 'solver:error') detail = c.solver.error?.code ?? '';
    else if (id === 'failure') detail = c.failure?.code ?? '';
    else if (id.startsWith('check:')) detail = c.checks[refIndex(id)]?.code ?? '';
  }
  return (
    <li id={`assist-ev-${id}`} data-testid="assist-evidence" data-ref={id}>
      <span class="assist-ev-kind">{label}</span>{' '}
      {detail && (
        <span class="technical" dir="ltr">
          {detail}
        </span>
      )}
      {code && (
        <pre class="assist-code technical" dir="ltr" data-testid="assist-excerpt">
          {code.join('\n')}
        </pre>
      )}
    </li>
  );
}

function FindingItem({ a, f, locale }: { a: Analysis; f: Finding; locale: LocaleInfo }) {
  const t = useT();
  return (
    <li
      id={`assist-finding-${f.key}`}
      class={`assist-finding assist-${f.severity}`}
      data-testid="assist-finding"
      data-id={f.id}
      data-key={f.key}
      data-severity={f.severity}
      data-certainty={f.certainty}
      data-source={f.source}
      tabIndex={-1}
    >
      <p class="assist-finding-head">
        <span class={`assist-severity assist-severity-${f.severity}`}>
          {t(`assist.severity.${f.severity}` as MessageKey)}
        </span>{' '}
        <strong>{t(`assist.family.${f.family}` as MessageKey)}</strong>{' '}
        <span class="muted small technical" dir="ltr">
          {f.id}
        </span>
      </p>
      <p data-testid="assist-finding-text">{findingText(locale, a, f)}</p>
      <p class="small muted" data-testid="assist-certainty">
        {t(`assist.certainty.${f.certainty}` as MessageKey)}
      </p>
      {f.action && (
        <p class="small" data-testid="assist-action">
          <strong>{t('assist.action.heading')}:</strong>{' '}
          {t(`assist.action.${f.action}` as MessageKey)}
        </p>
      )}
      {f.limitations.length > 0 && (
        <details class="small">
          <summary>{t('assist.limit.heading')}</summary>
          <ul data-testid="assist-limits">
            {f.limitations.map((l) => (
              <li key={l}>{t(`assist.limit.${l}` as MessageKey)}</li>
            ))}
          </ul>
        </details>
      )}
      <details class="small">
        <summary>{t('assist.evidence.heading')}</summary>
        <ul class="assist-evidence">
          {f.evidence.map((r) => (
            <EvidenceItem key={r} a={a} evRef={r} locale={locale} />
          ))}
        </ul>
      </details>
    </li>
  );
}

function Explanation({ a, r }: { a: Analysis; r: GatewayResult }) {
  const t = useT();
  if (!r.ok) {
    const key = `assist.error.${r.error}` as MessageKey;
    return (
      <p class="field-error" role="alert" data-testid="assist-explain-error" data-error={r.error}>
        {t(key, { seconds: String(Math.ceil((r.retryAfterMs ?? 0) / 1000)) })}
      </p>
    );
  }
  const byKey = new Map(a.findings.map((f) => [f.key, f]));
  const acc = r.accounting;
  const refsOf = (cites: string[]) =>
    cites.map((c, i) => (
      <span key={c}>
        {i > 0 && ', '}
        <a href={`#assist-ev-${c}`} class="technical" dir="ltr" data-testid="assist-cite">
          {c}
        </a>
      </span>
    ));
  return (
    <>
      {r.response.summary && <p data-testid="assist-summary">{r.response.summary.text}</p>}
      <ol class="assist-explanations">
        {r.response.explanations.map((e) => {
          const f = byKey.get(e.finding);
          return (
            <li key={e.finding} data-testid="assist-explanation" data-finding={e.finding}>
              <a
                href={`#assist-finding-${e.finding}`}
                class="small"
                data-testid="assist-explanation-link"
              >
                {f ? t(`assist.family.${f.family}` as MessageKey) : e.finding}
              </a>
              <p>{e.text}</p>
              <p class="small muted">
                {t('assist.explain.basedOn', { refs: '' })}
                {refsOf(e.cites)}
              </p>
            </li>
          );
        })}
        {(r.response.declined ?? []).map((d) => (
          <li key={d.finding} data-testid="assist-declined" data-finding={d.finding}>
            {t('assist.explain.declined', {
              reason: t(`assist.explain.declined.${d.reason}` as MessageKey),
            })}
          </li>
        ))}
        {r.unexplained.map((k) => (
          <li key={k} data-testid="assist-unexplained" data-finding={k}>
            <a href={`#assist-finding-${k}`}>{k}</a> {t('assist.explain.unexplained')}
          </li>
        ))}
      </ol>
      <p class="small muted" data-testid="assist-accounting">
        {t('assist.accounting', {
          provider: isolateLtr(acc.provider),
          model: isolateLtr(acc.model),
          tokens: isolateLtr(String(acc.inputTokens + acc.outputTokens)),
          cost: isolateLtr(`$${acc.costUsd.toFixed(4)}`),
          ms: isolateLtr(String(Math.round(acc.latencyMs))),
        })}
      </p>
    </>
  );
}

export function AssistPanel({
  onClose,
  trigger,
}: {
  onClose: () => void;
  trigger: HTMLElement | null;
}) {
  const state = useAppState();
  const store = useStore();
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    return () => trigger?.focus();
  }, [trigger]);
  useEffect(() => () => (phase.kind === 'running' ? phase.ctl.abort() : undefined), [phase]);
  // Escape closes the panel wherever focus is (it is non-modal), unless a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]'))
        return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const doc = state.doc;
  if (!doc) return null;

  const start = async () => {
    if (phase.kind === 'running') return;
    const ctl = new AbortController();
    setPhase({ kind: 'running', ctl });
    const boardId = programBoardOf(doc);
    const builds = store.builds;
    const build =
      boardId && builds ? builds.view(doc.projectId, boardId, doc.programs[boardId]!) : null;
    const analysis = await analyze({ doc, sim: state.sim, build }, state.locale.code, ctl.signal);
    setPhase({ kind: 'done', analysis });
  };
  const a = phase.kind === 'done' ? phase.analysis : null;
  const stale = !!a && a.doc !== doc;
  const info = assistGateway().providerInfo;

  return (
    <aside
      class="assist-panel"
      dir={state.locale.dir}
      aria-labelledby="assist-title"
      data-testid="assist-panel"
      data-phase={phase.kind}
    >
      <header class="assist-header">
        <h2 id="assist-title" tabIndex={-1} ref={heading}>
          {t('assist.panel.title')}
        </h2>
        <span class="assist-badge" data-testid="assist-experimental">
          {t('assist.panel.experimental')}
        </span>
        <button
          type="button"
          class="button button-quiet"
          data-testid="assist-close"
          onClick={onClose}
        >
          {t('assist.panel.close')}
        </button>
      </header>
      <p class="small">{t('assist.panel.intro')}</p>
      <div class="assist-actions">
        {phase.kind === 'running' ? (
          <>
            <span role="status" data-testid="assist-status">
              {t('assist.panel.analyzing')}
            </span>
            <button
              type="button"
              class="button"
              data-testid="assist-cancel"
              onClick={() => phase.ctl.abort()}
            >
              {t('assist.panel.cancel')}
            </button>
          </>
        ) : (
          <button
            type="button"
            class="button button-primary"
            data-testid="assist-analyze"
            onClick={() => void start()}
          >
            {t(a ? 'assist.panel.again' : 'assist.panel.analyze')}
          </button>
        )}
      </div>
      {stale && (
        <p class="banner banner-info small" role="status" data-testid="assist-stale">
          {t('assist.panel.stale')}
        </p>
      )}
      {a?.tooLarge && (
        <p class="field-error" role="alert" data-testid="assist-too-large">
          {t('assist.error.context_too_large')}
        </p>
      )}
      {a && !a.tooLarge && (
        <>
          <section
            class="assist-section"
            aria-labelledby="assist-findings-h"
            data-testid="assist-findings"
          >
            <h3 id="assist-findings-h">{t('assist.findings.heading')}</h3>
            <p class="small muted">{t('assist.findings.note')}</p>
            {a.findings.length === 0 ? (
              <p>{t('assist.findings.none')}</p>
            ) : (
              <ul class="assist-findings">
                {a.findings.map((f) => (
                  <FindingItem key={f.key} a={a} f={f} locale={state.locale} />
                ))}
              </ul>
            )}
          </section>
          <section
            class="assist-section assist-ai"
            aria-labelledby="assist-explain-h"
            data-testid="assist-explanation-section"
            data-provider={info?.id ?? ''}
            data-live={String(!!info?.live)}
          >
            <h3 id="assist-explain-h">{t('assist.explain.heading')}</h3>
            {!info?.live && (
              <p class="assist-mock-label small" data-testid="assist-mock-label">
                {t('assist.explain.mock')}
              </p>
            )}
            {a.explanation && <Explanation a={a} r={a.explanation} />}
          </section>
        </>
      )}
    </aside>
  );
}
