/**
 * Project creation and the single revision-advancing path for local changes.
 */

import { CATALOG, defaultParams } from './catalog.js';
import {
  cloneDocument,
  DOCUMENT_FORMAT,
  SCHEMA_VERSION,
  type ComponentTypeId,
  type ProjectDocument,
} from './schema.js';

/** Injected so tests are deterministic; the app passes the real clock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Issue the next id for a prefix and record it, so it is never issued again. */
export function allocateId(doc: ProjectDocument, prefix: string, separator = ''): string {
  const next = (doc.idCounters[prefix] ?? 0) + 1;
  doc.idCounters[prefix] = next;
  return `${prefix}${separator}${next}`;
}

export interface CreateProjectInput {
  projectId: string;
  deviceId: string;
  name: string;
  appVersion: string;
  clock?: Clock;
}

/**
 * A new project opens with a lab PSU and a ground already on the canvas, because every
 * circuit needs them (product scope §10.3, §14.1). They are not wired.
 */
export function createProject(input: CreateProjectInput): ProjectDocument {
  const now = (input.clock ?? systemClock).now().toISOString();
  const doc: ProjectDocument = {
    format: DOCUMENT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    projectId: input.projectId,
    createdWith: { app: input.appVersion, schemaVersion: SCHEMA_VERSION },
    createdAt: now,
    revision: {
      localRevision: 1,
      cloudRevision: null,
      baseRevision: null,
      updatedAt: now,
      deviceId: input.deviceId,
    },
    name: input.name,
    components: [],
    nets: [],
    connections: [],
    layout: { components: {}, wires: [], junctions: [] },
    idCounters: {},
    programs: {},
  };
  placeInitial(doc, 'instrument.lab_psu', -120, 0);
  placeInitial(doc, 'component.ground', -80, 120);
  return doc;
}

function placeInitial(doc: ProjectDocument, type: ComponentTypeId, x: number, y: number): void {
  const def = CATALOG[type];
  const id = allocateId(doc, def.refPrefix);
  doc.components.push({ id, type, typeVersion: def.typeVersion, params: defaultParams(def) });
  doc.layout.components[id] = { x, y, rotation: 0 };
}

/**
 * Advance revision metadata for a persisted local change. Every edit that reaches storage
 * goes through here, so a revision can never silently fail to move.
 */
export function stampRevision(
  doc: ProjectDocument,
  deviceId: string,
  clock: Clock = systemClock,
): ProjectDocument {
  return {
    ...doc,
    revision: {
      ...doc.revision,
      localRevision: doc.revision.localRevision + 1,
      updatedAt: clock.now().toISOString(),
      deviceId,
    },
  };
}

/**
 * The document to commit when undo/redo returns to `target` from `current` (Sprint 4).
 *
 * - Content (components, nets, layout, parameters, name) is `target`'s.
 * - Identity never goes backwards: every id counter keeps the highest value ever issued, so
 *   an id consumed after `target` (for example a component placed and then undone) is never
 *   reissued. Redo restores exactly the same ids.
 * - Revision metadata is `current`'s. The caller commits it through the normal path, which
 *   advances `localRevision` monotonically; undo never decrements or resurrects a revision.
 */
export function historyTarget(current: ProjectDocument, target: ProjectDocument): ProjectDocument {
  const counters: Record<string, number> = { ...target.idCounters };
  for (const [k, v] of Object.entries(current.idCounters))
    counters[k] = Math.max(v, counters[k] ?? 0);
  return { ...cloneDocument(target), idCounters: counters, revision: { ...current.revision } };
}
