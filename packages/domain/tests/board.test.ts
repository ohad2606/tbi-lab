/**
 * Runtime R1: the ESP32-DevKitC (WROOM-32) capability map is complete, explicit and consistent
 * with the approved rules (R1-A6).
 */
import { describe, expect, it } from 'vitest';
import { ESP32_DEVKITC_WROOM32 as MAP, boardPinForGpio } from '../src/index.js';

const gpio = (n: number) => boardPinForGpio(MAP, n)!;

describe('board.esp32_devkitc_wroom32', () => {
  it('lists all 38 header pins, J2 then J3, 19 each, in order, every one explicitly', () => {
    expect(MAP.pins).toHaveLength(38);
    for (const h of ['J2', 'J3'] as const) {
      const rows = MAP.pins.filter((p) => p.header === h);
      expect(rows.map((p) => p.position)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
    }
    for (const p of MAP.pins) {
      expect(p.exposed).toBe(true);
      for (const k of [
        'headerLabel',
        'digitalInput',
        'digitalOutput',
        'internalPull',
        'role',
        'strapping',
        'simulatorSupport',
      ] as const) {
        expect(p[k], `${p.header}.${p.position} ${k}`).toBeDefined();
      }
      if (p.simulatorSupport !== 'digital-io' || p.strapping) {
        expect(p.reason, `${p.headerLabel} needs a reason`).toBeTruthy();
      }
    }
  });

  it('exposes each GPIO once; GPIO20, 24, 28-31, 37 and 38 are not on the header', () => {
    const gpios = MAP.pins.map((p) => p.gpio).filter((g): g is number => g !== null);
    expect(new Set(gpios).size).toBe(gpios.length);
    expect(gpios.sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27,
      32, 33, 34, 35, 36, 39,
    ]);
  });

  it('GPIO6-11 are flash-connected and not user GPIO', () => {
    for (const n of [6, 7, 8, 9, 10, 11]) {
      expect(gpio(n)).toMatchObject({
        role: 'flash',
        digitalInput: false,
        digitalOutput: false,
        simulatorSupport: 'none',
      });
    }
  });

  it('GPIO34/35/36/39 are input-only with no internal pulls', () => {
    for (const n of [34, 35, 36, 39]) {
      expect(gpio(n)).toMatchObject({
        digitalInput: true,
        digitalOutput: false,
        internalPull: 'none',
        simulatorSupport: 'digital-input',
      });
    }
  });

  it('GPIO32/33 are output-capable and fully supported by the simulator', () => {
    for (const n of [32, 33]) {
      expect(gpio(n)).toMatchObject({ digitalOutput: true, simulatorSupport: 'digital-io' });
      expect(gpio(n).reason).toBeUndefined();
    }
  });

  it('GPIO0/2/5/12/15 are strapping pins; GPIO1/3 are the console UART', () => {
    expect(
      MAP.pins
        .filter((p) => p.strapping)
        .map((p) => p.gpio)
        .sort((a, b) => a! - b!),
    ).toEqual([0, 2, 5, 12, 15]);
    for (const n of [1, 3])
      expect(gpio(n)).toMatchObject({ role: 'console-uart', simulatorSupport: 'none' });
  });

  it('GPIO4/16/27 are ordinary supported pins (no feasibility-runtime masking)', () => {
    for (const n of [4, 16, 27]) {
      expect(gpio(n)).toMatchObject({
        role: 'gpio',
        digitalInput: true,
        digitalOutput: true,
        strapping: false,
        simulatorSupport: 'digital-io',
      });
      expect(gpio(n).reason).toBeUndefined();
    }
  });

  it('power, ground and EN carry no GPIO and no simulator support', () => {
    for (const p of MAP.pins.filter((x) => x.gpio === null)) {
      expect(['power', 'ground', 'enable']).toContain(p.role);
      expect(p.simulatorSupport).toBe('none');
    }
    expect(MAP.pins.filter((p) => p.role === 'ground')).toHaveLength(3);
  });

  it('records its sources and the runtime-wide limitations', () => {
    expect(MAP.sources.join('\n')).toMatch(/DevKitC V4 User Guide/);
    expect(MAP.sources.join('\n')).toMatch(/Datasheet v5\.3/);
    expect(MAP.simulatorLimitations.join('\n')).toMatch(/pull-up\/pull-down/);
  });
});
