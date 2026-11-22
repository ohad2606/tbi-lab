import { describe, expect, it } from 'vitest';
import { parseConfig, type PlanId } from '../config.js';
import { FairQueue, type Slots } from '../queue.js';
import { FakeClock } from '../time.js';
import { NOON, rng } from './helpers.js';

const pid = (i: number): string => `p_queueuser${String(i).padStart(4, '0')}`;
const MIN = 60_000;

function make(overrides: unknown = {}) {
  const cfg = parseConfig(overrides);
  const clock = new FakeClock(NOON);
  return { q: new FairQueue(cfg, clock), clock, cfg };
}

const open = (capacity: number, running = 0, runningFree = 0): Slots => ({
  capacity,
  running,
  runningFree,
});

describe('FairQueue order', () => {
  it('Pro, then Advanced (= legacy rank), then Free; then fewer minutes today; then FIFO', () => {
    const { q } = make();
    const add = (i: number, plan: PlanId, simMsToday: number) =>
      q.enqueue({ ticket: `t${i}`, principal: pid(i), plan, simMsToday });
    add(1, 'free', 0);
    add(2, 'advanced', 5 * MIN);
    add(3, 'pro', 9 * MIN);
    add(4, 'legacy', 1 * MIN);
    add(5, 'pro', 2 * MIN);
    add(6, 'free', 0);
    add(7, 'advanced', 5 * MIN);
    expect(q.snapshot().map((e) => e.ticket)).toEqual(['t5', 't3', 't4', 't2', 't7', 't1', 't6']);
    expect(q.position('t1')).toBe(6);
    expect(q.position('nope')).toBeNull();
  });

  it('rank is config: legacy can be moved to the Free rank', () => {
    const { q } = make({ queue: { rank: { legacy: 2 } } });
    q.enqueue({ ticket: 'a', principal: pid(1), plan: 'free', simMsToday: 0 });
    q.enqueue({ ticket: 'b', principal: pid(2), plan: 'legacy', simMsToday: 0 });
    expect(q.snapshot().map((e) => e.ticket)).toEqual(['a', 'b']);
  });

  it('property: dequeue order is a stable sort of arrival order by (rank, minutes today)', () => {
    const plans: PlanId[] = ['free', 'advanced', 'pro', 'legacy'];
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      const { q, cfg, clock } = make({ queue: { maxLength: 40 } });
      const n = 1 + Math.floor(rand() * 30);
      const arrivals: { ticket: string; plan: PlanId; simMsToday: number }[] = [];
      for (let i = 0; i < n; i++) {
        const a = {
          ticket: `t${i}`,
          plan: plans[Math.floor(rand() * 4)] as PlanId,
          // few distinct values so that ties (FIFO) are common
          simMsToday: Math.floor(rand() * 3) * MIN,
        };
        arrivals.push(a);
        expect(q.enqueue({ ...a, principal: pid(i) }).ok).toBe(true);
        clock.advance(Math.floor(rand() * 1000));
      }
      const r = cfg.queue.rank;
      const expected = arrivals
        .map((a, i) => ({ ...a, i }))
        .sort((x, y) => r[x.plan] - r[y.plan] || x.simMsToday - y.simMsToday || x.i - y.i)
        .map((a) => a.ticket);
      const got: string[] = [];
      for (;;) {
        // no Free cap pressure: capacity is large and nothing runs
        const d = q.dequeue(open(1000));
        if (!d.entry) break;
        got.push(d.entry.ticket);
      }
      expect(got, `seed ${seed}`).toEqual(expected);
      expect(q.length).toBe(0);
    }
  });
});

