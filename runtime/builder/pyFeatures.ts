/**
 * Firmware feature analysis for MicroPython on the Classic ESP32 (Sprint 19B, independent review
 * finding 1). The Arduino analysis (features.ts) refuses every facility the simulator does not
 * model at Build; MicroPython must refuse the same set, or a program would run with dead or
 * invented behaviour (an internal pull the solver never applies, a DAC that outputs nothing).
 *
 * Fail closed, by allowlist:
 * - **Imports.** Only modules whose behaviour the simulator reproduces are accepted; any other
 *   import (network, bluetooth, esp32, neopixel, onewire, dht, random, os, …) is refused as
 *   `library:<module>`.
 * - **`machine` names.** Only Pin, PWM, ADC, Signal and idle are accepted (ADC is refused at RUN
 *   time by Runtime v4, at the access, as are Pin.irq and lowering the CPU clock). Every other
 *   name is refused, by its facility where one exists (SPI → spi, DAC → dac, reset → restart,
 *   lightsleep → sleep, Timer → interrupt, …), else as `library:machine.<name>`.
 * - **Pin arguments.** A pull (`Pin.PULL_UP`, `pull=`, a third positional argument other than
 *   None) is an internal pull; a drive strength (`Pin.DRIVE_n`, `drive=`) is refused.
 * - **CPU clock.** `machine.freq(<value>)` is refused at Build: Runtime v4 only detects a clock
 *   LOWER than the highest one reached, not a raise (review finding 2).
 *
 * Tokens are matched in the program with comments removed and string literals KEPT (so
 * `getattr(machine, "reset")` is refused too). A name in a docstring may therefore refuse a
 * program that does not call it: an explicit, explained refusal, never a wrong simulation.
 * What static analysis cannot see (names built at run time from pieces) is the documented
 * residual; the run-time U frames remain the backstop for ADC, interrupts and the clock.
 */
import type { FeatureReport } from './protocol.js';
import { INPUT_CAPABLE_GPIOS } from './features.js';

/** Version of this analysis; part of the MicroPython profile hash (cache key). */
export const PY_FEATURES_ANALYZER = 1;

/** Modules the simulator reproduces (pure computation, timing, the console). */
const ALLOWED_MODULES = new Set([
  'machine',
  'time',
  'utime',
  'sys',
  'usys',
  'gc',
  'micropython',
  'math',
  'cmath',
  'struct',
  'ustruct',
  'array',
  'uarray',
  'collections',
  'ucollections',
  'json',
  'ujson',
  're',
  'ure',
  'binascii',
  'ubinascii',
  'errno',
  'uerrno',
]);

/** `machine` names that run as on the board (or are refused at the access by Runtime v4). */
const ALLOWED_MACHINE = new Set(['Pin', 'PWM', 'ADC', 'Signal', 'idle', 'freq']);

/** `machine` names refused by facility; anything else not allowed is `library:machine.<name>`. */
const MACHINE_FACILITY: Record<string, string> = {
  DAC: 'dac',
  TouchPad: 'touch',
  SPI: 'spi',
  SoftSPI: 'spi',
  // MicroPython's I2C has not been verified on the runtime (only the Arduino core's driver was).
  I2C: 'i2c',
  SoftI2C: 'i2c',
  reset: 'restart',
  soft_reset: 'restart',
  WDT: 'restart',
  lightsleep: 'sleep',
  deepsleep: 'sleep',
  sleep: 'sleep',
  wake_reason: 'sleep',
  Timer: 'interrupt',
  disable_irq: 'interrupt',
  enable_irq: 'interrupt',
};

/** Every refused `machine` name the analysis looks for in strings and after `import *`. */
const MACHINE_REFUSED_NAMES = [
  ...Object.keys(MACHINE_FACILITY),
  'RTC',
  'UART',
  'I2S',
  'SDCard',
  'Counter',
  'Encoder',
  'bitstream',
  'time_pulse_us',
  'unique_id',
  'reset_cause',
  'mem8',
  'mem16',
  'mem32',
];

