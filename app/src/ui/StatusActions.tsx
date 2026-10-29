/**
 * Sprint 23B: the status bar's actions: "Feedback" (opens the extended Report a problem dialog)
 * and, for the owner only, "Administration". In the bottom status bar, so they are always
 * reachable and never cover the circuit. The administration entry appears only after the
 * Session Host confirmed that this account is the owner (the server decides; this only hides).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ADMIN_UI, PROBLEM_REPORTS } from '../deployment.js';
import { gateFetch } from '../gate.js';
import { isOwner } from './admin.js';
import { openAdmin } from './AdminPanel.js';
import { useT } from './context.js';
import { openProblemReport } from './ProblemReport.js';

export function StatusActions() {
  const t = useT();
  const feedback = useRef<HTMLButtonElement>(null);
  const admin = useRef<HTMLButtonElement>(null);
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    if (!ADMIN_UI) return;
    let live = true;
    void isOwner((input, init) => gateFetch(input, init)).then((o) => live && setOwner(o));
    return () => {
      live = false;
    };
  }, []);
  if (!PROBLEM_REPORTS && !(ADMIN_UI && owner)) return null;
  return (
    <div class="statusbar-actions">
      {PROBLEM_REPORTS && (
        <button
          ref={feedback}
          type="button"
          class="statusbar-action"
          data-testid="feedback-button"
          aria-haspopup="dialog"
          onClick={() => openProblemReport(feedback.current)}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" class="control-icon">
            <path d="M2.5 3.5 H13.5 V10.5 H7 L4 13 V10.5 H2.5 Z" />
          </svg>
          <span>{t('status.feedback')}</span>
        </button>
      )}
      {ADMIN_UI && owner && (
        <button
          ref={admin}
          type="button"
          class="statusbar-action"
          data-testid="admin-button"
          aria-haspopup="dialog"
          onClick={() => openAdmin(admin.current)}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" class="control-icon">
            <circle cx="6" cy="5.5" r="2.5" />
            <path d="M1.5 13.5 C2 10.5 4 9.5 6 9.5 C8 9.5 10 10.5 10.5 13.5 M11 4 H15 M11 7 H15 M12 10 H15" />
          </svg>
          <span>{t('status.admin')}</span>
        </button>
      )}
    </div>
  );
}
