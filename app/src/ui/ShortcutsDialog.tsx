/**
 * The keyboard shortcuts dialog (TBI-020 slice 2): generated from SHORTCUTS, one real table per
 * area. A native modal `<dialog>` (focus trapped by the browser), labelled by its heading, Escape
 * closes it and focus returns to the control that opened it. Opened from the top bar's button and
 * by the typed `?` (ignored while typing or while another dialog is open). Key names are LTR
 * (`kbd` with dir="ltr") inside the RTL page; the texts follow the document direction.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Fragment, type ComponentChildren } from 'preact';
import type { MessageKey } from '../i18n/i18n.js';
import { useAppState, useT } from './context.js';
import {
  SHORTCUT_SCOPES,
  chordKeys,
  isHelpKey,
  shortcutsIn,
  type ShortcutDef,
} from './shortcuts.js';

const listeners = new Set<(trigger: HTMLElement | null) => void>();
/** Open the dialog; focus returns to `trigger` when it closes. */
export function openShortcuts(trigger: HTMLElement | null): void {
  for (const l of listeners) l(trigger);
}

/** Mounted once (App): the `?` listener and the dialog while it is open. */
export function ShortcutsHost() {
  const [trigger, setTrigger] = useState<{ el: HTMLElement | null } | null>(null);
  useEffect(() => {
    const open = (el: HTMLElement | null) => setTrigger((cur) => cur ?? { el });
    listeners.add(open);
    const onKey = (e: KeyboardEvent) => {
      if (!isHelpKey(e, !!document.querySelector('dialog[open]'))) return;
      e.preventDefault();
      open(document.activeElement as HTMLElement | null);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      listeners.delete(open);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  return trigger ? <ShortcutsDialog trigger={trigger.el} onClose={() => setTrigger(null)} /> : null;
}

/** Key names inside translated text (Esc, Tab, ...) stay left-to-right. */
const KEY_WORDS = /\b(Esc|Tab|Shift|Ctrl|Cmd|Enter|Space|Delete)\b/g;
function isolateKeyNames(text: string): ComponentChildren {
  const parts = text.split(KEY_WORDS);
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <bdi key={i} dir="ltr">
        {p}
      </bdi>
    ) : (
      p
    ),
  );
}

function Chord({ chord }: { chord: string }) {
  const t = useT();
  const names = chordKeys(chord);
  return (
    <span class="shortcut-chord" dir="ltr">
      {names.map((n, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden="true">+</span>}
          <kbd>{n === 'Mod' ? t('shortcuts.mod') : n}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

function Keys({ def }: { def: ShortcutDef }) {
  const t = useT();
  return (
    <>
      {def.keys.map((chord, i) => (
        <Fragment key={chord}>
          {i > 0 && <span class="shortcut-or"> {t('shortcuts.or')} </span>}
          <Chord chord={chord} />
        </Fragment>
      ))}
    </>
  );
}

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab inside the modal: the browser would otherwise move on to its own controls. The heading
 * (tabindex -1) is the start; the close button is the only stop, so Tab and Shift+Tab stay on it.
 */
function trapTab(e: KeyboardEvent) {
  if (e.key !== 'Tab') return;
  const dialog = e.currentTarget as HTMLElement;
  const stops = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (stops.length === 0) return;
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !stops.includes(active as HTMLElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !stops.includes(active as HTMLElement))) {
    e.preventDefault();
    first.focus();
  }
}

function ShortcutsDialog({
  trigger,
  onClose,
}: {
  trigger: HTMLElement | null;
  onClose: () => void;
}) {
  const t = useT();
  const { locale } = useAppState();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    // The heading takes focus: a screen reader reads the title, then Tab reaches the first
    // control; the long list is not read as one block.
    heading.current?.focus();
    return () => {
      d?.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  const key = (k: string) => k as MessageKey;
  return (
    <dialog
      ref={dialog}
      class="dialog shortcuts-dialog"
      dir={locale.dir}
      data-testid="shortcuts-dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
      aria-describedby="shortcuts-intro"
      onKeyDown={trapTab}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="shortcuts-title" ref={heading} tabIndex={-1}>
        {t('shortcuts.title')}
      </h2>
      <p id="shortcuts-intro">{t('shortcuts.intro')}</p>
      {SHORTCUT_SCOPES.map((scope) => (
        <section key={scope}>
          <table class="shortcut-table" data-testid={`shortcuts-${scope}`}>
            <caption>{t(key(`shortcuts.scope.${scope}`))}</caption>
            <thead>
              <tr>
                <th scope="col">{t('shortcuts.col.keys')}</th>
                <th scope="col">{t('shortcuts.col.action')}</th>
                <th scope="col">{t('shortcuts.col.when')}</th>
              </tr>
            </thead>
            <tbody>
              {shortcutsIn(scope).map((def) => (
                <tr key={def.id} data-testid={`shortcut-${def.id}`}>
                  <th scope="row" class="shortcut-keys">
                    <Keys def={def} />
                  </th>
                  <td>{isolateKeyNames(t(key(`shortcut.${def.id}.action`)))}</td>
                  <td>{isolateKeyNames(t(key(`shortcut.${def.id}.when`)))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      <div class="dialog-actions">
        <button type="button" class="button" data-testid="shortcuts-close" onClick={onClose}>
          {t('shortcuts.close')}
        </button>
      </div>
    </dialog>
  );
}
