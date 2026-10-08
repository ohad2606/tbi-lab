/**
 * Live controls (Sprint 11, R1; ADR-010): the one rule the Session Host applies when a mirror
 * command arrives and the engine applies again: which controls a component accepts while running,
 * and which values are acceptable.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG, CATALOG_ORDER, liveControlProblem, liveParamKeys } from '../src/index.js';

describe('live controls: part identity, allowed names, kinds and ranges', () => {
  it('a PIR takes `motion` (boolean); a photoresistor takes `illuminance` within 1 … 10 000 lux', () => {
    expect(liveParamKeys('sensor.pir_hc_sr501')).toEqual(['motion']);
    expect(liveParamKeys('component.photoresistor')).toEqual(['illuminance']);
    expect(liveControlProblem('sensor.pir_hc_sr501', { params: { motion: true } })).toBeNull();
    expect(
      liveControlProblem('component.photoresistor', { params: { illuminance: 1 } }),
    ).toBeNull();
    expect(
      liveControlProblem('component.photoresistor', { params: { illuminance: 10_000 } }),
    ).toBeNull();
  });

  it('wrong kind or out of range: invalid_value, naming the parameter', () => {
    for (const [type, params] of [
      ['sensor.pir_hc_sr501', { motion: 'yes' }],
      ['sensor.pir_hc_sr501', { motion: 1 }],
      ['component.photoresistor', { illuminance: 0.5 }],
      ['component.photoresistor', { illuminance: 20_000 }],
      ['component.photoresistor', { illuminance: Number.NaN }],
      ['component.photoresistor', { illuminance: Infinity }],
      ['component.photoresistor', { illuminance: '100' }],
    ] as const)
      expect(liveControlProblem(type, { params }), JSON.stringify(params)).toEqual({
        reason: 'invalid_value',
        key: Object.keys(params)[0],
      });
  });

  it('a parameter the part does not declare live, or on a part without live parameters: unsupported_control', () => {
    expect(liveControlProblem('component.photoresistor', { params: { model: 'x' } })).toEqual({
      reason: 'unsupported_control',
      key: 'model',
    });
    expect(liveControlProblem('component.resistor', { params: { resistance: 100 } })).toEqual({
      reason: 'unsupported_control',
      key: 'resistance',
    });
    expect(liveControlProblem('component.rgb_led', { params: { red: true } })).toEqual({
      reason: 'unsupported_control',
      key: 'red',
    });
    expect(liveControlProblem('sensor.pir_hc_sr501', { params: {} })).toEqual({
      reason: 'unsupported_control',
    });
  });

  it('PSU keys only on the lab supply, `closed` only on a toggle switch, never through params', () => {
    expect(liveControlProblem('instrument.lab_psu', { setpointVoltage: 5 })).toBeNull();
    expect(liveControlProblem('component.toggle_switch', { closed: true })).toBeNull();
    expect(liveControlProblem('sensor.pir_hc_sr501', { outputEnabled: true })).toEqual({
      reason: 'unsupported_control',
      key: 'outputEnabled',
    });
    expect(liveControlProblem('component.push_button', { closed: true })).toEqual({
      reason: 'unsupported_control',
      key: 'closed',
    });
    expect(liveControlProblem('instrument.lab_psu', { params: { setpointVoltage: 5 } })).toEqual({
      reason: 'unsupported_control',
      key: 'setpointVoltage',
    });
    expect(liveControlProblem('component.toggle_switch', { params: { closed: true } })).toEqual({
      reason: 'unsupported_control',
      key: 'closed',
    });
  });

  it('every catalog type: its live params are exactly its `live` parameters other than PSU/switch keys', () => {
    for (const t of CATALOG_ORDER) {
      const live = CATALOG[t].params
        .filter((p) => p.live)
        .map((p) => p.key)
        .filter((k) => !['setpointVoltage', 'currentLimit', 'outputEnabled', 'closed'].includes(k));
      expect(liveParamKeys(t), t).toEqual(live);
    }
  });
});
