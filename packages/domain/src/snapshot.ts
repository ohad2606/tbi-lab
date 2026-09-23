/**
 * Simulation snapshot (architecture §2.3).
 *
 * An immutable, language-neutral projection of one project revision: component instances
 * with type ids and parameters, nets and connections. It deliberately EXCLUDES the layout
 * (and so wires, positions and rotation), the project name and all user-authored text: none
 * of them affect physics. The snapshot is derived from the project, never the other way
 * round, so there is no second topology definition that could drift from the document.
 */

import {
  cloneDocument,
  type ComponentInstance,
  type Connection,
  type Net,
  type ProjectDocument,
} from './schema.js';

export const SNAPSHOT_FORMAT = 'tbi-lab.snapshot';

export interface SimulationSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  schemaVersion: number;
  /** Content hash of everything below `projectRevision`; identifies the exact design. */
  snapshotId: string;
  projectId: string;
  projectRevision: number;
  components: ComponentInstance[];
  nets: Pick<Net, 'id' | 'role'>[];
  connections: Connection[];
}

/** FNV-1a (64-bit) over UTF-16 code units: deterministic, dependency-free content hash. */
function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

export function createSnapshot(doc: ProjectDocument): SimulationSnapshot {
  const content = {
    components: cloneDocument(doc.components),
    nets: doc.nets.map((n) => ({ id: n.id, role: n.role })),
    connections: cloneDocument(doc.connections),
  };
  return {
    format: SNAPSHOT_FORMAT,
    schemaVersion: doc.schemaVersion,
    snapshotId: `snap_${fnv1a64(JSON.stringify(content))}`,
    projectId: doc.projectId,
    projectRevision: doc.revision.localRevision,
    ...content,
  };
}
