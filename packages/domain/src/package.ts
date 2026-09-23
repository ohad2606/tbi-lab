/**
 * Portable project package, format version 1 (Sprint 5). Specification: ../PACKAGE.md.
 *
 * A single UTF-8 JSON file (`.tbilab`) that WRAPS the schema v2 project document without
 * changing it. Sections for Arduino source, firmware artifacts and toolchain metadata exist
 * from version 1 on and are `null` for non-MCU projects, so Sprint 6/7 can fill them without
 * redefining the envelope. `formatVersion` is independent of the project `schemaVersion`.
 *
 * Import is parse-then-validate: nothing here performs I/O, and a package is either accepted
 * whole, as a valid current-schema document, or refused with a structured code. Nothing in a
 * package is ever executed or interpreted beyond JSON data.
 */

import { CANONICALIZATION, canonicalJson } from './canonical.js';
import { openDocument } from './migrate.js';
import { sha256Utf8 } from './sha256.js';
import { SCHEMA_VERSION, type ProjectDocument } from './schema.js';
import type { ValidationIssue } from './validate.js';

export const PACKAGE_FORMAT = 'tbi-lab.package';
export const PACKAGE_VERSION = 1;
export const PACKAGE_EXTENSION = '.tbilab';
export const PACKAGE_MEDIA_TYPE = 'application/vnd.tbi-lab.package+json';
/**
 * 2 MiB. A 30-component project packages to about 25 KB, so this is ~80x the largest V1
 * circuit while keeping a hostile file from being read into memory at all.
 */
export const PACKAGE_MAX_BYTES = 2 * 1024 * 1024;

export interface ProjectPackage {
  format: typeof PACKAGE_FORMAT;
  formatVersion: number;
  /** The exact engineering project document (schema v2). */
  project: ProjectDocument;
  /** Arduino sketch source. Not used before Sprint 7: always null. */
  source: null;
  /** Firmware artifacts with per-artifact sha256. Not used before Sprint 6: always null. */
  firmware: null;
  /** Build/toolchain metadata. Not used before Sprint 7: always null. */
  toolchain: null;
  integrity: {
    algorithm: 'sha256';
    canonicalization: typeof CANONICALIZATION;
    /** sha256 of canonicalJson(project). */
    project: string;
  };
  /** Export provenance. Not engineering state; ignored on import beyond shape checks. */
  exported: { app: string; appVersion: string; exportedAt: string };
}

/** Canonical content hash of a project document (lowercase hex SHA-256). */
export function projectHash(doc: ProjectDocument): string {
  return sha256Utf8(canonicalJson(doc));
}

export function createPackage(
  doc: ProjectDocument,
  meta: { appVersion: string; exportedAt: string },
): ProjectPackage {
  return {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_VERSION,
    project: doc,
    source: null,
    firmware: null,
    toolchain: null,
    integrity: {
      algorithm: 'sha256',
      canonicalization: CANONICALIZATION,
      project: projectHash(doc),
    },
    exported: { app: 'TBI Lab', appVersion: meta.appVersion, exportedAt: meta.exportedAt },
  };
}

