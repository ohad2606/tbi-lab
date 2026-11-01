/**
 * P1 (owner report): switching a board's programming language must never discard code. Schema v7
 * keeps the other language's complete source (entry file, further files, pinned libraries) and
 * restores it exactly; the migration from v6 is the identity.
 */
import { describe, expect, it } from 'vitest';
import {
  ESP32_ARDUINO_PROFILE,
  ESP32_MICROPYTHON_PROFILE,
  SCHEMA_VERSION,
  addComponent,
  addProgramFile,
  cloneDocument,
  createProject,
  openDocument,
  setProgramProfile,
  setProgramText,
  starterSourceFor,
  validateProject,
  type ProjectDocument,
} from '../src/index.js';

const ARDUINO =
  'const int TRIG = 5;\nvoid setup() { pinMode(TRIG, OUTPUT); }\nvoid loop() { /* the user’s work */ }\r\n';
const MPY = 'from machine import Pin\nled = Pin(2, Pin.OUT)\n# kept\n';

function boardProject(): { doc: ProjectDocument; u: string } {
  const base = createProject({ projectId: 'prj_p1', deviceId: 'd', name: 'P1', appVersion: '0' });
  const r = addComponent(base, 'board.esp32_devkitc_wroom32', { x: 200, y: 200 });
  if (!r.ok) throw new Error(r.error);
  return { doc: r.doc, u: r.id };
}
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};
const sw = (doc: ProjectDocument, u: string, profile: string) =>
  ok(setProgramProfile(doc, u, profile));
const program = (doc: ProjectDocument, u: string) => doc.programs[u]!;

