import { render } from 'preact';
import { ProjectStore } from './persistence/store.js';
import { McuSimulation } from './runtime/controller.js';
import { RuntimeClient } from './runtime/client.js';
import { SimulationDispatcher } from './sim/dispatch.js';
import { SimulationController, type WorkerLike } from './sim/controller.js';
import { AppStore, type Preferences } from './state/app.js';
import { App } from './ui/App.js';
import { StoreContext } from './ui/context.js';
import './styles.css';
import { randomId } from './ids.js';

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
  const local = new SimulationController({
    createWorker: () =>
      new Worker(new URL('./sim/worker.ts', import.meta.url), {
        type: 'module',
        name: 'tbi-lab-engine',
      }) as unknown as WorkerLike,
  });
  // ESP32 projects run on the R2 Session Host, reached same-origin through the deployment's
  // authenticating proxy (Sprint 6). Ordinary DC projects never use it.
  const mcu = new McuSimulation({
    client: new RuntimeClient({ base: import.meta.env.VITE_RUNTIME_BASE ?? '/runtime' }),
  });
  const simulation = new SimulationDispatcher(local, mcu);
  // A closing page releases its session at once (otherwise the host's lease reclaims it).
  addEventListener('pagehide', () => mcu.dispose());
  const store = new AppStore({
    simulation,
    storage,
    prefs,
    languages: navigator.languages,
    newId: randomId,
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
