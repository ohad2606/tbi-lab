/**
 * TBI-018 slice 3c: SimHostAdapter, the thin layer the Session Host will call (admit at session open,
 * heartbeat while it runs, ended when it ends). Flag off = inert; flag on = admit / queue / bill / stop;
 * every failure refuses or stops with an explicit reason.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseConfig, type PlanId } from '../config.js';
import type { SimEvent } from '../simminutes.js';
import {
  SimHostAdapter,
  closeReasonOf,
  type HostAdmit,
  type HostBeat,
  type HostSlots,
} from '../simhost.js';
import { MemoryStore } from '../store.js';
import { FakeClock } from '../time.js';
import { ADV, FREE, LEG, NOON } from './helpers.js';

const MIN = 60_000;
const PRO = 'p_prouser00001';
const sid = (n: number): string => n.toString(16).padStart(32, '0');
const p = (n: number): string => `p_user${String(n).padStart(8, '0')}`;

async function make(overrides: unknown = {}, enabled = true) {
  const config = parseConfig({ ...(overrides as object), metering: { enabled } });
  const clock = new FakeClock(NOON);
  const store = new MemoryStore<SimEvent>();
  const host = await SimHostAdapter.open(store, { config, clock });
  return { host, clock, store, config };
}

const slots = (running: number, capacity = 6): HostSlots => ({ capacity, running });
const decision = (r: HostAdmit): string =>
  !r.metered ? 'unmetered' : r.decision === 'refused' ? `refused:${r.error.code}` : r.decision;
const beat = (r: HostBeat): string =>
  !r.metered
    ? 'unmetered'
    : r.decision === 'continue'
      ? 'continue'
      : `${r.decision}:${r.error.code}`;

let t = 0;
const ticket = (): string => `t${++t}`;

describe('SimHostAdapter flag off (metering.enabled=false, the default)', () => {
  it('the defaults keep metering off and carry the approved DRAFT numbers as config only', () => {
    expect(DEFAULT_CONFIG.metering.enabled).toBe(false);
    expect(DEFAULT_CONFIG.sim.plans.free.monthlyMinutes).toBe(60);
    expect(DEFAULT_CONFIG.sim.plans.advanced.monthlyMinutes).toBe(900);
    expect(DEFAULT_CONFIG.sim.plans.pro.monthlyMinutes).toBe(2400);
    expect(DEFAULT_CONFIG.sim.plans.legacy.monthlyMinutes).toBeNull();
    expect(DEFAULT_CONFIG.queue.maxFree).toBe(16);
  });

  it('every call answers { metered: false }, writes nothing and queues nothing', async () => {
    const { host, store, clock } = await make({}, false);
    expect(host.enabled).toBe(false);
    for (let i = 0; i < 20; i++) {
      // even a full host and an unknown plan: the adapter takes no decision when off
      expect(
        await host.admit({
          ticket: ticket(),
          sessionId: sid(i + 1),
          principal: FREE,
          plan: 'free',
          slots: slots(6),
        }),
      ).toEqual({ metered: false });
      expect(await host.heartbeat(sid(i + 1))).toEqual({ metered: false });
      expect(await host.ended(sid(i + 1), 'ended', FREE)).toEqual({ metered: false });
      clock.advance(MIN);
    }
    expect(await host.housekeeping()).toEqual({ metered: false });
    expect(host.cancel('t1', FREE)).toEqual({ metered: false });
    expect(host.touch('t1', FREE)).toEqual({ metered: false });
    expect(store.appendCalls).toBe(0);
    expect(store.events).toEqual([]);
    expect(host.waiting).toBe(0);
    expect(host.tracked).toBe(0);
  });
});

describe('SimHostAdapter admit at session open', () => {
  it('a free slot starts the run: the meter opens the session with the plan fixed at open', async () => {
    const { host, store } = await make();
    const r = await host.admit({
      ticket: ticket(),
      sessionId: sid(1),
      principal: ADV,
      plan: 'advanced',
      slots: slots(0),
    });
    expect(r).toMatchObject({ metered: true, decision: 'start', remainingMs: 900 * MIN });
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ t: 'sim_open', plan: 'advanced', principal: ADV });
    expect(host.tracked).toBe(1);
    expect(host.waiting).toBe(0);
  });

  it('6 slots full: the request is queued with its position; nothing is opened or billed', async () => {
    const { host, store } = await make();
    const r = await host.admit({
      ticket: ticket(),
      sessionId: sid(1),
      principal: FREE,
      plan: 'free',
      slots: slots(6),
    });
    expect(r).toMatchObject({
      metered: true,
      decision: 'queued',
      position: 1,
      status: { code: 'queue', messageKey: 'limit.sim.queue', params: { n: 1 } },
    });
    expect(store.appendCalls).toBe(0);
    expect(host.waiting).toBe(1);
  });

  it('a freed slot goes to the higher plan; Free waits; nobody jumps a waiting entry', async () => {
    const { host } = await make();
    const tf = ticket();
    const tp = ticket();
    expect(
      decision(
        await host.admit({
          ticket: tf,
          sessionId: sid(1),
          principal: FREE,
          plan: 'free',
          slots: slots(6),
        }),
      ),
    ).toBe('queued');
    expect(
      decision(
        await host.admit({
          ticket: tp,
          sessionId: sid(2),
          principal: PRO,
          plan: 'pro',
          slots: slots(6),
        }),
      ),
    ).toBe('queued');
    // one slot frees; Free polls first but Pro is ahead of it
    const f = await host.admit({
      ticket: tf,
      sessionId: sid(1),
      principal: FREE,
      plan: 'free',
      slots: slots(5),
    });
    expect(f).toMatchObject({ decision: 'queued', position: 2 });
    // a new Free arrival is queued behind, not started
    const late = await host.admit({
      ticket: ticket(),
      sessionId: sid(3),
      principal: p(1),
      plan: 'free',
      slots: slots(5),
    });
    expect(late).toMatchObject({ decision: 'queued', position: 3 });
    const pr = await host.admit({
      ticket: tp,
      sessionId: sid(2),
      principal: PRO,
      plan: 'pro',
      slots: slots(5),
    });
    expect(decision(pr)).toBe('start');
    expect(host.waiting).toBe(2);
  });

  it('Free slot cap (4 of 6): a 5th Free waits while Advanced and legacy start (legacy is not under the Free cap)', async () => {
    const { host } = await make();
    for (let i = 0; i < 4; i++)
      expect(
        decision(
          await host.admit({
            ticket: ticket(),
            sessionId: sid(i + 1),
            principal: p(i),
            plan: 'free',
            slots: slots(i),
          }),
        ),
      ).toBe('start');
    const fifth = await host.admit({
      ticket: ticket(),
      sessionId: sid(5),
      principal: p(4),
      plan: 'free',
      slots: slots(4),
    });
    expect(decision(fifth)).toBe('queued');
    expect(
      decision(
        await host.admit({
          ticket: ticket(),
          sessionId: sid(6),
          principal: LEG,
          plan: 'legacy',
          slots: slots(4),
        }),
      ),
    ).toBe('start');
    expect(
      decision(
        await host.admit({
          ticket: ticket(),
          sessionId: sid(7),
          principal: ADV,
          plan: 'advanced',
          slots: slots(5),
        }),
      ),
    ).toBe('start');
  });

  it('queue.maxFree (16): the 17th waiting Free is refused queue_full; a paid user still joins', async () => {
    const { host } = await make();
    for (let i = 0; i < 16; i++)
      expect(
        decision(
          await host.admit({
            ticket: ticket(),
            sessionId: sid(i + 1),
            principal: p(i),
            plan: 'free',
            slots: slots(6),
          }),
        ),
      ).toBe('queued');
    expect(
      decision(
        await host.admit({
          ticket: ticket(),
          sessionId: sid(17),
          principal: p(16),
          plan: 'free',
          slots: slots(6),
        }),
      ),
    ).toBe('refused:queue_full');
    expect(
      decision(
        await host.admit({
          ticket: ticket(),
          sessionId: sid(18),
          principal: PRO,
          plan: 'pro',
          slots: slots(6),
        }),
      ),
    ).toBe('queued');
  });

  it('a user without minutes is refused before queueing (nobody waits for a run they cannot have)', async () => {
    const { host, clock } = await make({ sim: { plans: { free: { monthlyMinutes: 1 } } } });
    await host.admit({
      ticket: ticket(),
      sessionId: sid(1),
      principal: FREE,
      plan: 'free',
      slots: slots(0),
    });
    clock.advance(20_000);
    await host.heartbeat(sid(1));
    clock.advance(20_000);
    await host.heartbeat(sid(1));
    clock.advance(20_000);
    await host.ended(sid(1), 'ended', FREE);
    clock.advance(10 * MIN); // past the Free cooldown
    const r = await host.admit({
      ticket: ticket(),
      sessionId: sid(2),
      principal: FREE,
      plan: 'free',
      slots: slots(6),
    });
    expect(r).toMatchObject({
      decision: 'refused',
      error: { code: 'minutes_out_free', params: { date: '01.12.2026' } },
    });
    expect(host.waiting).toBe(0);
  });

  it('concurrent admits with the same (stale) slot picture never exceed the capacity', async () => {
    const { host } = await make();
    for (let i = 0; i < 5; i++)
      await host.admit({
        ticket: ticket(),
        sessionId: sid(i + 1),
        principal: p(i),
        plan: 'pro',
        slots: slots(i),
      });
    const [a, b] = await Promise.all([
      host.admit({
        ticket: ticket(),
        sessionId: sid(10),
        principal: p(10),
        plan: 'pro',
        slots: slots(5),
      }),
      host.admit({
        ticket: ticket(),
        sessionId: sid(11),
        principal: p(11),
        plan: 'pro',
        slots: slots(5),
      }),
    ]);
    expect([decision(a), decision(b)].sort()).toEqual(['queued', 'start']);
    expect(host.tracked).toBe(6);
  });
});

describe('SimHostAdapter bill at heartbeat, stop by remainingMs', () => {
  it('heartbeat answers the time left; at 0 the run must stop, billed up to that heartbeat', async () => {
    const { host, clock } = await make({ sim: { plans: { free: { monthlyMinutes: 1 } } } });
    const a = await host.admit({
      ticket: ticket(),
      sessionId: sid(1),
      principal: FREE,
      plan: 'free',
      slots: slots(0),
    });
    expect(a).toMatchObject({ decision: 'start', remainingMs: MIN });
    clock.advance(25_000);
    expect(await host.heartbeat(sid(1))).toEqual({
      metered: true,
      decision: 'continue',
      remainingMs: 35_000,
    });
    // the host stops when remainingMs elapses; its beat then detects 0 (it may be late by < one interval)
    clock.advance(20_000);
    expect(await host.heartbeat(sid(1))).toMatchObject({
      decision: 'continue',
      remainingMs: 15_000,
    });
    clock.advance(15_000 + 4_000);
    const s = await host.heartbeat(sid(1));
    expect(beat(s)).toBe('stop:minutes_out_free');
    const e = await host.ended(sid(1), 'ended', FREE);
    expect(e).toEqual({ metered: true, ok: true, billedMs: 64_000 });
    expect(host.tracked).toBe(0);
  });

  it('the plan is fixed at session open: the run bills against the plan it was admitted with', async () => {
    const { host, clock } = await make();
    await host.admit({
      ticket: ticket(),
      sessionId: sid(1),
      principal: ADV,
      plan: 'advanced',
      slots: slots(0),
    });
    clock.advance(10_000);
    const b = await host.heartbeat(sid(1));
    expect(b).toMatchObject({ decision: 'continue', remainingMs: 900 * MIN - 10_000 });
    expect(host.planOf(sid(1))).toBe('advanced');
  });

  it('Free cooldown also applies to a direct start (the host path calls cooldownMs)', async () => {
    const { host, clock } = await make();
    await host.admit({
      ticket: ticket(),
      sessionId: sid(1),
      principal: FREE,
      plan: 'free',
      slots: slots(0),
    });
    clock.advance(10_000);
    await host.ended(sid(1), 'ended', FREE);
    const r = await host.admit({
      ticket: ticket(),
      sessionId: sid(2),
      principal: FREE,
      plan: 'free',
      slots: slots(0),
    });
    expect(r).toMatchObject({
      decision: 'refused',
      error: { code: 'sim_cooldown', params: { n: 60 } },
    });
    clock.advance(60_000);
    expect(
      decision(
        await host.admit({
          ticket: ticket(),
          sessionId: sid(2),
          principal: FREE,
          plan: 'free',
          slots: slots(0),
        }),
      ),
    ).toBe('start');
  });

  it('closeReasonOf maps host end reasons to meter close reasons', () => {
    expect(closeReasonOf('lease_expired')).toBe('lease');
    expect(closeReasonOf('host_shutdown')).toBe('host');
    expect(closeReasonOf('terminated')).toBe('ended');
    expect(closeReasonOf('stopped')).toBe('ended');
  });
});

describe('SimHostAdapter fails closed with explicit reasons', () => {
  it('store append failure at open: refused system_unavailable, no slot taken, nothing billed', async () => {
    const { host, store } = await make();
    store.failOnCall = 'always';
    const r = await host.admit({
      ticket: ticket(),
      sessionId: sid(1),
      principal: ADV,
      plan: 'advanced',
      slots: slots(0),
    });
    expect(r).toMatchObject({ decision: 'refused', error: { code: 'system_unavailable' } });
    expect(host.tracked).toBe(0);
    expect(store.events).toEqual([]);
    // the meter stays closed: the next request is refused too, never started unmetered
    store.failOnCall = null;
    expect(
      decision(
        await host.admit({
          ticket: ticket(),
          sessionId: sid(2),
          principal: PRO,
          plan: 'pro',
          slots: slots(0),
        }),
      ),
    ).toBe('refused:system_unavailable');
  });

  it('store failure at heartbeat: the run is told to stop with system_unavailable', async () => {
    const { host, store, clock } = await make();
    await host.admit({
      ticket: ticket(),
      sessionId: sid(1),
      principal: ADV,
      plan: 'advanced',
      slots: slots(0),
    });
    store.failOnCall = 'always';
    clock.advance(10_000);
    expect(beat(await host.heartbeat(sid(1)))).toBe('stop:system_unavailable');
    const e = await host.ended(sid(1), 'ended', ADV);
    expect(e).toMatchObject({ metered: true, ok: false, error: { code: 'system_unavailable' } });
    expect(host.tracked).toBe(0);
  });

  it('unknown session, lost lease, bad slots and host/adapter disagreement are explicit', async () => {
    const { host, clock } = await make();
    expect(beat(await host.heartbeat(sid(9)))).toBe('stop:invalid_state');
    await host.admit({
      ticket: ticket(),
      sessionId: sid(1),
      principal: ADV,
      plan: 'advanced',
      slots: slots(0),
    });
    clock.advance(31_000);
    expect(beat(await host.heartbeat(sid(1)))).toBe('stop:lease_lost');
    for (const bad of [
      { capacity: Number.NaN, running: 0 },
      { capacity: 6, running: -1 },
      { capacity: 6, running: 1.5 },
    ])
      expect(
        decision(
          await host.admit({
            ticket: ticket(),
            sessionId: sid(2),
            principal: PRO,
            plan: 'pro',
            slots: bad,
          }),
        ),
      ).toBe('refused:invalid_request');
    // the host's count may lag the adapter (a stale picture): the larger count decides, never the smaller
    expect(
      decision(
        await host.admit({
          ticket: ticket(),
          sessionId: sid(3),
          principal: PRO,
          plan: 'pro',
          slots: slots(0, 1),
        }),
      ),
    ).toBe('queued');
    expect(
      decision(
        await host.admit({
          ticket: ticket(),
          sessionId: sid(5),
          principal: p(2),
          plan: 'gold' as PlanId,
          slots: slots(0),
        }),
      ),
    ).toBe('refused:invalid_request');
  });

  it('housekeeping drops timed-out waiters with queue_timeout and bills lease-lost runs', async () => {
    const { host, clock } = await make();
    await host.admit({
      ticket: ticket(),
      sessionId: sid(1),
      principal: ADV,
      plan: 'advanced',
      slots: slots(0),
    });
    const tw = ticket();
    await host.admit({
      ticket: tw,
      sessionId: sid(2),
      principal: PRO,
      plan: 'pro',
      slots: slots(6),
    });
    // the waiter keeps polling, the running session's client is gone
    for (let i = 0; i < 40; i++) {
      clock.advance(15_000);
      expect(host.touch(tw, PRO)).toEqual({ metered: true, queued: true });
    }
    const h = await host.housekeeping();
    expect(h).toMatchObject({
      metered: true,
      ok: true,
      closed: 1,
      pruned: 1,
      dropped: [{ ticket: tw, reason: 'timeout', error: { code: 'queue_timeout' } }],
    });
    // the lease-lost run no longer counts as running (TBI-018 s3c M2), even before the host reports it
    expect(host.tracked).toBe(0);
    expect(host.waiting).toBe(0);
    // the lease-lost run was billed up to its last beat + lease (30 s), not the 10 minutes since; the
    // late ended() is a duplicate
    expect(await host.ended(sid(1), 'lease', ADV)).toEqual({
      metered: true,
      ok: true,
      billedMs: 30_000,
    });
    expect(host.tracked).toBe(0);
  });

  it('cancel removes a waiting entry', async () => {
    const { host } = await make();
    const tw = ticket();
    await host.admit({
      ticket: tw,
      sessionId: sid(2),
      principal: PRO,
      plan: 'pro',
      slots: slots(6),
    });
    expect(host.cancel(tw, PRO)).toEqual({ metered: true, cancelled: true });
    expect(host.cancel(tw, PRO)).toEqual({ metered: true, cancelled: false });
    expect(host.waiting).toBe(0);
  });
});
