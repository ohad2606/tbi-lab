/**
 * TBI-018 follow-ups before the s3d host wiring (FABLE-REVIEW 11, 12, 15): journal throttle and bounded
 * memory, principal check on heartbeat/close, lease boundary, plan missing from the config.
 */
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { SimHostAdapter } from '../simhost.js';
import { SimMeter, type SimEvent, type SimResult } from '../simminutes.js';
import { MemoryStore } from '../store.js';
import { FakeClock, monthStart } from '../time.js';
import { ADV, FREE, NOON } from './helpers.js';

const LEASE = 30_000;
const TZ = 'Asia/Jerusalem';
const code = (r: SimResult<object>): string =>
  r.ok ? (r.metered ? 'ok' : 'unmetered') : r.error.code;

async function make(
  overrides: unknown = {},
  beatPersistMs?: number,
  store?: MemoryStore<SimEvent>,
) {
  const config = parseConfig({ ...(overrides as object), metering: { enabled: true } });
  const clock = new FakeClock(NOON);
  const st = store ?? new MemoryStore<SimEvent>();
  const meter = await SimMeter.open(st, { config, clock, beatPersistMs });
  return { meter, clock, store: st, config };
}
const beats = (s: MemoryStore<SimEvent>): number =>
  s.events.filter((e) => e.t === 'sim_beat').length;

describe('SimMeter heartbeat journal throttle (FABLE-REVIEW 11)', () => {
  it('writes at most one beat per persist interval; billing is the same as with every beat journaled', async () => {
    const thr = await make({}, 10_000);
    const all = await make({}, 0);
    for (const s of [thr, all]) {
      await s.meter.open('s1', ADV, 'advanced');
      for (let i = 0; i < 12; i++) {
        s.clock.advance(5_000);
        expect(code(await s.meter.heartbeat('s1'))).toBe('ok');
      }
    }
    expect(beats(all.store)).toBe(12);
    expect(beats(thr.store)).toBe(6);
    const a = await thr.meter.close('s1');
    const b = await all.meter.close('s1');
    expect(a.ok && a.metered && a.billedMs).toBe(60_000);
    expect(b.ok && b.metered && b.billedMs).toBe(60_000);
  });

  it('a close journals the newest beat first, so the journal replays to the same state', async () => {
    const s = await make({}, 20_000);
    await s.meter.open('s1', ADV, 'advanced');
    s.clock.advance(5_000);
    await s.meter.heartbeat('s1'); // not journaled (5 s < 20 s)
    s.clock.advance(5_000);
    await s.meter.heartbeat('s1'); // not journaled
    expect(beats(s.store)).toBe(0);
    s.clock.advance(LEASE + 1_000); // lease measured from the in-memory beat (10 s) -> expired at 40 s
    const r = await s.meter.close('s1', 'lease');
    expect(r.ok && r.metered && r.billedMs).toBe(10_000 + LEASE);
    expect(beats(s.store)).toBe(1);
    const re = await SimMeter.open(s.store, { config: s.config, clock: s.clock });
    expect(re.storeProblem).toBeUndefined();
    expect(re.stateJson()).toBe(s.meter.stateJson());
  });

  it('billing stays capped at the heartbeat that detected 0 (D-day0812-1), also when throttled', async () => {
    const s = await make({ sim: { plans: { free: { monthlyMinutes: 1 } } } }, 20_000);
    await s.meter.open('s1', FREE, 'free');
    for (let i = 0; i < 5; i++) {
      s.clock.advance(10_000);
      expect(code(await s.meter.heartbeat('s1'))).toBe('ok');
    }
    s.clock.advance(10_000); // 60 s used = the whole minute
    expect(code(await s.meter.heartbeat('s1'))).toBe('minutes_out_free');
    const c = await s.meter.close('s1');
    expect(c.ok && c.metered && c.billedMs).toBe(60_000);
    const re = await SimMeter.open(s.store, { config: s.config, clock: s.clock });
    expect(re.storeProblem).toBeUndefined();
    expect(re.stateJson()).toBe(s.meter.stateJson());
  });

  it('after a crash the replay bills up to the last JOURNALED beat + lease: never more than the live bill', async () => {
    const s = await make({}, 20_000);
    await s.meter.open('s1', ADV, 'advanced');
    s.clock.advance(15_000);
    await s.meter.heartbeat('s1'); // memory only
    // crash: a new meter replays the journal; the lease ran out at journaled lastBeat (0) + 30 s
    s.clock.advance(60_000);
    const re = await SimMeter.open(s.store, { config: s.config, clock: s.clock });
    const ss = re.session('s1');
    expect(ss?.closeReason).toBe('lease');
    expect(ss?.billedMs).toBe(LEASE);
    expect(ss?.billedMs).toBeLessThanOrEqual(15_000 + LEASE);
  });

  it('closed sessions and usage older than the previous month are evicted; allowance is unchanged', async () => {
    const s = await make({}, 0);
    await s.meter.open('old', ADV, 'advanced');
    s.clock.advance(60_000);
    await s.meter.close('old');
    s.clock.advance(monthStart(NOON, TZ, 2) + 3_600_000 - s.clock.now()); // two months later
    await s.meter.open('new', ADV, 'advanced');
    s.clock.advance(1_000);
    await s.meter.close('new');
    expect(s.meter.session('old')).toBeUndefined();
    expect(s.meter.session('new')?.billedMs).toBe(1_000);
    const json = JSON.parse(s.meter.stateJson()) as {
      usage: Record<string, Record<string, number>>;
    };
    expect(Object.keys(json.usage[ADV] ?? {})).toHaveLength(1);
    // a fresh replay is bounded the same way
    const re = await SimMeter.open(s.store, { config: s.config, clock: s.clock });
    expect(re.session('old')).toBeUndefined();
    const r = re.remaining(ADV, 'advanced');
    expect(r.ok && r.metered && r.usedMonthMs).toBe(1_000);
  });

  it('last month is kept', async () => {
    const s = await make({}, 0);
    await s.meter.open('prev', ADV, 'advanced');
    s.clock.advance(60_000);
    await s.meter.close('prev');
    s.clock.advance(monthStart(NOON, TZ, 1) + 3_600_000 - s.clock.now());
    await s.meter.sweep();
    expect(s.meter.session('prev')?.billedMs).toBe(LEASE); // capped at the lease, no beat
  });
});

