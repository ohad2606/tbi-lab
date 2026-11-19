import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { effectivePlan, renewDate, type Entitlement } from '../plans.js';

const cfg = parseConfig();
const ms = (iso: string): number => Date.parse(iso);
const P = 'p_testprincipal1';
const ent = (o: Partial<Entitlement>): Entitlement => ({
  principal: P,
  plan: 'advanced',
  periodStart: ms('2026-11-01T00:00:00Z'),
  periodEnd: ms('2026-12-01T00:00:00Z'),
  status: 'active',
  grantRefs: ['r1'],
  ...o,
});

describe('effectivePlan', () => {
  const now = ms('2026-11-19T12:00:00Z');
  it('undefined -> free', () => expect(effectivePlan(undefined, now)).toBe('free'));
  it('advanced active inside period', () => expect(effectivePlan(ent({}), now)).toBe('advanced'));
  it('end is exclusive', () => {
    const e = ent({});
    expect(effectivePlan(e, e.periodEnd)).toBe('free');
    expect(effectivePlan(e, e.periodEnd - 1)).toBe('advanced');
  });
  it('revoked and lapsed -> free', () => {
    expect(effectivePlan(ent({ plan: 'pro', status: 'revoked' }), now)).toBe('free');
    expect(effectivePlan(ent({ plan: 'pro', status: 'lapsed' }), now)).toBe('free');
  });
  it('legacy active at any time', () => {
    const e = ent({ plan: 'legacy', periodStart: 0, periodEnd: 1 });
    expect(effectivePlan(e, now)).toBe('legacy');
    expect(effectivePlan(e, ms('2040-01-01T00:00:00Z'))).toBe('legacy');
  });
  it('before the period starts -> free', () => {
    expect(effectivePlan(ent({}), ms('2026-10-31T23:59:59Z'))).toBe('free');
  });
  it('two entitlements: latest periodEnd wins, ties by higher seq', () => {
    const a = ent({ plan: 'advanced', periodEnd: ms('2026-12-01T00:00:00Z'), seq: 1 });
    const b = ent({ plan: 'pro', periodEnd: ms('2026-12-10T00:00:00Z'), seq: 2 });
    expect(effectivePlan([a, b], now)).toBe('pro');
    expect(effectivePlan([b, a], now)).toBe('pro');
    const c = ent({ plan: 'pro', periodEnd: ms('2026-12-01T00:00:00Z'), seq: 3 });
    expect(effectivePlan([a, c], now)).toBe('pro');
    expect(effectivePlan([c, a], now)).toBe('pro');
    const revoked = ent({
      plan: 'pro',
      periodEnd: ms('2027-01-01T00:00:00Z'),
      status: 'revoked',
      seq: 9,
    });
    expect(effectivePlan([a, revoked], now)).toBe('advanced');
  });
});

describe('renewDate dd.mm.yyyy', () => {
  it('free: first of next month', () => {
    expect(renewDate(undefined, ms('2026-11-19T12:00:00Z'), cfg)).toBe('01.12.2026');
  });
  it('free at 22:30Z on Dec 31 (already Jan 1 in IL)', () => {
    expect(renewDate(undefined, ms('2026-12-31T22:30:00Z'), cfg)).toBe('01.02.2027');
  });
  it('advanced: periodEnd', () => {
    const e = ent({
      periodStart: ms('2026-11-20T09:00:00Z'),
      periodEnd: ms('2026-12-20T09:00:00Z'),
    });
    expect(renewDate(e, ms('2026-11-25T09:00:00Z'), cfg)).toBe('20.12.2026');
  });
  it('lapsed paid shows the free calendar renewal', () => {
    expect(renewDate(ent({ status: 'lapsed' }), ms('2026-11-19T12:00:00Z'), cfg)).toBe(
      '01.12.2026',
    );
  });
});
