import { useEffect, useRef, useState } from 'preact/hooks';
import { LOCALES } from '../i18n/i18n.js';
import { useAppState, useStore, useT } from './context.js';
import { SimControls } from './SimControls.js';

const BRAND = 'TBI Lab';

export function TopBar() {
  const state = useAppState();
  const store = useStore();
  const t = useT();
  return (
    <header class="topbar">
      <span class="brand" dir="ltr">
        {BRAND}
      </span>
      {state.screen === 'editor' && (
        <button type="button" class="button" onClick={() => void store.goHome()}>
          {t('topbar.projects')}
        </button>
      )}
      {state.screen === 'editor' && state.doc && (
        <ProjectName name={state.doc.name} disabled={!!state.readOnly} />
      )}
      <span class="spacer" />
      {state.screen === 'editor' && state.doc && !state.readOnly && <HistoryControls />}
      {state.screen === 'editor' && state.doc && <SimControls />}
      {state.screen === 'editor' && !state.readOnly && <SaveIndicator />}
      <label class="language">
        <span>{t('topbar.language')}</span>
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
