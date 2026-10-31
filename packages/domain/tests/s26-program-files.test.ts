/**
 * Sprint 26: multi-file programs (schema v6) and the managed library registry: path rules (no
 * traversal, no hidden or reserved names, per-language file types), limits, file edits, the
 * libraries a project keeps (placed parts, code that names them), the source key, validation,
 * the v5 -> v6 identity, and an exact package round trip.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ESP32_MICROPYTHON_PROFILE,
  MANAGED_LIBRARIES,
  MIGRATIONS,
  PROGRAM_LIMITS,
  SCHEMA_VERSION,
  addComponent,
  addProgramFile,
  createPackage,
  deleteProgramFile,
  deleteSelection,
  libraryIssues,
  openDocument,
  parsePackage,
  programBuildFiles,
  programPathIssue,
  renameProgramFile,
  resolveLibraries,
  serializePackage,
  setProgramProfile,
  setProgramText,
  moveSelection,
  unpinLibrary,
  sourceKey,
  validateProject,
  type ProjectDocument,
} from '../src/index.js';
import { must, newDoc } from './helpers.js';

const BOARD = 'board.esp32_devkitc_wroom32';
const LCD_LIB = 'arduino.liquidcrystal-pcf8574';
const PY_LIB = 'micropython.python-lcd';

function withBoard(): { doc: ProjectDocument; id: string } {
  const r = must(addComponent(newDoc(), BOARD, { x: 60, y: 0 }));
  return { doc: r.doc, id: r.id };
}

describe('program file paths', () => {
  it('Arduino: sketch-folder sources and src/ only; never traversal, hidden, entry or reserved', () => {
    const ok = ['helpers.h', 'util.cpp', 'more.ino', 'c_code.c', 'x.hpp', 'src/a.cpp', 'src/d/b.h'];
    for (const p of ok) expect(programPathIssue('arduino-cpp', p), p).toBeNull();
    const bad: [string, string][] = [
      ['', 'empty'],
      ['../evil.h', 'bad_name'],
      ['./x.h', 'bad_name'],
      ['/etc/x.h', 'bad_name'],
      ['a//b.h', 'bad_name'],
      ['.hidden.h', 'bad_name'],
      ['sub\\x.h', 'bad_name'],
      ['with space.h', 'bad_name'],
      ['a.b.h', 'bad_name'],
      ['lib/x.cpp', 'bad_extension'],
      ['src/a.ino', 'bad_extension'],
      ['notes.txt', 'bad_extension'],
      ['src/a/b/c.cpp', 'too_deep'],
      ['sketch.ino', 'entry'],
      ['SKETCH.INO', 'entry'],
      ['sketch.h', 'reserved'],
      [`${'a'.repeat(95)}.h`, 'too_long'],
    ];
    for (const [p, why] of bad) expect(programPathIssue('arduino-cpp', p), p).toBe(why);
    expect(programPathIssue('arduino-cpp', 'Helpers.h', ['helpers.h'])).toBe('duplicate');
  });

  it('MicroPython: importable module and package names only; main.py and boot.py are taken', () => {
    for (const p of ['helpers.py', 'pkg/__init__.py', 'pkg/mod.py', 'a/b/c.py'])
      expect(programPathIssue('micropython', p), p).toBeNull();
    const bad: [string, string][] = [
      ['my-mod.py', 'bad_name'],
      ['9lives.py', 'bad_name'],
      ['pkg/../x.py', 'bad_name'],
      ['data.json', 'bad_extension'],
      ['main.py', 'entry'],
      ['boot.py', 'reserved'],
      ['a/b/c/d.py', 'too_deep'],
    ];
    for (const [p, why] of bad) expect(programPathIssue('micropython', p), p).toBe(why);
  });
});

describe('program file edits', () => {
  it('add, edit, rename and delete further files; the entry file is fixed; order is by path', () => {
    const { doc, id } = withBoard();
    let d = must(addProgramFile(doc, id, 'util.cpp', 'int x;\n')).doc;
    d = must(addProgramFile(d, id, 'helpers.h', '#pragma once\n')).doc;
    expect(d.programs[id]!.files!.map((f) => f.path)).toEqual(['helpers.h', 'util.cpp']);
    expect(addProgramFile(d, id, 'HELPERS.h')).toEqual({ ok: false, error: 'file_exists' });
    expect(addProgramFile(d, id, 'sketch.ino')).toEqual({ ok: false, error: 'file_exists' });
    expect(addProgramFile(d, id, '../x.h')).toEqual({ ok: false, error: 'file_path_invalid' });
    d = must(setProgramText(d, id, 'int y;\n', 'util.cpp')).doc;
    expect(d.programs[id]!.files!.find((f) => f.path === 'util.cpp')!.text).toBe('int y;\n');
    expect(setProgramText(d, id, 'x', 'nope.cpp')).toEqual({ ok: false, error: 'no_file' });
    d = must(renameProgramFile(d, id, 'util.cpp', 'src/util.cpp')).doc;
    expect(d.programs[id]!.files!.map((f) => f.path)).toEqual(['helpers.h', 'src/util.cpp']);
    expect(renameProgramFile(d, id, 'sketch.ino', 'x.ino')).toEqual({
      ok: false,
      error: 'no_file',
    });
    d = must(deleteProgramFile(d, id, 'helpers.h')).doc;
    d = must(deleteProgramFile(d, id, 'src/util.cpp')).doc;
    // Back to a one-file program: no `files` field at all (the document as before Sprint 26).
    expect(d.programs[id]).toEqual(doc.programs[id]);
    expect(validateProject(d)).toEqual([]);
  });

  it('limits: 16 files with the entry, 64 KiB per file, 256 KiB per project', () => {
    const { doc, id } = withBoard();
    let d = doc;
    for (let i = 0; i < PROGRAM_LIMITS.maxFiles - 1; i++)
      d = must(addProgramFile(d, id, `f${i}.h`, '')).doc;
    expect(addProgramFile(d, id, 'one_more.h')).toEqual({ ok: false, error: 'too_many_files' });
    const big = 'x'.repeat(60 * 1024);
    let e = doc;
    for (let i = 0; i < 4; i++) e = must(addProgramFile(e, id, `b${i}.h`, big)).doc;
    expect(addProgramFile(e, id, 'b9.h', big)).toEqual({ ok: false, error: 'project_too_large' });
    expect(addProgramFile(doc, id, 'huge.h', 'x'.repeat(65 * 1024))).toEqual({
      ok: false,
      error: 'source_too_large',
    });
  });

  it('validation refuses unsorted, traversing, duplicate or oversized files in a stored document', () => {
    const { doc, id } = withBoard();
    const d = must(addProgramFile(doc, id, 'a.h', '')).doc;
    const bad = (mut: (p: Record<string, unknown>) => void) => {
      const raw = JSON.parse(JSON.stringify(d)) as ProjectDocument;
      mut(raw.programs[id] as unknown as Record<string, unknown>);
      return validateProject(raw).map((i) => i.code);
    };
    expect(bad(() => {})).toEqual([]);
    expect(bad((p) => (p.files = [{ path: '../a.h', text: '' }]))).toContain('bad_program');
    expect(
      bad(
        (p) =>
          (p.files = [
            { path: 'b.h', text: '' },
            { path: 'a.h', text: '' },
          ]),
      ),
    ).toContain('bad_program');
    expect(bad((p) => (p.files = [{ path: 'a.h', text: '', extra: 1 }]))).toContain('bad_program');
    expect(bad((p) => (p.libraries = [{ id: 'X Y', version: '1' }]))).toContain('bad_program');
  });
});

describe('managed libraries', () => {
  it('the registry: exact versions, licences, checksums and sources; no dependency cycles', () => {
    expect(MANAGED_LIBRARIES.map((l) => [l.id, l.version, l.license.spdx])).toEqual([
      [LCD_LIB, '2.2.0', 'BSD-3-Clause'],
      [PY_LIB, '0.0.0-git.7affb0b', 'MIT'],
    ]);
    for (const l of MANAGED_LIBRARIES) {
      expect(l.tree).toMatch(/^[0-9a-f]{64}$/);
      expect(l.source.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(l.validated.length).toBeGreaterThan(0);
      expect(l.dependencies).toEqual([]);
    }
  });

  it('placing the LCD pins its library in the same edit; removing it unpins it unless code uses it', () => {
    const { doc, id } = withBoard();
    const placed = must(addComponent(doc, 'display.lcd1602_i2c', { x: 400, y: 0 }));
    expect(placed.doc.programs[id]!.libraries).toEqual([{ id: LCD_LIB, version: '2.2.0' }]);
    // The user's code is never edited.
    expect(placed.doc.programs[id]!.text).toBe(doc.programs[id]!.text);
    const removed = must(
      deleteSelection(placed.doc, { components: [placed.id], wires: [], junctions: [] }),
    );
    expect(removed.doc.programs[id]!.libraries).toBeUndefined();
    expect(removed.doc.programs[id]).toEqual(doc.programs[id]);
    // With code that includes the library, it stays after the part goes.
    const coded = must(
      setProgramText(
        placed.doc,
        id,
        '#include <LiquidCrystal_PCF8574.h>\nvoid setup(){}\nvoid loop(){}\n',
      ),
    );
    const kept = must(
      deleteSelection(coded.doc, { components: [placed.id], wires: [], junctions: [] }),
    );
    expect(kept.doc.programs[id]!.libraries).toEqual([{ id: LCD_LIB, version: '2.2.0' }]);
    // A commented-out include does not keep it.
    const commented = must(setProgramText(kept.doc, id, '// #include <LiquidCrystal_PCF8574.h>\n'));
    expect(commented.doc.programs[id]!.libraries).toBeUndefined();
  });

  it('MicroPython gets its own library; a pinned version is kept; unknown versions are named', () => {
    const { doc, id } = withBoard();
    const mpy = must(setProgramProfile(doc, id, ESP32_MICROPYTHON_PROFILE.id)).doc;
    const placed = must(addComponent(mpy, 'display.lcd1602_i2c', { x: 400, y: 0 })).doc;
    expect(placed.programs[id]!.libraries).toEqual([{ id: PY_LIB, version: '0.0.0-git.7affb0b' }]);
    const pinned: ProjectDocument = JSON.parse(JSON.stringify(placed));
    pinned.programs[id]!.libraries = [{ id: PY_LIB, version: '0.0.0-old' }];
    expect(resolveLibraries(pinned, pinned.programs[id]!)).toEqual([
      { id: PY_LIB, version: '0.0.0-old' },
    ]);
    expect(libraryIssues(pinned.programs[id]!)).toEqual([
      { code: 'unknown_library', id: PY_LIB, version: '0.0.0-old' },
    ]);
  });

  it('the source key is unchanged without libraries and names their trees with them', () => {
    const files = [{ name: 'sketch.ino', text: 'void setup(){}\n' }];
    const plain = sourceKey('esp32-arduino-3.3.12', files);
    expect(sourceKey('esp32-arduino-3.3.12', files, [])).toBe(plain);
    const lib = MANAGED_LIBRARIES[0]!;
    const withLib = sourceKey('esp32-arduino-3.3.12', files, [
      { id: lib.id, version: lib.version, tree: lib.tree },
    ]);
    expect(withLib).not.toBe(plain);
    expect(
      sourceKey('esp32-arduino-3.3.12', files, [{ id: lib.id, version: lib.version, tree: '0' }]),
    ).not.toBe(withLib);
    // Further files are part of the key, in path order whatever the order given.
    const two = [...files, { name: 'a.h', text: '' }];
    expect(sourceKey('esp32-arduino-3.3.12', two)).toBe(
      sourceKey('esp32-arduino-3.3.12', [...two].reverse()),
    );
  });
});

describe('review fixes', () => {
  it('H1: MicroPython project files may not take a name the firmware already has', () => {
    for (const p of [
      'network.py',
      'esp32/__init__.py',
      'machine.py',
      'Time.py',
      'lib/x.py',
      'umqtt/x.py',
    ])
      expect(programPathIssue('micropython', p), p).toBe('reserved');
    expect(programPathIssue('micropython', 'sensors.py')).toBeNull();
  });

  it('M2: an unrelated edit never pins a library; placing the part does; the user can unpin', () => {
    const { doc, id } = withBoard();
    // An older (v5-era) project: LCD placed, no libraries field.
    const placed = must(addComponent(doc, 'display.lcd1602_i2c', { x: 400, y: 0 }));
    const old: ProjectDocument = JSON.parse(JSON.stringify(placed.doc));
    delete old.programs[id]!.libraries;
    const moved = must(
      moveSelection(old, { components: [placed.id], wires: [], junctions: [] }, { x: 20, y: 0 }),
    );
    expect(moved.doc.programs[id]!.libraries).toBeUndefined();
    // Placing (another) LCD pins it.
    const again = must(addComponent(moved.doc, 'display.lcd1602_i2c', { x: 400, y: 200 }));
    expect(again.doc.programs[id]!.libraries).toEqual([{ id: LCD_LIB, version: '2.2.0' }]);
    // Unpinned by the user, it stays unpinned through other edits.
    const un = must(unpinLibrary(again.doc, id, LCD_LIB));
    expect(un.doc.programs[id]!.libraries).toBeUndefined();
    const moved2 = must(
      moveSelection(un.doc, { components: [again.id], wires: [], junctions: [] }, { x: 20, y: 0 }),
    );
    expect(moved2.doc.programs[id]!.libraries).toBeUndefined();
    // Code that includes it: cannot be unpinned.
    const coded = must(setProgramText(again.doc, id, '#include <LiquidCrystal_PCF8574.h>\n'));
    expect(unpinLibrary(coded.doc, id, LCD_LIB)).toEqual({ ok: false, error: 'library_in_use' });
  });

  it('M2: a program switched to MicroPython with the LCD placed gets the MicroPython library', () => {
    const { doc, id } = withBoard();
    const placed = must(addComponent(doc, 'display.lcd1602_i2c', { x: 400, y: 0 })).doc;
    const mpy = must(setProgramProfile(placed, id, ESP32_MICROPYTHON_PROFILE.id)).doc;
    expect(mpy.programs[id]!.libraries).toEqual([{ id: PY_LIB, version: '0.0.0-git.7affb0b' }]);
  });
});

describe('schema v6', () => {
  it('v5 -> v6 is the identity; a one-file document opens unchanged', () => {
    expect(SCHEMA_VERSION).toBe(6);
    const { doc } = withBoard();
    const v5 = { ...JSON.parse(JSON.stringify(doc)), schemaVersion: 5 };
    expect(MIGRATIONS[5]!(JSON.parse(JSON.stringify(v5)))).toEqual(v5);
    const opened = openDocument(v5);
    expect(opened.status).toBe('ok');
    if (opened.status === 'ok') expect({ ...opened.doc, schemaVersion: 5 }).toEqual(v5);
  });

  it('a multi-file project with libraries survives export and import byte for byte', () => {
    const { doc, id } = withBoard();
    let d = must(addComponent(doc, 'display.lcd1602_i2c', { x: 400, y: 0 })).doc;
    d = must(
      setProgramText(d, id, '#include "display.h"\r\nvoid setup(){}\r\nvoid loop(){}\r\n'),
    ).doc;
    d = must(addProgramFile(d, id, 'display.h', '// שלום\n#pragma once\n')).doc;
    d = must(addProgramFile(d, id, 'src/display.cpp', '#include "../display.h"\n')).doc;
    const text = serializePackage(
      createPackage(d, { appVersion: '0.0.0', exportedAt: '2026-10-31T00:00:00.000Z' }),
    );
    const back = parsePackage(text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.doc.programs[id]).toEqual(d.programs[id]);
    // Deterministic: the same project serializes to the same bytes.
    const again = serializePackage(
      createPackage(d, { appVersion: '0.0.0', exportedAt: '2026-10-31T00:00:00.000Z' }),
    );
    expect(createHash('sha256').update(again).digest('hex')).toBe(
      createHash('sha256').update(text).digest('hex'),
    );
    expect(programBuildFiles(d.programs[id]!).map((f) => f.name)).toEqual([
      'sketch.ino',
      'display.h',
      'src/display.cpp',
    ]);
  });
});
