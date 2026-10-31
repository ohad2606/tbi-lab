/**
 * Schema migration on open.
 *
 * Migrations are pure functions `vN -> vN+1`, run in the browser when a project is opened.
 * v2 is the first production schema (no v1 Gate D user data exists): v2 → v3 (Sprint 7, programs)
 * v3 → v4 (Sprint 20, the identity), v4 → v5 (Sprint POT-UNITS, the identity) and v5 → v6 (Sprint 26,
 * the identity). A document from a NEWER schema is never guessed at: it
 * opens read-only.
 */

import { SCHEMA_VERSION, cloneDocument } from './schema.js';
import { validateProject, type ValidationIssue } from './validate.js';
import type { ProjectDocument } from './schema.js';

export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** Keyed by the version a migration upgrades FROM. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  /**
   * v2 → v3 (Sprint 7): projects gain `programs` (authored board programs), empty for every v2
   * project. A board that ran no firmware (`none`) now runs its program (`program`), which starts
   * empty; a board on a pinned reference image keeps it. Deterministic, adds no user content.
   */
  2: (doc) => {
    const d = doc as Record<string, unknown> & { components?: unknown };
    const components = Array.isArray(d.components)
      ? (d.components as Record<string, unknown>[]).map((c) =>
          c.type === 'board.esp32_devkitc_wroom32' &&
          typeof c.params === 'object' &&
          c.params !== null &&
          (c.params as Record<string, unknown>).firmware === 'none'
            ? { ...c, params: { ...(c.params as Record<string, unknown>), firmware: 'program' } }
            : c,
        )
      : d.components;
    return { ...d, components, programs: {} };
  },
  /**
   * v3 → v4 (Sprint 20, DP-rt2-1): the IDENTITY. v4 adds no field; it marks documents that may
   * carry automatic wires (`Wire.auto`) so that older builds treat them as newer. A v3 document
   * with or without `auto` means exactly the same thing in v4 (a wire without `auto` is manual,
   * as in v3), so nothing is added, removed or rewritten; only `schemaVersion` changes (set by
   * openDocument). Opening never writes the result back: a stored v3 project becomes v4 only
   * when that project is saved by a v4 build (app.ts openProject).
   */
  3: (doc) => ({ ...doc }),
  /**
   * v4 -> v5 (Sprint POT-UNITS): the IDENTITY. v5 adds a component type and a unit, no field; a
   * v4 document means exactly the same in v5. Only `schemaVersion` changes (set by openDocument).
   */
  4: (doc) => ({ ...doc }),
  /**
   * v5 -> v6 (Sprint 26): the IDENTITY. v6 adds two optional program fields (`files`,
   * `libraries`); a v5 document (one file, no libraries) means exactly the same in v6.
   */
  5: (doc) => ({ ...doc }),
};

export type OpenResult =
  | { status: 'ok'; doc: ProjectDocument; migratedFrom: number | null }
  | { status: 'newer'; schemaVersion: number; raw: unknown }
  | { status: 'invalid'; issues: ValidationIssue[] }
  | { status: 'unmigratable'; schemaVersion: number };

export function openDocument(
  raw: unknown,
  migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
  current: number = SCHEMA_VERSION,
): OpenResult {
  if (typeof raw !== 'object' || raw === null) {
    return { status: 'invalid', issues: [{ code: 'not_an_object', path: '' }] };
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { status: 'invalid', issues: [{ code: 'bad_schema_version', path: 'schemaVersion' }] };
  }
  if (version > current) return { status: 'newer', schemaVersion: version, raw };

  let doc = cloneDocument(raw) as Record<string, unknown>;
  for (let v = version; v < current; v++) {
    const step = migrations[v];
    if (!step) return { status: 'unmigratable', schemaVersion: version };
    doc = { ...step(doc), schemaVersion: v + 1 };
  }
  const issues = validateProject(doc);
  if (issues.length) return { status: 'invalid', issues };
  return {
    status: 'ok',
    doc: doc as unknown as ProjectDocument,
    migratedFrom: version === current ? null : version,
  };
}
