/**
 * Sprint 13 H4: the first-run guide on the Projects screen (three steps, every locale). Shown until
 * dismissed on this device; the header link brings it back. It points to the capability panel and
 * says the two things an alpha tester must know: the simulator is shared, projects live in this
 * browser (Export keeps a copy).
 */
import { openCapabilities } from './Capabilities.js';
import { useT } from './context.js';

export function GettingStarted({ onDismiss }: { onDismiss: () => void }) {
  const t = useT();
  return (
    <section
      class="card getting-started"
      aria-labelledby="getting-started-heading"
      data-testid="getting-started"
    >
      <h2 id="getting-started-heading">{t('onboarding.heading')}</h2>
      <p>{t('onboarding.intro')}</p>
      <ol class="getting-started-steps">
        <li data-testid="onboarding-step-1">{t('onboarding.step1')}</li>
        <li data-testid="onboarding-step-2">{t('onboarding.step2')}</li>
        <li data-testid="onboarding-step-3">{t('onboarding.step3')}</li>
      </ol>
      <p class="muted small" data-testid="onboarding-note">
        {t('onboarding.note')}
      </p>
      <div class="getting-started-actions">
        <button
          type="button"
          class="button"
          data-testid="onboarding-capabilities"
          onClick={() => openCapabilities('firmware')}
        >
          {t('menu.capabilities')}
        </button>
        <button
          type="button"
          class="button button-primary"
          data-testid="onboarding-dismiss"
          onClick={onDismiss}
        >
          {t('onboarding.dismiss')}
        </button>
      </div>
    </section>
  );
}
