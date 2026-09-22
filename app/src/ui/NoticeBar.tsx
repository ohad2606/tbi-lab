import { isolateLtr } from '../i18n/i18n.js';
import { useAppState, useStore, useT } from './context.js';

export function NoticeBar() {
  const { notice, readOnly, unreadable } = useAppState();
  const store = useStore();
  const t = useT();
  return (
    <div class="banners">
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
      {notice && (
        <div class="banner banner-error" role="alert" data-testid="notice">
          <span>{t(notice.key, notice.params)}</span>
          <button type="button" class="link-button" onClick={() => store.dismissNotice()}>
            {t('notice.dismiss')}
          </button>
        </div>
      )}
    </div>
  );
}
