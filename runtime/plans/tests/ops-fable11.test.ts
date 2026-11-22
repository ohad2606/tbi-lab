/**
 * TBI-018 ops review of cfc7420 (FABLE-REVIEW 11-15 follow-ups):
 *  M1 a heartbeat with a foreign principal is refused, never 'stop' (the host must not stop another
 *     user's run on it);
 *  L2 a closed session pruned from memory cannot be opened again (a second sim_open would make the
 *     journal replay fail at the next restart);
 *  L3 admit's enqueue is the poll's sign of life: a waiting client that polls is not dropped as vanished
 *     first, and keeps its place.
 */
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { SimHostAdapter, type HostSlots } from '../simhost.js';
import { SimMeter, type SimEvent, type SimResult } from '../simminutes.js';
import { MemoryStore } from '../store.js';
import { FakeClock, monthStart } from '../time.js';
import { ADV, FREE, NOON } from './helpers.js';

const TZ = 'Asia/Jerusalem';
const PRO = 'p_prouser00001';
const code = (r: SimResult<object>): string =>
  r.ok ? (r.metered ? 'ok' : 'unmetered') : r.error.code;
const slots = (running: number, capacity = 6): HostSlots => ({ capacity, running });

async function adapter() {
  const config = parseConfig({ metering: { enabled: true } });
  const clock = new FakeClock(NOON);
  const store = new MemoryStore<SimEvent>();
  const host = await SimHostAdapter.open(store, { config, clock });
  return { host, clock, store, config };
}

describe('M1: foreign-principal heartbeat is refused, not stop', () => {
  it("leaves the victim's run going; its next own beat is continue", async () => {
    const { host, clock, store } = await adapter();
    const a = await host.admit({
      ticket: 't1',
      sessionId: 'victim1',
      principal: ADV,
      plan: 'advanced',
      slots: slots(0),
    });
    expect(a.metered && a.decision).toBe('start');
    clock.advance(5_000);
    const foreign = await host.heartbeat('victim1', FREE);
    expect(foreign).toEqual({
      metered: true,
      decision: 'refused',
      error: expect.objectContaining({ code: 'invalid_state' }),
    });
    expect(host.tracked).toBe(1);
    expect(store.events.filter((e) => e.t === 'sim_close')).toHaveLength(0);
    clock.advance(5_000);
    const own = await host.heartbeat('victim1', ADV);
    expect(own).toMatchObject({ metered: true, decision: 'continue' });
  });

  it('an unknown session id still answers stop (fail closed for the host its own run)', async () => {
    const { host } = await adapter();
    const r = await host.heartbeat('nosuch', ADV);
    expect(r).toMatchObject({ metered: true, decision: 'stop', error: { code: 'invalid_state' } });
  });
});

describe('L2: a pruned closed session id cannot be opened again', () => {
  it('reopen of a pruned id is refused, and a restart afterwards still replays', async () => {
    const config = parseConfig({ metering: { enabled: true } });
    const clock = new FakeClock(NOON);
    const store = new MemoryStore<SimEvent>();
    const meter = await SimMeter.open(store, { config, clock, beatPersistMs: 0 });
    await meter.open('old', ADV, 'advanced');
    clock.advance(60_000);
    await meter.close('old');
    clock.advance(monthStart(NOON, TZ, 2) + 3_600_000 - clock.now()); // two months later
    await meter.open('new', ADV, 'advanced');
    clock.advance(1_000);
    await meter.close('new'); // prunes 'old'
    expect(meter.session('old')).toBeUndefined();

    expect(code(await meter.open('old', ADV, 'advanced'))).toBe('invalid_state');
    expect(code(await meter.open('old', FREE, 'free'))).toBe('invalid_state');
    expect(store.events.filter((e) => e.t === 'sim_open' && e.sessionId === 'old')).toHaveLength(1);

    const re = await SimMeter.open(store, { config, clock });
    expect(re.storeProblem).toBeUndefined();
    // the tombstone is rebuilt by the replay
    expect(code(await re.open('old', ADV, 'advanced'))).toBe('invalid_state');
    expect(code(await re.open('fresh', ADV, 'advanced'))).toBe('ok');
    const again = await SimMeter.open(store, { config, clock });
    expect(again.storeProblem).toBeUndefined();
  });
});

describe('L3: admit poll is a sign of life', () => {
  it('a polling waiter past vanishMs is not dropped and keeps its place before a later waiter', async () => {
    const { host, clock, config } = await adapter();
    const vanish = config.queue.vanishMs;
    const a = await host.admit({
      ticket: 'tA',
      sessionId: 'sA',
      principal: PRO,
      plan: 'pro',
      slots: slots(6),
    });
    expect(a).toMatchObject({ decision: 'queued', position: 1 });
    clock.advance(vanish - 10_000);
    const b = await host.admit({
      ticket: 'tB',
      sessionId: 'sB',
      principal: ADV,
      plan: 'pro',
      slots: slots(6),
    });
    expect(b).toMatchObject({ decision: 'queued', position: 2 });
    clock.advance(10_000); // A's last sign of life is exactly vanishMs old
    const poll = await host.admit({
      ticket: 'tA',
      sessionId: 'sA',
      principal: PRO,
      plan: 'pro',
      slots: slots(6),
    });
    expect(poll).toMatchObject({ decision: 'queued', position: 1, dropped: [] });
    expect(host.waiting).toBe(2);
  });

  it("enqueue's own drops of other waiters are reported in dropped", async () => {
    const { host, clock, config } = await adapter();
    await host.admit({
      ticket: 'tA',
      sessionId: 'sA',
      principal: PRO,
      plan: 'pro',
      slots: slots(6),
    });
    clock.advance(config.queue.vanishMs);
    const b = await host.admit({
      ticket: 'tB',
      sessionId: 'sB',
      principal: ADV,
      plan: 'pro',
      slots: slots(6),
    });
    expect(b).toMatchObject({
      decision: 'queued',
      position: 1,
      dropped: [{ ticket: 'tA', principal: PRO, reason: 'vanished' }],
    });
  });
});
