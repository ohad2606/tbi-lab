/**
 * Gate D harness. Exposes a small imperative API on `window` so a Playwright spec can drive
 * real IndexedDB in a real browser. This is a test harness, not product code and not a UI.
 */

import { applyLocalChange, createProject, type ProjectState } from '../src/projectState.js';
import { ProjectStore } from '../src/store.js';
import { Autosave } from '../src/autosave.js';

interface GateD {
  init(): Promise<{ deviceId: string }>;
  create(projectId: string, name: string): Promise<ProjectState>;
  editAll(): Promise<ProjectState>;
  renameTo(name: string): Promise<ProjectState>;
  flush(): Promise<{ writeCount: number }>;
  load(projectId: string): Promise<ProjectState | undefined>;
  current(): ProjectState | null;
  listProjectIds(): Promise<string[]>;
}

let store: ProjectStore | null = null;
let autosave: Autosave | null = null;
let deviceId = '';
let state: ProjectState | null = null;

async function init(): Promise<{ deviceId: string }> {
  store = await ProjectStore.open();
  autosave = new Autosave(store, { debounceMs: 25 });
  deviceId = await store.getOrCreateDeviceId(() => crypto.randomUUID());
  return { deviceId };
}

function requireState(): ProjectState {
  if (!state) throw new Error('no current project');
  return state;
}

const api: GateD = {
  init,

  async create(projectId, name) {
    state = createProject(projectId, deviceId, name);
    autosave!.queue(state);
    await autosave!.flush();
    return state;
  },

  /** One edit touching every part of the state shape, so a partial round trip cannot pass. */
  async editAll() {
    state = applyLocalChange(requireState(), (draft) => {
      draft.components = [
        { id: 'R1', type: 'resistor', value: 220, position: { x: 40, y: 10 } },
        { id: 'D1', type: 'led', value: null, position: { x: 80, y: 10 } },
        { id: 'PSU1', type: 'psu', value: null, position: { x: 0, y: 0 } },
        { id: 'U1', type: 'mcu', value: null, position: { x: 120, y: 60 } },
      ];
      draft.connections = [
        { id: 'W1', from: 'PSU1.+', to: 'R1.a', net: 'vcc' },
        { id: 'W2', from: 'R1.b', to: 'D1.anode', net: 'n1' },
        { id: 'W3', from: 'D1.cathode', to: 'PSU1.-', net: 'gnd' },
        { id: 'W4', from: 'U1.gpio2', to: 'R1.a', net: 'vcc' },
      ];
      draft.psu = { setpointV: 3.3, currentLimitA: 0.25, enabled: true };
    });
    autosave!.queue(state);
    return state;
  },

  async renameTo(name) {
    state = applyLocalChange(requireState(), (draft) => {
      draft.name = name;
    });
    autosave!.queue(state);
    return state;
  },

  async flush() {
    await autosave!.flush();
    return { writeCount: autosave!.writeCount };
  },

  async load(projectId) {
    const loaded = await store!.load(projectId);
    if (loaded) state = loaded;
    return loaded;
  },

  current() {
    return state;
  },

  async listProjectIds() {
    return store!.listProjectIds();
  },
};

(window as unknown as { __gateD: GateD }).__gateD = api;
(window as unknown as { __gateDReady: boolean }).__gateDReady = true;
