/**
 * Sprint 15 (R4): the SG90's electrical side. No modelled current (supply unknown, never 0), the
 * assumed signal thresholds, the modelled supply range and its flags, the unrated supply warning.
 */
import { describe, expect, it } from 'vitest';
import { SG90_ELECTRICAL, servoPowered, servoSignalLevel } from '../src/index.js';

describe('SG90 part (R4)', () => {
  it('signal level: >= 2.0 V high, <= 0.8 V low, undefined between and when unknown', () => {
    expect(servoSignalLevel(3.3)).toBe(1);
    expect(servoSignalLevel(2.0)).toBe(1);
    expect(servoSignalLevel(1.99)).toBeNull();
    expect(servoSignalLevel(0.81)).toBeNull();
    expect(servoSignalLevel(0.8)).toBe(0);
    expect(servoSignalLevel(0)).toBe(0);
    expect(servoSignalLevel(null)).toBeNull();
  });

  it('powered only within 4.8-6.0 V', () => {
    expect(SG90_ELECTRICAL).toMatchObject({ minSupplyV: 4.8, maxSupplyV: 6.0 });
    expect(servoPowered(5)).toBe(true);
    expect(servoPowered(4.8)).toBe(true);
    expect(servoPowered(6.0)).toBe(true);
    expect(servoPowered(4.79)).toBe(false);
    expect(servoPowered(6.01)).toBe(false);
    expect(servoPowered(null)).toBe(false);
  });
});
