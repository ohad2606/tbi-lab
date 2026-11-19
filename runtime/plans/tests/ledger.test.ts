import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { closePeriod, consume, refundEligible, type Buckets } from '../ledger.js';

const cfg = parseConfig();
const ms = (iso: string): number => Date.parse(iso);
const NOW = ms('2026-11-19T12:00:00Z');
const FUTURE = ms('2027-06-01T00:00:00Z');
const b = (allowance: number, rollover: number, packs: [string, number, number][]): Buckets => ({
  allowance,
  rollover: rollover > 0 ? { credits: rollover, expiresAt: FUTURE } : null,
  packs: packs.map(([id, credits, expiresAt]) => ({ id, credits, expiresAt })),
});

describe('consume order and all-or-nothing', () => {
  it('table rows', () => {
    expect(consume(b(5, 10, [['k', 100, FUTURE]]), 1, NOW, 'advanced', cfg)).toEqual({
      ok: true,
      metered: true,
      parts: [{ bucket: 'allowance', credits: 1 }],
    });
    expect(consume(b(0, 10, [['k', 100, FUTURE]]), 1, NOW, 'advanced', cfg)).toMatchObject({
      parts: [{ bucket: 'rollover', credits: 1 }],
    });
    expect(consume(b(5, 10, [['k', 100, FUTURE]]), 15, NOW, 'advanced', cfg)).toMatchObject({
      parts: [
        { bucket: 'allowance', credits: 5 },
        { bucket: 'rollover', credits: 10 },
      ],
    });
    expect(consume(b(5, 10, [['k', 100, FUTURE]]), 20, NOW, 'advanced', cfg)).toMatchObject({
      parts: [
        { bucket: 'allowance', credits: 5 },
        { bucket: 'rollover', credits: 10 },
        { bucket: 'pack', credits: 5, packId: 'k' },
      ],
    });
  });
  it('expired packs and rollover are ignored', () => {
    expect(consume(b(0, 0, [['k', 100, NOW]]), 1, NOW, 'advanced', cfg)).toEqual({
      ok: false,
      code: 'credits_out',
    });
    const s: Buckets = { allowance: 0, rollover: { credits: 9, expiresAt: NOW }, packs: [] };
    expect(consume(s, 1, NOW, 'advanced', cfg)).toMatchObject({ ok: false });
  });
  it('refuses when total is short, deducting nothing (input untouched)', () => {
    const buckets = b(5, 5, [['k', 4, FUTURE]]);
    const copy = structuredClone(buckets);
    expect(consume(buckets, 15, NOW, 'advanced', cfg)).toEqual({ ok: false, code: 'credits_out' });
    expect(buckets).toEqual(copy);
  });
  it('oldest-expiry pack first', () => {
    const r = consume(
      b(0, 0, [
        ['tenth', 10, ms('2027-01-10T00:00:00Z')],
        ['fifth', 10, ms('2027-01-05T00:00:00Z')],
      ]),
      3,
      NOW,
      'pro',
      cfg,
    );
    expect(r).toMatchObject({ ok: true, parts: [{ bucket: 'pack', packId: 'fifth', credits: 3 }] });
  });
  it('free (lapsed paid): packs not consumable, kept intact', () => {
    const buckets = b(0, 0, [['k', 100, FUTURE]]);
    expect(consume(buckets, 1, NOW, 'free', cfg)).toEqual({ ok: false, code: 'credits_out_free' });
    expect(buckets.packs[0]?.credits).toBe(100);
  });
  it('legacy is unmetered', () => {
    expect(consume(b(0, 0, []), 15, NOW, 'legacy', cfg)).toEqual({
      ok: true,
      metered: false,
      parts: [],
    });
  });
});

describe('closePeriod (rollover)', () => {
  const next = { start: ms('2026-12-01T00:00:00Z'), end: ms('2027-01-01T00:00:00Z') };
  it('advanced, used 100 of 400: 300 roll, expiring at end of the NEXT period', () => {
    const r = closePeriod({ allowance: 300, rollover: null }, 'advanced', next, cfg);
    expect(r.allowance).toBe(400);
    expect(r.rollover).toEqual({ credits: 300, expiresAt: next.end });
    expect(r.expiredCredits).toBe(0);
  });
  it('fully used: no rollover', () => {
    const r = closePeriod({ allowance: 0, rollover: null }, 'advanced', next, cfg);
    expect(r.rollover).toBeNull();
    expect(r.allowance).toBe(400);
  });
  it('free does not roll by default', () => {
    const r = closePeriod({ allowance: 20, rollover: null }, 'free', next, cfg);
    expect(r).toMatchObject({ allowance: 30, rollover: null, expiredCredits: 20 });
  });
  it('old rollover expires; only unused ALLOWANCE rolls (never rolls twice)', () => {
    const r = closePeriod(
      { allowance: 100, rollover: { credits: 50, expiresAt: next.start } },
      'advanced',
      next,
      cfg,
    );
    expect(r.rollover?.credits).toBe(100);
    expect(r.expiredCredits).toBe(50);
  });
  it('free with rolloverMonths=1 rolls (Q1 is config only)', () => {
    const c = parseConfig({ plans: { free: { rolloverMonths: 1 } } });
    const r = closePeriod({ allowance: 20, rollover: null }, 'free', next, c);
    expect(r.rollover).toEqual({ credits: 20, expiresAt: next.end });
  });
  it('rolloverMonths=2 extends expiry by one more month', () => {
    const c = parseConfig({ plans: { advanced: { rolloverMonths: 2 } } });
    const r = closePeriod({ allowance: 20, rollover: null }, 'advanced', next, c);
    expect(r.rollover?.expiresAt).toBe(ms('2027-02-01T00:00:00Z'));
  });
});

describe('refundEligible', () => {
  const D = 86_400_000;
  const pack = { credits: 1000, boughtAt: ms('2026-11-01T00:00:00Z') };
  it('window boundary inclusive of 14 x 24 h', () => {
    expect(refundEligible(pack, 0, pack.boughtAt + 14 * D, cfg)).toBe(true);
    expect(refundEligible(pack, 0, pack.boughtAt + 14 * D + 1, cfg)).toBe(false);
  });
  it('used share 20% exactly ok, 20.1% not', () => {
    expect(refundEligible(pack, 200, pack.boughtAt + D, cfg)).toBe(true);
    expect(refundEligible(pack, 201, pack.boughtAt + D, cfg)).toBe(false);
    expect(refundEligible({ credits: 300, boughtAt: pack.boughtAt }, 60, pack.boughtAt, cfg)).toBe(
      true,
    );
  });
  it('windowDays from config', () => {
    const c = parseConfig({ packs: { refund: { windowDays: 7 } } });
    expect(refundEligible(pack, 0, pack.boughtAt + 7 * D, c)).toBe(true);
    expect(refundEligible(pack, 0, pack.boughtAt + 7 * D + 1, c)).toBe(false);
  });
  it('not before purchase', () => {
    expect(refundEligible(pack, 0, pack.boughtAt - 1, cfg)).toBe(false);
  });
});
