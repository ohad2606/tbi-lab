import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../store.js';
import { ADV, FREE, LEG, NOON, NOV, code, ms, req, setup } from './helpers.js';

describe('admit: Free plan table', () => {
  it('1 standard request: ok, allowance 29, daily 1', async () => {
    const { engine } = await setup();
    const r = await engine.admit(req(FREE));
    expect(r.ok && r.metered && r.reservation.state).toBe('open');
    const a = engine.account(FREE);
    expect(a?.allowance).toBe(29);
    expect(Object.values(a?.daily ?? {})).toEqual([1]);
  });

  it('rate: 3 within 10 s -> third refused with n = 50; trailing window boundary at +60 s', async () => {
    const { engine, clock } = await setup();
    expect(code(await engine.admit(req(FREE)))).toBe('ok');
    clock.advance(5000);
    expect(code(await engine.admit(req(FREE)))).toBe('ok');
    clock.advance(5000);
    const third = await engine.admit(req(FREE));
    expect(!third.ok && third.error).toMatchObject({ code: 'rate', messageKey: 'limit.ai.rate', params: { n: 50 } });
    // oldest (t0) leaves the window exactly at t0 + 60000
    clock.t = NOON + 59_999;
    expect(code(await engine.admit(req(FREE)))).toBe('rate');
    clock.t = NOON + 60_000;
    expect(code(await engine.admit(req(FREE)))).toBe('ok');
  });

  it('refused-for-rate requests are not counted; after the window the next is ok', async () => {
    const { engine, clock } = await setup();
    await engine.admit(req(FREE));
    await engine.admit(req(FREE));
    for (let i = 0; i < 20; i++) expect(code(await engine.admit(req(FREE)))).toBe('rate');
    expect(engine.account(FREE)?.allowance).toBe(28);
    clock.advance(60_000);
    expect(code(await engine.admit(req(FREE)))).toBe('ok');
    expect(engine.account(FREE)?.allowance).toBe(27);
  });

  it('11th standard request in a day -> daily; next Jerusalem day ok', async () => {
    const { engine, clock } = await setup();
    for (let i = 0; i < 10; i++) {
      expect(code(await engine.admit(req(FREE)))).toBe('ok');
      clock.advance(60_000);
    }
    const r = await engine.admit(req(FREE));
    expect(!r.ok && r.error.messageKey).toBe('limit.ai.daily');
    clock.t = ms('2026-11-19T22:00:00Z');
    expect(code(await engine.admit(req(FREE)))).toBe('ok');
  });

  it('allowance used up -> credits_out_free with the renewal date', async () => {
    const { engine, clock } = await setup({ plans: { free: { monthlyCredits: 2 } } });
    await engine.admit(req(FREE));
    clock.advance(60_000);
    await engine.admit(req(FREE));
    clock.advance(60_000);
    const r = await engine.admit(req(FREE));
    expect(!r.ok && r.error).toMatchObject({ code: 'credits_out_free', params: { date: '01.12.2026' } });
  });

  it('a new calendar month brings a fresh allowance (free does not roll)', async () => {
    const { engine, clock } = await setup({ plans: { free: { monthlyCredits: 2 } } });
    await engine.admit(req(FREE));
    clock.t = ms('2026-12-01T10:00:00Z');
    await engine.admit(req(FREE));
    const a = engine.account(FREE);
    expect(a?.allowance).toBe(1);
    expect(a?.rollover).toBeNull();
    const c = engine.conservation(FREE);
    expect(c.balance + c.reserved + c.consumed + c.expired).toBe(c.granted);
  });

  it('deep on Free: deep_not_in_plan, nothing consumed', async () => {
    const { engine } = await setup();
    const r = await engine.admit(req(FREE, 'deep'));
    expect(!r.ok && r.error.messageKey).toBe('limit.ai.deep_not_in_plan');
    expect(engine.account(FREE)?.allowance).toBe(30);
  });

  it('too_long: 12001 refused, 12000 ok', async () => {
    const { engine, clock } = await setup();
    const r = await engine.admit(req(FREE, 'standard', 12001));
    expect(!r.ok && r.error.code).toBe('too_long');
    clock.advance(1);
    expect(code(await engine.admit(req(FREE, 'standard', 12000)))).toBe('ok');
  });
});

