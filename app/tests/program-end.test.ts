/**
 * Sprint 24 (M1): the end of a MicroPython program read from its serial output (programEnd.ts):
 * the interpreter's own traceback and REPL banner, as real QEMU Runtime v4 printed them.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { micropythonProgramEnd } from '../src/programs/programEnd.js';
import { getLocale, translate } from '../src/i18n/i18n.js';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/s24-mpy-serial.json', import.meta.url), 'utf8'),
) as Record<'error' | 'finished', { program: string; serial: string }>;
const BANNER =
  'MicroPython v1.29.0 on 2026-08-24; Generic ESP32 module with ESP32\r\nType "help()" for more information.\r\n>>> ';

describe('MicroPython program end (from serial)', () => {
  it('an uncaught exception: the line where it was raised, the exception and the traceback', () => {
    expect(micropythonProgramEnd(golden.error.serial)).toEqual({
      kind: 'error',
      exception: 'ZeroDivisionError: divide by zero',
      line: 4,
      traceback: [
        'Traceback (most recent call last):',
        '  File "main.py", line 6, in <module>',
        '  File "main.py", line 4, in f',
        'ZeroDivisionError: divide by zero',
      ],
    });
  });

  it('the program ran to its end: finished', () => {
    expect(micropythonProgramEnd(golden.finished.serial)).toEqual({ kind: 'finished' });
  });

  it('still running (no prompt yet, or output after it): nothing', () => {
    expect(micropythonProgramEnd(golden.error.serial.replace(/>>> $/, ''))).toBeNull();
    expect(micropythonProgramEnd('A\r\nB\r\n')).toBeNull();
    expect(micropythonProgramEnd(`${golden.finished.serial}more\r\n`)).toBeNull();
    // The banner text in the middle of a running program's output is not an ending.
    expect(micropythonProgramEnd(`${BANNER}\r\ntick\r\n`)).toBeNull();
  });

  it('a traceback the program printed itself and went on: finished, not an error', () => {
    const s = `Traceback (most recent call last):\r\n  File "main.py", line 3, in <module>\r\nValueError: x\r\nrecovered\r\n${BANNER}`;
    expect(micropythonProgramEnd(s)).toEqual({ kind: 'finished' });
  });

  it('an error raised outside main.py: the error without a main.py line', () => {
    const s = `Traceback (most recent call last):\r\n  File "<stdin>", line 1, in <module>\r\nOSError: [Errno 19] ENODEV\r\n${BANNER}`;
    expect(micropythonProgramEnd(s)).toMatchObject({
      kind: 'error',
      exception: 'OSError: [Errno 19] ENODEV',
    });
    expect(micropythonProgramEnd(s)).not.toHaveProperty('line');
  });

  it('a trimmed serial window (the start dropped) still reads the ending', () => {
    expect(
      micropythonProgramEnd(golden.error.serial.slice(golden.error.serial.indexOf('Traceback'))),
    ).toMatchObject({
      kind: 'error',
      line: 4,
    });
  });

  it('the notice texts exist in every launch locale, with the line placeholder', () => {
    for (const locale of ['en', 'he'] as const) {
      const t = (k: Parameters<typeof translate>[1], p?: Record<string, string>) =>
        translate(getLocale(locale), k, p);
      expect(t('mcu.programEnd.errorLine', { line: '4' })).toContain('4');
      for (const k of [
        'mcu.programEnd.finished',
        'mcu.programEnd.repl',
        'mcu.programEnd.derived',
      ] as const)
        expect(t(k).length, `${locale} ${k}`).toBeGreaterThan(10);
    }
  });
});
