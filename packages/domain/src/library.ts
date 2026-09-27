/**
 * Project-library identity operations (Sprint 5).
 *
 * `copyAsNewProject` is the one way to make an independent project from existing content:
 * duplicate, import-as-copy (id collision) and example instantiation all use it. The copy gets
 * a new identity and a fresh history; the engineering content (components, parameters
 * including toggle positions, nets and their user names, connections, layout, id counters)
 * is copied exactly. Runtime state is never part of a document, so there is nothing else to
 * leave behind.
 */

import { systemClock, type Clock } from './project.js';
import { cloneDocument, SCHEMA_VERSION, type ProjectDocument } from './schema.js';

export interface NewIdentity {
  projectId: string;
  deviceId: string;
  appVersion: string;
  /** User-authored name of the copy. Defaults to the source's name, verbatim. */
  name?: string;
  clock?: Clock;
}

export function copyAsNewProject(source: ProjectDocument, id: NewIdentity): ProjectDocument {
  const now = (id.clock ?? systemClock).now().toISOString();
  const content = cloneDocument(source);
  return {
    format: content.format,
    schemaVersion: SCHEMA_VERSION,
    projectId: id.projectId,
    createdWith: { app: id.appVersion, schemaVersion: SCHEMA_VERSION },
    createdAt: now,
    revision: {
      localRevision: 1,
      cloudRevision: null,
      baseRevision: null,
      updatedAt: now,
      deviceId: id.deviceId,
    },
    name: id.name ?? content.name,
    components: content.components,
    nets: content.nets,
    connections: content.connections,
    layout: content.layout,
    idCounters: content.idCounters,
    programs: content.programs, // authored source travels with the copy, exactly
  };
}

/** The engineering content two documents must share to be "the same circuit". */
export function engineeringContent(doc: ProjectDocument) {
  return {
    components: doc.components,
    nets: doc.nets,
    connections: doc.connections,
    layout: doc.layout,
    idCounters: doc.idCounters,
  };
}

// ---------------------------------------------------------------------------------------------
// Project display names (Product Alpha maintenance). The project id is the identity; the
// display name is user-authored text stored verbatim. Within one library, two projects must not
// have names a person would read as the same, so new names are compared by a KEY that is never
// stored or shown:
//   - Unicode NFKC normalization (composed/decomposed and compatibility forms compare equal);
//   - directional marks and isolates removed (invisible, typically pasted from bidi text);
//   - leading/trailing whitespace trimmed and internal whitespace runs collapsed to one space;
//   - case-insensitive (lowercased; affects cased scripts such as Latin, not Hebrew).

const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** The comparison key of a project display name. Never stored, never displayed. */
export function projectNameKey(name: string): string {
  return name
    .normalize('NFKC')
    .replace(BIDI_CONTROLS, '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

/** Whether `name` would read as the same as one of `existing` (display names). */
export function projectNameTaken(name: string, existing: readonly string[]): boolean {
  const key = projectNameKey(name);
  return existing.some((n) => projectNameKey(n) === key);
}

/**
 * The first name in the sequence `format(1)`, `format(2)`, ... that is not taken. Deterministic:
 * it depends only on the existing names. `format` produces the localized candidate, e.g.
 * n => n === 1 ? 'Project (copy)' : `Project (copy ${n})`.
 */
export function firstAvailableName(
  existing: readonly string[],
  format: (n: number) => string,
): string {
  const taken = new Set(existing.map(projectNameKey));
  for (let n = 1; ; n++) {
    const candidate = format(n);
    if (!taken.has(projectNameKey(candidate))) return candidate;
  }
}
