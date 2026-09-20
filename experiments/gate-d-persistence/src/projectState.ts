/**
 * Minimal project state for the Gate D persistence proof.
 *
 * Sync-ready metadata (localRevision / cloudRevision / baseRevision / deviceId) is DESIGNED
 * but deliberately not acted on: Sprint 0 implements no cloud synchronisation, no CRDT and
 * no conflict resolution. The fields exist so a later sync design is not locked out.
 */

export const SCHEMA_VERSION = 1;

export interface ComponentState {
  id: string;
  /** Deliberately a small open set: Gate D is about persistence, not a component library. */
  type: 'resistor' | 'led' | 'psu' | 'mcu';
  /** Primary scalar value in SI units (ohms for a resistor); null where not applicable. */
  value: number | null;
  /** Free-form placement, proving nested structures survive a round trip. */
  position: { x: number; y: number };
}

export interface ConnectionState {
  id: string;
  /** "componentId.terminal" endpoints. */
  from: string;
  to: string;
  /** Electrical net this connection belongs to. */
  net: string;
}

export interface PsuSettings {
  setpointV: number;
  currentLimitA: number;
  enabled: boolean;
}

export interface ProjectState {
  projectId: string;
  schemaVersion: number;
  /** Bumped on every local write. */
  localRevision: number;
  /** Last revision known to exist in the cloud. null until a sync ever happens. */
  cloudRevision: number | null;
  /** The local revision the current cloud revision was derived from. */
  baseRevision: number | null;
  /** ISO-8601 UTC. */
  updatedAt: string;
  /** Stable per-browser-profile identifier. */
  deviceId: string;
  name: string;
  components: ComponentState[];
  connections: ConnectionState[];
  psu: PsuSettings;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function createProject(
  projectId: string,
  deviceId: string,
  name = 'Untitled',
  clock: Clock = systemClock,
): ProjectState {
  return {
    projectId,
    schemaVersion: SCHEMA_VERSION,
    localRevision: 1,
    cloudRevision: null,
    baseRevision: null,
    updatedAt: clock.now().toISOString(),
    deviceId,
    name,
    components: [],
    connections: [],
    psu: { setpointV: 5, currentLimitA: 0.1, enabled: false },
  };
}

/**
 * Apply a change and advance the local revision. Every local write goes through here so a
 * revision can never silently fail to move.
 */
export function applyLocalChange(
  state: ProjectState,
  mutate: (draft: ProjectState) => void,
  clock: Clock = systemClock,
): ProjectState {
  const draft: ProjectState = structuredClone(state);
  mutate(draft);
  draft.localRevision = state.localRevision + 1;
  draft.updatedAt = clock.now().toISOString();
  return draft;
}
