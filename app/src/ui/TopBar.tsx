import { useEffect, useState } from 'preact/hooks';
import { LOCALES } from '../i18n/i18n.js';
import { useAppState, useStore, useT } from './context.js';

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
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    if (draft === name) return;
    if (!store.rename(draft)) setDraft(name);
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
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(name);
          (e.target as HTMLInputElement).blur();
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
