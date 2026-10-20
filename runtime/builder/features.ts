/**
 * Firmware feature analysis for Arduino/C++ on the Classic ESP32 (Sprint 7). Conservative by
 * design: it reports what the simulator does NOT model so the product can refuse a Run with an
 * explicit reason instead of silently running dead behaviour. Two signals:
 *
 * - symbols linked into the ELF (sections are garbage-collected, so an API that is linked is
 *   used): interrupts, Wi-Fi, Bluetooth, ADC, PWM/LEDC, DAC, touch, deep sleep;
 * - tokens in the sketch source: internal pulls and restart requests. (`esp_restart` is always
 *   linked by the core's panic handler, so a symbol cannot tell whether the sketch calls it.)
 *   Sprint 18 (F-17C-1): CPU clock changes likewise (the core's main.cpp calls
 *   `setCpuFrequencyMhz(F_CPU / 1000000)` at boot, so the symbol is always linked).
 *
 * Static analysis cannot prove absence through macros or wrappers; runtime diagnostics (for
 * example `guest_reset`) remain the backstop. Pins are taken from literal arguments when every
 * use is literal, otherwise every input-capable pin is declared.
 */
import { ESP32_DEVKITC_WROOM32 } from '@tbi-lab/domain';
import type { FeatureReport } from './protocol.js';

/**
 * Version of this analysis. Raised whenever a rule is added or changed, so builds analysed by an
 * older rule set are built (and analysed) again instead of being reused from the cache with a
 * report that misses the new rule (Sprint 18: `cpu_frequency`).
 */
export const FEATURES_ANALYZER = 2;

/** GPIOs the simulator can read (digital I/O and input-only pads). */
export const INPUT_CAPABLE_GPIOS: number[] = ESP32_DEVKITC_WROOM32.pins
  .filter((p) => p.gpio !== null && p.simulatorSupport !== 'none')
  .map((p) => p.gpio!)
  .filter((g, i, a) => a.indexOf(g) === i)
  .sort((a, b) => a - b);

/** Linked symbols that mean an unmodelled facility is used. */
const SYMBOLS: [RegExp, string][] = [
  [/^(esp_wifi_init|esp_wifi_start)$/, 'wifi'],
  [/^(esp_bt_controller_init|btStart)$/, 'bluetooth'],
  [/^(__analogRead|analogRead|adc_oneshot_read)$/, 'adc'],
  [/^(ledcAttach|ledcAttachChannel|ledcWrite|__analogWrite|analogWrite)$/, 'pwm'],
  // R4: the LEDC hardware fade (the runtime refuses duty_scale, decision R4-D4) and output
  // inversion (the GPIO-matrix OUT_INV bit is not published to the host, so an inverted output
  // would be simulated non-inverted): refused on every runtime.
  [/^(ledcFade|ledcFadeWithInterrupt|ledcFadeWithInterruptArg|ledcOutputInvert)$/, 'pwm_advanced'],
  [/^(dacWrite|__dacWrite)$/, 'dac'],
  [/^(__touchRead|touchRead)$/, 'touch'],
  [/^(esp_deep_sleep_start|esp_light_sleep_start)$/, 'sleep'],
  [/^(i2cInit|i2c_master_bus_add_device|i2c_driver_install)$/, 'i2c'],
  [/^(spiStartBus|spi_bus_initialize)$/, 'spi'],
  // Sprint 13 P4: the runtime does not report a pad's drive strength (IO_MUX FUN_DRV), so the pad
  // model assumes the reset default; a sketch that selects another strength cannot be simulated
  // faithfully. Neither the 3.3.12 core nor its I2C driver links this symbol on the classic ESP32.
  [/^gpio_set_drive_capability$/, 'drive_strength'],
];
const INTERRUPT_SYMBOLS =
  /^(attachInterrupt|__attachInterrupt|__attachInterruptFunctionalArg|gpio_isr_handler_add)$/;

/** Core libraries the simulator can run as-is; any other used library is reported. */
const SUPPORTED_LIBRARIES = new Set(['Preferences']);
const LIBRARY_FACILITY: Record<string, string> = {
  WiFi: 'wifi',
  Network: 'wifi',
  Networking: 'wifi',
  NetworkClientSecure: 'wifi',
  HTTPClient: 'wifi',
  WebServer: 'wifi',
  AsyncUDP: 'wifi',
  BLE: 'bluetooth',
  BluetoothSerial: 'bluetooth',
  Wire: 'i2c',
  SPI: 'spi',
};

/**
 * Every facility code a feature report can name (Sprint 13 H1: the product's capability panel has
 * an entry for each; `library:<Name>` is reported per library and listed as `library`).
 */
export const FEATURE_CODES: readonly string[] = [
  ...new Set([
    ...SYMBOLS.map(([, f]) => f),
    ...Object.values(LIBRARY_FACILITY),
    'interrupt',
    'internal_pull',
    'restart',
    'cpu_frequency',
    'library',
  ]),
];

