/**
 * Simulated physical controls (Sprint 10, owner-approved 3D operation): ONE action path for a
 * switch or a push button, whichever view operates it. The Circuit view and the 3D view both call
 * these; neither has a control state of its own.
 *
 * - A toggle (the toggle switch's `closed`, the type's `toggleParam`) is a PERSISTENT edit of
 *   the document: revision, autosave, undo; while a simulation runs the store mirrors it to the
 *   session as a live control (AppStore.mirrorLiveChanges), so the solver or the ESP32's GPIO
 *   sees it at once.
 * - A momentary button (`momentary` in the catalog) is a TRANSIENT runtime input: held while
 *   pressed, never persisted, only while a simulation runs (AppStore.press -> the simulation
 *   controller, which drives the circuit and an ESP32's input pin alike).
 * Both views render from the same state: the document's parameter, and the session's pressed set.
 */
import {
  CATALOG,
  emptySelection,
  setParam,
  type ComponentTypeId,
  type ProjectDocument,
} from '@tbi-lab/domain';
import type { AppStore } from '../state/app.js';

export type ControlKind = 'toggle' | 'momentary';

/**
 * The control a component type offers (or null). `physicalOnly`: only physical switches and
 * buttons (the 3D view operates these; a sensor's environment toggle is not a physical control).
 */
export function controlKind(type: ComponentTypeId, physicalOnly = false): ControlKind | null {
  const def = CATALOG[type];
  if (def.momentary) return 'momentary';
  if (!def.toggleParam) return null;
  if (physicalOnly && type !== 'component.toggle_switch') return null;
  return 'toggle';
}

/** Flip a toggle control (a persistent edit; live while running). */
export function toggleControl(
  store: AppStore,
  doc: ProjectDocument,
  componentId: string,
  opts: { select?: boolean } = {},
): boolean {
  const c = doc.components.find((x) => x.id === componentId);
  const key = c && CATALOG[c.type].toggleParam;
  if (!c || !key) return false;
  const r = setParam(doc, c.id, key, c.params[key] !== true);
  if (!r.ok) return false;
  store.apply(r, opts.select ? { ...emptySelection(), components: [c.id] } : undefined);
  return true;
}

/** Press or release a momentary control (a runtime input; only while running). */
export function pressControl(store: AppStore, componentId: string, pressed: boolean): boolean {
  return store.press(componentId, pressed);
}

/** A control's current state, from the one shared source (document or session). */
export function controlState(
  doc: ProjectDocument,
  pressed: readonly string[],
  componentId: string,
): { kind: ControlKind; on: boolean } | null {
  const c = doc.components.find((x) => x.id === componentId);
  if (!c) return null;
  const kind = controlKind(c.type);
  if (!kind) return null;
  if (kind === 'momentary') return { kind, on: pressed.includes(c.id) };
  const key = CATALOG[c.type].toggleParam!;
  return { kind, on: c.params[key] === true };
}
