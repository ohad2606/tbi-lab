import { useEffect, useRef, useState } from 'preact/hooks';
import logoUrl from '../assets/brand/tbi-logo.png';
import { SIGN_OUT_URL } from '../deployment.js';
import { LOCALES } from '../i18n/i18n.js';
import { AppMenu } from './AppMenu.js';
import { useAppState, useStore, useT } from './context.js';
import { useImportPicker } from './importFile.js';
import { SimControls } from './SimControls.js';

/**
 * Top bar. Editor: brand and project | editing and simulation | language and the menu.
 * Projects screen (itself the navigation hub): brand | language and sign-out.
 */
export function TopBar() {
  const state = useAppState();
  const editing = state.screen === 'editor' && !!state.doc;
  return (
    <header class={`topbar ${editing ? 'topbar-editor' : 'topbar-home'}`}>
      {editing ? <EditorBar /> : <HomeBar />}
    </header>
  );
}

/** The TBI brand letters take the logo's three colours; the product name follows in ink. */
const BRAND_SUFFIX = '\u00a0Lab';
const BRAND_LETTERS: readonly [string, string][] = [
  ['T', 'brand-t'],
  ['B', 'brand-b'],
  ['I', 'brand-i'],
];

/** The regular TBI logo (made for the navy brand colour, as in the Projects hero) and name. */
function Brand() {
  const t = useT();
  return (
    <span class="brand" data-testid="brand" dir="ltr">
      <span class="brand-logo-tile">
        <img
          class="brand-logo"
          data-testid="brand-logo"
          src={logoUrl}
          alt={t('brand.logoAlt')}
          width={533}
          height={300}
          decoding="async"
        />
      </span>
      <span class="brand-word">
        {BRAND_LETTERS.map(([letter, cls]) => (
          <span key={letter} class={cls}>
            {letter}
          </span>
        ))}
        {BRAND_SUFFIX}
      </span>
    </span>
  );
}

function HomeBar() {
  const t = useT();
  return (
    <>
      <div class="topbar-group topbar-nav">
        <Brand />
      </div>
      <span class="spacer" />
      <div class="topbar-group topbar-meta">
        <LanguageSelect />
        {/* Only a protected deployment configures this; a plain navigation leaves it. */}
        {SIGN_OUT_URL && (
          <a class="button button-quiet sign-out" data-testid="sign-out" href={SIGN_OUT_URL}>
            {t('topbar.signOut')}
          </a>
        )}
      </div>
    </>
  );
}

function EditorBar() {
  const state = useAppState();
  const picker = useImportPicker();
  return (
    <>
      {/* 1. Where am I: the brand and the project's own name. */}
      <div class="topbar-group topbar-nav">
        <Brand />
        <ProjectName name={state.doc!.name} disabled={!!state.readOnly} />
      </div>
      {/* 2. Work on the circuit: file state, history, the one simulation control. */}
      <div class="topbar-group topbar-work">
        {!state.readOnly && <SaveIndicator />}
        {!state.readOnly && <HistoryControls />}
        <SimControls />
      </div>
      <span class="spacer" />
      {/* 3. Application: language, then projects, files and account in the menu. */}
      <div class="topbar-group topbar-meta">
        <LanguageSelect />
        {picker.input}
        <AppMenu chooseImport={picker.choose} />
      </div>
    </>
  );
}

function LanguageSelect() {
  const state = useAppState();
  const store = useStore();
  const t = useT();
  return (
    <label class="language">
      {/* The select shows each language's own name; the label stays for assistive tech. */}
      <span class="visually-hidden">{t('topbar.language')}</span>
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" class="control-icon">
        <circle cx="8" cy="8" r="6.2" />
        <path d="M1.8 8 H14.2 M8 1.8 C5.6 4.2 5.6 11.8 8 14.2 M8 1.8 C10.4 4.2 10.4 11.8 8 14.2" />
      </svg>
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