/** Human-readable file text (2-space JSON, trailing newline). The hash does not depend on it. */
export function serializePackage(pkg: ProjectPackage): string {
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export type ImportErrorCode =
  | 'too_large'
  | 'not_json'
  | 'not_a_package'
  | 'bad_package'
  | 'newer_package'
  | 'unsupported_content'
  | 'hash_mismatch'
  | 'newer_schema'
  | 'unsupported_schema'
  | 'invalid_project';

export interface ImportError {
  code: ImportErrorCode;
  /** For newer_package / newer_schema / unsupported_schema: the version found. */
  version?: number;
  /** For invalid_project: the structural issues (codes and paths, never display text). */
  issues?: ValidationIssue[];
}

export type PackageParseResult =
  { ok: true; doc: ProjectDocument } | { ok: false; error: ImportError };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const sameKeys = (o: Record<string, unknown>, keys: readonly string[]) => {
  const k = Object.keys(o);
  return k.length === keys.length && k.every((x) => keys.includes(x));
};
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function parsePackage(
  text: string,
  maxBytes: number = PACKAGE_MAX_BYTES,
): PackageParseResult {
  const fail = (
    code: ImportErrorCode,
    extra: Omit<ImportError, 'code'> = {},
  ): PackageParseResult => ({
    ok: false,
    error: { code, ...extra },
  });
  if (new TextEncoder().encode(text).length > maxBytes) return fail('too_large');
  // A ZIP container (a possible later package version) starts with "PK\x03\x04".
  if (text.startsWith('PK\u0003\u0004')) return fail('newer_package');

  let raw: unknown;
  try {
    // JSON only: no code is evaluated. Prototype-related keys are refused outright.
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // byte-order mark
    raw = JSON.parse(body, (key, value: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) throw new SyntaxError('forbidden key');
      return value;
    });
  } catch {
    return fail('not_json');
  }
  if (!isObj(raw) || raw.format !== PACKAGE_FORMAT) return fail('not_a_package');
  if (!isInt(raw.formatVersion) || raw.formatVersion < 1) return fail('bad_package');
  if (raw.formatVersion > PACKAGE_VERSION) {
    return fail('newer_package', { version: raw.formatVersion });
  }
  const TOP = ['format', 'formatVersion', 'project', 'source', 'firmware', 'toolchain'];
  if (!sameKeys(raw, [...TOP, 'integrity', 'exported'])) return fail('bad_package');
  if (raw.source !== null || raw.firmware !== null || raw.toolchain !== null) {
    return fail('unsupported_content');
  }
  const integrity = raw.integrity;
  if (
    !isObj(integrity) ||
    !sameKeys(integrity, ['algorithm', 'canonicalization', 'project']) ||
    integrity.algorithm !== 'sha256' ||
    integrity.canonicalization !== CANONICALIZATION ||
    typeof integrity.project !== 'string' ||
    !/^[0-9a-f]{64}$/.test(integrity.project)
  ) {
    return fail('bad_package');
  }
  const exported = raw.exported;
  if (
    !isObj(exported) ||
    !sameKeys(exported, ['app', 'appVersion', 'exportedAt']) ||
    typeof exported.app !== 'string' ||
    typeof exported.appVersion !== 'string' ||
    typeof exported.exportedAt !== 'string'
  ) {
    return fail('bad_package');
  }
  if (!isObj(raw.project)) return fail('invalid_project', { issues: [] });

  let hash: string;
  try {
    hash = sha256Utf8(canonicalJson(raw.project));
  } catch {
    return fail('invalid_project', { issues: [] });
  }
  if (hash !== integrity.project) return fail('hash_mismatch');

  const version = raw.project.schemaVersion;
  if (isInt(version) && version > SCHEMA_VERSION) return fail('newer_schema', { version });
  const opened = openDocument(raw.project);
  if (opened.status === 'newer') return fail('newer_schema', { version: opened.schemaVersion });
  if (opened.status === 'unmigratable') {
    return fail('unsupported_schema', { version: opened.schemaVersion });
  }
  if (opened.status === 'invalid') return fail('invalid_project', { issues: opened.issues });
  const extra = unexpectedFields(opened.doc);
  if (extra.length) {
    return fail('invalid_project', { issues: extra.map((path) => ({ code: 'bad_field', path })) });
  }
  return { ok: true, doc: opened.doc };
}

/**
 * Paths of fields the schema does not define. The structural validator tolerates extra
 * fields (a newer schema's document may carry them); an imported document may not, so that
 * nothing unknown is ever written into local storage.
 */
export function unexpectedFields(doc: ProjectDocument): string[] {
  const out: string[] = [];
  const check = (o: unknown, keys: readonly string[], path: string) => {
    if (!isObj(o)) return;
    for (const k of Object.keys(o)) if (!keys.includes(k)) out.push(path ? `${path}.${k}` : k);
  };
  check(
    doc,
    [
      'format',
      'schemaVersion',
      'projectId',
      'createdWith',
      'createdAt',
      'revision',
      'name',
      'components',
      'nets',
      'connections',
      'layout',
      'idCounters',
    ],
    '',
  );
  check(doc.createdWith, ['app', 'schemaVersion'], 'createdWith');
  check(
    doc.revision,
    ['localRevision', 'cloudRevision', 'baseRevision', 'updatedAt', 'deviceId'],
    'revision',
  );
  doc.components.forEach((c, i) => {
    check(c, ['id', 'type', 'typeVersion', 'params'], `components[${i}]`);
    for (const [k, v] of Object.entries(c.params)) {
      if (isObj(v)) check(v, ['value', 'unit'], `components[${i}].params.${k}`);
    }
  });
  doc.nets.forEach((n, i) => check(n, ['id', 'role', 'userName'], `nets[${i}]`));
  doc.connections.forEach((c, i) =>
    check(c, ['component', 'terminal', 'net'], `connections[${i}]`),
  );
  check(doc.layout, ['components', 'wires', 'junctions'], 'layout');
  for (const [id, p] of Object.entries(doc.layout.components)) {
    check(p, ['x', 'y', 'rotation'], `layout.components.${id}`);
  }
  doc.layout.wires.forEach((w, i) => {
    const path = `layout.wires[${i}]`;
    check(w, ['id', 'from', 'to', 'vertices'], path);
    for (const end of ['from', 'to'] as const) {
      const e = w[end];
      check(
        e,
        e.kind === 'junction' ? ['kind', 'junction'] : ['kind', 'component', 'terminal'],
        `${path}.${end}`,
      );
    }
    w.vertices.forEach((v, j) => check(v, ['x', 'y'], `${path}.vertices[${j}]`));
  });
  doc.layout.junctions.forEach((j, i) => check(j, ['id', 'x', 'y'], `layout.junctions[${i}]`));
  for (const k of Object.keys(doc.idCounters)) {
    if (!/^[A-Z]+$/.test(k)) out.push(`idCounters.${k}`);
  }
  if (Number.isNaN(Date.parse(doc.createdAt))) out.push('createdAt');
  return out;
}
