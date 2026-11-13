/**
 * Firmware feature analysis for MicroPython on the Classic ESP32 (Sprint 19B, independent review
 * finding 1). The Arduino analysis (features.ts) refuses every facility the simulator does not
 * model at Build; MicroPython must refuse the same set, or a program would run with dead or
 * invented behaviour (an internal pull the solver never applies, a DAC that outputs nothing).
 *
 * Fail closed, by allowlist:
 * - **Imports.** Only modules whose behaviour the simulator reproduces are accepted; any other
 *   import (network, bluetooth, esp32, neopixel, onewire, random, os, …) is refused as
 *   `library:<module>`. Phase 2 of the MicroPython expansion allows `dht` (the firmware's own
 *   driver, validated with the DHT22 model; its DHT11 class has no simulated part to run with).
 * - **`machine` names.** Only Pin, PWM, ADC, Signal, idle and time_pulse_us are accepted (ADC is refused at RUN
 *   time by Runtime v4, at the access, as are Pin.irq and lowering the CPU clock). Every other
 *   name is refused, by its facility where one exists (SPI → spi, DAC → dac, reset → restart,
 *   lightsleep → sleep, Timer → interrupt, …), else as `library:machine.<name>`.
 * - **Pin arguments.** A pull (`Pin.PULL_UP`, `pull=`, a third positional argument other than
 *   None) is an internal pull; a drive strength (`Pin.DRIVE_n`, `drive=`) is refused.
 * - **CPU clock.** `machine.freq(<value>)` is refused at Build: Runtime v4 only detects a clock
 *   LOWER than the highest one reached, not a raise (review finding 2).
 *
 * - **I2C (Sprint 24, M3).** On a runtime with the bridge capability `i2c` (patch 0008), the
 *   hardware `machine.I2C` is allowed (the build then `requires: [i2c]`) exactly in the shape the
 *   simulator verified, every argument a literal: `I2C(0, scl=Pin(22), sda=Pin(21), freq=<= the
 *   rated clock of every modelled I2C part>)` (the PCF8574: 100 kHz). A missing, computed or faster
 *   `freq` is `i2c_frequency`; another bus id `i2c_bus`; other pins `i2c_pins`; other options
 *   (`timeout=`, extra arguments) `i2c_option`. Bus operations the modelled parts do not answer
 *   (`readfrom*`, register-addressed `*_mem`) and I2C reached indirectly (a name in a string, an
 *   alias) are `i2c_operation`. `scan()`, `writeto()` and `writevto()` run. `SoftI2C` stays `i2c`
 *   (a bit-banged bus is not decodable at the 1 ms input tick). Without the capability, `I2C` is
 *   `i2c` as before.
 *
 * Tokens are matched in the program with comments removed and string literals KEPT (so
 * `getattr(machine, "reset")` is refused too). A name in a docstring may therefore refuse a
 * program that does not call it: an explicit, explained refusal, never a wrong simulation.
 * Sprint 28 (L7): the `machine` checks above hold only if every use of the machine module is a
 * written attribute (`machine.Name`) the rules can read. So `dynamic_access` refuses, fail closed:
 * the module object used any other way (`m = machine`, `f(machine)`, `[machine]`, a computed
 * `getattr(machine, ...)`), a name looked up at run time anywhere in the program (`getattr`,
 * `setattr`, `delattr`, `hasattr` with a name not written as a string; `vars()`, `globals()`,
 * `locals()`, `__dict__`, `__getattribute__`, `exec`, `eval`, `compile`, `sys.modules`). The
 * machine module re-exported by a project file (`from hw import mc`, `from hw import *`,
 * `hw.mc`) is checked like `machine` itself (`projectMachineAliases`). Static code is unchanged.
 */
import { I2C_PART_MAX_SCL_HZ } from '@tbi-lab/engine';
import { MICROPYTHON_RESERVED_MODULES, programInputReads } from '@tbi-lab/domain';
import type { FeatureReport } from './protocol.js';
import { INPUT_CAPABLE_GPIOS } from './features.js';

