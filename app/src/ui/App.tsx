import { CapabilitiesHost } from './Capabilities.js';
import { ProblemReportHost } from './ProblemReport.js';
import { useEffect, useLayoutEffect } from 'preact/hooks';
import { useAppState, useStore, useT } from './context.js';
import { Editor } from './Editor.js';
import { EnvironmentNotes } from './EnvironmentNotes.js';
import { Home } from './Home.js';
import { NoticeBar } from './NoticeBar.js';
import { TopBar } from './TopBar.js';
import { SignInBanner } from './SignInBanner.js';
import { UpdateBanner } from './UpdateBanner.js';
import { VersionStatus } from './VersionStatus.js';

export function App() {
  const state = useAppState();
  const store = useStore();
  const t = useT();

  // Direction and language apply to the application chrome; the canvas opts out (dir="ltr").
  // A layout effect: set in the same commit as the translated text, so no frame ever shows
  // one locale's text with the other's direction (a post-paint effect lagged on slow runners,
  // GitHub Actions 36328598866).
  useLayoutEffect(() => {
    document.documentElement.lang = state.locale.code;
    document.documentElement.dir = state.locale.dir;
  }, [state.locale]);

  useEffect(() => {
    const flush = () => void store.flush();
    const onVisibility = () => document.visibilityState === 'hidden' && flush();
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (store.hasUnsavedChanges) {
        flush();
        e.preventDefault();
      }
    };
    // Project undo/redo shortcuts. Inside text fields the browser's own input undo applies to
    // the draft text only; project history is never delegated to it.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const redo = (e.code === 'KeyZ' && e.shiftKey) || (e.code === 'KeyY' && !e.shiftKey);
      const undo = e.code === 'KeyZ' && !e.shiftKey;
      if (!undo && !redo) return;
      e.preventDefault();
      if (undo) store.undo();
      else store.redo();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [store]);

  if (state.screen === 'loading') {
    return (
      <>
        <EnvironmentNotes />
        <div class="app-message" role="status">
          {t('app.loading')}
        </div>
      </>
    );
  }
  if (state.screen === 'unavailable') {
    return (
      <>
        <EnvironmentNotes />
        <div class="app-message" role="alert" data-testid="storage-unavailable">
          <p>{t('app.storageUnavailable')}</p>
          <button type="button" class="button button-primary" onClick={() => location.reload()}>
            {t('app.reload')}
          </button>
        </div>
      </>
    );
  }
  return (
    <div class="app">
      {/* The DEV strip and the screen support note: their own row, above the top bar. */}
      <EnvironmentNotes />
      <TopBar />
      <SignInBanner />
      <UpdateBanner />
      <NoticeBar />
      {state.screen === 'editor' && state.doc ? <Editor /> : <Home />}
      <VersionStatus />
      <CapabilitiesHost />
      <ProblemReportHost />
    </div>
  );
}
