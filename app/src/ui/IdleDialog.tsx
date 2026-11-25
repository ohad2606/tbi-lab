/**
 * K3-3: "Still there?". Shown while the running ESP32 session is about to be stopped for lack of
 * activity (`view.idleSoon`). A modal alertdialog with static text (no countdown is read out):
 * focus starts on "Keep running", Esc means the same, and only these explicit actions decide.
 *
 * Nothing is claimed that the host did not confirm: the dialog closes when the warning is gone
 * (accepted answer, Stop, or the session ended). A refused or unanswered "Keep running" is said in
 * the dialog, which stays usable; "Stop now" always works.
 *
 * Focus on close: back to where it was; if the run is over (or there was nowhere), to Run.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppStore } from '../state/app.js';
import { useAppState, useStore, useT } from './context.js';
import { trapTab } from './ShortcutsDialog.js';

export function IdleHost() {
  const { sim } = useAppState();
  return sim.status === 'running' && sim.runtime?.idleSoon ? <IdleDialog /> : null;
}

/** The Run/Stop control is disabled while the session ends: wait on <main>, never on <body>. */
function settleFocus(store: AppStore, opener: Element | null) {
  const status = () => store.state.sim.status;
  const back = opener instanceof HTMLElement && opener !== document.body && opener.isConnected;
  // Another dialog under this one keeps the focus it had; the toolbar is inert behind it.
  if (back && (status() === 'running' || opener.closest('dialog[open]'))) return opener.focus();
  const run = () => document.querySelector<HTMLElement>('.sim-toggle');
  if (status() !== 'stopping') return run()?.focus();
  const main = document.getElementById('main');
  main?.focus();
  const off = store.subscribe(() => {
    if (status() === 'stopping') return;
    off();
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (a === main || a === document.body) run()?.focus();
    });
  });
}

function IdleDialog() {
  const t = useT();
  const { locale } = useAppState();
  const store = useStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const open = useRef(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const opener = document.activeElement;
    open.current = true;
    dialog.current?.showModal();
    keepButton.current?.focus();
    return () => {
      open.current = false;
      dialog.current?.close();
      requestAnimationFrame(() => settleFocus(store, opener));
    };
  }, []);
  const keep = () => {
    setFailed(false); // empty first: a repeated failure is announced again
    void store.stillHere().then((ok) => open.current && setFailed(!ok));
  };
  return (
    <dialog
      ref={dialog}
      class="dialog idle-dialog"
      dir={locale.dir}
      data-testid="idle-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="idle-title"
      aria-describedby="idle-body"
      onKeyDown={(e) => {
        e.stopPropagation(); // app shortcuts stay behind the modal
        // A held key is not a decision: auto-repeat must not activate a button.
        if (e.repeat && (e.key === 'Enter' || e.key === ' ')) return e.preventDefault();
        trapTab(e);
        if (e.key !== 'Escape') return;
        // Handled here: the browser may close a dialog on a repeated Esc despite `cancel`.
        e.preventDefault();
        if (!e.repeat) keep();
      }}
      onCancel={(e) => {
        e.preventDefault();
        keep();
      }}
      // Closed by the browser while the warning stands: show it again, on "Keep running".
      onClose={() => {
        if (!open.current || dialog.current?.open) return;
        dialog.current?.showModal();
        keepButton.current?.focus();
      }}
    >
      <h2 id="idle-title">{t('sim.idle.title')}</h2>
      <p id="idle-body">{t('sim.idle.body')}</p>
      <div role="status" data-testid="idle-failed">
        {failed ? t('sim.idle.failed') : ''}
      </div>
      <div class="dialog-actions">
        <button type="button" class="button" data-testid="idle-stop" onClick={() => store.stop()}>
          {t('sim.idle.stop')}
        </button>
        <button
          ref={keepButton}
          type="button"
          class="button button-primary"
          data-testid="idle-keep"
          onClick={keep}
        >
          {t('sim.idle.continue')}
        </button>
      </div>
    </dialog>
  );
}