/** Version of this analysis; part of the MicroPython profile hash (cache key). */
// Sprint 29: serial input (input(), sys.stdin) refused (7). MicroPython expansion: machine.time_pulse_us
// allowed (8), validated against the HC-SR04 model across its range (mpy-distance.runtime.test.ts);
// the firmware's dht module allowed (9), validated against the DHT22 model (mpy-dht.runtime.test.ts).
export const PY_FEATURES_ANALYZER = 9;

/**
 * Sprint 24 (M3): the fastest I2C clock a program may select: the lowest rated SCL of the I2C parts
 * the simulator models (the PCF8574 backpack: 100 kHz, NXP data sheet p.1), whatever the circuit.
 */
export const I2C_MAX_FREQ_HZ = Math.min(...Object.values(I2C_PART_MAX_SCL_HZ));
/** The bus the simulator verified on the runtime (Sprint 12 T-R3-1: Wire on I2C0, pads 21/22). */
export const I2C_BUS = { id: 0, scl: 22, sda: 21 } as const;
/** Bus operations no modelled part answers (reads; register-addressed transfers). */
const I2C_REFUSED_METHODS = [
  'readfrom',
  'readfrom_into',
  'readfrom_mem',
  'readfrom_mem_into',
  'writeto_mem',
];

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
  // MicroPython expansion phase 2: the firmware's own DHT11/DHT22 driver (validated on real QEMU
  // against the DHT22 model, mpy-dht.runtime.test.ts).
  'dht',
]);

/** `machine` names that run as on the board (or are refused at the access by Runtime v4). */
const ALLOWED_MACHINE = new Set(['Pin', 'PWM', 'ADC', 'Signal', 'idle', 'freq', 'time_pulse_us']);

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

/**
 * Sprint 24 (review H1, M1): one statement per line, so the line-anchored rules see every
 * statement: a backslash line continuation is joined, and a `;` outside strings and brackets
 * starts a new line (`import os; import socket`, `from machine import I2C; I2C(...)`).
 */
export function logicalLines(code: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"' || c === "'") {
      const triple = code.startsWith(c.repeat(3), i);
      const end = triple ? c.repeat(3) : c;
      let j = i + end.length;
      while (j < code.length && !code.startsWith(end, j)) {
        if (code[j] === '\\') j++;
        else if (!triple && code[j] === '\n') break;
        j++;
      }
      j = Math.min(code.length, j + end.length);
      out += code.slice(i, j);
      i = j - 1;
      continue;
    }
    if (c === '\\' && code[i + 1] === '\n') {
      out += ' ';
      i++;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    out += c === ';' && depth === 0 ? '\n' : c;
  }
  return out;
}

/** The text between the parenthesis at `open` and its partner (strings skipped); null: unclosed. */
function callArgs(code: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"' || c === "'") {
      const triple = code.startsWith(c.repeat(3), i);
      const end = triple ? c.repeat(3) : c;
      i += end.length;
      while (i < code.length && !code.startsWith(end, i)) i += code[i] === '\\' ? 2 : 1;
      i += end.length - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return null;
}

/** Top-level comma-separated arguments. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      out.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = args.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/** A Python integer literal (decimal or hex, with `_` separators), else null. */
function intLiteral(text: string): number | null {
  const t = text.trim();
  if (/^[1-9][\d_]*$|^0$/.test(t)) return Number(t.replace(/_/g, ''));
  if (/^0[xX][\da-fA-F_]+$/.test(t)) return Number.parseInt(t.slice(2).replace(/_/g, ''), 16);
  return null;
}

/** A pin given as a literal: `22`, `Pin(22)` or `machine.Pin(22)`. */
function pinLiteral(text: string): number | null {
  const m = /^(?:(?:\w+\s*\.\s*)?Pin\s*\(\s*([^()]*?)\s*\)|([^()]+))$/.exec(text.trim());
  return m ? intLiteral(m[1] ?? m[2]!) : null;
}

