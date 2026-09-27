/**
 * Simulation snapshot (architecture §2.3).
 *
 * An immutable, language-neutral projection of one project revision: component instances
 * with type ids and parameters, nets and connections. It deliberately EXCLUDES the layout
 * (and so wires, positions and rotation), the project name and all user-authored text: none
 * of them affect physics. The snapshot is derived from the project, never the other way
 * round, so there is no second topology definition that could drift from the document.
 */

import { CATALOG } from './catalog.js';
import {
  cloneDocument,
  type ParamValue,
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

/**
 * Everything a running simulation depends on EXCEPT live-capable parameters: the netlist,
 * component identities and types, and every non-live parameter. While a simulation runs,
 * an edit that changes this key would change the loaded topology and must not be applied
 * silently; an edit that leaves it unchanged is layout-only or a live change.
 */
export function topologyKey(doc: ProjectDocument): string {
  const components = doc.components.map((c) => {
    const def = CATALOG[c.type];
    const params = Object.fromEntries(
      Object.entries(c.params).filter(([k]) => !def?.params.find((p) => p.key === k)?.live),
    );
    return { id: c.id, type: c.type, typeVersion: c.typeVersion, params };
  });
  return JSON.stringify({
    components,
    nets: doc.nets.map((n) => ({ id: n.id, role: n.role })),
    connections: doc.connections,
  });
}

/** Live-capable parameters whose values differ between two revisions, per component. */
export function liveChanges(
  before: ProjectDocument,
  after: ProjectDocument,
): { component: string; params: Record<string, ParamValue> }[] {
  const out: { component: string; params: Record<string, ParamValue> }[] = [];
  for (const c of after.components) {
    const prev = before.components.find((x) => x.id === c.id);
    if (!prev) continue;
    const params: Record<string, ParamValue> = {};
    for (const p of CATALOG[c.type].params) {
      if (!p.live) continue;
      if (JSON.stringify(prev.params[p.key]) !== JSON.stringify(c.params[p.key])) {
        params[p.key] = c.params[p.key]!;
      }
    }
    if (Object.keys(params).length) out.push({ component: c.id, params });
  }
  return out;
}

/**
 * The three kinds of persistent edit, relative to a running simulation (Sprint 4, explicit):
 *
 * - `layout`: only the drawing changed (move, rotate, rename). Allowed while running; the
 *   loaded snapshot is unaffected.
 * - `live`: only live-capable parameters changed (PSU setpoint / limit / output, toggle
 *   position). Allowed while running: persisted first, then mirrored to the session.
 * - `structural`: anything the snapshot depends on changed (wiring, parts, non-live
 *   parameters such as a resistance). Refused while running.
 *
 * - `program` (Sprint 7): only a board's program source changed. Allowed while running; the
 *   running session keeps its immutable firmware and the edit never reaches it (the next Run
 *   needs a new build).
 *
 * TRANSIENT runtime interaction (push-button press/release) is not an edit at all: it never
 * produces a new document and never reaches this function.
 */
export type EditKind = 'layout' | 'live' | 'program' | 'structural';

export function classifyEdit(before: ProjectDocument, after: ProjectDocument): EditKind {
  if (topologyKey(before) !== topologyKey(after)) return 'structural';
  if (liveChanges(before, after).length) return 'live';
  return JSON.stringify(before.programs) !== JSON.stringify(after.programs) ? 'program' : 'layout';
}
