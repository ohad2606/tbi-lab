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
