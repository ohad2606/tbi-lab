/**
 * K11 slice 2: two storage notices (logic in storageNotices.ts).
 *  - TabOutdatedBanner: assertive live region (always mounted, no role while empty so it is not an
 *    empty alert); the banner inside has role="alert". Reload button. No timeout, never moves focus.
 *  - ExportReminder: polite live region; the note inside has role="status". Non-modal, dismissible,
 *    shown once per session.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { onPersistStatus, persistStatus, type PersistResult } from '../persistence/persist.js';
import { useAppState, useStore, useT } from './context.js';
import { downloadProject } from './download.js';
import {
  isVersionChanged,
  markReminderSeen,
  onVersionChanged,
  reloadTab,
  reminderSeen,
  shouldShowExportReminder,
} from './storageNotices.js';

const session = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

export function TabOutdatedBanner() {
  const t = useT();
  const [stale, setStale] = useState(isVersionChanged);
  useEffect(() => onVersionChanged(() => setStale(true)), []);
  // The live region is always mounted; its content appears later so screen readers announce it.
  return (
    <div class="banners" aria-live="assertive" aria-atomic="true" data-testid="tab-outdated-live">
      {stale && (
        <div class="banner banner-warning" role="alert" data-testid="tab-outdated">
          <span id="tab-outdated-text">{t('storage.tabOutdated')}</span>{' '}
          <button
            type="button"
            class="button button-primary"
            data-testid="tab-outdated-reload"
            aria-label={t('storage.reloadTab')}
            aria-describedby="tab-outdated-text"
            onClick={() => reloadTab()}
          >
            {t('storage.reload')}
          </button>
        </div>
      )}
    </div>
  );
}

export function ExportReminder() {
  const t = useT();
  const store = useStore();
  const { doc } = useAppState();
  const [persist, setPersist] = useState<PersistResult | null>(persistStatus);
  const [stale, setStale] = useState(isVersionChanged);
  const [edited, setEdited] = useState(false);
  const [visible, setVisible] = useState(false);
  const projectId = useRef<string | null>(null);
  const baseline = useRef(new Map<string, number>());
  useEffect(() => onPersistStatus(setPersist), []);
  useEffect(() => onVersionChanged(() => setStale(true)), []);
  // An edit = the open project's revision moved past the one first seen in this session
  // (opening or creating a project is not an edit).
  useEffect(() => {
    if (!doc) return;
    const rev = doc.revision.localRevision;
    const base = baseline.current.get(doc.projectId);
    if (base === undefined) baseline.current.set(doc.projectId, rev);
    else if (rev > base) {
      projectId.current = doc.projectId;
      setEdited(true);
    }
  }, [doc]);
  useEffect(() => {
    if (visible) return;
    if (
      shouldShowExportReminder({
        persist,
        edited,
        seenThisSession: reminderSeen(session()),
        storageUnavailable: stale,
      })
    ) {
      markReminderSeen(session());
      setVisible(true);
    }
  }, [persist, edited, stale, visible]);
  // Dismissing removes the focused button: move focus to the main landmark (tabIndex -1).
  const dismiss = () => {
    setVisible(false);
    document.getElementById('main')?.focus();
  };
  return (
    <div class="banners" aria-live="polite" aria-atomic="true" data-testid="export-reminder-live">
      {visible && (
        <div class="banner banner-info export-reminder" role="status" data-testid="export-reminder">
          <span>{t('storage.exportReminder')}</span>
          <span class="update-actions">
            {projectId.current && (
              <button
                type="button"
                class="button"
                data-testid="export-reminder-export"
                onClick={() => void downloadProject(store, projectId.current!)}
              >
                {t('storage.exportAction')}
              </button>
            )}
            <button
              type="button"
              class="button"
              data-testid="export-reminder-dismiss"
              onClick={dismiss}
            >
              {t('storage.exportDismiss')}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
