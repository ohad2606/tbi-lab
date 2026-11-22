/**
 * TBI-018 s3c ops-review follow-ups for SimHostAdapter:
 *  M1 queue operations by ticket act only on the caller's own entry (admit drop, cancel, touch);
 *  M2 housekeeping prunes live entries whose meter session is closed or whose lease ran out;
 *  L1 admit never loses another waiter when its own entry vanished between the check and the dequeue.
 */
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import type { FairQueue } from '../queue.js';
import type { SimEvent } from '../simminutes.js';
import { SimHostAdapter, type HostSlots } from '../simhost.js';
import { MemoryStore } from '../store.js';
import { FakeClock } from '../time.js';
import { ADV, FREE, NOON } from './helpers.js';

const MIN = 60_000;
const PRO = 'p_prouser00001';
const sid = (n: number): string => n.toString(16).padStart(32, '0');
const slots = (running: number, capacity = 6): HostSlots => ({ capacity, running });

async function make(overrides: unknown = {}) {
  const config = parseConfig({ ...(overrides as object), metering: { enabled: true } });
  const clock = new FakeClock(NOON);
  const store = new MemoryStore<SimEvent>();
  const host = await SimHostAdapter.open(store, { config, clock });
  return { host, clock, store, config };
}

/** FREE uses up its 1 Free minute, then waits out the cooldown: every later admit is refused. */
async function exhaustFree(host: SimHostAdapter, clock: FakeClock): Promise<void> {
  await host.admit({
    ticket: 'f1',
    sessionId: sid(1),
    principal: FREE,
    plan: 'free',
    slots: slots(0),
  });
  for (let i = 0; i < 3; i++) {
    clock.advance(20_000);
    await host.heartbeat(sid(1));
  }
  await host.ended(sid(1), 'ended');
  clock.advance(10 * MIN);
}

describe('M1: ticket operations check the principal', () => {
  it("a refused admit with someone else's ticket does not drop that waiter", async () => {
    const { host, clock } = await make({ sim: { plans: { free: { monthlyMinutes: 1 } } } });
    await exhaustFree(host, clock);
    const a = await host.admit({
      ticket: 'tA',
      sessionId: sid(2),
      principal: PRO,
      plan: 'pro',
      slots: slots(6),
    });
    expect(a).toMatchObject({ decision: 'queued', position: 1 });
    const b = await host.admit({
      ticket: 'tA',
      sessionId: sid(3),
      principal: FREE,
      plan: 'free',
      slots: slots(6),
    });
    expect(b).toMatchObject({ decision: 'refused', error: { code: 'minutes_out_free' } });
    expect(host.waiting).toBe(1);
    // A's next poll still finds its place
    expect(
      await host.admit({
        ticket: 'tA',
        sessionId: sid(2),
        principal: PRO,
        plan: 'pro',
        slots: slots(6),
      }),
    ).toMatchObject({ decision: 'queued', position: 1 });
  });

  it('a refused admit with its own ticket still drops its own waiting entry', async () => {
    const { host, clock } = await make({ sim: { plans: { free: { monthlyMinutes: 1 } } } });
    // FREE queues behind a full host while it still has minutes, then runs out on another run
    await host.admit({
      ticket: 'f1',
      sessionId: sid(1),
      principal: FREE,
      plan: 'free',
      slots: slots(0),
    });
    await host.admit({
      ticket: 'fq',
      sessionId: sid(5),
      principal: ADV,
      plan: 'advanced',
      slots: slots(6),
    });
    expect(host.waiting).toBe(1);
    for (let i = 0; i < 3; i++) {
      clock.advance(20_000);
      await host.heartbeat(sid(1));
      expect(host.touch('fq', ADV)).toEqual({ metered: true, queued: true });
    }
    await host.ended(sid(1), 'ended');
    const r = await host.admit({
      ticket: 'fq',
      sessionId: sid(6),
      principal: FREE,
      plan: 'free',
      slots: slots(6),
    });
    expect(r).toMatchObject({ decision: 'refused' });
    // ADV's entry is not FREE's: it stays
    expect(host.waiting).toBe(1);
    expect(host.cancel('fq', ADV)).toEqual({ metered: true, cancelled: true });
    expect(host.waiting).toBe(0);
  });

  it("user B cannot cancel user A's ticket", async () => {
    const { host } = await make();
    await host.admit({
      ticket: 'tA',
      sessionId: sid(2),
      principal: PRO,
      plan: 'pro',
      slots: slots(6),
    });
    expect(host.cancel('tA', ADV)).toEqual({ metered: true, cancelled: false });
    expect(host.waiting).toBe(1);
    expect(host.cancel('tA', PRO)).toEqual({ metered: true, cancelled: true });
    expect(host.waiting).toBe(0);
  });

  it("user B cannot touch user A's ticket (A's client still vanishes)", async () => {
    const { host, clock } = await make();
    await host.admit({
      ticket: 'tA',
      sessionId: sid(2),
      principal: PRO,
      plan: 'pro',
      slots: slots(6),
    });
    for (let i = 0; i < 3; i++) {
      clock.advance(15_000);
      expect(host.touch('tA', ADV)).toEqual({ metered: true, queued: false });
    }
    const h = await host.housekeeping();
    expect(h).toMatchObject({ ok: true, dropped: [{ ticket: 'tA', reason: 'vanished' }] });
    expect(host.waiting).toBe(0);
  });
});

