/** Firmware feature analysis (Sprint 7): conservative, explicit, never silent. */
import { describe, expect, it } from 'vitest';
import { analyzeFeatures, codeOnly, INPUT_CAPABLE_GPIOS } from '../features.js';

const none = { internalPull: [], gpioInterrupt: [], restart: false, unsupported: [] };

describe('analyzeFeatures', () => {
  it('plain digital I/O reports nothing unsupported (the pinned core always links esp_restart)', () => {
    const source =
      'void setup(){ pinMode(2, OUTPUT); pinMode(5, INPUT); }\nvoid loop(){ digitalWrite(2, digitalRead(5)); }';
    expect(
      analyzeFeatures({
        source,
        symbols: ['pinMode', 'digitalWrite', 'esp_restart'],
        libraries: [],
      }),
    ).toEqual(none);
  });

  it('internal pulls: literal pins when every use is literal, all input-capable pins otherwise', () => {
    expect(
      analyzeFeatures({
        source: 'pinMode(4, INPUT_PULLUP); pinMode(34, INPUT_PULLDOWN);',
        symbols: [],
        libraries: [],
      }).internalPull,
    ).toEqual([4, 34]);
    expect(
      analyzeFeatures({
        source: 'const int P = 4; pinMode(P, INPUT_PULLUP);',
        symbols: [],
        libraries: [],
      }).internalPull,
    ).toEqual(INPUT_CAPABLE_GPIOS);
    expect(
      analyzeFeatures({ source: 'gpio_pullup_en(GPIO_NUM_4);', symbols: [], libraries: [] })
        .internalPull,
    ).toEqual(INPUT_CAPABLE_GPIOS);
  });

  it('interrupts come from linked symbols; pins from literal calls', () => {
    const source = 'attachInterrupt(digitalPinToInterrupt(4), isr, FALLING);';
    expect(
      analyzeFeatures({ source, symbols: ['__attachInterrupt'], libraries: [] }).gpioInterrupt,
    ).toEqual([4]);
    expect(
      analyzeFeatures({
        source: 'attachInterrupt(pin, isr, RISING);',
        symbols: ['attachInterrupt'],
        libraries: [],
      }).gpioInterrupt,
    ).toEqual(INPUT_CAPABLE_GPIOS);
    // Mentioned only in a comment and not linked: not used.
    expect(
      analyzeFeatures({ source: '// attachInterrupt(4, isr, RISING);', symbols: [], libraries: [] })
        .gpioInterrupt,
    ).toEqual([]);
  });

  it('restart requests come from the source, not from symbols; comments and strings do not count', () => {
    expect(analyzeFeatures({ source: 'ESP.restart();', symbols: [], libraries: [] }).restart).toBe(
      true,
    );
    expect(analyzeFeatures({ source: 'esp_restart();', symbols: [], libraries: [] }).restart).toBe(
      true,
    );
    expect(
      analyzeFeatures({
        source: '/* ESP.restart(); */ Serial.println("ESP.restart()");',
        symbols: ['esp_restart'],
        libraries: [],
      }).restart,
    ).toBe(false);
  });

  it('unmodelled facilities from symbols and core libraries; Preferences is supported', () => {
    const r = analyzeFeatures({
      source: '',
      symbols: ['esp_wifi_init', 'ledcWrite', '__analogRead'],
      libraries: ['WiFi', 'Networking', 'Wire', 'Preferences', 'Mystery'],
    });
    expect(r.unsupported).toEqual(['adc', 'i2c', 'library:Mystery', 'pwm', 'wifi']);
    expect(
      analyzeFeatures({ source: '', symbols: [], libraries: ['Preferences'] }).unsupported,
    ).toEqual([]);
  });

  it('codeOnly strips comments and literals', () => {
    expect(codeOnly('a /* b */ c // d\n"e" \'f\'')).toBe('a   c  \n"" \'\'');
  });
});