describe('FairQueue slots (acceptance 5) and no eviction (acceptance 7)', () => {
  it('4 Free + 2 Pro busy: nothing is handed out; a 5th Free waits even when a slot frees up', () => {
    const { q } = make();
    q.enqueue({ ticket: 'f5', principal: pid(5), plan: 'free', simMsToday: 0 });
    expect(q.dequeue(open(6, 6, 4)).entry).toBeNull();
    // a Pro session ends: 4 Free + 1 Pro running, one slot idle, still no 5th Free
    expect(q.dequeue(open(6, 5, 4)).entry).toBeNull();
    expect(q.position('f5')).toBe(1);
  });

  it('4 Free + 1 Pro running, Pro and Free waiting: the freed slot goes to Pro', () => {
    const { q } = make();
    q.enqueue({ ticket: 'f', principal: pid(1), plan: 'free', simMsToday: 0 });
    q.enqueue({ ticket: 'p', principal: pid(2), plan: 'pro', simMsToday: 50 * MIN });
    expect(q.dequeue(open(6, 5, 4)).entry?.ticket).toBe('p');
    expect(q.dequeue(open(6, 6, 4)).entry).toBeNull();
  });

  it('a paid entry behind a capped Free entry still starts', () => {
    const { q } = make({ queue: { rank: { free: 0, pro: 2 } } });
    q.enqueue({ ticket: 'f', principal: pid(1), plan: 'free', simMsToday: 0 });
    q.enqueue({ ticket: 'p', principal: pid(2), plan: 'pro', simMsToday: 0 });
    expect(q.dequeue(open(6, 4, 4)).entry?.ticket).toBe('p');
  });

  it('Free cap never exceeds the capacity; liftUntilFirstPaid lifts it only while no paid user exists', () => {
    const fixed = make().q;
    expect(fixed.freeCap({ ...open(3), anyPaidUser: false })).toBe(3);
    expect(fixed.freeCap({ ...open(6), anyPaidUser: false })).toBe(4);
    const lift = make({ queue: { freeCapMode: 'liftUntilFirstPaid' } }).q;
    expect(lift.freeCap({ ...open(6), anyPaidUser: false })).toBe(6);
    expect(lift.freeCap({ ...open(6), anyPaidUser: true })).toBe(4);
    // unknown = fixed cap (fail safe)
    expect(lift.freeCap(open(6))).toBe(4);
  });

  it('property: with a full host, dequeue never hands out a slot (nothing to evict, ever)', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rand = rng(seed);
      const { q } = make();
      for (let i = 0; i < 10; i++)
        q.enqueue({
          ticket: `t${i}`,
          principal: pid(i),
          plan: (['free', 'pro', 'advanced'] as const)[i % 3] as PlanId,
          simMsToday: 0,
        });
      const cap = 1 + Math.floor(rand() * 8);
      const running = cap + Math.floor(rand() * 3);
      const before = q.length;
      const d = q.dequeue(open(cap, running, Math.floor(rand() * (running + 1))));
      expect(d.entry).toBeNull();
      expect(q.length).toBe(before);
      // the result carries only a waiting entry and drops of waiting entries: no session field exists
      expect(Object.keys(d).sort()).toEqual(['dropped', 'entry']);
    }
  });

  it('malformed slot pictures give nothing (fail closed)', () => {
    const { q } = make();
    q.enqueue({ ticket: 'p', principal: pid(1), plan: 'pro', simMsToday: 0 });
    expect(q.dequeue(open(6, 2, 3)).entry).toBeNull();
    expect(q.dequeue(open(Number.NaN, 0, 0)).entry).toBeNull();
    expect(q.dequeue(open(6, -1, -1)).entry).toBeNull();
    expect(q.dequeue(open(6, -1, 0)).entry).toBeNull();
    expect(q.dequeue(open(-1, 0, 0)).entry).toBeNull();
    expect(q.dequeue(open(6, 1.5, 0)).entry).toBeNull();
    expect(q.dequeue(open(6, 0, 0)).entry?.ticket).toBe('p');
  });
});