describe('M2: housekeeping prunes runs the host never reported ended', () => {
  it('a lease-lost run is closed by the sweep and stops counting as running', async () => {
    const { host, clock } = await make({ queue: { freeSlotCap: 1 } });
    const s = await host.admit({
      ticket: 'f1',
      sessionId: sid(1),
      principal: FREE,
      plan: 'free',
      slots: slots(0),
    });
    expect(s).toMatchObject({ decision: 'start' });
    expect(host.tracked).toBe(1);
    clock.advance(31_000); // past the 30 s lease, no heartbeat, no ended()
    const h = await host.housekeeping();
    expect(h).toMatchObject({ metered: true, ok: true, closed: 1, pruned: 1 });
    expect(host.tracked).toBe(0);
    expect(host.planOf(sid(1))).toBeUndefined();
    // the late ended() is a duplicate: same bill, no second cooldown / slot release
    expect(await host.ended(sid(1), 'lease')).toEqual({
      metered: true,
      ok: true,
      billedMs: 30_000,
    });
    expect(host.tracked).toBe(0);
  });

  it('the pruned Free run starts the Free cooldown (counted from the prune)', async () => {
    const { host, clock } = await make();
    await host.admit({
      ticket: 'f1',
      sessionId: sid(1),
      principal: FREE,
      plan: 'free',
      slots: slots(0),
    });
    clock.advance(31_000);
    await host.housekeeping();
    const r = await host.admit({
      ticket: 'f2',
      sessionId: sid(2),
      principal: FREE,
      plan: 'free',
      slots: slots(0),
    });
    expect(r).toMatchObject({ decision: 'refused', error: { code: 'sim_cooldown' } });
  });

  it('a live run whose lease has not run out is kept', async () => {
    const { host, clock } = await make();
    await host.admit({
      ticket: 'a1',
      sessionId: sid(1),
      principal: ADV,
      plan: 'advanced',
      slots: slots(0),
    });
    clock.advance(20_000);
    await host.heartbeat(sid(1));
    clock.advance(20_000);
    expect(await host.housekeeping()).toMatchObject({ ok: true, closed: 0, pruned: 0 });
    expect(host.tracked).toBe(1);
  });

  it('a stuck live entry no longer blocks the slot for the next waiter', async () => {
    const { host, clock } = await make();
    await host.admit({
      ticket: 'a1',
      sessionId: sid(1),
      principal: ADV,
      plan: 'advanced',
      slots: slots(0, 1),
    });
    // the host thinks it is idle (it lost the session without telling us)
    clock.advance(31_000);
    expect(
      await host.admit({
        ticket: 'p1',
        sessionId: sid(2),
        principal: PRO,
        plan: 'pro',
        slots: slots(0, 1),
      }),
    ).toMatchObject({ decision: 'queued' });
    await host.housekeeping();
    expect(
      await host.admit({
        ticket: 'p1',
        sessionId: sid(2),
        principal: PRO,
        plan: 'pro',
        slots: slots(0, 1),
      }),
    ).toMatchObject({ decision: 'start' });
  });
});

describe('L1: admit never loses another waiter', () => {
  it('own entry times out between the check and the dequeue: refused with queue_timeout, the next waiter stays', async () => {
    const ADV2 = 'p_advanced0002';
    const { host, clock, config } = await make();
    await host.admit({
      ticket: 'a1',
      sessionId: sid(1),
      principal: ADV,
      plan: 'advanced',
      slots: slots(6),
    });
    clock.advance(15_000);
    await host.admit({
      ticket: 'a2',
      sessionId: sid(2),
      principal: ADV2,
      plan: 'advanced',
      slots: slots(6),
    });
    // keep both clients alive until 1 ms before a1's max wait
    let waited = 15_000;
    while (waited + 15_000 < config.queue.maxWaitMs) {
      clock.advance(15_000);
      waited += 15_000;
      host.touch('a1', ADV);
      host.touch('a2', ADV2);
    }
    clock.advance(config.queue.maxWaitMs - waited - 1);
    host.touch('a2', ADV2);
    // a real clock moves on inside the call: a1's max wait elapses right after its enqueue
    const q = (host as unknown as { queue: FairQueue }).queue;
    const enqueue = q.enqueue.bind(q);
    q.enqueue = (r) => {
      const out = enqueue(r);
      clock.advance(1);
      return out;
    };
    const r = await host.admit({
      ticket: 'a1',
      sessionId: sid(1),
      principal: ADV,
      plan: 'advanced',
      slots: slots(0),
    });
    expect(r).toMatchObject({
      decision: 'refused',
      error: { code: 'queue_timeout' },
      dropped: [{ ticket: 'a1', reason: 'timeout' }],
    });
    expect(host.tracked).toBe(0);
    // a2 was not taken out of the queue on a1's behalf
    expect(q.snapshot().map((e) => e.ticket)).toEqual(['a2']);
    q.enqueue = enqueue;
    expect(
      await host.admit({
        ticket: 'a2',
        sessionId: sid(2),
        principal: ADV2,
        plan: 'advanced',
        slots: slots(0),
      }),
    ).toMatchObject({ decision: 'start' });
  });
});

describe('FairQueue.dequeue(slots, only)', () => {
  it('hands out the next entry only when it has that ticket; otherwise removes nothing', async () => {
    const { FairQueue } = await import('../queue.js');
    const config = parseConfig({ metering: { enabled: true } });
    const q = new FairQueue(config, new FakeClock(NOON));
    q.enqueue({ ticket: 'x', principal: PRO, plan: 'pro', simMsToday: 0 });
    q.enqueue({ ticket: 'y', principal: ADV, plan: 'advanced', simMsToday: 0 });
    const open = { capacity: 6, running: 0, runningFree: 0 };
    expect(q.dequeue(open, 'y').entry).toBeNull();
    expect(q.length).toBe(2);
    expect(q.dequeue(open, 'x').entry?.ticket).toBe('x');
    expect(q.dequeue(open, 'y').entry?.ticket).toBe('y');
    expect(q.length).toBe(0);
  });
});
