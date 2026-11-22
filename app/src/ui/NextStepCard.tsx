/**
 * TBI-014 slice 2: a compact, non-modal card above the editor canvas, shown once per device after
 * the first successful Run of the first-run example. It never takes focus: it sits in the tab
 * order after the palette and view tabs' predecessors (DOM order), is announced once through a
 * polite status region, and closes with its button or Esc (when focus is inside it). It has no
 * timers and no motion. Design: docs/design/TBI-014-first-five-minutes.md.
 */
import { useEffect, useRef } from 'preact/hooks';
import { isolateLtr } from '../i18n/i18n.js';
import { useStore, useT } from './context.js';
import { FIRST_RUN_PROBE } from './firstRun.js';

/** After closing from inside the card, focus goes to the simulation control (Run/Stop). */
function focusSimControl(): void {
  const el =
    document.querySelector<HTMLElement>('[data-testid="sim-stop"]') ??
    document.querySelector<HTMLElement>('[data-testid="sim-run"]');
  el?.focus();
}

export function NextStepCard({ onDismiss }: { onDismiss: () => void }) {
  const t = useT();
  const store = useStore();
  // Shown once per device: remembered however the card goes away (button, Esc, leaving the
  // project or the editor).
  useEffect(() => () => store.setNextStepSeen(true), []);
  const root = useRef<HTMLElement>(null);
  const dismiss = () => {
    const hadFocus = !!root.current?.contains(document.activeElement);
    onDismiss();
    // Only move focus when the user was in the card (it is about to disappear under them).
    if (hadFocus) requestAnimationFrame(focusSimControl);
  };
  return (
    <section
      ref={root}
      class="next-step"
      data-testid="next-step"
      aria-labelledby="next-step-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          dismiss();
        }
      }}
    >
      <div class="next-step-head">
        <h2 id="next-step-title" class="next-step-title">
          {t('nextStep.title')}
        </h2>
        <button
          type="button"
          class="button next-step-dismiss"
          data-testid="next-step-dismiss"
          onClick={dismiss}
        >
          {t('nextStep.dismiss')}
        </button>
      </div>
      <ul class="next-step-list" aria-label={t('nextStep.listLabel')}>
        <li>{t('nextStep.step1', { probe: isolateLtr(FIRST_RUN_PROBE) })}</li>
        <li>{t('nextStep.step2')}</li>
        <li>{t('nextStep.step3')}</li>
      </ul>
    </section>
  );
}
