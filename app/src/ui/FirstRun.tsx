/**
 * TBI-014: the first-run welcome. A modal native <dialog> (focus trapped by the browser, Esc
 * closes, labelled by its title) with three steps and a button that opens the real "LED current
 * limiting" example through the store. Remembered per device in localStorage; reopenable from the
 * application menu. Design: docs/design/TBI-014-first-five-minutes.md.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { isolateLtr } from '../i18n/i18n.js';
import { useAppState, useStore, useT } from './context.js';
import { FIRST_RUN_EXAMPLE, FIRST_RUN_PROBE, shouldAutoShowFirstRun } from './firstRun.js';

const listeners = new Set<() => void>();
/** Open the welcome on request (the menu entry). */
/**
 * Return focus to the element that opened the dialog; when that is gone (the menu item that
 * opened it), to the app-menu trigger. Deferred a frame: the native dialog close restores its
 * own (possibly detached) previous focus first and would otherwise win.
 */
function restoreFocus(back: HTMLElement | null): void {
  requestAnimationFrame(() => {
    if (back?.isConnected) back.focus();
    else document.querySelector<HTMLElement>('[data-testid="app-menu-button"]')?.focus();
  });
}

export function openFirstRun(): void {
  for (const l of listeners) l();
}

/** Skip or Esc hides the automatic welcome for this page session only. */
let skippedThisSession = false;

/** Mounted once (App): opens itself for a new device, on request for everyone. */
export function FirstRunHost() {
  const state = useAppState();
  const store = useStore();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [announce, setAnnounce] = useState('');
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const l = () => {
      opener.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    };
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);

  useEffect(() => {
    if (
      !open &&
      shouldAutoShowFirstRun({
        screen: state.screen,
        projectCount: state.projects.length,
        seen: store.firstRunSeen(),
        skippedThisSession,
      })
    )
      setOpen(true);
  }, [state.screen, state.projects.length]);

  const close = (remember: boolean) => {
    if (remember) store.setFirstRunSeen(true);
    else skippedThisSession = true;
    setOpen(false);
    const back = opener.current;
    opener.current = null;
    restoreFocus(back);
  };

  const start = async () => {
    const back = opener.current;
    setOpen(false);
    opener.current = null;
    if (!(await store.openExample(FIRST_RUN_EXAMPLE))) {
      // The store shows its own error notice; the welcome stays available and focus returns.
      restoreFocus(back);
      return;
    }
    store.setFirstRunSeen(true);
    setAnnounce(t('firstRun.opened'));
    // Put the next step (Run) under the keyboard once the editor has rendered it.
    const until = Date.now() + 3000;
    const focusRun = () => {
      const run = document.querySelector<HTMLElement>('[data-testid="sim-run"]');
      if (run) run.focus();
      else if (Date.now() < until) requestAnimationFrame(focusRun);
    };
    focusRun();
    setTimeout(() => setAnnounce(''), 6000);
  };

  return (
    <>
      <div class="visually-hidden" role="status" data-testid="first-run-status">
        {announce}
      </div>
      {open && <FirstRunDialog onStart={() => void start()} onClose={close} />}
    </>
  );
}

function FirstRunDialog({
  onStart,
  onClose,
}: {
  onStart: () => void;
  onClose: (remember: boolean) => void;
}) {
  const t = useT();
  const { locale } = useAppState();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      class="dialog first-run-dialog"
      dir={locale.dir}
      data-testid="first-run-dialog"
      aria-labelledby="first-run-title"
      aria-describedby="first-run-intro"
      onCancel={(e) => {
        e.preventDefault();
        onClose(false);
      }}
    >
      <h2 id="first-run-title">{t('firstRun.title')}</h2>
      <p id="first-run-intro">{t('firstRun.intro')}</p>
      <ol class="first-run-steps" aria-label={t('firstRun.listLabel')}>
        <li data-testid="first-run-step-1">{t('firstRun.step1')}</li>
        <li data-testid="first-run-step-2">{t('firstRun.step2')}</li>
        <li data-testid="first-run-step-3">
          {t('firstRun.step3', { probe: isolateLtr(FIRST_RUN_PROBE) })}
        </li>
      </ol>
      <p class="muted small">{t('firstRun.note')}</p>
      <div class="dialog-actions first-run-actions">
        <button
          type="button"
          class="button"
          data-testid="first-run-skip"
          onClick={() => onClose(false)}
        >
          {t('firstRun.skip')}
        </button>
        <button
          type="button"
          class="button"
          data-testid="first-run-never"
          onClick={() => onClose(true)}
        >
          {t('firstRun.never')}
        </button>
        <button
          type="button"
          class="button button-primary"
          data-testid="first-run-start"
          autofocus
          onClick={onStart}
        >
          {t('firstRun.start')}
        </button>
      </div>
    </dialog>
  );
}
