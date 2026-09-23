import { useEffect } from 'preact/hooks';
import { useAppState, useStore, useT } from './context.js';
import { Editor } from './Editor.js';
import { Home } from './Home.js';
import { NoticeBar } from './NoticeBar.js';
import { TopBar } from './TopBar.js';

export function App() {
  const state = useAppState();
  const store = useStore();
  const t = useT();

  // Direction and language apply to the application chrome; the canvas opts out (dir="ltr").
  useEffect(() => {
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
      <div class="app-message" role="status">
        {t('app.loading')}
      </div>
    );
  }
  if (state.screen === 'unavailable') {
    return (
      <div class="app-message" role="alert" data-testid="storage-unavailable">
        <p>{t('app.storageUnavailable')}</p>
        <button type="button" class="button button-primary" onClick={() => location.reload()}>
          {t('app.reload')}
        </button>
      </div>
    );
  }
  return (
    <div class="app">
      <TopBar />
      <NoticeBar />
      {state.screen === 'editor' && state.doc ? <Editor /> : <Home />}
    </div>
  );
}