describe('admit: paid and legacy', () => {
  it('Advanced: 3 deep requests in a day -> third daily (45 > 40)', async () => {
    const { engine, clock } = await setup({ plans: { advanced: { perMinute: 10 } } });
    await engine.grant(ADV, 'advanced', NOV, 'g1');
    expect(code(await engine.admit(req(ADV, 'deep')))).toBe('ok');
    clock.advance(1000);
    expect(code(await engine.admit(req(ADV, 'deep')))).toBe('ok');
    clock.advance(1000);
    expect(code(await engine.admit(req(ADV, 'deep')))).toBe('daily');
    expect(engine.account(ADV)?.allowance).toBe(370);
  });

  it('Advanced with 14 credits: deep -> credits_out', async () => {
    const { engine } = await setup({ plans: { advanced: { monthlyCredits: 14 } } });
    await engine.grant(ADV, 'advanced', NOV, 'g1');
    const r = await engine.admit(req(ADV, 'deep'));
    expect(!r.ok && r.error).toMatchObject({ code: 'credits_out', params: { date: '01.12.2026' } });
  });

  it('legacy: 31st request in a day -> daily; no monthly deduction at any point', async () => {
    const { engine, clock } = await setup();
    await engine.grant(LEG, 'legacy', { start: 0, end: 0 }, 'g1');
    for (let i = 0; i < 30; i++) {
      expect(code(await engine.admit(req(LEG)))).toBe('ok');
      clock.advance(60_000);
    }
    expect(code(await engine.admit(req(LEG)))).toBe('daily');
    const c = engine.conservation(LEG);
    expect(c).toMatchObject({ balance: 0, reserved: 0, consumed: 0 });
  });

  it('paid plan: packs are consumed after allowance and rollover', async () => {
    const { engine } = await setup({ plans: { advanced: { monthlyCredits: 1 } } });
    await engine.grant(ADV, 'advanced', NOV, 'g1');
    expect(await engine.addPack(ADV, 'ai300', 'pk1')).toMatchObject({ ok: true });
    await engine.admit(req(ADV));
    const r = await engine.admit(req(ADV)); // allowance empty -> pack (perMinute 3 ok)
    expect(r.ok && r.metered && r.reservation.parts).toMatchObject([{ bucket: 'pack', credits: 1 }]);
    expect(engine.account(ADV)?.packs[0]?.credits).toBe(299);
  });
});

describe('admit: atomicity, idempotency, validation', () => {
  it('two parallel admits with 1 credit left: exactly one ok', async () => {
    const { engine } = await setup({ plans: { free: { monthlyCredits: 1, perMinute: 5 } } });
    const rs = await Promise.all([engine.admit(req(FREE)), engine.admit(req(FREE))]);
    expect(rs.map(code).sort()).toEqual(['credits_out_free', 'ok']);
  });

  it('same reqId again returns the same reservation, balance unchanged', async () => {
    const { engine } = await setup();
    const rq = req(FREE);
    const a = await engine.admit(rq);
    const b = await engine.admit(rq);
    expect(b.ok && b.metered && b.duplicate).toBe(true);
    expect(a.ok && a.metered && a.reservation).toEqual(b.ok && b.metered && b.reservation);
    expect(engine.account(FREE)?.allowance).toBe(29);
  });

  it('e-mail principal -> invalid_principal, nothing persisted', async () => {
    const { engine, store } = await setup();
    const r = await engine.admit(req('a@b.com'));
    expect(!r.ok && r.error.code).toBe('invalid_principal');
    expect((store as MemoryStore).events).toHaveLength(0);
    expect(engine.principals()).toEqual([]);
  });

  it('store append throws on 2nd call -> system_unavailable, state unchanged, nothing consumed', async () => {
    const { engine, store } = await setup();
    await engine.admit(req(FREE));
    (store as MemoryStore).failOnCall = 2;
    const before = engine.stateJson();
    const r = await engine.admit(req(FREE));
    expect(!r.ok && r.error).toMatchObject({ code: 'system_unavailable', messageKey: 'limit.system.unavailable' });
    expect(engine.stateJson()).toBe(before);
  });

  it('metering.enabled=false: always ok, journal untouched', async () => {
    const { engine, store } = await setup({}, { enabled: false });
    for (let i = 0; i < 50; i++) expect(await engine.admit(req(FREE, 'deep', 999999))).toEqual({ ok: true, metered: false });
    expect(await engine.settle('x', 1)).toMatchObject({ ok: true });
    expect((store as MemoryStore).appendCalls).toBe(0);
  });

  it('default config has metering off', async () => {
    const { parseConfig } = await import('../config.js');
    expect(parseConfig().metering.enabled).toBe(false);
  });

  it('global_off refusal never consumes credits (spend reserve refuses)', async () => {
    const { engine } = await setup({ spend: { worstMicro: { standard: 5_000_000 } } });
    const r = await engine.admit(req(FREE));
    expect(!r.ok && r.error.code).toBe('global_off');
    expect(engine.account(FREE)?.allowance).toBe(30);
    expect(engine.conservation(FREE).reserved).toBe(0);
  });

  it('invalid request shape', async () => {
    const { engine } = await setup();
    expect(code(await engine.admit({ ...req(FREE), reqId: '' }))).toBe('invalid_request');
    expect(code(await engine.admit({ ...req(FREE), inputTokens: -1 }))).toBe('invalid_request');
  });
});

