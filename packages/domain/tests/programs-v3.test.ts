/**
 * Schema v3 programs and package format v2 (Sprint 7, D-S7-1/D-S7-2): authored source is exact
 * project data, travels with the project everywhere, and never carries build or runtime state.
 */
import { describe, expect, it } from 'vitest';
import {
  CANONICALIZATION,
  FIRMWARE_ARTIFACTS,
  MIGRATIONS,
  PACKAGE_VERSION,
  PROGRAM_FIRMWARE,
  SCHEMA_VERSION,
  addComponent,
  canonicalJson,
  classifyEdit,
  copyAsNewProject,
  createPackage,
  deleteSelection,
  openDocument,
  parsePackage,
  serializePackage,
  setParam,
  setProgramText,
  sha256Utf8,
  validateProject,
  type ProjectDocument,
} from '../src/index.js';
import { must, newDoc } from './helpers.js';

const BOARD = 'board.esp32_devkitc_wroom32';

function withBoard(): { doc: ProjectDocument; id: string } {
  const r = must(addComponent(newDoc(), BOARD, { x: 60, y: 0 }));
  return { doc: r.doc, id: r.id };
}

/** Source with bytes that any normalisation would change. */
const TRICKY =
  '// שלום — מקור בעברית\r\nvoid setup() {\r\n\tSerial.begin(115200);  \r\n}\n\nvoid loop() {}\n\n\n';

describe('schema v3 and the v2 → v3 migration', () => {
  it('the v2 → v3 migration is deterministic and adds no user content (current schema: 4)', () => {
    expect(SCHEMA_VERSION).toBe(4);
    const v3 = withBoard().doc;
    const v2 = JSON.parse(JSON.stringify(v3)) as Record<string, unknown> & {
      components: { params: Record<string, unknown> }[];
    };
    delete v2.programs;
    v2.schemaVersion = 2;
    v2.components.find((c) => (c as { type?: string }).type === BOARD)!.params.firmware = 'none';
    const once = MIGRATIONS[2]!(JSON.parse(JSON.stringify(v2)));
    const twice = MIGRATIONS[2]!(JSON.parse(JSON.stringify(v2)));
    expect(once).toEqual(twice);
    expect(once.programs).toEqual({});
    const opened = openDocument(v2);
    expect(opened.status).toBe('ok');
    if (opened.status !== 'ok') return;
    expect(opened.migratedFrom).toBe(2);
    expect(
      opened.doc.components.find((c) => (c as { type?: string }).type === BOARD)!.params.firmware,
    ).toBe(PROGRAM_FIRMWARE); // none → program
    expect(validateProject(opened.doc)).toEqual([]);
  });

  it('a v2 board on a pinned reference image keeps it', () => {
    const { doc, id } = withBoard();
    const pinned = must(setParam(doc, id, 'firmware', FIRMWARE_ARTIFACTS[0]!.sha256)).doc;
    const v2 = JSON.parse(JSON.stringify(pinned)) as Record<string, unknown>;
    delete v2.programs;
    v2.schemaVersion = 2;
    const opened = openDocument(v2);
    expect(
      opened.status === 'ok' &&
        opened.doc.components.find((c) => (c as { type?: string }).type === BOARD)!.params.firmware,
    ).toBe(FIRMWARE_ARTIFACTS[0]!.sha256);
  });
});