describe('FairQueue timeouts with a fake clock (acceptance 6)', () => {
  it('max wait 10 min: dropped with queue_timeout exactly at the limit, even while polling', () => {
    const { q, clock } = make();
    q.enqueue({ ticket: 't', principal: pid(1), plan: 'pro', simMsToday: 0 });
    for (let i = 0; i < 39; i++) {
      clock.advance(15_000);
      q.touch('t');
      expect(q.tick()).toEqual([]);
    }
    clock.advance(14_999);
    expect(q.tick()).toEqual([]);
    clock.advance(1);
    const d = q.tick();
    expect(d).toHaveLength(1);
    expect(d[0]?.reason).toBe('timeout');
    expect(d[0]?.error?.messageKey).toBe('limit.sim.queue_timeout');
    expect(q.length).toBe(0);
  });

  it('a vanished client leaves within 30 s; a polling one stays', () => {
    const { q, clock } = make();
    q.enqueue({ ticket: 'gone', principal: pid(1), plan: 'free', simMsToday: 0 });
    q.enqueue({ ticket: 'here', principal: pid(2), plan: 'free', simMsToday: 0 });
    clock.advance(15_000);
    q.touch('here');
    clock.advance(14_999);
    expect(q.tick()).toEqual([]);
    clock.advance(1);
    expect(q.tick().map((d) => [d.ticket, d.reason, d.error?.messageKey])).toEqual([
      ['gone', 'vanished', null],
    ]);
    expect(q.snapshot().map((e) => e.ticket)).toEqual(['here']);
  });

  it('dequeue never hands out an expired entry and reports its drop', () => {
    const { q, clock } = make();
    q.enqueue({ ticket: 'old', principal: pid(1), plan: 'pro', simMsToday: 0 });
    clock.advance(30_000);
    q.enqueue({ ticket: 'new', principal: pid(2), plan: 'free', simMsToday: 0 });
    const d = q.dequeue(open(6));
    expect(d.entry?.ticket).toBe('new');
    expect(d.dropped.map((x) => x.ticket)).toEqual(['old']);
  });

  it('drop on lease loss and on cancel', () => {
    const { q } = make();
    q.enqueue({ ticket: 'a', principal: pid(1), plan: 'pro', simMsToday: 0 });
    q.enqueue({ ticket: 'b', principal: pid(2), plan: 'pro', simMsToday: 0 });
    expect(q.drop('a', 'lease_lost')?.reason).toBe('lease_lost');
    expect(q.drop('a')).toBeNull();
    expect(q.drop('b')?.reason).toBe('cancelled');
    expect(q.length).toBe(0);
  });
});

