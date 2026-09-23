import { render } from 'preact';
import { ProjectStore } from './persistence/store.js';
import { SimulationController, type WorkerLike } from './sim/controller.js';
import { AppStore, type Preferences } from './state/app.js';
import { App } from './ui/App.js';
import { StoreContext } from './ui/context.js';
import './styles.css';

/** Per-device preferences, kept apart from project data. Failure is never fatal. */
const prefs: Preferences = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Preferences are a convenience; projects are stored in IndexedDB.
    }
  },
};

async function main() {
  // Without IndexedDB (e.g. a locked-down profile) the app says so instead of pretending to save.
  const storage = await ProjectStore.open().catch(() => null);
  // The electrical engine runs only in this module Worker, never on the UI thread.
  const simulation = new SimulationController({
    createWorker: () =>
      new Worker(new URL('./sim/worker.ts', import.meta.url), {
        type: 'module',
        name: 'tbi-lab-engine',
      }) as unknown as WorkerLike,
  });
  const store = new AppStore({
    simulation,
    storage,
    prefs,
    languages: navigator.languages,
    newId: () => crypto.randomUUID().replace(/-/g, ''),
  });
  render(
    <StoreContext.Provider value={store}>
      <App />
    </StoreContext.Provider>,
    document.getElementById('root')!,
  );
  await store.init();
}

void main();