describe('settle / release / sweep', () => {
  it('settle after ok: credits stay deducted, spend replaced by actual; twice is a no-op', async () => {
    const { engine } = await setup();
    const rq = req(FREE);
    await engine.admit(rq);
    expect(engine.spendState().reservedMicro).toBe(2250);
    expect(await engine.settle(rq.reqId, 700)).toEqual({ ok: true });
    expect(engine.reservation(rq.reqId)?.state).toBe('settled');
    expect(engine.spendState()).toMatchObject({ reservedMicro: 0, dayMicro: 700, monthMicro: 700 });
    expect(engine.account(FREE)?.allowance).toBe(29);
    expect(await engine.settle(rq.reqId, 999)).toEqual({ ok: true, noop: true });
    expect(engine.spendState().dayMicro).toBe(700);
  });

  it('release returns credits to the SAME buckets; worst case stays in the day total', async () => {
    const { engine } = await setup({ plans: { advanced: { monthlyCredits: 5 } } });
    await engine.grant(ADV, 'advanced', NOV, 'g1');
    await engine.addPack(ADV, 'ai300', 'pk1');
    const rq = req(ADV, 'deep'); // 15 = allowance 5 + pack 10
    const a = await engine.admit(rq);
    expect(a.ok && a.metered && a.reservation.parts.map((p) => p.bucket)).toEqual(['allowance', 'pack']);
    expect(await engine.release(rq.reqId)).toEqual({ ok: true });
    const acc = engine.account(ADV);
    expect(acc?.allowance).toBe(5);
    expect(acc?.packs[0]?.credits).toBe(300);
    expect(Object.values(acc?.daily ?? {})).toEqual([0]);
    expect(engine.spendState()).toMatchObject({ reservedMicro: 0, dayMicro: 45000 });
    expect(await engine.release(rq.reqId)).toEqual({ ok: true, noop: true });
  });

  it("failedCallCounts 'zero' does not count a failed call", async () => {
    const { engine } = await setup({ spend: { failedCallCounts: 'zero' } });
    const rq = req(FREE);
    await engine.admit(rq);
    await engine.release(rq.reqId);
    expect(engine.spendState().dayMicro).toBe(0);
  });

  it('release after settle and settle after release are invalid_state, no change', async () => {
    const { engine } = await setup();
    const a = req(FREE);
    await engine.admit(a);
    await engine.settle(a.reqId, 1);
    const before = engine.stateJson();
    const r = await engine.release(a.reqId);
    expect(!r.ok && r.error.code).toBe('invalid_state');
    expect(engine.stateJson()).toBe(before);
    const b = req(FREE);
    await engine.admit(b);
    await engine.release(b.reqId);
    const s = await engine.settle(b.reqId, 1);
    expect(!s.ok && s.error.code).toBe('invalid_state');
    const u = await engine.settle('nope', 1);
    expect(!u.ok && u.error.code).toBe('invalid_state');
  });

  it('reservation older than ttl is auto-released by sweep and at open', async () => {
    const { engine, clock, store, cfg } = await setup();
    await engine.admit(req(FREE));
    clock.advance(cfg.reservation.ttlMs - 1);
    expect(await engine.sweep()).toBe(0);
    clock.advance(1);
    expect(await engine.sweep()).toBe(1);
    expect(engine.account(FREE)?.allowance).toBe(30);
    expect(engine.spendState().dayMicro).toBe(2250);

    const second = await setup({}, {});
    await second.engine.admit(req(FREE));
    second.clock.advance(second.cfg.reservation.ttlMs);
    const { PlansEngine } = await import('../reserve.js');
    const reopened = await PlansEngine.open(second.store, { config: second.cfg, clock: second.clock });
    expect(reopened.account(FREE)?.allowance).toBe(30);
    void store;
  });
});