describe('FairQueue bound, cooldown, idempotency', () => {
  it('max length 20: the 21st gets queue_full at once', () => {
    const { q } = make({ queue: { maxFree: 19 } });
    for (let i = 0; i < 20; i++)
      expect(
        q.enqueue({
          ticket: `t${i}`,
          principal: pid(i),
          plan: i < 19 ? 'free' : 'pro',
          simMsToday: 0,
        }).ok,
      ).toBe(true);
    const r = q.enqueue({ ticket: 'x', principal: pid(99), plan: 'pro', simMsToday: 0 });
    expect(r.ok ? 'ok' : r.error.code).toBe('queue_full');
    expect(r.ok ? null : r.error.messageKey).toBe('limit.sim.queue_full');
    expect(q.length).toBe(20);
  });

  it('Free waiting entries are capped (maxFree 16): paid users can still join a Free-crowded queue', () => {
    const { q } = make();
    for (let i = 0; i < 16; i++)
      expect(
        q.enqueue({ ticket: `f${i}`, principal: pid(i), plan: 'free', simMsToday: 0 }).ok,
      ).toBe(true);
    const f = q.enqueue({ ticket: 'f16', principal: pid(16), plan: 'free', simMsToday: 0 });
    expect(f.ok ? 'ok' : f.error.code).toBe('queue_full');
    for (let i = 0; i < 4; i++)
      expect(
        q.enqueue({ ticket: `p${i}`, principal: pid(50 + i), plan: 'advanced', simMsToday: 0 }).ok,
      ).toBe(true);
    const full = q.enqueue({ ticket: 'p4', principal: pid(60), plan: 'pro', simMsToday: 0 });
    expect(full.ok ? 'ok' : full.error.code).toBe('queue_full');
    expect(q.length).toBe(20);
    // a Free entry leaves: a Free place is free again and the queue has one place
    q.drop('f0');
    expect(q.enqueue({ ticket: 'f16', principal: pid(16), plan: 'free', simMsToday: 0 }).ok).toBe(
      true,
    );
  });

  it('config: maxFree must leave room for paid users; queue ranges are not negative', () => {
    expect(parseConfig().queue.maxFree).toBe(16);
    expect(() => parseConfig({ queue: { maxFree: 20 } })).toThrow(/maxFree/);
    expect(() => parseConfig({ queue: { maxLength: 5 } })).toThrow(/maxFree/);
    expect(parseConfig({ queue: { maxLength: 5, maxFree: 4 } }).queue.maxFree).toBe(4);
    expect(parseConfig({ queue: { maxFree: 0 } }).queue.maxFree).toBe(0);
    for (const q of [
      { maxFree: -1 },
      { freeSlotCap: -1 },
      { freeCooldownMs: -1 },
      { rank: { pro: -1 } },
      { rank: { free: -0.5 } },
    ])
      expect(() => parseConfig({ queue: q }), JSON.stringify(q)).toThrow(/negative/);
  });

  it('HOST CONTRACT: the cooldown is enforced on enqueue only; a direct start must ask cooldownMs()', () => {
    const { q, clock } = make();
    expect(q.cooldownMs(pid(1))).toBe(0);
    q.sessionEnded(pid(1), 'free');
    q.sessionEnded(pid(2), 'advanced');
    // the host reads this before starting a Free run on an idle slot without queueing
    expect(q.cooldownMs(pid(1))).toBe(60_000);
    expect(q.cooldownMs(pid(2))).toBe(0);
    clock.advance(59_000);
    expect(q.cooldownMs(pid(1))).toBe(1_000);
    clock.advance(1_000);
    expect(q.cooldownMs(pid(1))).toBe(0);
    q.tick();
    expect(q.cooldownMs(pid(1))).toBe(0);
    // freeCooldownMs 0 = no cooldown at all
    const none = make({ queue: { freeCooldownMs: 0 } }).q;
    none.sessionEnded(pid(1), 'free');
    expect(none.cooldownMs(pid(1))).toBe(0);
  });

  it('Free cooldown 60 s after a session ends; none for paid', () => {
    const { q, clock } = make();
    q.sessionEnded(pid(1), 'free');
    q.sessionEnded(pid(2), 'pro');
    clock.advance(1_000);
    const r = q.enqueue({ ticket: 'f', principal: pid(1), plan: 'free', simMsToday: 0 });
    expect(r.ok ? 'ok' : [r.error.code, r.error.params.n]).toEqual(['sim_cooldown', 59]);
    expect(q.enqueue({ ticket: 'p', principal: pid(2), plan: 'pro', simMsToday: 0 }).ok).toBe(true);
    clock.advance(58_999);
    expect(q.cooldownMs(pid(1))).toBe(1);
    expect(q.enqueue({ ticket: 'f', principal: pid(1), plan: 'free', simMsToday: 0 }).ok).toBe(
      false,
    );
    clock.advance(1);
    expect(q.enqueue({ ticket: 'f', principal: pid(1), plan: 'free', simMsToday: 0 }).ok).toBe(
      true,
    );
  });

  it('same ticket twice = one entry; a new ticket of the same principal keeps the place and wait clock', () => {
    const { q, clock } = make();
    q.enqueue({ ticket: 'a', principal: pid(1), plan: 'free', simMsToday: 0 });
    q.enqueue({ ticket: 'b', principal: pid(2), plan: 'free', simMsToday: 0 });
    const again = q.enqueue({ ticket: 'a', principal: pid(1), plan: 'free', simMsToday: 0 });
    expect(again.ok && again.duplicate).toBe(true);
    clock.advance(5 * MIN);
    const re = q.enqueue({ ticket: 'a2', principal: pid(1), plan: 'free', simMsToday: 0 });
    expect(re.ok && [re.duplicate, re.position, re.status.params.n]).toEqual([true, 1, 1]);
    expect(q.length).toBe(2);
    clock.advance(5 * MIN);
    q.touch('b');
    expect(q.tick().map((d) => [d.ticket, d.reason])).toContainEqual(['a2', 'timeout']);
  });

  it('rejects bad input; a ticket of another principal is refused; no e-mail is accepted', () => {
    const { q } = make();
    const code = (r: ReturnType<FairQueue['enqueue']>) => (r.ok ? 'ok' : r.error.code);
    expect(
      code(
        q.enqueue({ ticket: 't', principal: 'someone@example.com', plan: 'free', simMsToday: 0 }),
      ),
    ).toBe('invalid_principal');
    expect(code(q.enqueue({ ticket: 't t', principal: pid(1), plan: 'free', simMsToday: 0 }))).toBe(
      'invalid_request',
    );
    expect(
      code(q.enqueue({ ticket: 't', principal: pid(1), plan: 'gold' as PlanId, simMsToday: 0 })),
    ).toBe('invalid_request');
    expect(code(q.enqueue({ ticket: 't', principal: pid(1), plan: 'free', simMsToday: -1 }))).toBe(
      'invalid_request',
    );
    expect(code(q.enqueue({ ticket: 't', principal: pid(1), plan: 'free', simMsToday: 0 }))).toBe(
      'ok',
    );
    expect(code(q.enqueue({ ticket: 't', principal: pid(2), plan: 'free', simMsToday: 0 }))).toBe(
      'invalid_request',
    );
    expect(JSON.stringify(q.snapshot())).not.toContain('@');
  });

  it('a re-enqueue refreshes the plan (upgrade while waiting moves the entry up)', () => {
    const { q } = make();
    q.enqueue({ ticket: 'a', principal: pid(1), plan: 'free', simMsToday: 0 });
    q.enqueue({ ticket: 'b', principal: pid(2), plan: 'advanced', simMsToday: 0 });
    expect(q.position('a')).toBe(2);
    const up = q.enqueue({ ticket: 'a', principal: pid(1), plan: 'pro', simMsToday: 0 });
    expect(up.ok && [up.duplicate, up.position]).toEqual([true, 1]);
    expect(q.snapshot()[0]).toMatchObject({ ticket: 'a', plan: 'pro' });
    // new ticket of the same principal: plan refreshed too, place in arrival order kept
    const re = q.enqueue({ ticket: 'a2', principal: pid(1), plan: 'advanced', simMsToday: 0 });
    expect(re.ok && re.position).toBe(1);
    expect(q.snapshot().map((e) => [e.ticket, e.plan])).toEqual([
      ['a2', 'advanced'],
      ['b', 'advanced'],
    ]);
    // downgrade to Free: it gets the Free rank
    q.enqueue({ ticket: 'a2', principal: pid(1), plan: 'free', simMsToday: 0 });
    expect(q.position('a2')).toBe(2);
  });

  it('a downgrade to Free while waiting obeys the Free rules (cooldown, Free share)', () => {
    const { q } = make({ queue: { maxFree: 1 } });
    q.sessionEnded(pid(1), 'free');
    q.enqueue({ ticket: 'a', principal: pid(1), plan: 'pro', simMsToday: 0 });
    const r = q.enqueue({ ticket: 'a', principal: pid(1), plan: 'free', simMsToday: 0 });
    expect(r.ok ? 'ok' : r.error.code).toBe('sim_cooldown');
    expect(q.position('a')).toBeNull();
    q.enqueue({ ticket: 'f', principal: pid(2), plan: 'free', simMsToday: 0 });
    q.enqueue({ ticket: 'b', principal: pid(3), plan: 'pro', simMsToday: 0 });
    const s = q.enqueue({ ticket: 'b', principal: pid(3), plan: 'free', simMsToday: 0 });
    expect(s.ok ? 'ok' : s.error.code).toBe('queue_full');
    expect(q.snapshot().map((e) => e.ticket)).toEqual(['f']);
  });
});