describe('programs: validation and edits', () => {
  it('a new board gets the starter program; a second board gets none (one program in V1)', () => {
    const { doc, id } = withBoard();
    expect(Object.keys(doc.programs)).toEqual([id]);
    expect(doc.programs[id]!.text).toContain('void setup()');
    const second = must(addComponent(doc, BOARD, { x: 400, y: 0 }));
    expect(Object.keys(second.doc.programs)).toEqual([id]);
    expect(validateProject(second.doc)).toEqual([]);
  });

  it('setProgramText stores the text byte for byte and is a program edit (allowed while running)', () => {
    const { doc, id } = withBoard();
    const next = must(setProgramText(doc, id, TRICKY)).doc;
    expect(next.programs[id]!.text).toBe(TRICKY);
    expect(classifyEdit(doc, next)).toBe('program');
    expect(validateProject(next)).toEqual([]);
    expect(setProgramText(doc, 'U9', 'x')).toEqual({ ok: false, error: 'no_program' });
    expect(setProgramText(doc, id, 'a'.repeat(64 * 1024 + 1))).toEqual({
      ok: false,
      error: 'source_too_large',
    });
    expect(setProgramText(doc, id, 'a\u0000')).toEqual({ ok: false, error: 'source_invalid' });
    // Exactly 64 KiB (in UTF-8 bytes) is allowed.
    expect(setProgramText(doc, id, 'a'.repeat(64 * 1024)).ok).toBe(true);
  });

  it('deleting the board deletes its program', () => {
    const { doc, id } = withBoard();
    const next = must(deleteSelection(doc, { components: [id], wires: [], junctions: [] })).doc;
    expect(next.programs).toEqual({});
    expect(validateProject(next)).toEqual([]);
  });

  it('refuses programs that do not fit their board, profile or limits', () => {
    const { doc, id } = withBoard();
    const bad = (mutate: (d: ProjectDocument) => void) => {
      const d = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
      mutate(d);
      return validateProject(d).map((i) => i.code);
    };
    expect(bad((d) => (d.programs[id]!.profile = 'esp32-micropython-1.29'))).toContain(
      'bad_program',
    );
    expect(bad((d) => (d.programs[id]!.fileName = 'main.cpp'))).toContain('bad_program');
    expect(bad((d) => (d.programs[id]!.language = 'python'))).toContain('bad_program');
    expect(bad((d) => (d.programs.R9 = { ...d.programs[id]! }))).toContain('bad_program');
    expect(
      bad((d) => ((d.programs[id] as unknown as Record<string, unknown>).builtSha = 'x')),
    ).toContain('bad_program');
    expect(bad((d) => (d.programs[id]!.text = 'a'.repeat(70_000)))).toContain('bad_program');
    expect(bad((d) => delete (d as Partial<ProjectDocument>).programs)).toContain('bad_field');
  });

  it('duplication keeps the source exactly', () => {
    const { doc, id } = withBoard();
    const src = must(setProgramText(doc, id, TRICKY)).doc;
    const copy = copyAsNewProject(src, {
      projectId: 'prj_copy',
      deviceId: 'dev_x',
      appVersion: 't',
    });
    expect(copy.programs[id]!.text).toBe(TRICKY);
  });
});

describe('package format v2', () => {
  it('exports v2 and round-trips the source exactly; no build state is written', () => {
    const { doc, id } = withBoard();
    const src = must(setProgramText(doc, id, TRICKY)).doc;
    const pkg = createPackage(src, { appVersion: 't', exportedAt: '2026-09-27T00:00:00.000Z' });
    expect(pkg.formatVersion).toBe(2);
    expect(PACKAGE_VERSION).toBe(2);
    expect([pkg.source, pkg.firmware, pkg.toolchain]).toEqual([null, null, null]);
    const back = parsePackage(serializePackage(pkg));
    expect(back.ok && back.doc.programs[id]!.text).toBe(TRICKY);
    expect(back.ok && back.doc).toEqual(src);
  });

  it('imports a version 1 package (schema v2 project) through the migration', () => {
    const { doc } = withBoard();
    const v2 = JSON.parse(JSON.stringify(doc)) as Record<string, unknown> & {
      components: { params: Record<string, unknown> }[];
    };
    delete v2.programs;
    v2.schemaVersion = 2;
    v2.components.find((c) => (c as { type?: string }).type === BOARD)!.params.firmware = 'none';
    const v1 = {
      format: 'tbi-lab.package',
      formatVersion: 1,
      project: v2,
      source: null,
      firmware: null,
      toolchain: null,
      integrity: {
        algorithm: 'sha256',
        canonicalization: CANONICALIZATION,
        project: sha256Utf8(canonicalJson(v2)),
      },
      exported: { app: 'tbi-lab', appVersion: '0.1.0', exportedAt: '2026-09-26T00:00:00.000Z' },
    };
    const r = parsePackage(JSON.stringify(v1));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.schemaVersion).toBe(4); // v2 -> v3 -> v4 (Sprint 20: identity)
    expect(r.doc.programs).toEqual({});
    expect(
      r.doc.components.find((c) => (c as { type?: string }).type === BOARD)!.params.firmware,
    ).toBe(PROGRAM_FIRMWARE);
  });
});