describe('grant / revoke / addPack', () => {
  it('same ref twice: one entitlement, one allowance grant', async () => {
    const { engine } = await setup();
    expect(await engine.grant(ADV, 'advanced', NOV, 'g1')).toEqual({ ok: true });
    expect(await engine.grant(ADV, 'advanced', NOV, 'g1')).toEqual({ ok: true, duplicate: true });
    const a = engine.account(ADV);
    expect(a?.entitlements).toHaveLength(1);
    expect(a?.allowance).toBe(400);
    expect(a?.granted).toBe(30 + 400);
  });

  it('pro over advanced mid-period: allowance replaced, rollover kept', async () => {
    const { engine, clock } = await setup();
    await engine.grant(ADV, 'advanced', NOV, 'g1');
    await engine.admit(req(ADV)); // 399
    // renewal for December granted before the period ends; the first request in December closes November
    clock.t = ms('2026-11-30T10:00:00Z');
    await engine.grant(ADV, 'advanced', { start: NOV.end, end: ms('2027-01-01T00:00:00Z') }, 'g2');
    clock.t = ms('2026-12-02T10:00:00Z');
    const dec = req(ADV);
    await engine.admit(dec);
    await engine.release(dec.reqId);
    expect(engine.account(ADV)).toMatchObject({ allowance: 400, rollover: { credits: 399 } });
    await engine.grant(ADV, 'pro', { start: NOV.end, end: ms('2027-02-01T00:00:00Z') }, 'g3');
    const a = engine.account(ADV);
    expect(a).toMatchObject({ plan: 'pro', allowance: 1500, rollover: { credits: 399 } });
    const c = engine.conservation(ADV);
    expect(c.balance + c.reserved + c.consumed + c.expired).toBe(c.granted);
  });

  it('revoke: effective plan free, allowance dropped to free, packs kept but not consumable', async () => {
    const { engine, clock } = await setup();
    await engine.grant(ADV, 'advanced', NOV, 'g1');
    await engine.addPack(ADV, 'ai300', 'pk1');
    expect(await engine.revoke(ADV)).toEqual({ ok: true });
    const a = engine.account(ADV);
    expect(a).toMatchObject({ plan: 'free', allowance: 30 });
    expect(a?.packs[0]?.credits).toBe(300);
    // exhaust the free allowance: pack must stay untouched
    for (let i = 0; i < 10; i++) {
      await engine.admit(req(ADV));
      clock.advance(60_000);
    }
    clock.t = ms('2026-11-20T10:00:00Z');
    for (let i = 0; i < 10; i++) {
      await engine.admit(req(ADV));
      clock.advance(60_000);
    }
    clock.t = ms('2026-11-21T10:00:00Z');
    for (let i = 0; i < 10; i++) {
      await engine.admit(req(ADV));
      clock.advance(60_000);
    }
    clock.t = ms('2026-11-22T10:00:00Z');
    const r = await engine.admit(req(ADV));
    expect(!r.ok && r.error.code).toBe('credits_out_free');
    expect(engine.account(ADV)?.packs[0]?.credits).toBe(300);
    expect(await engine.revoke(ADV)).toEqual({ ok: true, noop: true });
  });

  it('addPack without an active paid plan -> pack_needs_plan; with advanced ok and expiry set', async () => {
    const { engine } = await setup();
    const r = await engine.addPack(FREE, 'ai300', 'pk0');
    expect(!r.ok && r.error).toMatchObject({ code: 'pack_needs_plan', messageKey: 'limit.pack.needs_plan' });
    await engine.grant(ADV, 'advanced', NOV, 'g1');
    expect(await engine.addPack(ADV, 'ai1000', 'pk1')).toEqual({ ok: true });
    expect(await engine.addPack(ADV, 'ai1000', 'pk1')).toEqual({ ok: true, duplicate: true });
    const p = engine.account(ADV)?.packs;
    expect(p).toHaveLength(1);
    expect(p?.[0]).toMatchObject({ credits: 1000, boughtAt: NOON, expiresAt: NOON + 365 * 86_400_000 });
  });

  it('rejects bad input', async () => {
    const { engine } = await setup();
    expect((await engine.grant('x@y.z', 'advanced', NOV, 'g')).ok).toBe(false);
    expect((await engine.grant(ADV, 'advanced', { start: 5, end: 5 }, 'g')).ok).toBe(false);
    expect((await engine.grant(ADV, 'free' as 'pro', NOV, 'g')).ok).toBe(false);
    expect((await engine.grant(ADV, 'advanced', NOV, '')).ok).toBe(false);
  });

  it('lapsed paid period falls back to free at the period end', async () => {
    const { engine, clock } = await setup();
    await engine.grant(ADV, 'advanced', NOV, 'g1');
    clock.t = NOV.end;
    const r = await engine.admit(req(ADV));
    expect(r.ok && r.metered && r.reservation.plan).toBe('free');
    expect(engine.account(ADV)?.allowance).toBe(29);
  });
});

void NOON;
