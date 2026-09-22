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
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
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
      <div class="app-message" role="alert">
        {t('app.storageUnavailable')}
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
