/**
 * What runs on the Classic ESP32 in TBI Lab V1 (Sprint 13 H1): one registry the product's
 * "supported / unsupported" panel is generated from, so the panel cannot drift from what the
 * product actually does.
 *
 * - Firmware facilities: every facility the build service can name in a feature report
 *   (`runtime/builder/features.ts`; a runtime test keeps the two in sync), plus the facilities
 *   that run. A facility gated by a runtime capability (I2C) is supported only on a runtime that
 *   announces it (Runtime v2).
 * - Parts: derived from the catalog (`mcuRuntime`, `mcuRuntimeReason`), never listed by hand.
 * - Timing: the V1 timing contract (docs/runtime/RUNTIME-V2-LIMITATIONS.md), in product words.
 * - Session limits: the runtime refusal codes a user can meet while the product works as designed.
 *
 * Identifiers only; all text is in the message catalogs (`capabilities.*`, `build.feature.*`).
 */
import { CATALOG, CATALOG_ORDER } from './catalog.js';
import type { ComponentTypeId } from './schema.js';

export type CapabilityStatus = 'supported' | 'limited' | 'unsupported';

export interface FirmwareFacility {
  /** The id; for refused facilities, the build service's feature code (`build.feature.<id>`). */
  id: string;
  status: CapabilityStatus;
  /** The build service refuses a Run with this facility (it appears in feature reports). */
  refusedByBuild: boolean;
  /** Supported only on a runtime announcing this bridge capability. */
  requiresRuntime?: string;
}

/** In panel order: what runs first, then limits, then what is refused. */
export const FIRMWARE_FACILITIES: readonly FirmwareFacility[] = [
  { id: 'digital_io', status: 'supported', refusedByBuild: false },
  { id: 'serial', status: 'supported', refusedByBuild: false },
  { id: 'preferences', status: 'supported', refusedByBuild: false },
  { id: 'i2c', status: 'supported', refusedByBuild: false, requiresRuntime: 'i2c' },
  { id: 'timing', status: 'limited', refusedByBuild: false },
  { id: 'dual_core', status: 'limited', refusedByBuild: false },
  // R4: LEDC PWM on Runtime v3 (capability `pwm`); limited: duty 0 driving a load, loads that do not
  // settle instantly and LEDC modes the runtime cannot represent are refused at Run time.
  { id: 'pwm', status: 'limited', refusedByBuild: false, requiresRuntime: 'pwm' },
  { id: 'interrupt', status: 'unsupported', refusedByBuild: true },
  { id: 'internal_pull', status: 'unsupported', refusedByBuild: true },
  { id: 'adc', status: 'unsupported', refusedByBuild: true },
  { id: 'dac', status: 'unsupported', refusedByBuild: true },
  { id: 'touch', status: 'unsupported', refusedByBuild: true },
  { id: 'spi', status: 'unsupported', refusedByBuild: true },
  { id: 'wifi', status: 'unsupported', refusedByBuild: true },
  { id: 'bluetooth', status: 'unsupported', refusedByBuild: true },
  { id: 'sleep', status: 'unsupported', refusedByBuild: true },
  { id: 'drive_strength', status: 'unsupported', refusedByBuild: true },
  { id: 'pwm_advanced', status: 'unsupported', refusedByBuild: true },
  { id: 'restart', status: 'unsupported', refusedByBuild: true },
  { id: 'library', status: 'unsupported', refusedByBuild: true },
];

/** The V1 timing contract, item by item (accepted 2026-10-11). */
export const TIMING_CONTRACT: readonly string[] = [
  'electrical_exact',
  'polling',
  'outputs_longer',
  'busy_core0',
  'delay_phase',
  'pulsein',
  'no_us_claim',
];

/** Runtime refusals that are limits of the service, not faults (`sim.error.runtime.<code>`). */
export const SESSION_LIMITS: readonly string[] = [
  'runtime_busy',
  'session_quota',
  'rate_limited',
  'session_expired',
  'commands_rate_limited',
];

export interface PartCapability {
  type: ComponentTypeId;
  status: CapabilityStatus;
  /** Why a part is refused next to an ESP32 (the palette's own reason codes). */
  reason?: 'part_time_dependent' | 'part_needs_runtime';
}

/** Every catalog part, as it behaves in a project with a Classic ESP32 (catalog order). */
export function partCapabilities(): PartCapability[] {
  return CATALOG_ORDER.filter((t) => t !== 'board.esp32_devkitc_wroom32').map((type) => {
    const def = CATALOG[type];
    if (def.mcuRuntime !== false) return { type, status: 'supported' };
    return {
      type,
      status: 'unsupported',
      reason:
        def.mcuRuntimeReason === 'time_dependent' ? 'part_time_dependent' : 'part_needs_runtime',
    };
  });
}

/** The panel entry a build feature code belongs to (`library:Name` → `library`). */
export function facilityForFeature(code: string): FirmwareFacility | undefined {
  const id = code.startsWith('library:') ? 'library' : code;
  return FIRMWARE_FACILITIES.find((f) => f.id === id);
}

/**
 * Sprint 13 H2: each part's documented model limitations (what the simulation does not model, or
 * models under a stated assumption), from the part models' own documentation. Text:
 * `limitation.<id>` in the message catalogs. Every catalog part except the ground symbol has
 * entries (a test checks it).
 */
export const MODEL_LIMITATIONS: Readonly<Partial<Record<ComponentTypeId, readonly string[]>>> = {
  'instrument.lab_psu': ['psu_ideal'],
  'component.resistor': ['resistor_ideal', 'resistor_no_power'],
  'component.led': ['dc_25c', 'led_card_range', 'no_breakdown', 'pwm_average'],
  'component.diode': ['dc_25c', 'no_breakdown'],
  'component.push_button': ['switch_ideal'],
  'component.toggle_switch': ['switch_ideal'],
  'component.rgb_led': ['dc_25c', 'led_card_range', 'no_breakdown', 'pwm_average'],
  'component.photoresistor': [
    'ldr_typical',
    'ldr_extrapolated',
    'ldr_digital_esp32',
    'ldr_no_dynamics',
  ],
  'component.buzzer': ['buzzer_curve', 'buzzer_dc'],
  'component.relay': ['relay_thresholds', 'relay_no_inductance', 'relay_ideal_contacts'],
  'component.bjt_npn': ['bjt_dc', 'bjt_no_breakdown'],
  'sensor.pir_hc_sr501': ['pir_static'],
  'display.led_matrix_8x8': ['matrix_window', 'matrix_no_esp32'],
  'component.capacitor': ['capacitor_ideal', 'capacitor_no_esp32'],
  'sensor.hc_sr04': ['hcsr04_target', 'hcsr04_output', 'hcsr04_retrigger', 'supply_below_min'],
  'sensor.dht22': ['dht22_tgo', 'dht22_current', 'dht22_output', 'supply_below_min'],
  'display.lcd1602_i2c': [
    'lcd_backlight',
    'lcd_bus_timing',
    'lcd_pullups',
    'lcd_input_clamp',
    'supply_below_min',
  ],
  'component.servo_sg90': [
    'servo_supply_current',
    'servo_thresholds',
    'servo_supply_range',
    'servo_mapping',
    'servo_frames',
  ],
  'board.esp32_devkitc_wroom32': [
    'esp32_timing',
    'esp32_pulls',
    'esp32_drive',
    'esp32_input_clamp',
    'esp32_pwm',
  ],
};
