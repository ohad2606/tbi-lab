/**
 * Sprint 29: the MicroPython support contract cannot drift from the Build analysis. Every entry's
 * probe is analysed exactly as a build is (Runtime v5 capabilities):
 * - a Build refusal reports exactly its id;
 * - a session refusal is the analysis field the host refuses at creation (internalPull, restart);
 * - a supported or run-time entry passes Build (nothing unsupported) and requires what it says.
 */
import { describe, expect, it } from 'vitest';
import { MICROPYTHON_CONTRACT } from '../pyContract.js';
import { analyzeMicroPython } from '../pyFeatures.js';
import { getLocale, translate } from '../../../app/src/i18n/i18n.js';
import type { MessageKey } from '../../../app/src/i18n/messages.en.js';

const V5 = [
  'gpio-irq',
  'i2c',
  'i2c-clock',
  'input-read',
  'pad-func',
  'pwm',
  'sched-input',
  'unmodelled',
];

describe('MicroPython support contract (Sprint 29)', () => {
  it('ids are unique and every entry is complete', () => {
    const ids = MICROPYTHON_CONTRACT.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of MICROPYTHON_CONTRACT) {
      expect(e.note.length, e.id).toBeGreaterThan(10);
      expect(e.evidence.length, e.id).toBeGreaterThan(3);
      if (e.status === 'refused') expect(e.refusal, e.id).toBeTruthy();
    }
    expect(MICROPYTHON_CONTRACT.filter((e) => e.status === 'unknown')).toEqual([]);
  });

  for (const e of MICROPYTHON_CONTRACT)
    it(`${e.id} (${e.status} at ${e.at}): the Build analysis agrees`, () => {
      const r = analyzeMicroPython(e.probe, V5);
      if (e.status === 'refused' && e.at === 'build') {
        expect(r.unsupported, e.id).toEqual([e.refusal]);
        return;
      }
      expect(r.unsupported, e.id).toEqual([]);
      if (e.at === 'session') {
        if (e.refusal === 'internalPull') expect(r.internalPull.length, e.id).toBeGreaterThan(0);
        else if (e.refusal === 'restart') expect(r.restart, e.id).toBe(true);
        else throw new Error(`unknown session refusal ${e.refusal}`);
        return;
      }
      for (const c of e.requires ?? []) expect(r.requires, e.id).toContain(c);
    });

  it('every Build refusal id has its EN and HE text (build.feature.<id>)', () => {
    for (const e of MICROPYTHON_CONTRACT.filter(
      (x) => x.status === 'refused' && x.at === 'build',
    )) {
      const key = e.refusal!.startsWith('library:')
        ? null
        : (`build.feature.${e.refusal}` as MessageKey);
      if (!key) continue;
      for (const l of ['en', 'he']) {
        const t = translate(getLocale(l), key);
        expect(t, `${l} ${key}`).not.toBe(key);
        expect(t.length, `${l} ${key}`).toBeGreaterThan(5);
      }
    }
  });

  it('serial input is refused, a user function named input or a word in a string is not', () => {
    expect(analyzeMicroPython('import sys\nsys.stdin.read(1)\n', V5).unsupported).toEqual([
      'serial_input',
    ]);
    expect(analyzeMicroPython('from sys import stdin\n', V5).unsupported).toEqual(['serial_input']);
    expect(analyzeMicroPython('import usys\nusys.stdin.readline()\n', V5).unsupported).toEqual([
      'serial_input',
    ]);
    expect(
      analyzeMicroPython('def input(x):\n    return x\nmy_input = 1\nprint("input()")\n', V5)
        .unsupported,
    ).toEqual([]);
  });
});
