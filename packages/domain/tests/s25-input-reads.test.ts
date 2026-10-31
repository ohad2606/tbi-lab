/** Sprint 25 (Runtime v5, input-read): the pins a program may read, for the Session Host. */
import { describe, expect, it } from 'vitest';
import { programInputReads, type ProgramSource } from '../src/index.js';

const cpp = (text: string): ProgramSource => ({
  language: 'arduino-cpp',
  profile: '',
  fileName: 'sketch.ino',
  text,
});
const py = (text: string): ProgramSource => ({
  language: 'micropython',
  profile: '',
  fileName: 'main.py',
  text,
});

describe('programInputReads', () => {
  it('Arduino: literal and constant pins of pinMode(INPUT…) and digitalRead, outputs included', () => {
    expect(
      programInputReads(
        cpp(
          'const int DATA = 4;\n#define BTN 34\nvoid setup(){ pinMode(BTN, INPUT); pinMode(2, OUTPUT); }\nvoid loop(){ digitalRead(DATA); digitalRead(2); }',
        ),
      ),
    ).toEqual({ pins: [2, 4, 34], unresolved: false });
  });

  it('Arduino: a computed pin, gpio_get_level or a register read is unresolved', () => {
    expect(programInputReads(cpp('for (int o : OUTS) digitalRead(o);'))).toEqual({
      pins: [],
      unresolved: true,
    });
    expect(programInputReads(cpp('int v = gpio_get_level(GPIO_NUM_4);')).unresolved).toBe(true);
    expect(programInputReads(cpp('uint32_t v = REG_READ(GPIO_IN_REG);')).unresolved).toBe(true);
    // Comments and strings are not code.
    expect(programInputReads(cpp('// digitalRead(x)\nSerial.println("digitalRead(y)");'))).toEqual({
      pins: [],
      unresolved: false,
    });
  });

  it('MicroPython: every Pin made from a literal or constant; anything else is unresolved', () => {
    expect(
      programInputReads(
        py('from machine import Pin\nBTN = 34\nb = Pin(BTN, Pin.IN)\nled = Pin(2, Pin.OUT)\n'),
      ),
    ).toEqual({ pins: [2, 34], unresolved: false });
    expect(
      programInputReads(py('from machine import Pin\nb = Pin(30 + 4, Pin.IN)\n')).unresolved,
    ).toBe(true);
    expect(programInputReads(py('import machine\np = machine.Pin(n)\n')).unresolved).toBe(true);
  });

  it('review M2: constant arrays and range-for variables resolve; any unparsed read is unresolved', () => {
    expect(
      programInputReads(
        cpp(
          'const int OUTS[] = {4, 16};\nconst int INS[] = {34, 35};\nvoid setup(){ for (int o : OUTS) digitalRead(o); digitalRead(INS[1]); }',
        ),
      ),
    ).toEqual({ pins: [4, 16, 34, 35], unresolved: false });
    expect(programInputReads(cpp('int v = digitalRead(f(i));')).unresolved).toBe(true);
    expect(programInputReads(cpp('unsigned long d = pulseIn(5, HIGH);'))).toEqual({
      pins: [5],
      unresolved: false,
    });
    expect(programInputReads(cpp('byte b = shiftIn(4, 5, MSBFIRST);')).unresolved).toBe(true);
    expect(programInputReads(cpp('int v = rtc_gpio_get_level(GPIO_NUM_4);')).unresolved).toBe(true);
    expect(
      programInputReads(py('from machine import Pin\nb = Pin(int(x), Pin.IN)\n')).unresolved,
    ).toBe(true);
    expect(programInputReads(py('from machine import Pin as P\nb = P(4, P.IN)\n')).unresolved).toBe(
      true,
    );
  });
});
