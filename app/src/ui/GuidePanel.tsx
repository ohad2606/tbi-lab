/**
 * TBI-019 G2: the component guide panel. A NON-modal complementary region on the inline-end side
 * (bottom sheet on narrow screens), so the circuit stays visible while the learner reads.
 * - labelled by its title (h2); each section is an h3; the try-it step is an ordered list;
 * - the title takes focus on open; Escape (focus inside the panel) or the close button closes;
 *   focus returns to the opener (or, if that was removed by opening the example, to the canvas);
 * - no focus trap; nothing is stored (no "tried it" tick, no localStorage);
 * - every number is computed by the engine from the linked example (facts.ts) and shown as an LTR
 *   isolate; if a number cannot be computed the panel says so and shows a dash, never a guess;
 * - "Open the example" opens the guide's example as a new project; the result is announced in a
 *   polite status region. The created project id is remembered IN MEMORY ONLY (guideCopies.ts, D-1420-4):
 *   while that copy still exists the panel offers "Go back to my copy" (primary) and "Start a fresh
 *   copy" instead; focus moves to the primary button when the buttons swap.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ProjectDocument } from '@tbi-lab/domain';
import { loadExampleDocument } from '../examples/catalog.js';
import { guideById } from '../guides/catalog.js';
import { lookupGuideCopy, rememberGuideCopy } from '../guides/guideCopies.js';
import { evaluateGuide, formatFacts, type GuideEvaluation } from '../guides/facts.js';
import { messageParts } from '../i18n/i18n.js';
import type { MessageKey } from '../i18n/messages.en.js';
import { useAppState, useStore, useT } from './context.js';
import { LtrMessage } from './LtrMessage.js';

const NO_VALUE = '–';

export function GuidePanel({
  guideId,
  trigger,
  onClose,
}: {
  guideId: string;
  trigger: HTMLElement | null;
  onClose: () => void;
}) {
  const guide = guideById(guideId);
  const { locale } = useAppState();
  const store = useStore();
  const t = useT();
  const heading = useRef<HTMLHeadingElement>(null);
  const [evaluation, setEvaluation] = useState<GuideEvaluation | null>(null);
  const [status, setStatus] = useState('');
  const [copyId, setCopyId] = useState<string | undefined>();
  const primary = useRef<HTMLButtonElement>(null);
  const refocusPrimary = useRef(false);
  const announceTimer = useRef<ReturnType<typeof setTimeout>>();

  // Focus the title on open; on close return to the opener, or to the canvas if the opener is gone.
  useEffect(() => {
    return () => {
      clearTimeout(announceTimer.current);
      const target =
        trigger && trigger.isConnected
          ? trigger
          : document.querySelector<HTMLElement>('[data-testid="canvas"]');
      target?.focus();
    };
  }, []);

  // Focus the title on open and whenever another guide replaces this one while the panel stays
  // mounted (latent today: only one guide exists, so no e2e can switch guides yet).
  useEffect(() => {
    heading.current?.focus();
  }, [guideId]);

  // The numbers come from the real engine on the example's own document; the panel is already on
  // screen while this runs (it never blocks on it).
  useEffect(() => {
    setEvaluation(null);
    if (!guide) return;
    let live = true;
    void loadExampleDocument(guide.exampleId)
      .catch(() => undefined)
      .then((doc: ProjectDocument | undefined) => {
        if (live) setEvaluation(doc ? evaluateGuide(guide, doc) : { facts: {}, tryIt: nothing });
      });
    return () => void (live = false);
  }, [guideId]);

  /** The learner's copy of this guide's circuit, if it still exists (the library list is fresh). */
  const findCopy = async (): Promise<string | undefined> => {
    await store.refreshProjects().catch(() => undefined);
    const ids = store.state.projects.map((p) => p.projectId);
    const open = store.state.doc?.projectId;
    return lookupGuideCopy(guideId, open ? [...ids, open] : ids);
  };
  useEffect(() => {
    setCopyId(undefined);
    let live = true;
    void findCopy().then((id) => live && setCopyId(id));
    return () => void (live = false);
  }, [guideId]);

  // The primary button changes label when a copy appears; keep keyboard focus on it.
  useEffect(() => {
    if (refocusPrimary.current && primary.current) {
      refocusPrimary.current = false;
      primary.current.focus();
    }
  }, [copyId]);

  const params = useMemo(() => {
    if (!guide || !evaluation) return {};
    const formatted = formatFacts(locale, evaluation.facts);
    const out: Record<string, string> = {};
    for (const s of guide.sections)
      for (const k of s.keys)
        for (const p of messageParts(locale, k))
          if ('param' in p) out[p.param] = formatted[p.param] ?? NO_VALUE;
    return out;
  }, [guide, evaluation, locale]);

  /** Polite status; a repeat of the same message is re-announced (cleared, then set again). */
  const announce = (text: string) => {
    setStatus('');
    clearTimeout(announceTimer.current);
    announceTimer.current = setTimeout(() => setStatus(text), 60);
  };

  if (!guide) return null;
  const missing =
    !!evaluation &&
    (Object.keys(evaluation.facts).length === 0 ||
      Object.values(evaluation.facts).some((f) => f === null));
  const msg = (k: MessageKey) => <LtrMessage k={k} params={params} />;

  /** Create a new copy of the example and remember it for this guide (memory only). */
  const createCopy = async (missing = false) => {
    refocusPrimary.current = true;
    const ok = await store.openExample(guide.exampleId);
    const id = store.state.doc?.projectId;
    if (ok && id) {
      rememberGuideCopy(guide.id, id);
      setCopyId(id);
    }
    announce(
      t(
        !ok
          ? 'guidepanel.panel.exampleFailed'
          : missing
            ? 'guidepanel.panel.copyMissing'
            : 'guidepanel.panel.exampleOpened',
      ),
    );
  };

  const openExample = async () => {
    // Re-check at click time: the copy may have been deleted since the panel opened.
    const existing = await findCopy();
    if (existing) return void (await goBack(existing));
    await createCopy(copyId !== undefined);
  };

  const goBack = async (id: string) => {
    await store.openProject(id);
    if (store.state.doc?.projectId === id) {
      announce(t('guidepanel.panel.wentBack'));
      return;
    }
    // The project vanished between the check and the open.
    await createCopy(true);
  };

  return (
    <aside
      class="guide-panel"
      aria-labelledby="guide-panel-title"
      data-testid="guide-panel"
      lang={locale.code}
      dir={locale.dir}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <header class="guide-header">
        <h2 id="guide-panel-title" tabIndex={-1} ref={heading} data-testid="guide-title">
          {t(guide.titleKey)}
        </h2>
        <button type="button" class="button" data-testid="guide-close" onClick={onClose}>
          {t('guidepanel.panel.close')}
        </button>
      </header>
      <p class="muted small">{t('guidepanel.panel.minutes', { n: guide.minutes })}</p>
      <div role="status" data-testid="guide-notes">
        {!evaluation && <p class="muted">{t('guidepanel.panel.loading')}</p>}
        {missing && (
          <p class="guide-note" data-testid="guide-values-missing">
            {t('guidepanel.panel.valuesUnavailable')}
          </p>
        )}
      </div>
      {evaluation &&
        guide.sections.map((s) => {
          const [head, ...rest] = s.keys;
          return (
            <section key={s.id} class="guide-section" data-testid={`guide-section-${s.id}`}>
              <h3>{msg(head!)}</h3>
              {s.id === 'behaviour' ? (
                <ul>
                  {rest.map((k) => (
                    <li key={k}>{msg(k)}</li>
                  ))}
                </ul>
              ) : s.id === 'tryit' ? (
                <>
                  <ol>
                    <li>{msg(rest[0]!)}</li>
                  </ol>
                  <p>
                    <strong>{t('guidepanel.panel.expected')}</strong> {msg(rest[1]!)}
                  </p>
                </>
              ) : (
                rest.map((k) => <p key={k}>{msg(k)}</p>)
              )}
              {s.id === 'circuit' &&
                (copyId ? (
                  <div>
                    <p class="muted" data-testid="guide-copy-hint">
                      {t('guidepanel.panel.copyHint')}
                    </p>
                    <div>
                      <button
                        type="button"
                        class="button button-primary"
                        data-testid="guide-go-back"
                        ref={primary}
                        onClick={() => void goBack(copyId)}
                      >
                        {t('guidepanel.panel.goBack')}
                      </button>{' '}
                      <button
                        type="button"
                        class="button"
                        data-testid="guide-fresh-copy"
                        onClick={() => void createCopy()}
                      >
                        {t('guidepanel.panel.freshCopy')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    class="button button-primary"
                    data-testid="guide-open-example"
                    ref={primary}
                    onClick={() => void openExample()}
                  >
                    {t('guidepanel.panel.openExample')}
                  </button>
                ))}
            </section>
          );
        })}
      <div class="visually-hidden" role="status" aria-live="polite" data-testid="guide-status">
        {status}
      </div>
    </aside>
  );
}

const nothing = { applied: false, solved: false, exceedsRating: null, ratingWarned: false };
