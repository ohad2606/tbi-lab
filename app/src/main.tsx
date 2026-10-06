import { render } from 'preact';
import { PREVIEW_NAME, STORAGE_NAMESPACE, storageName } from './deployment.js';
import { DB_NAME, ProjectStore } from './persistence/store.js';
import { McuSimulation } from './runtime/controller.js';
import { RuntimeClient } from './runtime/client.js';
import { resolveFirmware } from './runtime/snapshot.js';
import { BuildClient } from './programs/client.js';
import { ProgramBuilds } from './programs/state.js';
import { SimulationDispatcher } from './sim/dispatch.js';
import { SimulationController, type WorkerLike } from './sim/controller.js';
import { AppStore, type Preferences } from './state/app.js';
import { App } from './ui/App.js';
import { StoreContext } from './ui/context.js';
import './styles.css';
import { randomId } from './ids.js';
import { prefetchExamples } from './examples/catalog.js';

/** Per-device preferences, kept apart from project data. Failure is never fatal. */
const prefs: Preferences = {
  get: (key) => {
    try {
      return localStorage.getItem(storageName(key, STORAGE_NAMESPACE));
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(storageName(key, STORAGE_NAMESPACE), value);
    } catch {
      // Preferences are a convenience; projects are stored in IndexedDB.
    }
  },
};

async function main() {
  // Without IndexedDB (e.g. a locked-down profile) the app says so instead of pretending to save.
  const storage = await ProjectStore.open(indexedDB, storageName(DB_NAME, STORAGE_NAMESPACE)).catch(
    () => null,
  );
  if (PREVIEW_NAME) document.title = `${PREVIEW_NAME} preview · ${document.title}`;
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
  // Sprint 7: programs are built by the build service (same origin, same authentication).
  const buildClient = new BuildClient({ base: import.meta.env.VITE_BUILD_BASE ?? '/build' });
  let simulation: SimulationDispatcher | null = null;
  const builds = new ProgramBuilds({
    client: buildClient,
    sessionActive: () => simulation?.engine === 'mcu' && simulation.active,
  });
  const mcu = new McuSimulation({
    client: new RuntimeClient({ base: import.meta.env.VITE_RUNTIME_BASE ?? '/runtime' }),
    // What the board runs: the CURRENT build of its program (never a stale one), a reference
    // image, or an Advanced prebuilt image for this Run.
    resolve: (doc, board, options) => {
      const program = doc.programs[board.id];
      return resolveFirmware(doc, board, {
        build: program ? builds.current(doc.projectId, board.id, program) : null,
        ...(options.prebuilt ? { prebuilt: options.prebuilt } : {}),
      });
    },
    // Pin the artifact until the Session Host has its private copy (D-S7-8). An evicted build
    // is forgotten: the program shows "Build required" again; its source is untouched.
    lease: async (firmware, board) => {
      const ticket = await buildClient.lease(firmware.sha256);
      if (ticket === null && firmware.origin === 'program') {
        const doc = store.state.doc;
        if (doc) builds.forget(doc.projectId, board.id, firmware.sha256);
      }
      return ticket;
    },
  });
  simulation = new SimulationDispatcher(local, mcu);
  // A closing page releases its session at once (otherwise the host's lease reclaims it).
  addEventListener('pagehide', () => mcu.dispose());
  const store: AppStore = new AppStore({
    simulation,
    builds,
    buildClient,
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
  // The example documents are not needed to start: fetch them when the browser is idle.
  const idle = (globalThis as { requestIdleCallback?: (f: () => void) => void })
    .requestIdleCallback;
  if (idle) idle(prefetchExamples);
  else setTimeout(prefetchExamples, 2000);
  await store.init();
}

void main();
