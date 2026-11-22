import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig, type PlanId } from '../config.js';
import { renderLimit } from '../messages.js';
import {
  SimMeter,
  splitByDay,
  type SimEvent,
  type SimResult,
  type SimRemaining,
} from '../simminutes.js';
import { JournalStore, MemoryStore, type Store } from '../store.js';
import { FakeClock } from '../time.js';
import { FREE, ADV, LEG, NOON, ms, rng } from './helpers.js';

const MIN = 60_000;
const LEASE = 30_000;
const TZ = 'Asia/Jerusalem';

async function make(
  overrides: unknown = {},
  opts: { store?: Store<SimEvent>; start?: number; enabled?: boolean } = {},
) {
  const config = parseConfig({
    ...(overrides as object),
    metering: { enabled: opts.enabled ?? true },
  });
  const clock = new FakeClock(opts.start ?? NOON);
  const store = opts.store ?? new MemoryStore<SimEvent>();
  const meter = await SimMeter.open(store, { config, clock });
  return { meter, clock, store, config };
}

const code = (r: SimResult<object>): string =>
  r.ok ? (r.metered ? 'ok' : 'unmetered') : r.error.code;
const rem = (r: SimResult<SimRemaining>): SimRemaining => {
  if (!r.ok || !r.metered) throw new Error(`not metered: ${code(r)}`);
  return r;
};
const billed = (r: SimResult<{ billedMs: number }>): number => {
  if (!r.ok || !r.metered) throw new Error(`not metered: ${code(r)}`);
  return r.billedMs;
};

/** Run a session with a heartbeat every `beatMs` for `lenMs`, then close. */
async function runSession(
  s: Awaited<ReturnType<typeof make>>,
  id: string,
  principal: string,
  plan: PlanId,
  lenMs: number,
  beatMs = 10_000,
) {
  expect(code(await s.meter.open(id, principal, plan))).toBe('ok');
  let t = 0;
  while (t + beatMs <= lenMs) {
    s.clock.advance(beatMs);
    t += beatMs;
    expect(code(await s.meter.heartbeat(id))).toBe('ok');
  }
  s.clock.advance(lenMs - t);
  return billed(await s.meter.close(id));
}

async function beats(s: Awaited<ReturnType<typeof make>>, id: string, lenMs: number) {
  for (let t = 0; t < lenMs; t += 10_000) {
    s.clock.advance(10_000);
    expect(code(await s.meter.heartbeat(id))).toBe('ok');
  }
}

