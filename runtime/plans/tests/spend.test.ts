import { describe, expect, it } from 'vitest';
import { PlansEngine } from '../reserve.js';
import { MemoryAlertSink } from '../spend.js';
import { MemoryStore } from '../store.js';
import { FakeSpendProvider } from './fake-provider.js';
import { ADV, FREE, NOV, call, ms, rng, setup } from './helpers.js';

const BIG = {
  plans: { advanced: { perMinute: 1000, dailyCredits: 100000, monthlyCredits: 100000 } },
  spend: { worstMicro: { standard: 500_000 } },
};

async function advancedSetup(extra: unknown = BIG) {
  const s = await setup(extra);
  await s.engine.grant(ADV, 'advanced', NOV, 'g1');
  return { ...s, provider: new FakeSpendProvider(500_000) };
}

describe('SpendGuard scenario 6.3 (fake provider, 500,000 micro-USD per call)', () => {
  it('walks the whole table', async () => {
    const { engine, store, clock, sink, cfg, provider } = await advancedSetup();
    const codes = (): string[] => sink.alerts.map((a) => a.code);

    // 1-2
    expect(await call(engine, provider, ADV)).toBe('ok');
    expect(await call(engine, provider, ADV)).toBe('ok');
    expect(engine.spendState().dayMicro).toBe(1_000_000);
    expect(codes()).toEqual([]);
    // 3
    expect(await call(engine, provider, ADV)).toBe('ok');
    expect(engine.spendState().dayMicro).toBe(1_500_000);
    expect(codes()).toEqual(['day_50']);
    // 4-5
    await call(engine, provider, ADV);
    await call(engine, provider, ADV);
    expect(engine.spendState().dayMicro).toBe(2_500_000);
    expect(codes()).toEqual(['day_50']);
    // 6: 2,500,000 + 500,000 = cap is allowed; after settle the AI is off
    expect(await call(engine, provider, ADV)).toBe('ok');
    expect(engine.spendState()).toMatchObject({
      dayMicro: 3_000_000,
      state: 'auto_stopped',
      stopReason: 'daily_cap',
    });
    expect(codes()).toEqual(['day_50', 'day_100']);
    // 7: global_off, provider not called, credits untouched
    const callsBefore = provider.calls;
    const credBefore = engine.conservation(ADV);
    expect(await call(engine, provider, ADV)).toBe('global_off');
    expect(provider.calls).toBe(callsBefore);
    expect(engine.conservation(ADV)).toEqual(credBefore);
    // 8: resume without headroom trips again
    expect(await engine.ownerResume({})).toEqual({ ok: true });
    expect(engine.spendState().state).toBe('on');
    expect(await call(engine, provider, ADV)).toBe('global_off');
    expect(engine.spendState()).toMatchObject({ state: 'auto_stopped', stopReason: 'daily_cap' });
    expect(provider.calls).toBe(callsBefore);
    expect(engine.conservation(ADV)).toEqual(credBefore);
    expect(codes()).toEqual(['day_50', 'day_100']); // never a second day_100
    // 9: resume with headroom
    await engine.ownerResume({ extraDayMicro: 1_000_000 });
    expect(await call(engine, provider, ADV)).toBe('ok');
    expect(engine.spendState()).toMatchObject({ dayMicro: 3_500_000, state: 'on' });
    // 10: rebuild from the journal: same counters, state, alertsFired; no duplicate alerts
    const sink2 = new MemoryAlertSink();
    const reopened = await PlansEngine.open(store, { config: cfg, clock, alerts: sink2 });
    expect(reopened.spendState()).toEqual(engine.spendState());
    expect(reopened.spendState().alertsFired).toEqual(['day_50', 'day_100']);
    expect(sink2.alerts).toEqual([]);
    expect(await call(reopened, provider, ADV)).toBe('ok'); // 4,000,000 = cap + extra
    expect(reopened.spendState().state).toBe('auto_stopped');
    expect(sink2.alerts.map((a) => a.code)).toEqual([]); // day_100 already fired today
    // 11: next Jerusalem day clears a daily_cap stop; day counters and alerts reset
    clock.t = ms('2026-11-19T22:00:00Z');
    expect(await call(reopened, provider, ADV)).toBe('ok');
    expect(reopened.spendState()).toMatchObject({
      state: 'on',
      dayMicro: 500_000,
      dayKey: '2026-11-20',
      dayExtraMicro: 0,
    });
    expect(reopened.spendState().alertsFired).toEqual([]);
    // 12: provider failure: credits returned, worst case counted
    provider.mode = 'fail';
    const credits = reopened.conservation(ADV);
    expect(await call(reopened, provider, ADV)).toBe('provider_failed');
    expect(reopened.conservation(ADV)).toEqual(credits);
    expect(reopened.spendState().dayMicro).toBe(1_000_000);
    provider.mode = 'ok';
  });

  it('13: monthly cap trips, does not clear next day, clears on resume or new month', async () => {
    const { engine, clock, provider } = await advancedSetup();
    await engine.testSeedSpend({ monthMicro: 59_800_000 });
    expect(await call(engine, provider, ADV)).toBe('global_off');
    expect(engine.spendState()).toMatchObject({ state: 'auto_stopped', stopReason: 'monthly_cap' });
    expect(engine.spendState().alertsFired).toContain('month_100');
    expect(provider.calls).toBe(0);
    clock.t = ms('2026-11-20T10:00:00Z');
    expect(await call(engine, provider, ADV)).toBe('global_off');
    expect(engine.spendState()).toMatchObject({ state: 'auto_stopped', stopReason: 'monthly_cap' });
    await engine.ownerResume({});
    expect(await call(engine, provider, ADV)).toBe('global_off'); // no monthly headroom: trips again
    clock.t = ms('2026-12-01T10:00:00Z'); // new month key
    expect(await call(engine, provider, ADV)).toBe('ok');
    expect(engine.spendState()).toMatchObject({
      state: 'on',
      monthKey: '2026-12',
      monthMicro: 500_000,
    });
    expect(engine.spendState().alertsFired).not.toContain('month_100');
  });

  it('month alerts fire once each at 50/80/100 percent', async () => {
    const { engine, sink, provider } = await advancedSetup({
      ...BIG,
      spend: {
        worstMicro: { standard: 500_000 },
        dayStopMicro: 100_000_000,
        dayAlertMicro: 100_000_000,
      },
    });
    await engine.testSeedSpend({ monthMicro: 29_500_000 });
    await call(engine, provider, ADV); // 30,000,000 = 50%
    await call(engine, provider, ADV);
    expect(sink.alerts.map((a) => a.code)).toEqual(['month_50']);
    await engine.testSeedSpend({ monthMicro: 47_900_000 });
    await call(engine, provider, ADV); // 48,400,000 >= 80%
    expect(sink.alerts.map((a) => a.code)).toEqual(['month_50', 'month_80']);
    await engine.testSeedSpend({ monthMicro: 59_600_000 });
    await call(engine, provider, ADV); // 60,100,000 >= cap
    expect(sink.alerts.map((a) => a.code)).toEqual(['month_50', 'month_80', 'month_100']);
    expect(engine.spendState()).toMatchObject({ state: 'auto_stopped', stopReason: 'monthly_cap' });
  });

  it('14: ownerPause stops Free and paid alike until ownerResume', async () => {
    const { engine, provider } = await advancedSetup();
    await engine.ownerPause();
    expect(engine.spendState().state).toBe('manual_off');
    expect(await call(engine, provider, ADV)).toBe('global_off');
    expect(await call(engine, provider, FREE)).toBe('global_off');
    expect(provider.calls).toBe(0);
    await engine.ownerResume({});
    expect(await call(engine, provider, FREE)).toBe('ok');
    // manual_off is not overridden by a cap evaluation or a day roll
    await engine.ownerPause();
    expect(engine.spendState().state).toBe('manual_off');
  });

  it('15: 20 parallel calls on a fresh day with room for 6: provider called 6 times, dayMicro never above cap', async () => {
    const { engine, provider } = await advancedSetup();
    const out = await Promise.all(Array.from({ length: 20 }, () => call(engine, provider, ADV)));
    expect(out.filter((c) => c === 'ok')).toHaveLength(6);
    expect(out.filter((c) => c === 'global_off')).toHaveLength(14);
    expect(provider.calls).toBe(6);
    expect(engine.spendState().dayMicro).toBe(3_000_000);
  });

  it('15b: property, random costs, seeded: day total never exceeds the cap', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rand = rng(seed);
      const { engine, provider, cfg } = await advancedSetup({
        ...BIG,
        spend: { worstMicro: { standard: 400_000 } },
      });
      const calls: Promise<string>[] = [];
      for (let i = 0; i < 40; i++) {
        provider.usdMicro = Math.floor(rand() * 400_001);
        calls.push(call(engine, provider, ADV));
        if (rand() < 0.5) await Promise.resolve();
      }
      await Promise.all(calls);
      const s = engine.spendState();
      expect(s.dayMicro).toBeLessThanOrEqual(cfg.spend.dayStopMicro);
      expect(s.reservedMicro).toBe(0);
    }
  });

  it('16: auto-trigger on: 650,000 against a 200,000 average stops; off: no stop', async () => {
    const hist = Array.from({ length: 7 }, (_, i) => ({
      dayKey: `2026-11-0${i + 1}`,
      micro: 200_000,
    }));
    for (const enabled of [true, false]) {
      const { engine, provider } = await advancedSetup({
        ...BIG,
        spend: { worstMicro: { standard: 650_000 } },
        killSwitch: { autoTrigger: { enabled, multiple: 3, minMicro: 100_000 } },
      });
      await engine.testSeedSpend({ history: hist });
      provider.usdMicro = 650_000;
      expect(await call(engine, provider, ADV)).toBe('ok');
      if (enabled)
        expect(engine.spendState()).toMatchObject({
          state: 'auto_stopped',
          stopReason: 'auto_trigger',
        });
      else expect(engine.spendState().state).toBe('on');
    }
  });

  it('auto_trigger stop does not clear at the next day, only by ownerResume', async () => {
    const { engine, clock, provider } = await advancedSetup({
      ...BIG,
      spend: { worstMicro: { standard: 650_000 } },
      killSwitch: { autoTrigger: { enabled: true, multiple: 3, minMicro: 100_000 } },
    });
    await engine.testSeedSpend({
      history: Array.from({ length: 7 }, (_, i) => ({
        dayKey: `2026-11-0${i + 1}`,
        micro: 200_000,
      })),
    });
    provider.usdMicro = 650_000;
    await call(engine, provider, ADV);
    clock.t = ms('2026-11-20T10:00:00Z');
    expect(await call(engine, provider, ADV)).toBe('global_off');
    await engine.ownerResume({});
    expect(engine.spendState().state).toBe('on');
  });

  it('alert sink failure does not break metering', async () => {
    const { engine, provider, clock, cfg } = await advancedSetup();
    const store = new MemoryStore();
    const e2 = await PlansEngine.open(store, {
      config: cfg,
      clock,
      alerts: {
        alert() {
          throw new Error('channel down');
        },
      },
    });
    await e2.grant(ADV, 'advanced', NOV, 'g1');
    for (let i = 0; i < 3; i++) expect(await call(e2, provider, ADV)).toBe('ok');
    expect(e2.spendState().alertsFired).toContain('day_50');
    void engine;
  });
});