describe('SimMeter principal check on heartbeat/close (FABLE-REVIEW 12)', () => {
  it("another principal's session answers like an unknown one and nothing changes", async () => {
    const s = await make();
    await s.meter.open('s1', ADV, 'advanced');
    s.clock.advance(5_000);
    const unknown = code(await s.meter.heartbeat('nope', FREE));
    expect(code(await s.meter.heartbeat('s1', FREE))).toBe(unknown);
    expect(code(await s.meter.close('s1', 'ended', FREE))).toBe(unknown);
    expect(s.meter.session('s1')?.closedAt).toBeUndefined();
    expect(code(await s.meter.heartbeat('s1', ADV))).toBe('ok');
    const c = await s.meter.close('s1', 'ended', ADV);
    expect(c.ok && c.metered && c.billedMs).toBe(5_000);
    // closed session: still no data for a foreign principal
    expect(code(await s.meter.close('s1', 'ended', FREE))).toBe(unknown);
  });

  it('the adapter does not touch or end a run for the wrong principal', async () => {
    const config = parseConfig({ metering: { enabled: true } });
    const clock = new FakeClock(NOON);
    const host = await SimHostAdapter.open(new MemoryStore<SimEvent>(), { config, clock });
    const a = await host.admit({
      ticket: 't1',
      sessionId: 'sess1',
      principal: ADV,
      plan: 'advanced',
      slots: { capacity: 6, running: 0 },
    });
    expect(a.metered && a.decision).toBe('start');
    const wrong = await host.heartbeat('sess1', FREE);
    expect(wrong.metered && wrong.decision).toBe('stop');
    const end = await host.ended('sess1', 'ended', FREE);
    expect(end.metered && end.ok).toBe(false);
    expect(host.tracked).toBe(1);
    const right = await host.heartbeat('sess1', ADV);
    expect(right.metered && right.decision).toBe('continue');
    const done = await host.ended('sess1', 'ended', ADV);
    expect(done.metered && done.ok).toBe(true);
    expect(host.tracked).toBe(0);
  });
});

describe('SimMeter lease boundary and missing plan config (FABLE-REVIEW 15)', () => {
  it('a heartbeat exactly at lastBeat + lease is alive, +1 ms is lease_lost', async () => {
    const s = await make({}, 0);
    await s.meter.open('s1', ADV, 'advanced');
    s.clock.advance(LEASE);
    expect(code(await s.meter.heartbeat('s1'))).toBe('ok');
    s.clock.advance(LEASE + 1);
    expect(code(await s.meter.heartbeat('s1'))).toBe('lease_lost');
  });

  it('sweep does not close at exactly the lease, closes at +1 ms and bills exactly the lease', async () => {
    const s = await make({}, 0);
    await s.meter.open('s1', ADV, 'advanced');
    s.clock.advance(LEASE);
    const at = await s.meter.sweep();
    expect(at.ok && at.metered && at.closed).toBe(0);
    s.clock.advance(1);
    const after = await s.meter.sweep();
    expect(after.ok && after.metered && after.closed).toBe(1);
    expect(s.meter.session('s1')?.billedMs).toBe(LEASE);
  });

  it('the concurrent-session count uses the same boundary (live at expiry, free at +1 ms)', async () => {
    const s = await make({}, 0);
    await s.meter.open('s1', ADV, 'advanced');
    s.clock.advance(LEASE);
    expect(code(await s.meter.open('s2', ADV, 'advanced'))).toBe('sim_concurrent');
    s.clock.advance(1);
    expect(code(await s.meter.open('s2', ADV, 'advanced'))).toBe('ok');
  });

  it('open with a plan missing from sim.plans is system_unavailable and writes nothing', async () => {
    const s = await make();
    delete (s.config.sim.plans as Partial<Record<string, unknown>>).advanced;
    expect(code(await s.meter.open('s1', ADV, 'advanced'))).toBe('system_unavailable');
    expect(code(s.meter.remaining(ADV, 'advanced'))).toBe('system_unavailable');
    expect(s.store.appendCalls).toBe(0);
    expect(code(await s.meter.open('s2', FREE, 'free'))).toBe('ok');
  });
});