/**
 * Sprint 18 (F-17C-1): a sketch that changes the CPU clock. On Runtime v2 and v3 the emulator stops
 * advancing simulated time about a second after any change (160, 80, 40 or 20 MHz alike: the next
 * FreeRTOS delay never returns), so such a sketch is refused at Build instead of running into the
 * `stalled` failure. The boot frequency, 240 MHz, is not a change (the core returns early) and is
 * accepted when every call passes the literal 240. The IDF calls below it are refused outright.
 */
function changesCpuFrequency(code: string): boolean {
  if (
    /\b(?:rtc_clk_cpu_freq_set_config(?:_fast)?|rtc_clk_cpu_freq_set_xtal|esp_pm_configure)\b/.test(
      code,
    )
  )
    return true;
  const all = code.match(/\bsetCpuFrequencyMhz\b/g)?.length ?? 0;
  const boot = code.match(/\bsetCpuFrequencyMhz\s*\(\s*240\s*\)/g)?.length ?? 0;
  return all > boot;
}

/** Strip comments and string/char literals so tokens in them do not count. */
export function codeOnly(source: string): string {
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
      // Sprint 18 (review): C++14 digit separators (1'000, 0xFF'FF) are not character literals;
      // dropped first (inside a number token, one that starts with a digit), so a call between two
      // of them is not mistaken for literal text. case'a' and u8'x' stay character literals.
      .replace(/(?<=\b\d[\dA-Fa-fxXbB']*)'(?=[\dA-Fa-f])/g, '')
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
  );
}

function literalPins(code: string, call: RegExp, any: RegExp): number[] {
  const all = code.match(any)?.length ?? 0;
  if (all === 0) return [];
  const pins = [...code.matchAll(call)].map((m) => Number(m[1]));
  // Every use literal and a GPIO number: exactly those pins; otherwise all input-capable pins.
  if (pins.length === all && pins.every((p) => Number.isInteger(p) && p >= 0 && p <= 39))
    return [...new Set(pins)].sort((a, b) => a - b);
  return INPUT_CAPABLE_GPIOS;
}

/**
 * Facilities a runtime can provide (Sprint 12, ADR-011 §5): when the runtime the build service
 * issues tickets for announces the bridge capability, the facility is no longer `unsupported` but
 * `requires`d, and its core library is allowed. The capability set comes from the provisioned
 * runtime.json, never typed by hand.
 */
const RUNTIME_FACILITIES: Record<string, { capability: string; libraries: string[] }> = {
  i2c: { capability: 'i2c', libraries: ['Wire'] },
  // R4 (patch 0009): LEDC waveforms on a runtime announcing `pwm` (Runtime v3).
  pwm: { capability: 'pwm', libraries: [] },
};

export function analyzeFeatures(input: {
  source: string;
  symbols: string[];
  libraries: string[];
  /** Bridge capabilities of the runtime tickets are issued for (absent: none). */
  capabilities?: readonly string[];
}): FeatureReport {
  const code = codeOnly(input.source);
  const syms = new Set(input.symbols);
  const unsupported = new Set<string>();
  for (const s of syms)
    for (const [re, facility] of SYMBOLS) if (re.test(s)) unsupported.add(facility);
  for (const lib of input.libraries)
    if (!SUPPORTED_LIBRARIES.has(lib)) unsupported.add(LIBRARY_FACILITY[lib] ?? `library:${lib}`);

  const internalPull = literalPins(
    code,
    /\bpinMode\s*\(\s*(\d+)\s*,\s*INPUT_PULL(?:UP|DOWN)\s*\)/g,
    /\bINPUT_PULL(?:UP|DOWN)\b|\bgpio_(?:pullup_en|pulldown_en|set_pull_mode)\b|\bGPIO_PULL(?:UP|DOWN)_ENABLE\b/g,
  );
  // Interrupt APIs are only linked when called; the pins come from literal calls if possible.
  const interruptUsed = [...syms].some((s) => INTERRUPT_SYMBOLS.test(s));
  const callPins = literalPins(
    code,
    /\battachInterrupt(?:Arg)?\s*\(\s*(?:digitalPinToInterrupt\s*\(\s*)?(\d+)\s*\)?\s*,/g,
    /\battachInterrupt(?:Arg)?\s*\(|\bgpio_isr_handler_add\s*\(/g,
  );
  const gpioInterrupt = !interruptUsed ? [] : callPins.length > 0 ? callPins : INPUT_CAPABLE_GPIOS;
  const restart = /\bESP\s*\.\s*restart\s*\(|\besp_restart\s*\(/.test(code);
  if (changesCpuFrequency(code)) unsupported.add('cpu_frequency');
  const requires = new Set<string>();
  for (const [facility, f] of Object.entries(RUNTIME_FACILITIES)) {
    if (!input.capabilities?.includes(f.capability) || !unsupported.has(facility)) continue;
    unsupported.delete(facility);
    requires.add(f.capability);
  }
  return {
    internalPull,
    gpioInterrupt,
    restart,
    unsupported: [...unsupported].sort(),
    ...(requires.size ? { requires: [...requires].sort() } : {}),
  };
}
