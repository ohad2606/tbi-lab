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

  // Sprint 13 P4 (PM 2026-10-12): the runtime cannot report a pad's drive strength, so a sketch
  // selecting one is refused. Evidence (3.3.12, provision path): a sketch calling it links
  // `gpio_set_drive_capability`; TbiLcd (Wire / IDF i2c_master) and the probe sketches do not.
  it('P4: explicit drive strength is refused, on every runtime; Wire alone does not trigger it', () => {
    const drive = analyzeFeatures({
      source: 'gpio_set_drive_capability(GPIO_NUM_5, GPIO_DRIVE_CAP_3);',
      symbols: ['gpio_set_drive_capability', 'pinMode'],
      libraries: [],
      capabilities: ['i2c', 'pad-func', 'sched-input'],
    });
    expect(drive.unsupported).toEqual(['drive_strength']);
    expect(
      analyzeFeatures({
        source: '',
        symbols: ['i2c_master_bus_add_device', 'gpio_set_level', 'gpio_config'],
        libraries: ['Wire'],
        capabilities: ['i2c', 'pad-func', 'sched-input'],
      }).unsupported,
    ).toEqual([]);
  });

  // Sprint 18 (F-17C-1): any CPU clock change stalls the emulator (measured on Runtime v3 with
  // setCpuFrequencyMhz 160/80/40/20: the next delay never returns; 240 runs on). The symbol is
  // always linked (the core sets F_CPU at boot), so the source decides.
  it('F-17C-1: a CPU clock change is refused from the source; the boot 240 MHz is not a change', () => {
    const f = (source: string) =>
      analyzeFeatures({ source, symbols: ['setCpuFrequencyMhz'], libraries: [] }).unsupported;
    expect(f('void setup() {}')).toEqual([]);
    expect(f('setCpuFrequencyMhz(240);')).toEqual([]);
    expect(f('setCpuFrequencyMhz( 240 ); setCpuFrequencyMhz(240);')).toEqual([]);
    for (const src of [
      'setCpuFrequencyMhz(160);',
      'setCpuFrequencyMhz(80);',
      'setCpuFrequencyMhz(40);',
      'const int MHZ = 240; setCpuFrequencyMhz(MHZ);',
      'setCpuFrequencyMhz(240); setCpuFrequencyMhz(80);',
      'bool (*f)(uint32_t) = setCpuFrequencyMhz;',
      'rtc_clk_cpu_freq_set_config(&c);',
      'rtc_clk_cpu_freq_set_config_fast(&c);',
      'rtc_clk_cpu_freq_set_xtal();',
      'esp_pm_configure(&pm);',
    ])
      expect(f(src), src).toEqual(['cpu_frequency']);
    expect(f('/* setCpuFrequencyMhz(80); */ Serial.println("setCpuFrequencyMhz(80)");')).toEqual(
      [],
    );
  });

  it('codeOnly strips comments and literals', () => {
    expect(codeOnly('a /* b */ c // d\n"e" \'f\'')).toBe('a   c  \n"" \'\'');
  });
});