/** The refusals of one `I2C(...)` constructor call (empty: the verified shape). */
function i2cCallRefusals(args: string): string[] {
  const out = new Set<string>();
  const positional: string[] = [];
  const kw = new Map<string, string>();
  for (const a of splitArgs(args)) {
    const m = /^(\w+)\s*=(?!=)\s*([\s\S]*)$/.exec(a);
    if (m) kw.set(m[1]!, m[2]!);
    else positional.push(a);
  }
  const id = kw.get('id') ?? positional[0];
  if (id === undefined || intLiteral(id) !== I2C_BUS.id) out.add('i2c_bus');
  if (positional.length > (kw.has('id') ? 0 : 1) || positional.some((a) => a.startsWith('*')))
    out.add('i2c_option');
  for (const k of kw.keys()) if (!['id', 'scl', 'sda', 'freq'].includes(k)) out.add('i2c_option');
  const scl = kw.get('scl');
  const sda = kw.get('sda');
  if (
    scl === undefined ||
    sda === undefined ||
    pinLiteral(scl) !== I2C_BUS.scl ||
    pinLiteral(sda) !== I2C_BUS.sda
  )
    out.add('i2c_pins');
  const freq = kw.get('freq');
  const hz = freq === undefined ? null : intLiteral(freq);
  if (hz === null || hz <= 0 || hz > I2C_MAX_FREQ_HZ) out.add('i2c_frequency');
  return [...out];
}

/**
 * Sprint 24 (M3): hardware I2C, allowed only in the verified shape (see the header). `names` are
 * the program's names for machine.I2C (`I2C`, an `as` alias, `<machine alias>.I2C`).
 */
