/**
 * Firmware feature analysis for Arduino/C++ on the Classic ESP32 (Sprint 7). Conservative by
 * design: it reports what the simulator does NOT model so the product can refuse a Run with an
 * explicit reason instead of silently running dead behaviour. Two signals:
 *
 * - symbols linked into the ELF (sections are garbage-collected, so an API that is linked is
 *   used): interrupts, Wi-Fi, Bluetooth, ADC, PWM/LEDC, DAC, touch, deep sleep;
 * - tokens in the sketch source: internal pulls and restart requests. (`esp_restart` is always
 *   linked by the core's panic handler, so a symbol cannot tell whether the sketch calls it.)
 *
 * Static analysis cannot prove absence through macros or wrappers; runtime diagnostics (for
 * example `guest_reset`) remain the backstop. Pins are taken from literal arguments when every
 * use is literal, otherwise every input-capable pin is declared.
 */
import { ESP32_DEVKITC_WROOM32 } from '@tbi-lab/domain';
import type { FeatureReport } from './protocol.js';

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
  [/^(dacWrite|__dacWrite)$/, 'dac'],
  [/^(__touchRead|touchRead)$/, 'touch'],
  [/^(esp_deep_sleep_start|esp_light_sleep_start)$/, 'sleep'],
  [/^(i2cInit|i2c_master_bus_add_device|i2c_driver_install)$/, 'i2c'],
  [/^(spiStartBus|spi_bus_initialize)$/, 'spi'],
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

/** Strip comments and string/char literals so tokens in them do not count. */
export function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
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

export function analyzeFeatures(input: {
  source: string;
  symbols: string[];
  libraries: string[];
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
  return {
    internalPull,
    gpioInterrupt,
    restart,
    unsupported: [...unsupported].sort(),
  };
}