describe('Sprint 12 (ADR-011 §5): facilities the runtime provides become `requires`', () => {
  const wire = {
    source: '#include <Wire.h>\nvoid setup(){ Wire.begin(21, 22); }\nvoid loop(){}',
    symbols: ['i2c_master_bus_add_device', 'setup', 'loop'],
    libraries: ['Wire'],
  };
  it('T-R3-14: Wire is unsupported without the i2c capability and required with it', () => {
    expect(analyzeFeatures(wire)).toMatchObject({ unsupported: ['i2c'] });
    expect(analyzeFeatures(wire).requires).toBeUndefined();
    expect(analyzeFeatures({ ...wire, capabilities: ['sched-input'] })).toMatchObject({
      unsupported: ['i2c'],
    });
    const v2 = analyzeFeatures({ ...wire, capabilities: ['i2c', 'pad-func', 'sched-input'] });
    expect(v2.unsupported).toEqual([]);
    expect(v2.requires).toEqual(['i2c']);
  });
  it('T-R3-15: internal pulls stay refused with Wire (PM D-4)', () => {
    const f = analyzeFeatures({
      ...wire,
      source: `${wire.source}\nvoid x(){ pinMode(4, INPUT_PULLUP); }`,
      capabilities: ['i2c', 'pad-func', 'sched-input'],
    });
    expect(f.internalPull).toEqual([4]);
    expect(f.requires).toEqual(['i2c']);
  });
  const V3 = ['i2c', 'pad-func', 'pwm', 'sched-input'];
  const pwmSketch = {
    source: 'void setup(){ ledcAttach(18, 50, 16); ledcWrite(18, 4915); }\nvoid loop(){}',
    symbols: ['ledcAttach', 'ledcWrite', 'setup', 'loop'],
    libraries: [],
  };
  it('T-R4-6: PWM is unsupported without the pwm capability and required with it', () => {
    expect(analyzeFeatures(pwmSketch)).toMatchObject({ unsupported: ['pwm'] });
    expect(
      analyzeFeatures({ ...pwmSketch, capabilities: ['i2c', 'pad-func', 'sched-input'] }),
    ).toMatchObject({ unsupported: ['pwm'] });
    const v3 = analyzeFeatures({ ...pwmSketch, capabilities: V3 });
    expect(v3.unsupported).toEqual([]);
    expect(v3.requires).toEqual(['pwm']);
    // analogWrite is the same facility.
    expect(
      analyzeFeatures({ source: '', symbols: ['__analogWrite'], libraries: [], capabilities: V3 }),
    ).toMatchObject({ unsupported: [], requires: ['pwm'] });
    // With Wire too, both are required.
    expect(
      analyzeFeatures({
        ...pwmSketch,
        symbols: [...pwmSketch.symbols, 'i2c_master_bus_add_device'],
        libraries: ['Wire'],
        capabilities: V3,
      }).requires,
    ).toEqual(['i2c', 'pwm']);
  });
  it('T-R4-6: the LEDC hardware fade and output inversion are refused on every runtime', () => {
    for (const sym of [
      'ledcFade',
      'ledcFadeWithInterrupt',
      'ledcFadeWithInterruptArg',
      'ledcOutputInvert',
    ]) {
      const f = analyzeFeatures({
        ...pwmSketch,
        symbols: [...pwmSketch.symbols, sym],
        capabilities: V3,
      });
      expect(f.unsupported, sym).toEqual(['pwm_advanced']);
      expect(f.requires, sym).toEqual(['pwm']);
    }
  });
  it('other facilities are unaffected by the capabilities (SPI stays unsupported)', () => {
    const f = analyzeFeatures({
      source: '',
      symbols: ['spi_bus_initialize', 'i2cInit'],
      libraries: ['SPI', 'Wire'],
      capabilities: ['i2c', 'pad-func', 'sched-input'],
    });
    expect(f.unsupported).toEqual(['spi']);
    expect(f.requires).toEqual(['i2c']);
  });
});

describe('Sprint 13 H1: every reportable facility has a capability-panel entry', () => {
  it('each feature code maps to a registry facility that is refused or runtime-gated', async () => {
    const { FEATURE_CODES } = await import('../features.js');
    const { facilityForFeature } = await import('@tbi-lab/domain');
    for (const code of FEATURE_CODES) {
      const f = facilityForFeature(code);
      expect(f, code).toBeDefined();
      expect(f!.refusedByBuild || f!.requiresRuntime !== undefined, code).toBe(true);
    }
  });

  it('no stale entries: every refused registry facility is a code the build service can report', async () => {
    const { FEATURE_CODES } = await import('../features.js');
    const { FIRMWARE_FACILITIES } = await import('@tbi-lab/domain');
    for (const f of FIRMWARE_FACILITIES.filter((x) => x.refusedByBuild))
      expect(FEATURE_CODES, f.id).toContain(f.id);
  });
});
