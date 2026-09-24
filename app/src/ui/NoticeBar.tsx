import { isolateLtr } from '../i18n/i18n.js';
import type { SimFailure } from '../sim/controller.js';
import type { RatingWarning } from '@tbi-lab/engine';
import {
  engineErrorMessage,
  groupByComponent,
  ratingRow,
  simFailureMessage,
} from '../sim/format.js';
import { warningsFor } from '../sim/ratings.js';
import { useAppState, useStore, useT } from './context.js';

export function NoticeBar() {
  const { notice, readOnly, unreadable, sim, locale, doc, saveState, saveError, screen } =
    useAppState();
  const store = useStore();
  const t = useT();
  const running = sim.status === 'running' ? sim.outcome : null;
  return (
    <div class="banners">
      {sim.status === 'failed' && (
        <div
          class="banner banner-error"
          role="alert"
          data-testid="sim-error"
          data-code={failureCode(sim.failure)}
        >
          {simFailureMessage(locale, sim.failure, doc)}
        </div>
      )}
      {running && !running.ok && (
        <div
          class="banner banner-error"
          role="alert"
          data-testid="sim-error"
          data-code={running.error.code}
        >
          {engineErrorMessage(locale, running.error, doc)}
        </div>
      )}
      {running?.ok && doc && warningsFor(doc, running).length > 0 && (
        // A documented datasheet limit is exceeded: a WARNING (amber), distinct from the red
        // solver errors above. The solved values are unchanged.
        <div class="banner banner-warning banner-rating" role="status" data-testid="rating-warning">
          <strong class="rating-title">{t('rating.heading')}</strong>
          {groupByComponent(warningsFor(doc, running)).map(([id, rows]) => (
            <RatingGroup key={id} component={id} rows={rows} />
          ))}
          <span class="rating-note small">{t('rating.note')}</span>
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
      {screen === 'editor' && saveState === 'error' && (
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
          <button type="button" class="link-button" onClick={() => store.dismissNotice()}>
            {t('notice.dismiss')}
          </button>
        </div>
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
    <div class="rating-group" data-testid={`rating-${component}`} data-model={rows[0]?.model}>
      <span class="rating-summary">{t('rating.atRisk', { component: isolateLtr(component) })}</span>
      <ul class="rating-list">
        {rows.map((w) => (
          <li key={w.code} data-code={w.code}>
            {ratingRow(locale, w)}
          </li>
        ))}
      </ul>
    </div>
  );
}
