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

/**
 * Sprint 24 (M3): hardware I2C on a runtime with the `i2c` capability, in exactly the verified
 * shape, every argument a literal; the clock at most the PCF8574's rated 100 kHz.
 */
describe('MicroPython hardware I2C (Sprint 24)', () => {
  const I2C_RT = ['i2c', 'pad-func', 'pwm', 'sched-input', 'unmodelled'];
  const ok = `from machine import Pin, I2C
i2c = I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)
print(i2c.scan())
i2c.writeto(0x27, bytes([0x08]))
i2c.writevto(0x27, (b'\\x0c', b'\\x08'))
`;

  it('the verified shape is allowed and requires the i2c capability', () => {
    expect(analyzeMicroPython(ok, I2C_RT)).toEqual({ ...clean, requires: ['i2c'] });
    for (const src of [
      'import machine\ni2c = machine.I2C(0, scl=machine.Pin(22), sda=machine.Pin(21), freq=50_000)',
      'import machine as m\nb = m.I2C(id=0, sda=21, scl=22, freq=0x186A0)',
      'from machine import I2C as Bus, Pin\nb = Bus(0, scl=Pin(22), sda=Pin(21), freq=100000)',
      'from machine import *\nb = I2C(0, scl=Pin(22), sda=Pin(21), freq=10000)',
    ])
      expect(analyzeMicroPython(src, I2C_RT), src).toEqual({ ...clean, requires: ['i2c'] });
  });

  it('without the runtime capability I2C stays refused as i2c', () => {
    expect(analyzeMicroPython(ok).unsupported).toEqual(['i2c']);
    expect(analyzeMicroPython(ok, ['unmodelled']).unsupported).toEqual(['i2c']);
    expect(analyzeMicroPython(ok).requires).toBeUndefined();
  });

  it('SoftI2C stays refused (a bit-banged bus is not decodable)', () => {
    const src =
      'from machine import Pin, SoftI2C\nb = SoftI2C(scl=Pin(22), sda=Pin(21), freq=100000)';
    expect(analyzeMicroPython(src, I2C_RT).unsupported).toEqual(['i2c']);
  });

  it('freq missing, computed or above 100 kHz is refused by name (i2c_frequency)', () => {
    for (const freq of [
      '',
      ', freq=400000',
      ', freq=100001',
      ', freq=F',
      ', freq=100_000 * 2',
      ', freq=1e5',
    ])
      expect(
        analyzeMicroPython(
          `from machine import Pin, I2C\nI2C(0, scl=Pin(22), sda=Pin(21)${freq})`,
          I2C_RT,
        ).unsupported,
        freq,
      ).toEqual(['i2c_frequency']);
    // A later re-configuration with a faster clock, too.
    expect(
      analyzeMicroPython(`${ok}i2c.init(scl=Pin(22), sda=Pin(21), freq=400000)\n`, I2C_RT)
        .unsupported,
    ).toEqual(['i2c_frequency']);
  });

  it('another bus, other pins, other options are refused by name', () => {
    const at = (args: string) =>
      analyzeMicroPython(`from machine import Pin, I2C\nI2C(${args})`, I2C_RT).unsupported;
    expect(at('1, scl=Pin(22), sda=Pin(21), freq=100000')).toEqual(['i2c_bus']);
    expect(at('BUS, scl=Pin(22), sda=Pin(21), freq=100000')).toEqual(['i2c_bus']);
    expect(at('0, scl=Pin(21), sda=Pin(22), freq=100000')).toEqual(['i2c_pins']);
    expect(at('0, scl=Pin(18), sda=Pin(19), freq=100000')).toEqual(['i2c_pins']);
    expect(at('0, freq=100000')).toEqual(['i2c_pins']);
    expect(at('0, scl=Pin(22), sda=Pin(21), freq=100000, timeout=50000')).toEqual(['i2c_option']);
    expect(at('0, Pin(22), Pin(21), freq=100000')).toEqual(['i2c_option', 'i2c_pins']);
  });

  it('operations no modelled part answers, and indirect use, are refused (i2c_operation)', () => {
    for (const op of [
      'i2c.readfrom(0x27, 1)',
      'i2c.readfrom_into(0x27, buf)',
      'i2c.readfrom_mem(0x27, 0, 1)',
      'i2c.readfrom_mem_into(0x27, 0, buf)',
      'i2c.writeto_mem(0x27, 0, b"x")',
      'getattr(i2c, "readfrom")(0x27, 1)',
    ])
      expect(analyzeMicroPython(ok + op, I2C_RT).unsupported, op).toEqual(['i2c_operation']);
    for (const src of [
      'import machine\nB = machine.I2C\nb = B(0, scl=22, sda=21, freq=100000)',
      'import machine\nb = getattr(machine, "I2C")(0, scl=22, sda=21, freq=400000)',
    ])
      expect(analyzeMicroPython(src, I2C_RT).unsupported, src).toContain('i2c_operation');
  });

  it('the rated clock is the PCF8574 data-sheet value pinned in the engine', async () => {
    const { I2C_MAX_FREQ_HZ } = await import('../pyFeatures.js');
    const { PCF8574_MAX_SCL_HZ } = await import('@tbi-lab/engine');
    expect(I2C_MAX_FREQ_HZ).toBe(PCF8574_MAX_SCL_HZ);
    expect(I2C_MAX_FREQ_HZ).toBe(100_000);
  });
});

describe('MicroPython hardware I2C: names in strings and comments', () => {
  it('I2C in a printed string or a comment is not a use of the bus', () => {
    const src =
      '# I2C on bus 0\nfrom machine import Pin, I2C\nb = I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)\nprint("I2C scan:", b.scan())\n';
    expect(analyzeMicroPython(src, ['i2c', 'unmodelled'])).toEqual({ ...clean, requires: ['i2c'] });
  });
});