function analyzeI2c(code: string, names: string[], unsupported: Set<string>): boolean {
  // Lines that only import do not use the name, nor does text inside a string literal (a name
  // passed as a string is refused separately); blanked, offsets kept.
  const body = code
    .replace(
      /("""|'''|"|')(?:\\.|(?!\1)[\s\S])*?\1/g,
      (str, q: string) => q + ' '.repeat(str.length - 2 * q.length) + q,
    )
    .replace(/^[ \t]*from[ \t]+[\w.]+[ \t]+import[ \t]*\([^)]*\)/gm, (l) =>
      l.replace(/[^\n]/g, ' '),
    )
    .replace(/^[ \t]*(?:from[ \t]+[\w.]+[ \t]+)?import[ \t][^\n]*/gm, (l) => ' '.repeat(l.length));
  let used = false;
  /** Offsets of the `I2C` tokens a known name reached (every other one is refused below). */
  const checked = new Set<number>();
  for (const name of names) {
    const dotted = name.includes('.');
    const pattern = `(?<![\\w.])${dotted ? name.replace('.', '\\s*\\.\\s*') : name}`;
    for (const m of body.matchAll(new RegExp(`${pattern}\\b(\\s*\\()?`, 'g'))) {
      used = true;
      checked.add(m.index + m[0].replace(/\s*\($/, '').length - 3);
      if (!m[1]) {
        // Referenced without being called here (an alias, a subclass): not analysable.
        unsupported.add('i2c_operation');
        continue;
      }
      const args = callArgs(body, m.index + m[0].length - 1);
      if (args === null) unsupported.add('i2c_bus');
      else for (const r of i2cCallRefusals(args)) unsupported.add(r);
    }
  }
  // Review H1: an `I2C` no known name accounts for (an import the rules did not see, a name
  // spelled another way) is not analysable: refused, never allowed unchecked.
  for (const m of body.matchAll(/(?<!\w)I2C\b/g))
    if (!checked.has(m.index)) {
      used = true;
      unsupported.add('i2c_operation');
    }
  if (!used) return false;
  // Review M2: with I2C in the program, attribute names built at run time (exec, eval, compile,
  // getattr with a computed name, the attribute dictionaries) could reach a refused operation.
  if (/(?<![\w.])(?:exec|eval|compile)\s*\(|__dict__|__getattribute__|\bsetattr\s*\(/.test(body))
    unsupported.add('i2c_operation');
  for (const m of code.matchAll(/(?<![\w.])getattr\s*\(/g)) {
    const name = splitArgs(callArgs(code, m.index + m[0].length - 1) ?? '')[1];
    if (name === undefined || !/^(["'])\w+\1$/.test(name)) unsupported.add('i2c_operation');
  }
  for (const method of I2C_REFUSED_METHODS)
    if (new RegExp(`\\.\\s*${method}\\b|["']${method}["']`).test(code))
      unsupported.add('i2c_operation');
  // Re-configuration at run time: an `.init(...)` with a clock is checked like the constructor's.
  for (const m of code.matchAll(/\.\s*init\s*\(/g)) {
    const args = callArgs(code, m.index + m[0].length - 1) ?? '';
    // Review L2: re-pinning at run time must keep the verified pins.
    for (const a of splitArgs(args)) {
      const kw = /^(scl|sda)\s*=(?!=)\s*([\s\S]*)$/.exec(a);
      if (kw && pinLiteral(kw[2]!) !== I2C_BUS[kw[1] as 'scl' | 'sda']) unsupported.add('i2c_pins');
    }
    const freq = splitArgs(args)
      .map((a) => /^freq\s*=(?!=)\s*([\s\S]*)$/.exec(a)?.[1])
      .find((x) => x !== undefined);
    if (freq === undefined) continue;
    const hz = intLiteral(freq);
    if (hz === null || hz <= 0 || hz > I2C_MAX_FREQ_HZ) unsupported.add('i2c_frequency');
  }
  return true;
}

/**
 * Sprint 28 (L7): the names a file binds to the machine module object (`import machine` ->
 * `machine`, `import machine as m` -> `m`). The provider passes every file's (and every managed
 * library module's) names to each file's analysis, so a re-export across files is still seen.
 */
export function machineModuleAliases(source: string): string[] {
  const code = logicalLines(pythonCodeOnly(source));
  const out = new Set<string>();
  for (const m of code.matchAll(/^[ \t]*import[ \t]+([^\n;]+)/gm))
    for (const part of m[1]!.split(',')) {
      const [mod, alias] = part.trim().split(/\s+as\s+/) as [string, string | undefined];
      if (mod === 'machine') out.add(alias ?? 'machine');
    }
  return [...out];
}

/** String literal contents blanked (offsets kept): text in strings is never code. */
const blankStrings = (code: string) =>
  code.replace(
    /("""|'''|"|')(?:\\.|(?!\1)[\s\S])*?\1/g,
    (str, q: string) => q + ' '.repeat(str.length - 2 * q.length) + q,
  );

/** A regular expression source for a (possibly dotted) name, spaces allowed around dots. */
const nameSource = (name: string) => name.split('.').join('\\s*\\.\\s*');

/**
 * Sprint 28 (L7): run-time name lookups, and the machine module object used other than through a
 * written attribute. Either could reach a refused machine facility the rules cannot see.
 */
function dynamicAccess(code: string, aliases: readonly string[]): boolean {
  const body = blankStrings(code);
  // Lookups by a computed name anywhere in the program.
  if (
    /(?<![\w.])(?:exec|eval|compile|vars|globals|locals)\s*\(|__dict__|__getattribute__|\b(?:u?sys)\s*\.\s*modules\b|^[ \t]*from[ \t]+u?sys[ \t]+import[^\n]*\bmodules\b/m.test(
      body,
    )
  )
    return true;
  for (const m of body.matchAll(/(?<![\w.])(getattr|setattr|delattr|hasattr)\s*\(/g)) {
    const name = splitArgs(callArgs(code, m.index + m[0].length - 1) ?? '')[1];
    if (name === undefined || !/^(["'])\w+\1$/.test(name)) return true;
  }
  // The module object itself: every use must be `<alias>.<name>` (or getattr with a written
  // name). Import lines bind it; they do not use it.
  const uses = body
    .replace(/^[ \t]*from[ \t]+[\w.]+[ \t]+import[ \t]*\([^)]*\)/gm, (l) =>
      l.replace(/[^\n]/g, ' '),
    )
    .replace(/^[ \t]*(?:from[ \t]+[\w.]+[ \t]+)?import[ \t][^\n]*/gm, (l) => ' '.repeat(l.length));
  for (const alias of aliases)
    for (const m of uses.matchAll(
      new RegExp(`(?<![\\w.])${nameSource(alias)}\\b(?!\\s*\\.\\s*\\w)`, 'g'),
    )) {
      const before = uses.slice(0, m.index);
      const after = code.slice(m.index + m[0].length);
      if (/getattr\s*\(\s*$/.test(before) && /^\s*,\s*(["'])\w+\1\s*[,)]/.test(after)) continue;
      return true;
    }
  return false;
}

export function analyzeMicroPython(
  source: string,
  /** Bridge capabilities of the runtime tickets are issued for (Sprint 24: `i2c`). */
  capabilities: readonly string[] = [],
  /**
   * Sprint 26: modules the program's own file system provides: the project's further files
   * (`helpers`, `pkg`, `pkg.mod`) and the pinned managed libraries' modules. Importing them is
   * allowed (their own code is the program's, analysed with it, or a vetted library's).
   */
  localModules: readonly string[] = [],
  /**
   * Sprint 28 (L7): names other files of the program (and its managed libraries) bind to the
   * machine module (machineModuleAliases). `machine` is always among them.
   */
  projectMachineAliases: readonly string[] = [],
): FeatureReport {
  // Review H1: a name the firmware already has (built in or frozen) is never the project's.
  const local = new Set(
    localModules.filter((m) => !MICROPYTHON_RESERVED_MODULES.has(m.split('.')[0]!)),
  );
  const allowed = (mod: string) =>
    local.has(mod) || (!mod.includes('.') && ALLOWED_MODULES.has(mod));
  const code = logicalLines(pythonCodeOnly(source));
  const i2cRuntime = capabilities.includes('i2c');
  /** Local names bound to machine.I2C (`from machine import I2C [as X]`). */
  const i2cLocal = new Set<string>();
  const unsupported = new Set<string>();
  const projectAliases = new Set(['machine', ...projectMachineAliases]);
  let restart = false;
  let pull = false;
  const machineNames = new Set<string>();
  const machineAliases = new Set<string>();
  let machineStar = false;

  const refuseMachine = (name: string) => {
    if (ALLOWED_MACHINE.has(name)) return;
    if (name === 'I2C' && i2cRuntime) return; // analysed below (analyzeI2c)
    const f = MACHINE_FACILITY[name] ?? `library:machine.${name}`;
    if (f === 'restart') restart = true;
    else unsupported.add(f);
  };

  // import a, b.c as d
  for (const m of code.matchAll(/^[ \t]*import[ \t]+([^\n;]+)/gm))
    for (const part of m[1]!.split(',')) {
      const [mod, alias] = part.trim().split(/\s+as\s+/) as [string, string | undefined];
      if (!allowed(mod)) unsupported.add(`library:${mod}`);
      if (mod === 'machine') machineAliases.add(alias ?? 'machine');
      // Sprint 28 (L7): `import hw` then `hw.mc.reset()` (mc: hw's machine module).
      else if (local.has(mod))
        for (const a of projectAliases) machineAliases.add(`${alias ?? mod}.${a}`);
    }
  // from m import a, b as c   /   from m import *
  for (const m of code.matchAll(
    /^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n;]+)/gm,
  )) {
    const mod = m[1]!;
    // A relative import inside one of the project's packages names the project's own module.
    const relative = mod.startsWith('.') && [...local].some((l) => l.includes('.'));
    if (!relative && !allowed(mod)) {
      unsupported.add(`library:${mod}`);
      continue;
    }
    for (const part of m[2]!.replace(/[()\\]/g, ' ').split(',')) {
      const [name, alias] = part.trim().split(/\s+as\s+/) as [string, string | undefined];
      if (mod !== 'machine') {
        // Sprint 27 (review L1): `I2C` from the project's own module (a re-export of
        // machine.I2C, under any name) is analysed call by call like machine's own; the
        // defining module is analysed on its own.
        if (name === 'I2C') i2cLocal.add(alias ?? 'I2C');
        // Sprint 28 (L7): the machine module re-exported by a project module is machine.
        if (name === '*') for (const a of projectAliases) machineAliases.add(a);
        else if (name && projectAliases.has(name)) machineAliases.add(alias ?? name);
        continue;
      }
      if (name === '*') machineStar = true;
      else if (name) machineNames.add(name);
      if (name === 'I2C') i2cLocal.add(alias ?? 'I2C');
    }
  }
  // __import__ / importlib cannot be checked by name.
  if (/\b(__import__|importlib)\b/.test(code)) unsupported.add('library:__import__');

  for (const name of machineNames) refuseMachine(name);
  for (const alias of machineAliases)
    for (const m of code.matchAll(
      new RegExp(`(?<![\\w.])${nameSource(alias)}\\s*\\.\\s*(\\w+)`, 'g'),
    ))
      refuseMachine(m[1]!);
  // Sprint 28 (L7): everything above reads written names only.
  if (dynamicAccess(code, [...machineAliases])) unsupported.add('dynamic_access');
  // Sprint 29 (Workstream A): a session has no serial input path (the serial monitor is output
  // only), so input() or a read of sys.stdin would wait forever, silently: refused by name.
  // A program's own function named input (def input(...)) is not the built-in.
  const codeNoStrings = blankStrings(code).replace(/\bdef\s+input\b/g, 'def _');
  if (
    /(?<![\w.])input\s*\(/.test(codeNoStrings) ||
    /(?<![\w.])u?sys\s*\.\s*stdin\b/.test(codeNoStrings) ||
    /^[ \t]*from[ \t]+u?sys[ \t]+import[^\n]*\bstdin\b/m.test(codeNoStrings)
  )
    unsupported.add('serial_input');
  // A name passed as a string (getattr(machine, "reset")) or used after `from machine import *`.
  const quoted = new Set([...code.matchAll(/["'](\w+)["']/g)].map((m) => m[1]!));
  for (const name of MACHINE_REFUSED_NAMES)
    if (quoted.has(name) || (machineStar && new RegExp(`(?<![.\\w])${name}\\b`).test(code)))
      refuseMachine(name);

  // Sprint 24 (M3): hardware I2C on a runtime that provides it.
  let requires: string[] = [];
  if (i2cRuntime) {
    if (machineStar) i2cLocal.add('I2C');
    const names = [...i2cLocal, ...[...machineAliases].map((a) => `${a}.I2C`)];
    // A name built at run time (getattr(machine, "I2C")) cannot be checked.
    const indirect = quoted.has('I2C');
    if (indirect) unsupported.add('i2c_operation');
    if (analyzeI2c(code, names, unsupported) || indirect) requires = ['i2c'];
  }

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

  // Sprint 25 (Runtime v5): `Pin.irq` edge interrupts are delivered (`gpio-irq`; a level or wake
  // trigger is still refused by the runtime at the write), and the pins the program may read are
  // watched (`input-read`).
  if (capabilities.includes('gpio-irq') && /\.\s*irq\s*\(/.test(code)) requires.push('gpio-irq');
  if (requires.includes('i2c') && capabilities.includes('i2c-clock')) requires.push('i2c-clock');
  let inputReads: FeatureReport['inputReads'];
  if (capabilities.includes('input-read')) {
    inputReads = programInputReads({
      language: 'micropython',
      profile: '',
      fileName: 'main.py',
      text: source,
    });
    requires.push('input-read');
  }
  return {
    // The pins cannot be told reliably from Python: every input-capable pin is declared.
    internalPull: pull ? INPUT_CAPABLE_GPIOS : [],
    gpioInterrupt: [],
    restart,
    unsupported: [...unsupported].sort(),
    ...(requires.length ? { requires: requires.sort() } : {}),
    ...(inputReads ? { inputReads } : {}),
  };
}
