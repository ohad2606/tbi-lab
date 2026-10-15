/**
 * Sprint 13 H1: the "what runs on the ESP32" registry is well-formed and derived from the
 * catalog (parts are never listed by hand).
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  CATALOG_ORDER,
  FIRMWARE_FACILITIES,
  SESSION_LIMITS,
  TIMING_CONTRACT,
  facilityForFeature,
  partCapabilities,
} from '../src/index.js';

describe('capabilities registry', () => {
  it('facilities: unique ids, refused ones are unsupported, gated ones name their capability', () => {
    const ids = FIRMWARE_FACILITIES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of FIRMWARE_FACILITIES) {
      if (f.refusedByBuild) expect(f.status).toBe('unsupported');
      if (f.status === 'unsupported') expect(f.refusedByBuild).toBe(true);
    }
    expect(FIRMWARE_FACILITIES.find((f) => f.id === 'i2c')?.requiresRuntime).toBe('i2c');
    expect(facilityForFeature('library:DHT')?.id).toBe('library');
    // R4: PWM runs on a runtime announcing `pwm` (Runtime v3), with refusals (limited); the LEDC
    // hardware fade and output inversion stay refused everywhere.
    expect(facilityForFeature('pwm')).toMatchObject({ status: 'limited', requiresRuntime: 'pwm' });
    expect(facilityForFeature('pwm_advanced')?.status).toBe('unsupported');
    expect(facilityForFeature('nonsense')).toBeUndefined();
  });

  it('parts: every catalog part except the board, status from the catalog flags', () => {
    const parts = partCapabilities();
    expect(parts.map((p) => p.type)).toEqual(
      CATALOG_ORDER.filter((t) => t !== 'board.esp32_devkitc_wroom32'),
    );
    for (const p of parts) {
      const def = CATALOG[p.type];
      if (def.mcuRuntime === false) {
        expect(p.status).toBe('unsupported');
        expect(p.reason).toBe(
          def.mcuRuntimeReason === 'time_dependent' ? 'part_time_dependent' : 'part_needs_runtime',
        );
      } else expect(p).toEqual({ type: p.type, status: 'supported' });
    }
    // The two refusals the product shows today.
    expect(parts.find((p) => p.type === 'component.capacitor')?.reason).toBe('part_time_dependent');
    expect(parts.find((p) => p.type === 'display.led_matrix_8x8')?.reason).toBe(
      'part_needs_runtime',
    );
  });

  it('timing contract and session limits are non-empty and unique', () => {
    for (const list of [TIMING_CONTRACT, SESSION_LIMITS]) {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
    }
  });
});
