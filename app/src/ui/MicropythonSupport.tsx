/**
 * TBI-005: "MicroPython support" — what MicroPython code the Lab supports and refuses, generated
 * from the support contract (runtime/builder/pyContract.ts: the same table whose probes the
 * builder tests check against the Build analysis), so the list cannot drift from the code. The
 * contract is language-neutral; every sentence here is a translation key
 * (`mpy.contract.<id>.note` is the entry's note, held equal to the contract text by a test).
 * Shown from the code area while MicroPython is the editor language.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { MessageKey } from '../i18n/i18n.js';
import { SUPPORT_SECTIONS, entriesWithStatus } from './mpyContractView.js';
import { useAppState, useT } from './context.js';

/** The button (in the code bar) and its dialog. */
export function MicropythonSupport() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    // The native dialog restores focus too; do it explicitly so it never depends on that.
    opener.current?.focus();
  };
  return (
    <>
      <button
        ref={opener}
        type="button"
        class="button mpy-support-button"
        data-testid="mpy-support-button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {t('mpy.support.button')}
      </button>
      {open && <MicropythonSupportDialog onClose={close} />}
    </>
  );
}

function MicropythonSupportDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { locale } = useAppState();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  const key = (k: string) => k as MessageKey;
  return (
    <dialog
      ref={dialog}
      class="dialog mpy-support-dialog"
      dir={locale.dir}
      data-testid="mpy-support-dialog"
      aria-labelledby="mpy-support-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={() => undefined}
    >
      <div class="mpy-support-head">
        <h2 id="mpy-support-title">{t('mpy.support.title')}</h2>
        <button
          type="button"
          class="button"
          data-testid="mpy-support-close"
          autofocus
          onClick={onClose}
        >
          {t('mpy.support.close')}
        </button>
      </div>
      <p>{t('mpy.support.intro')}</p>
      {SUPPORT_SECTIONS.map((status) => {
        const entries = entriesWithStatus(status);
        if (!entries.length) return null;
        return (
          <section key={status} aria-labelledby={`mpy-support-h-${status}`}>
            <h3 id={`mpy-support-h-${status}`}>{t(key(`mpy.support.section.${status}`))}</h3>
            <ul class="capability-list mpy-support-list">
              {entries.map((e) => (
                <li key={e.id} data-testid={`mpy-entry-${e.id}`} data-status={e.status}>
                  <bdi dir="ltr" class="technical mpy-api">
                    <code>{e.api}</code>
                  </bdi>{' '}
                  <span class={`mpy-status mpy-status-${e.status}`}>
                    <span aria-hidden="true">{e.status === 'supported' ? '✓ ' : '✕ '}</span>
                    {t(key(`mpy.support.status.${e.status}`))}
                  </span>
                  <div class="small">{t(key(`mpy.contract.${e.id}.note`))}</div>
                  <div class="small muted">
                    {t(key(`mpy.support.at.${e.at}`))}
                    {e.refusal && (
                      <>
                        {' · '}
                        {t('mpy.support.refusal')}{' '}
                        <bdi dir="ltr" class="technical">
                          <code>{e.refusal}</code>
                        </bdi>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </dialog>
  );
}
