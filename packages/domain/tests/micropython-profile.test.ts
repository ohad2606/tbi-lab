/**
 * Sprint 19B (MicroPython M1): the genuine-MicroPython build profile and switching a board's
 * programming environment (no translation between languages; a valid, storable program).
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  BUILD_PROFILES,
  ESP32_MICROPYTHON_PROFILE,
  setProgramProfile,
  setProgramText,
  starterSourceFor,
  useBoardProgram,
  validateProject,
} from '../src/index.js';
import { must, newDoc } from './helpers.js';

function board() {
  const r = addComponent(newDoc(), 'board.esp32_devkitc_wroom32', { x: 0, y: 0 });
  if (!r.ok) throw new Error(r.error);
  return { doc: must(useBoardProgram(r.doc, r.id)).doc, id: r.id };
}

describe('MicroPython profile', () => {
  it('is offered for the classic ESP32 DevKitC, after Arduino (which stays the default)', () => {
    expect(BUILD_PROFILES.map((p) => p.id)).toEqual([
      'esp32-arduino-3.3.12',
      'esp32-micropython-1.29',
    ]);
    expect(ESP32_MICROPYTHON_PROFILE).toMatchObject({
      language: 'micropython',
      fileName: 'main.py',
      board: 'board.esp32_devkitc_wroom32',
      maxSourceBytes: 65536,
    });
    expect(board().doc.programs[board().id]!.profile).toBe('esp32-arduino-3.3.12');
  });

  it('switching starts the other environment’s starter (never a translation); valid; back again', () => {
    const { doc, id } = board();
    const edited = must(
      setProgramText(doc, id, 'void setup() { pinMode(2, OUTPUT); }\nvoid loop() {}\n'),
    ).doc;
    const py = must(setProgramProfile(edited, id, 'esp32-micropython-1.29')).doc;
    expect(py.programs[id]).toEqual({
      language: 'micropython',
      profile: 'esp32-micropython-1.29',
      fileName: 'main.py',
      text: starterSourceFor('micropython'),
    });
    expect(validateProject(py)).toEqual([]);
    const text = 'from machine import Pin\nPin(2, Pin.OUT).value(1)\n';
    const written = must(setProgramText(py, id, text)).doc;
    expect(written.programs[id]!.text).toBe(text);
    const back = must(setProgramProfile(written, id, 'esp32-arduino-3.3.12')).doc;
    expect(back.programs[id]!.text).toBe(starterSourceFor('arduino-cpp'));
    expect(setProgramProfile(back, id, 'esp32-nope')).toMatchObject({
      ok: false,
      error: 'unknown_profile',
    });
    expect(setProgramProfile(back, id, 'esp32-arduino-3.3.12')).toMatchObject({
      ok: true,
      doc: back,
    });
  });
});