describe('language switching keeps every language’s code (schema v7)', () => {
  it('is schema v7', () => expect(SCHEMA_VERSION).toBe(7));

  it('Arduino -> MicroPython -> Arduino restores the Arduino source byte for byte', () => {
    const p = boardProject();
    const u = p.u;
    let doc = p.doc;
    doc = ok(setProgramText(doc, u, ARDUINO)).doc;
    const before = JSON.stringify(program(doc, u));
    const toMpy = sw(doc, u, ESP32_MICROPYTHON_PROFILE.id);
    expect(toMpy.restored).toBe(false);
    expect(program(toMpy.doc, u).text).toBe(starterSourceFor('micropython'));
    expect(program(toMpy.doc, u).alternates).toEqual([JSON.parse(before)]);
    expect(validateProject(toMpy.doc)).toEqual([]);
    const back = sw(toMpy.doc, u, ESP32_ARDUINO_PROFILE.id);
    expect(back.restored).toBe(true);
    const { alternates, ...active } = program(back.doc, u);
    expect(JSON.stringify(active)).toBe(before);
    expect(active.text).toBe(ARDUINO); // exact, including the CRLF and the non-ASCII apostrophe
    expect(alternates?.map((a) => a.profile)).toEqual([ESP32_MICROPYTHON_PROFILE.id]);
    // The source given in the call is never modified.
    expect(program(doc, u).alternates).toBeUndefined();
  });

  it('MicroPython -> Arduino -> MicroPython keeps both sides’ edits independently', () => {
    const p = boardProject();
    const u = p.u;
    let doc = p.doc;
    doc = sw(doc, u, ESP32_MICROPYTHON_PROFILE.id).doc;
    doc = ok(setProgramText(doc, u, MPY)).doc;
    doc = sw(doc, u, ESP32_ARDUINO_PROFILE.id).doc;
    doc = ok(setProgramText(doc, u, ARDUINO)).doc; // an edit while Arduino is active
    doc = sw(doc, u, ESP32_MICROPYTHON_PROFILE.id).doc;
    expect(program(doc, u).text).toBe(MPY);
    doc = sw(doc, u, ESP32_ARDUINO_PROFILE.id).doc;
    expect(program(doc, u).text).toBe(ARDUINO);
    expect(program(doc, u).alternates).toHaveLength(1);
    expect(program(doc, u).alternates![0]!.text).toBe(MPY);
  });

  it('multi-file programs: every file, path, entry point and library comes back; nothing leaks across', () => {
    const p = boardProject();
    const u = p.u;
    let doc = p.doc;
    doc = ok(
      setProgramText(doc, u, '#include "display.h"\nvoid setup() { show(); }\nvoid loop() {}\n'),
    ).doc;
    doc = ok(addProgramFile(doc, u, 'display.h', 'void show();\n')).doc;
    doc = ok(addProgramFile(doc, u, 'src/util.cpp', 'int twice(int x) { return 2 * x; }\n')).doc;
    // A pinned library (as the LCD part pins it).
    doc = cloneDocument(doc);
    doc.programs[u]!.libraries = [{ id: 'arduino.liquidcrystal-pcf8574', version: '2.2.0' }];
    const arduino = JSON.stringify(program(doc, u));
    doc = sw(doc, u, ESP32_MICROPYTHON_PROFILE.id).doc;
    // The MicroPython side has none of the Arduino files or libraries.
    expect(program(doc, u).files).toBeUndefined();
    expect(program(doc, u).libraries).toBeUndefined();
    doc = ok(addProgramFile(doc, u, 'helpers.py', 'def two():\n    return 2\n')).doc;
    const mpy = JSON.stringify({ ...program(doc, u), alternates: undefined });
    doc = sw(doc, u, ESP32_ARDUINO_PROFILE.id).doc;
    const { alternates, ...active } = program(doc, u);
    expect(JSON.stringify(active)).toBe(arduino);
    expect(JSON.stringify({ ...alternates![0], alternates: undefined })).toBe(mpy);
    expect(validateProject(doc)).toEqual([]);
  });

  it('a part placed while the other language is active: each language gets only its own library', () => {
    const p = boardProject();
    const u = p.u;
    let doc = p.doc;
    doc = ok(setProgramText(doc, u, ARDUINO)).doc;
    doc = sw(doc, u, ESP32_MICROPYTHON_PROFILE.id).doc;
    doc = ok(addComponent(doc, 'display.lcd1602_i2c', { x: 600, y: 200 })).doc;
    expect(program(doc, u).libraries).toEqual([
      { id: 'micropython.python-lcd', version: '0.0.0-git.7affb0b' },
    ]);
    expect(program(doc, u).alternates![0]!.libraries).toBeUndefined();
    doc = sw(doc, u, ESP32_ARDUINO_PROFILE.id).doc;
    expect(program(doc, u).text).toBe(ARDUINO);
    expect(program(doc, u).libraries).toEqual([
      { id: 'arduino.liquidcrystal-pcf8574', version: '2.2.0' },
    ]);
    expect(program(doc, u).alternates![0]!.libraries).toEqual([
      { id: 'micropython.python-lcd', version: '0.0.0-git.7affb0b' },
    ]);
    expect(validateProject(doc)).toEqual([]);
  });

  it('switching to the active language changes nothing', () => {
    const { doc, u } = boardProject();
    expect(setProgramProfile(doc, u, ESP32_ARDUINO_PROFILE.id)).toMatchObject({
      ok: true,
      doc,
      restored: true,
    });
  });

  it('a v6 project opens as v7 unchanged (identity migration, nothing added)', () => {
    const { doc } = boardProject();
    const v6 = {
      ...cloneDocument(doc),
      schemaVersion: 6,
      createdWith: { app: '0', schemaVersion: 6 },
    };
    const r = openDocument(v6);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.migratedFrom).toBe(6);
    expect({ ...r.doc, schemaVersion: 6 }).toEqual(v6);
  });

  it('malformed kept code is refused by validation (fails closed)', () => {
    const p = boardProject();
    const u = p.u;
    let doc = p.doc;
    doc = sw(doc, u, ESP32_MICROPYTHON_PROFILE.id).doc;
    const bad = (mutate: (d: ProjectDocument) => void) => {
      const d = cloneDocument(doc);
      mutate(d);
      return validateProject(d).map((i) => i.code);
    };
    expect(bad((d) => (d.programs[u]!.alternates = []))).toContain('bad_program');
    expect(
      bad((d) => d.programs[u]!.alternates!.push(cloneDocument(d.programs[u]!.alternates![0]!))),
    ).toContain('bad_program');
    expect(
      bad((d) => (d.programs[u]!.alternates![0]!.profile = ESP32_MICROPYTHON_PROFILE.id)),
    ).toContain('bad_program');
    expect(
      bad((d) => ((d.programs[u]!.alternates![0] as Record<string, unknown>).alternates = [])),
    ).toContain('bad_program');
    expect(bad((d) => (d.programs[u]!.alternates![0]!.text = 'x\u0000'))).toContain('bad_program');
  });
});
