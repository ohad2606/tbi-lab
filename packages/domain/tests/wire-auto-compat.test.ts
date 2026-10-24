/**
 * Wire routing integrity (rt2): the `.tbilab` compatibility of automatic wires (`Wire.auto`).
 *
 * Recorded facts (evidence: tbi-s19d/route/rt2-compat-*.txt, run against the domain code of the
 * deployed 19B build 4676139 and RC5 84f4691):
 *  - this build round-trips `auto` exactly (same document, same hash);
 *  - those builds REFUSE such a file whole as `invalid_project` (`bad_field` at
 *    `layout.wires[i].auto`, their strict key check); nothing is imported or rewritten;
 *  - Sprint 20 (owner-approved DP-rt2-1): the schema is now 4, so those builds refuse such a file
 *    as NEWER ("made by a newer version"), by name (s20r evidence: s20r-compat-*.txt). These tests
 *    pin that state, so a change of version (or of the key check) is deliberate.
 */
import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  addComponent,
  addWire,
  createPackage,
  parsePackage,
  projectHash,
  serializePackage,
  type ProjectDocument,
} from '../src/index.js';
import { must, newDoc } from './helpers.js';

const t = (component: string, terminal: string) => ({
  kind: 'terminal' as const,
  component,
  terminal,
});
const meta = { appVersion: 'rt2', exportedAt: '2026-10-22T00:00:00.000Z' };

function autoCircuit(): ProjectDocument {
  let doc = newDoc();
  doc = must(addComponent(doc, 'component.resistor', { x: 140, y: 80 })).doc;
  doc = must(addWire(doc, t('PSU1', 'positive'), t('R1', 'a'), [], { waypoints: [] })).doc;
  doc = must(
    addWire(doc, t('R1', 'b'), t('GND1', 'ref'), [{ x: 200, y: 160 }], {
      waypoints: [{ x: 200, y: 160 }],
    }),
  ).doc;
  return doc;
}
/** Re-sign a hand-edited package (a consistent file, so only the key check can refuse it). */
function resign(text: string, edit: (project: Record<string, unknown>) => void): string {
  const pkg = JSON.parse(text) as {
    project: Record<string, unknown>;
    integrity: { project: string };
  };
  edit(pkg.project);
  pkg.integrity.project = projectHash(pkg.project as unknown as ProjectDocument);
  return JSON.stringify(pkg);
}

describe('automatic wires in a .tbilab (rt2 compatibility)', () => {
  it('this build exports and imports `auto` exactly (same document, same hash)', () => {
    const doc = autoCircuit();
    const text = serializePackage(createPackage(doc, meta));
    const r = parsePackage(text);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.doc).toEqual(doc);
    expect(projectHash(r.doc)).toBe(projectHash(doc));
    expect(r.doc.layout.wires.map((w) => w.auto)).toEqual([
      { waypoints: [] },
      { waypoints: [{ x: 200, y: 160 }] },
    ]);
  });

  it('the schema version is 4 (Sprint 20): a file with automatic wires is a v4 file', () => {
    expect(SCHEMA_VERSION).toBe(4);
    expect(createPackage(autoCircuit(), meta).project.schemaVersion).toBe(4);
  });

  it('an unknown key inside `auto`, or a malformed waypoint, is refused by its path', () => {
    const text = serializePackage(createPackage(autoCircuit(), meta));
    const extra = parsePackage(
      resign(text, (p) => {
        (p.layout as { wires: { auto: Record<string, unknown> }[] }).wires[0]!.auto.via = 1;
      }),
    );
    expect(extra).toEqual({
      ok: false,
      error: {
        code: 'invalid_project',
        issues: [{ code: 'bad_field', path: 'layout.wires[0].auto.via' }],
      },
    });
    const bad = parsePackage(
      resign(text, (p) => {
        (p.layout as { wires: { auto: unknown }[] }).wires[1]!.auto = { waypoints: [{ x: 1.5 }] };
      }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe('invalid_project');
      expect(bad.error.issues).toContainEqual({ code: 'bad_field', path: 'layout.wires[1].auto' });
    }
  });

  it('a project without automatic wires exports no `auto` key at all (older builds accept it)', () => {
    let doc = newDoc();
    doc = must(addComponent(doc, 'component.resistor', { x: 140, y: 80 })).doc;
    doc = must(addWire(doc, t('PSU1', 'positive'), t('R1', 'a'))).doc;
    const text = serializePackage(createPackage(doc, meta));
    expect(text).not.toContain('"auto"');
  });
});
