import { useEffect, useRef, useState } from 'preact/hooks';
import markUrl from '../assets/brand/tbi-mark.png';
import { SIGN_OUT_URL } from '../deployment.js';
import { LOCALES } from '../i18n/i18n.js';
import { useAppState, useStore, useT } from './context.js';
import { downloadProject } from './download.js';
import { SimControls } from './SimControls.js';

const BRAND = 'TBI Lab';
/** The TBI letters take the logo's three colours; the product name follows in ink. */
const BRAND_LETTERS: readonly [string, string][] = [
  ['T', 'brand-t'],
  ['B', 'brand-b'],
  ['I', 'brand-i'],
];
const BRAND_SUFFIX = '\u00a0Lab';

export function TopBar() {
  const state = useAppState();
  const store = useStore();
  const t = useT();
  const editing = state.screen === 'editor' && !!state.doc;
  return (
    <header class="topbar">
      {/* 1. Where am I: brand, back to the library, the project's own name. */}
      <div class="topbar-group topbar-nav">
        <span class="brand" dir="ltr" aria-label={BRAND}>
          <img class="brand-mark" src={markUrl} alt="" width={30} height={30} />
          <span class="brand-word" aria-hidden="true">
            {BRAND_LETTERS.map(([letter, cls]) => (
              <span key={letter} class={cls}>
                {letter}
              </span>
            ))}
            {BRAND_SUFFIX}
          </span>
        </span>
        {editing && (
          <button type="button" class="button button-quiet" onClick={() => void store.goHome()}>
            <span aria-hidden="true" class="nav-arrow">
              ‹
            </span>{' '}
            {t('topbar.projects')}
          </button>
        )}
        {editing && <ProjectName name={state.doc!.name} disabled={!!state.readOnly} />}
      </div>
      <span class="spacer" />
      {/* 2. Work on the circuit: history, then the simulation. */}
      {editing && (
        <div class="topbar-group topbar-work">
          {!state.readOnly && <HistoryControls />}
          <SimControls />
        </div>
      )}
      {/* 3. Project file state and application settings. */}
      <div class="topbar-group topbar-meta">
        {editing && !state.readOnly && <SaveIndicator />}
        {editing && !state.readOnly && (
          <button
            type="button"
            class="button button-quiet"
            data-testid="export-current"
            title={t('export.title')}
            onClick={() => void downloadProject(store, state.doc!.projectId)}
          >
            {t('export.button')}
          </button>
        )}
        <label class="language">
          {/* The select shows each language's own name; the label stays for assistive tech. */}
          <span class="visually-hidden">{t('topbar.language')}</span>
          <select
            data-testid="language-select"
            value={state.locale.code}
            onChange={(e) => store.setLocale((e.target as HTMLSelectElement).value)}
          >
            {LOCALES.map((l) => (
              <option key={l.code} value={l.code} lang={l.code} dir={l.dir}>
                {l.autonym}
              </option>
            ))}
          </select>
        </label>
        {/* Only a protected deployment configures this; a plain navigation leaves it. */}
        {SIGN_OUT_URL && (
          <a class="button button-quiet sign-out" data-testid="sign-out" href={SIGN_OUT_URL}>
            {t('topbar.signOut')}
          </a>
        )}
      </div>
    </header>
  );
}

function ProjectName({ name, disabled }: { name: string; disabled: boolean }) {
  const store = useStore();
  const t = useT();
  const [draft, setDraft] = useState(name);
  // Re-sync only when the stored name really changes, never on mount (see ParamField).
  const synced = useRef(name);
  useEffect(() => {
    if (synced.current === name) return;
    synced.current = name;
    setDraft(name);
  }, [name]);
  /**
   * Commit the element's actual value, not the draft state: Enter/Blur can arrive before a
   * pending state render has run (CI run 35789744836).
   */
  const commit = (input: HTMLInputElement) => {
    const raw = input.value;
    if (raw === name) return;
    if (!store.rename(raw)) {
      // Refused (e.g. empty): restore both the state and the element itself, which may
      // already hold the stale text if no render is pending.
      input.value = name;
      setDraft(name);
    }
  };
  return (
    <input
      class="project-name"
      data-testid="project-name"
      aria-label={t('topbar.projectName')}
      dir="auto"
      value={draft}
      disabled={disabled}
      onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          // Restore synchronously so the blur that follows commits nothing.
          e.currentTarget.value = name;
          setDraft(name);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function SaveIndicator() {
  const { saveState } = useAppState();
  const store = useStore();
  const t = useT();
  const text = { saved: t('save.saved'), saving: t('save.saving'), error: t('save.error') }[
    saveState
  ];
  const icon = { saved: '✓', saving: '…', error: '!' }[saveState];
  return (
    <span
      class={`save-state save-${saveState}`}
      role="status"
      aria-live="polite"
      data-testid="save-state"
      data-state={saveState}
    >
      <span class="save-icon" aria-hidden="true">
        {icon}
      </span>
      {text}
      {saveState === 'error' && (
        <button type="button" class="link-button" onClick={() => void store.retrySave()}>
          {t('save.retry')}
        </button>
      )}
    </span>
  );
}

/** Project undo/redo (persistent edits only; see AppStore). */
function HistoryControls() {
  const { history } = useAppState();
  const store = useStore();
  const t = useT();
  return (
    <div class="history-controls" role="group">
      <button
        type="button"
        class="button"
        data-testid="undo"
        disabled={history.undo === 0}
        aria-keyshortcuts="Control+Z Meta+Z"
        onClick={() => store.undo()}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" class="control-icon">
          <path d="M6 3 L2 7 L6 11 M2 7 H10 a4 4 0 0 1 0 8 H8" />
        </svg>{' '}
        {t('history.undo')}
      </button>
      <button
        type="button"
        class="button"
        data-testid="redo"
        disabled={history.redo === 0}
        aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
        onClick={() => store.redo()}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" class="control-icon">
          <path d="M10 3 L14 7 L10 11 M14 7 H6 a4 4 0 0 0 0 8 H8" />
        </svg>{' '}
        {t('history.redo')}
      </button>
    </div>
  );
}