describe('SimMeter billing', () => {
  it('bills wall time while heartbeats arrive', async () => {
    const s = await make();
    expect(await runSession(s, 's1', ADV, 'advanced', 7 * MIN + 5_000)).toBe(7 * MIN + 5_000);
    const r = rem(s.meter.remaining(ADV, 'advanced'));
    expect(r.usedMonthMs).toBe(7 * MIN + 5_000);
    expect(r.monthMs).toBe(900 * MIN - (7 * MIN + 5_000));
    expect(r.dayMs).toBeNull();
  });

  it('heartbeat gap: billing stops at lastBeat + leaseMs (acceptance 8, host crash)', async () => {
    const s = await make();
    await s.meter.open('s1', ADV, 'advanced');
    await beats(s, 's1', 4 * MIN);
    // a beat after a gap longer than the lease is refused (no back-billing of the gap)
    const gap = await make();
    await gap.meter.open('g', ADV, 'advanced');
    gap.clock.advance(LEASE + 1);
    expect(code(await gap.meter.heartbeat('g'))).toBe('lease_lost');
    expect(billed(await gap.meter.close('g'))).toBe(LEASE);
    // host crashes: no more beats; the close (or a sweep) comes an hour later
    s.clock.advance(60 * MIN);
    expect(code(await s.meter.heartbeat('s1'))).toBe('lease_lost');
    expect(billed(await s.meter.close('s1', 'lease'))).toBe(4 * MIN + LEASE);
  });

  it('a close inside the lease bills up to the close, not the lease end', async () => {
    const s = await make();
    await s.meter.open('s1', ADV, 'advanced');
    s.clock.advance(20_000);
    expect(billed(await s.meter.close('s1'))).toBe(20_000);
  });

  it('restart: replay closes a crashed session at lastBeat + lease on boot', async () => {
    const store = new MemoryStore<SimEvent>();
    const a = await make({}, { store });
    await a.meter.open('s1', ADV, 'advanced');
    await beats(a, 's1', 2 * MIN);
    const b = await make({}, { store, start: a.clock.now() + 3 * 3_600_000 });
    expect(b.meter.session('s1')?.billedMs).toBe(2 * MIN + LEASE);
    expect(b.meter.session('s1')?.closeReason).toBe('lease');
    // the lease value is a fact of the session: a config change later does not rebill it
    const c = await make({ sim: { leaseMs: 1 } }, { store, start: b.clock.now() });
    expect(c.meter.session('s1')?.billedMs).toBe(2 * MIN + LEASE);
  });

  it('close is idempotent: a second close reports the same billed time and writes nothing', async () => {
    const s = await make();
    await s.meter.open('s1', ADV, 'advanced');
    s.clock.advance(MIN);
    const first = await s.meter.close('s1');
    const n = (s.store as MemoryStore<SimEvent>).events.length;
    s.clock.advance(10 * MIN);
    const second = await s.meter.close('s1', 'host');
    expect(second).toEqual({ ok: true, metered: true, duplicate: true, billedMs: billed(first) });
    expect((s.store as MemoryStore<SimEvent>).events.length).toBe(n);
    expect(code(await s.meter.heartbeat('s1'))).toBe('invalid_state');
    expect(code(await s.meter.open('s1', ADV, 'advanced'))).toBe('invalid_state');
  });

  it('open is idempotent per session id; another principal on the same id is refused', async () => {
    const s = await make();
    await s.meter.open('s1', ADV, 'advanced');
    const again = await s.meter.open('s1', ADV, 'advanced');
    expect(again.ok && again.metered && again.duplicate).toBe(true);
    expect(code(await s.meter.open('s1', FREE, 'free'))).toBe('invalid_request');
    expect((s.store as MemoryStore<SimEvent>).events.length).toBe(1);
  });

  it('a session across Jerusalem midnight is split per day; parts sum to the billed time', async () => {
    const start = ms('2026-11-19T21:50:00Z'); // 23:50 in Jerusalem (UTC+2)
    const s = await make({}, { start });
    const b = await runSession(s, 's1', ADV, 'advanced', 20 * MIN);
    expect(b).toBe(20 * MIN);
    const r = rem(s.meter.remaining(ADV, 'advanced'));
    expect(r.usedTodayMs).toBe(10 * MIN);
    expect(r.usedMonthMs).toBe(20 * MIN);
    expect(splitByDay(start, start + 20 * MIN, TZ)).toEqual([
      { dayKey: '2026-11-19', ms: 10 * MIN },
      { dayKey: '2026-11-20', ms: 10 * MIN },
    ]);
  });

  it('month resets on the 1st in Asia/Jerusalem', async () => {
    const start = ms('2026-11-30T21:30:00Z'); // 23:30 on 30.11 in Jerusalem
    const s = await make({}, { start });
    await runSession(s, 's1', FREE, 'free', 20 * MIN);
    // now 23:50 on 30.11
    expect(rem(s.meter.remaining(FREE, 'free')).usedMonthMs).toBe(20 * MIN);
    s.clock.advance(10 * MIN); // 00:00 on 01.12 Jerusalem (still 30.11 in UTC)
    const r = rem(s.meter.remaining(FREE, 'free'));
    expect(r.usedMonthMs).toBe(0);
    expect(r.monthMs).toBe(60 * MIN);
  });

  it('splitByDay over the 2026 DST changes keeps the exact total', () => {
    for (const [a, b] of [
      ['2026-03-26T20:00:00Z', '2026-03-28T02:00:00Z'],
      ['2026-10-24T18:00:00Z', '2026-10-26T03:00:00Z'],
    ] as const) {
      const parts = splitByDay(ms(a), ms(b), TZ);
      expect(parts.reduce((n, p) => n + p.ms, 0)).toBe(ms(b) - ms(a));
      expect(new Set(parts.map((p) => p.dayKey)).size).toBe(parts.length);
    }
  });
});

