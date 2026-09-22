import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import { translate, type MessageKey, type Params } from '../i18n/i18n.js';
import type { AppState, AppStore } from '../state/app.js';

export const StoreContext = createContext<AppStore | null>(null);

export function useStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('StoreContext missing');
  return store;
}

/** Subscribe to the whole app state; re-renders on every change (the state is small). */
export function useAppState(): AppState {
  const store = useStore();
  const [state, setState] = useState(store.state);
  useEffect(() => {
    setState(store.state);
    return store.subscribe(() => setState(store.state));
  }, [store]);
  return state;
}

/** Translation bound to the current locale. */
export function useT(): (key: MessageKey, params?: Params) => string {
  const { locale } = useAppState();
  return (key, params) => translate(locale, key, params);
}