/** The program without comments; string literals are kept, so names in them count. */
export function pythonCodeOnly(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = source.startsWith(c.repeat(3), i);
      const end = triple ? c.repeat(3) : c;
      let j = i + end.length;
      while (j < source.length && !source.startsWith(end, j)) {
        if (source[j] === '\\') j++;
        else if (!triple && source[j] === '\n') break;
        j++;
      }
      j = Math.min(source.length, j + end.length);
      out += source.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function analyzeMicroPython(source: string): FeatureReport {
  const code = pythonCodeOnly(source);
  const unsupported = new Set<string>();
  let restart = false;
  let pull = false;
  const machineNames = new Set<string>();
  const machineAliases = new Set<string>();
  let machineStar = false;

  const refuseMachine = (name: string) => {
    if (ALLOWED_MACHINE.has(name)) return;
    const f = MACHINE_FACILITY[name] ?? `library:machine.${name}`;
    if (f === 'restart') restart = true;
    else unsupported.add(f);
  };

  // import a, b.c as d
  for (const m of code.matchAll(/^[ \t]*import[ \t]+([^\n;]+)/gm))
    for (const part of m[1]!.split(',')) {
      const [mod, alias] = part.trim().split(/\s+as\s+/) as [string, string | undefined];
      const top = mod.split('.')[0]!;
      if (!ALLOWED_MODULES.has(top) || mod.includes('.')) unsupported.add(`library:${mod}`);
      if (mod === 'machine') machineAliases.add(alias ?? 'machine');
    }
  // from m import a, b as c   /   from m import *
  for (const m of code.matchAll(
    /^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n;]+)/gm,
  )) {
    const mod = m[1]!;
    if (!ALLOWED_MODULES.has(mod)) {
      unsupported.add(`library:${mod}`);
      continue;
    }
    if (mod !== 'machine') continue;
    for (const part of m[2]!.replace(/[()\\]/g, ' ').split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]!;
      if (name === '*') machineStar = true;
      else if (name) machineNames.add(name);
    }
  }
  // __import__ / importlib cannot be checked by name.
  if (/\b(__import__|importlib)\b/.test(code)) unsupported.add('library:__import__');

  for (const name of machineNames) refuseMachine(name);
  for (const alias of machineAliases)
    for (const m of code.matchAll(new RegExp(`\\b${alias}\\s*\\.\\s*(\\w+)`, 'g')))
      refuseMachine(m[1]!);
  // A name passed as a string (getattr(machine, "reset")) or used after `from machine import *`.
  const quoted = new Set([...code.matchAll(/["'](\w+)["']/g)].map((m) => m[1]!));
  for (const name of MACHINE_REFUSED_NAMES)
    if (quoted.has(name) || (machineStar && new RegExp(`(?<![.\\w])${name}\\b`).test(code)))
      refuseMachine(name);

  // Pin arguments: internal pulls and drive strength.
  if (/\bPULL_(UP|DOWN|HOLD)\b|\bpull\s*=\s*(?!None\b)/.test(code)) pull = true;
  for (const m of code.matchAll(/\bPin\s*\(\s*[^,()]+,\s*[^,()]+,\s*([^,()=]+?)\s*[,)]/g))
    if (m[1]!.trim() !== 'None') pull = true;
  if (/\bDRIVE_\d\b|\bdrive\s*=/.test(code)) unsupported.add('drive_strength');

  // CPU clock: machine's freq called with a value (machine.freq(x), or freq(x) imported from
  // machine); a PWM object's own pwm.freq(x) is not the CPU clock.
  const freqCalls = [
    ...[...machineAliases].map((a) => new RegExp(`\\b${a}\\s*\\.\\s*freq\\s*\\(\\s*[^)\\s]`)),
    ...(machineNames.has('freq') || machineStar ? [/(?<![.\w])freq\s*\(\s*[^)\s]/] : []),
  ];
  if (freqCalls.some((re) => re.test(code))) unsupported.add('cpu_frequency');

  return {
    // The pins cannot be told reliably from Python: every input-capable pin is declared.
    internalPull: pull ? INPUT_CAPABLE_GPIOS : [],
    gpioInterrupt: [],
    restart,
    unsupported: [...unsupported].sort(),
  };
}