describe('SimMeter limits', () => {
  it('Free: after 60 minutes, open is refused with minutes_out_free and the renewal date', async () => {
    const s = await make();
    await runSession(s, 's1', FREE, 'free', 60 * MIN);
    const r = await s.meter.open('s2', FREE, 'free');
    expect(code(r)).toBe('minutes_out_free');
    if (r.ok) throw new Error('unreachable');
    expect(r.error.params).toEqual({ date: '01.12.2026' });
    expect(renderLimit('en', r.error)).toContain('01.12.2026');
    expect(renderLimit('he', r.error)).toContain('01.12.2026');
  });

  it('paid plans get minutes_out; legacy has no monthly meter; numbers come from config', async () => {
    const s = await make({ sim: { plans: { advanced: { monthlyMinutes: 1 } } } });
    await runSession(s, 's1', ADV, 'advanced', MIN);
    expect(code(await s.meter.open('s2', ADV, 'advanced'))).toBe('minutes_out');
    expect(rem(s.meter.remaining(LEG, 'legacy')).monthMs).toBeNull();
    expect(await runSession(s, 's3', LEG, 'legacy', 120 * MIN)).toBe(120 * MIN);
    expect(code(await s.meter.open('s4', LEG, 'legacy'))).toBe('ok');
  });

  it('open sessions count toward remaining (one user cannot overlap past the limit)', async () => {
    const s = await make({ sim: { plans: { free: { monthlyMinutes: 1 } } } });
    await s.meter.open('s1', FREE, 'free');
    s.clock.advance(20_000);
    await s.meter.heartbeat('s1');
    s.clock.advance(20_000);
    await s.meter.heartbeat('s1');
    s.clock.advance(20_000);
    expect(rem(s.meter.remaining(FREE, 'free')).monthMs).toBe(0);
    expect(code(await s.meter.open('s2', FREE, 'free'))).toBe('minutes_out_free');
  });

  it('optional daily cap (config) refuses with sim_daily and resets at Jerusalem midnight', async () => {
    const start = ms('2026-11-19T20:00:00Z'); // 22:00 Jerusalem
    const s = await make({ sim: { plans: { pro: { dailyMinutes: 5 } } } }, { start });
    await runSession(s, 's1', 'p_prouser00001', 'pro', 5 * MIN);
    expect(code(await s.meter.open('s2', 'p_prouser00001', 'pro'))).toBe('sim_daily');
    s.clock.advance(2 * 3_600_000);
    expect(rem(s.meter.remaining('p_prouser00001', 'pro')).dayMs).toBe(5 * MIN);
    expect(code(await s.meter.open('s2', 'p_prouser00001', 'pro'))).toBe('ok');
  });

  it('usedTodayMs feeds the queue key', async () => {
    const s = await make();
    await runSession(s, 's1', ADV, 'advanced', 3 * MIN);
    const r = s.meter.usedTodayMs(ADV);
    expect(r.ok && r.metered && r.ms).toBe(3 * MIN);
  });
});

