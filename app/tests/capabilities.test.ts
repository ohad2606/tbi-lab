/**
 * Sprint 13 H1: every entry of the "what runs on the ESP32" panel has its text in every locale,
 * and every refusal the panel explains maps to a real product message.
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  CATALOG_ORDER,
  FIRMWARE_FACILITIES,
  MODEL_LIMITATIONS,
  SESSION_LIMITS,
  TIMING_CONTRACT,
  partCapabilities,
} from '@tbi-lab/domain';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import { sectionForFailure } from '../src/ui/Capabilities.js';

const keys = [
  ...FIRMWARE_FACILITIES.flatMap((f) => [
    `capabilities.facility.${f.id}.name`,
    `capabilities.facility.${f.id}.body`,
  ]),
  ...TIMING_CONTRACT.map((id) => `capabilities.timing.${id}`),
  ...SESSION_LIMITS.map((id) => `capabilities.limit.${id}`),
  ...partCapabilities().flatMap((p) => [
    CATALOG[p.type].nameKey,
    ...(p.reason ? [`palette.unavailable.${p.reason}`] : []),
  ]),
];

describe('capability panel texts', () => {
  it('every generated key exists in English and Hebrew, non-empty', () => {
    for (const k of keys) {
      expect((en as Record<string, string>)[k], `en ${k}`).toBeTruthy();
      expect((he as Record<string, string>)[k], `he ${k}`).toBeTruthy();
    }
  });

  it('every session limit is a real runtime refusal code with its own error message', () => {
    for (const code of SESSION_LIMITS) {
      expect((en as Record<string, string>)[`sim.error.runtime.${code}`], code).toBeTruthy();
      expect(sectionForFailure(code)).toBe('limits');
    }
  });

  it('feature and part refusals link to their sections; other failures do not', () => {
    expect(sectionForFailure('mcu_unsupported_features')).toBe('firmware');
    expect(sectionForFailure('mcu_component_time_dependent')).toBe('parts');
    expect(sectionForFailure('unsupported_component')).toBe('parts');
    expect(sectionForFailure('no_ground')).toBeNull();
    expect(sectionForFailure('runtime_crashed')).toBeNull();
  });
});

describe('model limitations (H2)', () => {
  it('every part except the ground symbol documents its limitations, in English and Hebrew', () => {
    for (const type of CATALOG_ORDER) {
      const ids = MODEL_LIMITATIONS[type] ?? [];
      if (type === 'component.ground') continue;
      expect(ids.length, type).toBeGreaterThan(0);
      for (const id of ids) {
        expect((en as Record<string, string>)[`limitation.${id}`], `en ${id}`).toBeTruthy();
        expect((he as Record<string, string>)[`limitation.${id}`], `he ${id}`).toBeTruthy();
      }
    }
  });
});
