import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, parseConfig } from '../config.js';

describe('config strict parse', () => {
  it('defaults: metering off, Jerusalem', () => {
    const c = parseConfig();
    expect(c.metering.enabled).toBe(false);
    expect(c.meter.timezone).toBe('Asia/Jerusalem');
    expect(c).toEqual(DEFAULT_CONFIG);
  });
  it('merges overrides deeply without touching defaults', () => {
    const c = parseConfig({ plans: { free: { rolloverMonths: 1 } }, metering: { enabled: true } });
    expect(c.plans.free.rolloverMonths).toBe(1);
    expect(c.plans.free.monthlyCredits).toBe(DEFAULT_CONFIG.plans.free.monthlyCredits);
    expect(DEFAULT_CONFIG.plans.free.rolloverMonths).toBe(0);
  });
  it('rejects unknown keys at any depth', () => {
    expect(() => parseConfig({ bogus: 1 })).toThrow(ConfigError);
    expect(() => parseConfig({ plans: { free: { monthlyCreditz: 1 } } })).toThrow(
      /unknown config key/,
    );
    expect(() => parseConfig({ plans: { gold: {} } })).toThrow(ConfigError);
  });
  it('rejects negative numbers', () => {
    expect(() => parseConfig({ plans: { free: { dailyCredits: -1 } } })).toThrow(/negative/);
    expect(() => parseConfig({ spend: { dayStopMicro: -5 } })).toThrow(/negative/);
  });
  it('rejects non-integer credits and money', () => {
    expect(() => parseConfig({ plans: { free: { monthlyCredits: 1.5 } } })).toThrow(/integer/);
    expect(() => parseConfig({ credits: { deep: 2.5 } })).toThrow(/integer/);
    expect(() => parseConfig({ spend: { worstMicro: { standard: 0.5 } } })).toThrow(/integer/);
  });
  it('rejects dayAlertMicro above dayStopMicro', () => {
    expect(() => parseConfig({ spend: { dayAlertMicro: 3000001 } })).toThrow(/dayAlertMicro/);
    expect(() => parseConfig({ spend: { dayAlertMicro: 3000000 } })).not.toThrow();
  });
  it('rejects wrong types, bad zone, NaN', () => {
    expect(() => parseConfig({ metering: { enabled: 'yes' } })).toThrow(ConfigError);
    expect(() => parseConfig({ meter: { timezone: 'Mars/Base' } })).toThrow(/time zone/);
    expect(() => parseConfig({ ai: { maxInputTokens: Number.NaN } })).toThrow(ConfigError);
    expect(() => parseConfig('x')).toThrow(ConfigError);
  });
  it('allows unmetered (null) and null->number for monthlyCredits', () => {
    expect(
      parseConfig({ plans: { legacy: { monthlyCredits: 50 } } }).plans.legacy.monthlyCredits,
    ).toBe(50);
    expect(
      parseConfig({ plans: { free: { monthlyCredits: null } } }).plans.free.monthlyCredits,
    ).toBeNull();
  });
  it('fractions are allowed only for the refund cap', () => {
    expect(
      parseConfig({ packs: { refund: { maxUsedFraction: 0.5 } } }).packs.refund.maxUsedFraction,
    ).toBe(0.5);
    expect(() => parseConfig({ packs: { refund: { maxUsedFraction: 1.5 } } })).toThrow(ConfigError);
  });
  it('sim and queue sections: nullable minutes, enum mode, positive bounds', () => {
    const c = parseConfig({
      sim: { plans: { free: { monthlyMinutes: null, dailyMinutes: 10 } } },
      queue: { freeCapMode: 'liftUntilFirstPaid' },
    });
    expect(c.sim.plans.free).toEqual({ monthlyMinutes: null, dailyMinutes: 10 });
    expect(c.queue.freeCapMode).toBe('liftUntilFirstPaid');
    expect(() => parseConfig({ queue: { freeCapMode: 'open' } })).toThrow(/freeCapMode/);
    expect(() => parseConfig({ queue: { maxLength: 0 } })).toThrow(/maxLength/);
    expect(() => parseConfig({ sim: { leaseMs: 0 } })).toThrow(/leaseMs/);
    expect(() => parseConfig({ queue: { rank: { gold: 0 } } })).toThrow(/unknown config key/);
    expect(() => parseConfig({ sim: { plans: { pro: { monthlyMinutes: 1.5 } } } })).toThrow(
      /integer/,
    );
    expect(() => parseConfig({ queue: { freeSlotCap: null } })).toThrow(ConfigError);
  });
});
