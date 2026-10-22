/**
 * Sprint 19B (independent review finding 1): MicroPython facilities the simulator does not model
 * are refused at Build, by name, as the Arduino analysis does. Fail closed: unknown imports and
 * `machine` names are refused; what runs (Pin, PWM, time, print) passes untouched.
 */
import { describe, expect, it } from 'vitest';
import { analyzeMicroPython, pythonCodeOnly } from '../pyFeatures.js';
import { INPUT_CAPABLE_GPIOS } from '../features.js';

const clean = { internalPull: [], gpioInterrupt: [], restart: false, unsupported: [] };

describe('MicroPython feature analysis', () => {
  it('a program that only uses what is modelled is not refused', () => {
    const src = `
from machine import Pin, PWM
import time
led = Pin(2, Pin.OUT)
btn = Pin(4, Pin.IN)          # external pull-down on the board: PULL_UP not used here
pwm = PWM(Pin(18), freq=1000, duty_u16=32768)
pwm.freq(2000)                # the PWM's own frequency, not the CPU clock
while True:
    led.value(not led.value())
    print("tick", btn.value())
    time.sleep_ms(250)
`;
    expect(analyzeMicroPython(src)).toEqual(clean);
  });

  it('internal pulls in every spelling are refused (all input-capable pins declared)', () => {
    for (const src of [
      'from machine import Pin\np = Pin(4, Pin.IN, Pin.PULL_UP)',
      'import machine\np = machine.Pin(4, machine.Pin.IN, pull=machine.Pin.PULL_DOWN)',
      'from machine import Pin\np = Pin(4, Pin.IN, 1)',
      'from machine import Pin\np = Pin(4)\np.init(Pin.IN, pull=1)',
    ])
      expect(analyzeMicroPython(src).internalPull, src).toEqual(INPUT_CAPABLE_GPIOS);
    expect(
      analyzeMicroPython('from machine import Pin\nPin(4, Pin.IN, None)').internalPull,
    ).toEqual([]);
    expect(
      analyzeMicroPython('from machine import Pin\nPin(4, Pin.IN, pull=None)').internalPull,
    ).toEqual([]);
  });

  it('unmodelled machine facilities are refused by facility; others by name', () => {
    const cases: [string, string][] = [
      ['from machine import DAC', 'dac'],
      ['from machine import TouchPad', 'touch'],
      ['import machine\nmachine.SPI(1)', 'spi'],
      ['from machine import SoftI2C', 'i2c'],
      ['from machine import Timer', 'interrupt'],
      ['import machine as m\nm.lightsleep(100)', 'sleep'],
      ['import machine\nmachine.freq(240000000)', 'cpu_frequency'],
      ['from machine import freq\nfreq(80_000_000)', 'cpu_frequency'],
      ['from machine import Pin\nPin(2, Pin.OUT, drive=Pin.DRIVE_3)', 'drive_strength'],
      ['from machine import UART', 'library:machine.UART'],
      ['import machine\nmachine.mem32[0x3ff44004] = 4', 'library:machine.mem32'],
      ['from machine import *\nr = RTC()', 'library:machine.RTC'],
    ];
    for (const [src, f] of cases) expect(analyzeMicroPython(src).unsupported, src).toContain(f);
    // Reading the clock is allowed.
    expect(analyzeMicroPython('import machine\nprint(machine.freq())').unsupported).toEqual([]);
  });

  it('restart requests are refused in every spelling', () => {
    for (const src of [
      'import machine\nmachine.reset()',
      'from machine import reset\nreset()',
      'from machine import soft_reset as sr',
      'from machine import WDT\nWDT(timeout=2000)',
      'import machine\ngetattr(machine, "reset")()',
      'from machine import *\nreset()',
    ])
      expect(analyzeMicroPython(src).restart, src).toBe(true);
  });

  it('only allowlisted modules may be imported', () => {
    for (const [src, f] of [
      ['import network', 'library:network'],
      ['import bluetooth', 'library:bluetooth'],
      ['import esp32', 'library:esp32'],
      ['from neopixel import NeoPixel', 'library:neopixel'],
      ['import time, dht', 'library:dht'],
      ['import random', 'library:random'],
      ['import os', 'library:os'],
      ["m = __import__('network')", 'library:__import__'],
    ] as const)
      expect(analyzeMicroPython(src).unsupported, src).toContain(f);
    expect(
      analyzeMicroPython('import time, math, gc, sys, micropython, struct').unsupported,
    ).toEqual([]);
  });

  it('comments do not count; string literals do (fail closed)', () => {
    expect(pythonCodeOnly('x = 1  # import network\ny = "# not a comment"')).toBe(
      'x = 1  \ny = "# not a comment"',
    );
    expect(analyzeMicroPython('# machine.reset() would restart the board\nimport time')).toEqual(
      clean,
    );
    expect(analyzeMicroPython('"""Calls Pin.PULL_UP elsewhere."""').internalPull).toEqual(
      INPUT_CAPABLE_GPIOS,
    );
  });
});
