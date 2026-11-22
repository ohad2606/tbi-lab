/**
 * TBI-018 slice 3c: the s3b follow-ups.
 *  - PlansEngine (reserve.ts) fails closed after a failed append, like SimMeter (a failed append may have
 *    written part of the batch; the next append would reuse its sequence numbers).
 *  - SimMeter replay validates every number and the billing invariants of an event (a tampered or
 *    damaged journal is corrupt, never billed).
 *  - SimMeter.admissible: the allowance check without opening (the host adapter asks it before queueing).
 */
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { SimMeter, applySimEvent, emptySimState, type SimEvent } from '../simminutes.js';
import { MemoryStore } from '../store.js';
import { FakeClock } from '../time.js';
import { ADV, FREE, NOON, req, setup } from './helpers.js';

describe('PlansEngine append failure (s3b follow-up)', () => {
  it('a failed append fails the engine closed until the journal is reloaded', async () => {
    const { engine, store } = await setup();
    const mem = store as MemoryStore;
    expect((await engine.admit(req(FREE))).ok).toBe(true);
    mem.failOnCall = mem.appendCalls + 1;
    const failed = await engine.admit(req(FREE));
    expect(!failed.ok && failed.error.code).toBe('system_unavailable');
    expect(engine.storeProblem).toMatchObject({ kind: 'corrupt', detail: 'append failed' });
    // the store works again, but the engine does not write on top of a possibly partial batch
    const calls = mem.appendCalls;
    const next = await engine.admit(req(FREE));
    expect(!next.ok && next.error.code).toBe('system_unavailable');
    expect(mem.appendCalls).toBe(calls);
    // explicit reload (recover) replays the journal and the engine serves again
    expect(await engine.recover()).toEqual({ ok: true });
    expect((await engine.admit(req(FREE))).ok).toBe(true);
  });
});

const T0 = NOON;
const open = (over: Partial<SimEvent> = {}): SimEvent =>
  ({
    t: 'sim_open',
    sessionId: 's1',
    principal: FREE,
    plan: 'free',
    leaseMs: 30_000,
    seq: 1,
    at: T0,
    ...over,
  }) as SimEvent;
const close = (over: Record<string, unknown> = {}): SimEvent =>
  ({
    t: 'sim_close',
    sessionId: 's1',
    reason: 'ended',
    endAt: T0 + 10_000,
    billedMs: 10_000,
    parts: [{ dayKey: '2026-11-19', ms: 10_000 }],
    seq: 2,
    at: T0 + 10_000,
    ...over,
  }) as SimEvent;

function replay(events: SimEvent[]): void {
  const s = emptySimState();
  for (const ev of events) applySimEvent(s, ev);
}

describe('SimMeter replay numeric validation (s3b follow-up)', () => {
  it('a well-formed open/close replays', () => {
    expect(() => replay([open(), close()])).not.toThrow();
  });

  it.each([
    ['NaN at', open({ at: Number.NaN })],
    ['string at', open({ at: '1' as unknown as number })],
    ['negative at', open({ at: -1 })],
    ['zero lease', open({ leaseMs: 0 } as Partial<SimEvent>)],
    ['fractional lease', open({ leaseMs: 1.5 } as Partial<SimEvent>)],
    ['unknown plan', open({ plan: 'gold' } as unknown as Partial<SimEvent>)],
  ])('sim_open with %s is corrupt', (_n, ev) => {
    expect(() => replay([ev])).toThrow();
  });

  it.each([
    ['negative billed', { billedMs: -10_000, parts: [{ dayKey: '2026-11-19', ms: -10_000 }] }],
    [
      'billed != endAt - openedAt',
      { billedMs: 99_000, parts: [{ dayKey: '2026-11-19', ms: 99_000 }] },
    ],
    ['parts do not sum to billed', { parts: [{ dayKey: '2026-11-19', ms: 5_000 }] }],
    ['endAt before open', { endAt: T0 - 1, billedMs: -1, parts: [] }],
    [
      'endAt after lastBeat + lease',
      {
        endAt: T0 + 40_000,
        billedMs: 40_000,
        at: T0 + 40_000,
        parts: [{ dayKey: '2026-11-19', ms: 40_000 }],
      },
    ],
    ['endAt after the event time', { at: T0 + 5_000 }],
    ['unknown reason', { reason: 'magic' }],
    ['parts not an array', { parts: null }],
    ['NaN part', { parts: [{ dayKey: '2026-11-19', ms: Number.NaN }] }],
    ['Infinity endAt', { endAt: Number.POSITIVE_INFINITY }],
  ])('sim_close with %s is corrupt', (_n, over) => {
    expect(() => replay([open(), close(over)])).toThrow();
  });

  it('a journal with an inflated close makes the meter refuse with system_unavailable', async () => {
    const store = new MemoryStore<SimEvent>();
    store.events.push(
      open(),
      close({ billedMs: 3_600_000, parts: [{ dayKey: '2026-11-19', ms: 3_600_000 }] }),
    );
    const config = parseConfig({ metering: { enabled: true } });
    const meter = await SimMeter.open(store, { config, clock: new FakeClock(T0 + 20_000) });
    expect(meter.storeProblem).toMatchObject({ kind: 'corrupt' });
    const r = await meter.open('s2', FREE, 'free');
    expect(!r.ok && r.error.code).toBe('system_unavailable');
    expect(store.appendCalls).toBe(0);
  });
});

describe('SimMeter.admissible', () => {
  it('answers the remaining time, the exhausted refusal, or unmetered; writes nothing', async () => {
    const store = new MemoryStore<SimEvent>();
    const clock = new FakeClock(T0);
    const config = parseConfig({
      metering: { enabled: true },
      sim: { plans: { free: { monthlyMinutes: 1 } } },
    });
    const meter = await SimMeter.open(store, { config, clock });
    const a = meter.admissible(FREE, 'free');
    expect(a.ok && a.metered && a.monthMs).toBe(60_000);
    await meter.open('s1', FREE, 'free');
    clock.advance(20_000);
    await meter.heartbeat('s1');
    clock.advance(20_000);
    await meter.heartbeat('s1');
    clock.advance(20_000);
    const out = meter.admissible(FREE, 'free');
    expect(!out.ok && out.error.code).toBe('minutes_out_free');
    expect(meter.admissible(ADV, 'advanced').ok).toBe(true);
    const calls = store.appendCalls;
    meter.admissible(FREE, 'free');
    expect(store.appendCalls).toBe(calls);
    const off = await SimMeter.open(new MemoryStore<SimEvent>(), {
      config: parseConfig({}),
      clock,
    });
    expect(off.admissible(FREE, 'free')).toEqual({ ok: true, metered: false });
  });
});