describe('SimMeter fail closed, replay, conservation', () => {
  it('store append failure: system_unavailable, nothing applied, retry bills the same', async () => {
    const store = new MemoryStore<SimEvent>();
    const s = await make({}, { store });
    store.failOnCall = 'always';
    expect(code(await s.meter.open('s1', ADV, 'advanced'))).toBe('system_unavailable');
    expect(s.meter.session('s1')).toBeUndefined();
    store.failOnCall = null;
    await s.meter.open('s1', ADV, 'advanced');
    s.clock.advance(10_000);
    store.failOnCall = 'always';
    expect(code(await s.meter.heartbeat('s1'))).toBe('system_unavailable');
    s.clock.advance(5_000);
    expect(code(await s.meter.close('s1'))).toBe('system_unavailable');
    expect(s.meter.session('s1')?.closedAt).toBeUndefined();
    store.failOnCall = null;
    expect(billed(await s.meter.close('s1'))).toBe(15_000);
  });

  it('unreadable or corrupt journal: every call refuses with system_unavailable', async () => {
    const broken: Store<SimEvent> = {
      append: async () => undefined,
      load: async () => {
        throw new Error('disk gone');
      },
    };
    const a = await make({}, { store: broken });
    expect(code(await a.meter.open('s1', ADV, 'advanced'))).toBe('system_unavailable');
    expect(code(a.meter.remaining(ADV, 'advanced'))).toBe('system_unavailable');
    expect(code(a.meter.usedTodayMs(ADV))).toBe('system_unavailable');
    expect(code(await a.meter.sweep())).toBe('system_unavailable');

    const gap = new MemoryStore<SimEvent>();
    gap.events.push({
      t: 'sim_beat',
      sessionId: 'nope',
      seq: 1,
      at: NOON,
    });
    const b = await make({}, { store: gap });
    expect(b.meter.storeProblem?.kind).toBe('corrupt');
    expect(code(await b.meter.close('nope'))).toBe('system_unavailable');

    const torn: Store<SimEvent> = {
      append: async () => undefined,
      load: async () => ({
        events: [],
        problem: { kind: 'torn_tail', detail: 'x', validBytes: 0 },
      }),
    };
    const c = await make({}, { store: torn });
    expect(code(await c.meter.open('s1', ADV, 'advanced'))).toBe('system_unavailable');
  });

  it('metering disabled: inert, writes nothing', async () => {
    const s = await make({}, { enabled: false });
    expect(code(await s.meter.open('s1', ADV, 'advanced'))).toBe('unmetered');
    expect(code(await s.meter.heartbeat('s1'))).toBe('unmetered');
    expect(code(await s.meter.close('s1'))).toBe('unmetered');
    expect(code(s.meter.remaining(ADV, 'advanced'))).toBe('unmetered');
    expect((s.store as MemoryStore<SimEvent>).appendCalls).toBe(0);
  });

  it('property (seeded): conservation and live state == replayed state (memory and journal)', async () => {
    const principals = [FREE, ADV, LEG];
    const plans: PlanId[] = ['free', 'advanced', 'legacy'];
    for (let seed = 1; seed <= 25; seed++) {
      const rand = rng(seed);
      const store =
        seed % 5 === 0
          ? new JournalStore<SimEvent>(join(mkdtempSync(join(tmpdir(), 'sim-journal-')), 'j.log'))
          : new MemoryStore<SimEvent>();
      const s = await make({ sim: { plans: { free: { monthlyMinutes: 600 } } } }, { store });
      let n = 0;
      const live: string[] = [];
      for (let i = 0; i < 80; i++) {
        const roll = rand();
        if (roll < 0.25) {
          const k = Math.floor(rand() * 3);
          const id = `s${seed}-${++n}`;
          const r = await s.meter.open(id, principals[k] as string, plans[k] as PlanId);
          if (r.ok) live.push(id);
        } else if (roll < 0.55 && live.length) {
          await s.meter.heartbeat(live[Math.floor(rand() * live.length)] as string);
        } else if (roll < 0.75 && live.length) {
          await s.meter.close(live.splice(Math.floor(rand() * live.length), 1)[0] as string);
        } else if (roll < 0.8) {
          await s.meter.sweep();
        } else {
          s.clock.advance(Math.floor(rand() * (rand() < 0.1 ? 6 * 3_600_000 : 50_000)));
        }
      }
      const st = JSON.parse(s.meter.stateJson()) as {
        sessions: Record<
          string,
          {
            billedMs?: number;
            openedAt: number;
            closedAt?: number;
            lastBeat: number;
            leaseMs: number;
          }
        >;
        usage: Record<string, Record<string, number>>;
      };
      // conservation: billed ms of closed sessions == the sum of all day buckets; each bill is capped
      let billedSum = 0;
      for (const ss of Object.values(st.sessions)) {
        if (ss.closedAt === undefined) continue;
        billedSum += ss.billedMs ?? -1;
        expect(ss.billedMs).toBe((ss.closedAt as number) - ss.openedAt);
        expect(ss.closedAt).toBeLessThanOrEqual(ss.lastBeat + ss.leaseMs);
        expect(ss.billedMs).toBeGreaterThanOrEqual(0);
      }
      const usageSum = Object.values(st.usage)
        .flatMap((d) => Object.values(d))
        .reduce((a, b) => a + b, 0);
      expect(usageSum, `seed ${seed}`).toBe(billedSum);
      const replay = await make({}, { store, start: s.clock.now(), enabled: false });
      expect(replay.meter.stateJson(), `seed ${seed}`).toBe(s.meter.stateJson());
    }
  });

  it('privacy: journal and every output carry only opaque ids, never an e-mail or token text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-privacy-'));
    const file = join(dir, 'j.log');
    const s = await make({}, { store: new JournalStore<SimEvent>(file) });
    const outputs: unknown[] = [];
    outputs.push(await s.meter.open('s1', ADV, 'advanced'));
    outputs.push(await s.meter.open('s2', 'tester@example.com', 'free'));
    outputs.push(await s.meter.open('s3', 'Bearer sk-secret-token', 'free'));
    s.clock.advance(MIN);
    outputs.push(await s.meter.heartbeat('s1'));
    outputs.push(s.meter.remaining('tester@example.com', 'free'));
    outputs.push(await s.meter.close('s1'));
    const text = JSON.stringify(outputs) + readFileSync(file, 'utf8') + s.meter.stateJson();
    expect(text).not.toContain('@');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('Bearer');
    expect(code(outputs[1] as SimResult)).toBe('invalid_principal');
  });
});
