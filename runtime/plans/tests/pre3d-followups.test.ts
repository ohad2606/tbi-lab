/**
 * TBI-018 follow-ups before the s3d host wiring (ops review fable11 LOW4, LOW5; numeric validation):
 *  - LOW4  the sim journal can be compacted, and the compaction carries the tombstones of pruned
 *          sessions forward, so a pruned id can never be opened (billed) a second time; the cap path
 *          prunes like close/sweep.
 *  - LOW5  SimHostAdapter.ended() requires the caller's principal and verifies it against the one
 *          recorded at admission; nobody can end or bill another principal's run.
 *  - replay and API numeric validation of the credits/spend engine: NaN, Infinity, negative,
 *    non-integer or unsafe numbers are refused explicitly, never coerced.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseConfig, ConfigError } from '../config.js';
import type { PlanEvent } from '../events.js';
import { SimHostAdapter } from '../simhost.js';
import { SimMeter, type SimEvent, type SimResult } from '../simminutes.js';
import { JournalStore, MemoryStore } from '../store.js';
import { FakeClock } from '../time.js';
import { ADV, FREE, LEG, NOON, NOV, code as admitCode, ms, req, setup } from './helpers.js';

const parent = mkdtempSync(join(tmpdir(), 'tbi-pre3d-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));

const code = (r: SimResult<object>): string =>
  r.ok ? (r.metered ? 'ok' : 'unmetered') : r.error.code;

async function meter(
  overrides: unknown = {},
  opts: { store?: MemoryStore<SimEvent>; start?: number; enabled?: boolean } = {},
) {
  const config = parseConfig({
    ...(overrides as object),
    metering: { enabled: opts.enabled ?? true },
  });
  const clock = new FakeClock(opts.start ?? NOON);
  const store = opts.store ?? new MemoryStore<SimEvent>();
  const m = await SimMeter.open(store, { config, clock, beatPersistMs: 0 });
  return { meter: m, clock, store, config };
}

/** A closed session s1 (Nov 2026) that is pruned once the clock is in Jan 2027. */
async function withPrunedSession() {
  const s = await meter();
  expect(code(await s.meter.open('s1', ADV, 'advanced'))).toBe('ok');
  s.clock.advance(10_000);
  expect(code(await s.meter.heartbeat('s1', ADV))).toBe('ok');
  expect(code(await s.meter.close('s1', 'ended', ADV))).toBe('ok');
  s.clock.t = ms('2027-01-15T10:00:00Z');
  expect(code(await s.meter.sweep())).toBe('ok'); // prunes s1 (closed before Dec 1)
  expect(s.meter.session('s1')).toBeUndefined();
  return s;
}

describe('LOW4: sim journal compaction carries tombstones forward', () => {
  it('compact -> a pruned id is still refused, live and after a replay of the compacted journal', async () => {
    const s = await withPrunedSession();
    const c = await s.meter.compact();
    expect(code(c)).toBe('ok');
    expect(s.store.events).toHaveLength(1);
    expect(s.store.events[0]?.t).toBe('sim_snapshot');
    expect(code(await s.meter.open('s1', ADV, 'advanced'))).toBe('invalid_state');
    const again = await SimMeter.open(s.store, { config: s.config, clock: s.clock });
    expect(again.storeProblem).toBeUndefined();
    expect(code(await again.open('s1', ADV, 'advanced'))).toBe('invalid_state');
    // a different principal cannot re-use it either
    expect(code(await again.open('s1', FREE, 'free'))).toBe('invalid_state');
    expect(s.store.events).toHaveLength(1); // nothing written by the refusals
  });

  it('a journal that opens a tombstoned id after the snapshot fails replay (fail closed)', async () => {
    const s = await withPrunedSession();
    expect(code(await s.meter.compact())).toBe('ok');
    s.store.events.push({
      t: 'sim_open',
      sessionId: 's1',
      principal: ADV,
      plan: 'advanced',
      leaseMs: s.config.sim.leaseMs,
      seq: 2,
      at: s.clock.t,
    });
    const replay = await SimMeter.open(s.store, { config: s.config, clock: s.clock });
    expect(replay.storeProblem?.kind).toBe('corrupt');
    expect(code(await replay.open('s9', ADV, 'advanced'))).toBe('system_unavailable');
  });

  it('a snapshot anywhere but first, or one with bad numbers, fails replay', async () => {
    const s = await withPrunedSession();
    expect(code(await s.meter.compact())).toBe('ok');
    const snap = s.store.events[0] as SimEvent;
    const bad: unknown[] = [
      { ...snap, seq: 2 },
      { ...snap, at: Number.NaN },
      { ...snap, tombstones: ['__proto__'] },
      { ...snap, tombstones: ['s1', 's1'] },
      { ...snap, usage: { [ADV]: { '2027-01-15': -1 } } },
      { ...snap, usage: { [ADV]: { '2027-01-15': 1.5 } } },
      { ...snap, usage: { [ADV]: { '2027-01-15': Number.POSITIVE_INFINITY } } },
    ];
    for (const ev of bad) {
      const st = new MemoryStore<SimEvent>();
      st.events = [ev as SimEvent];
      const m = await SimMeter.open(st, { config: s.config, clock: s.clock });
      expect(m.storeProblem?.kind, JSON.stringify(ev)).toBe('corrupt');
    }
    const twice = new MemoryStore<SimEvent>();
    twice.events = [snap, { ...snap, seq: 2 }];
    expect(
      (await SimMeter.open(twice, { config: s.config, clock: s.clock })).storeProblem?.kind,
    ).toBe('corrupt');
  });

  it('compaction keeps billing, remaining time and open sessions exactly (compacted == not compacted)', async () => {
    const a = await meter();
    const b = await meter();
    for (const s of [a, b]) {
      await s.meter.open('c1', FREE, 'free');
      s.clock.advance(120_000 - 1);
      await s.meter.heartbeat('c1', FREE);
      await s.meter.close('c1', 'ended', FREE);
      await s.meter.open('o1', FREE, 'free');
      s.clock.advance(15_000);
      await s.meter.heartbeat('o1', FREE);
    }
    const noSeq = (j: string): unknown => ({ ...(JSON.parse(j) as object), seq: 0 });
    const beforeCompact = b.meter.stateJson();
    expect(code(await b.meter.compact())).toBe('ok');
    // same sessions, usage and tombstones; only the sequence restarts at 1
    expect(noSeq(b.meter.stateJson())).toEqual(noSeq(beforeCompact));
    expect(JSON.parse(b.meter.stateJson()).seq).toBe(1);
    const b2 = await SimMeter.open(b.store, { config: b.config, clock: b.clock });
    expect(b2.remaining(FREE, 'free')).toEqual(a.meter.remaining(FREE, 'free'));
    expect(b.meter.remaining(FREE, 'free')).toEqual(a.meter.remaining(FREE, 'free'));
    for (const s of [a, b]) s.clock.advance(20_000);
    const ca = await a.meter.close('o1', 'ended', FREE);
    const cb = await b.meter.close('o1', 'ended', FREE);
    expect(cb).toEqual(ca);
    expect(b.meter.remaining(FREE, 'free')).toEqual(a.meter.remaining(FREE, 'free'));
    // the compacted journal + the close replays to the same remaining time
    const b3 = await SimMeter.open(b.store, { config: b.config, clock: b.clock });
    expect(b3.storeProblem).toBeUndefined();
    expect(b3.remaining(FREE, 'free')).toEqual(a.meter.remaining(FREE, 'free'));
    expect(b3.session('o1')?.billedMs).toBe(a.meter.session('o1')?.billedMs);
  });

  it('a store without replace, a failed replace, metering off: refused, journal unchanged', async () => {
    const s = await withPrunedSession();
    const noReplace = {
      append: (e: SimEvent[]) => s.store.append(e),
      load: () => s.store.load(),
    };
    const m = await SimMeter.open(noReplace, { config: s.config, clock: s.clock });
    const before = s.store.events.length;
    expect(code(await m.compact())).toBe('system_unavailable');
    expect(s.store.events).toHaveLength(before);

    const failing = new MemoryStore<SimEvent>();
    failing.events = structuredClone(s.store.events);
    failing.failReplace = true;
    const f = await SimMeter.open(failing, { config: s.config, clock: s.clock });
    expect(code(await f.compact())).toBe('system_unavailable');
    expect(failing.events).toHaveLength(before);
    // fail closed until the journal is replayed
    expect(code(await f.open('s7', ADV, 'advanced'))).toBe('system_unavailable');

    const off = await meter({}, { enabled: false });
    expect(code(await off.meter.compact())).toBe('unmetered');
    expect(off.store.appendCalls).toBe(0);
  });

  it('JournalStore.replace is atomic on disk and replays to the same tombstones', async () => {
    const dir = mkdtempSync(join(parent, 'j-'));
    const path = join(dir, 'sim.jsonl');
    const config = parseConfig({ metering: { enabled: true } });
    const clock = new FakeClock(NOON);
    const m = await SimMeter.open(new JournalStore<SimEvent>(path), { config, clock });
    await m.open('s1', ADV, 'advanced');
    clock.advance(5_000);
    await m.close('s1', 'ended', ADV);
    clock.t = ms('2027-01-15T10:00:00Z');
    await m.sweep();
    expect(code(await m.compact())).toBe('ok');
    expect(readdirSync(dir)).toEqual(['sim.jsonl']); // no temp file left behind
    const r = await new JournalStore<SimEvent>(path).load();
    expect(r.problem).toBeUndefined();
    expect(r.events.map((e) => e.t)).toEqual(['sim_snapshot']);
    const again = await SimMeter.open(new JournalStore<SimEvent>(path), { config, clock });
    expect(code(await again.open('s1', ADV, 'advanced'))).toBe('invalid_state');
    expect(code(await again.open('s2', ADV, 'advanced'))).toBe('ok');
    expect(existsSync(`${path}.compact-tmp`)).toBe(false);
  });

  it('the cap path prunes like close and sweep (LOW4: cap path does not prune)', async () => {
    const s = await meter(
      { sim: { plans: { free: { monthlyMinutes: 1 } } } },
      { start: ms('2026-09-10T10:00:00Z') },
    );
    await s.meter.open('old', FREE, 'free');
    s.clock.advance(1_000);
    await s.meter.close('old', 'ended', FREE);
    s.clock.t = NOON; // Nov: 'old' (Sep) is before the previous month, but nothing pruned yet
    expect(s.meter.session('old')).toBeDefined();
    await s.meter.open('new', FREE, 'free');
    let last: SimResult<object> | undefined;
    for (let i = 0; i < 4; i++) {
      s.clock.advance(20_000);
      last = await s.meter.heartbeat('new', FREE);
      if (!last.ok) break;
    }
    expect(last && code(last)).toBe('minutes_out_free');
    expect(s.meter.session('new')?.closeReason).toBe('cap');
    expect(s.meter.session('old')).toBeUndefined();
    expect(code(await s.meter.open('old', FREE, 'free'))).toBe('invalid_state');
  });
});

describe('LOW5: SimHostAdapter.ended() records and verifies the principal', () => {
  async function adapter() {
    const config = parseConfig({ metering: { enabled: true } });
    const clock = new FakeClock(NOON);
    const store = new MemoryStore<SimEvent>();
    const host = await SimHostAdapter.open(store, { config, clock });
    const a = await host.admit({
      ticket: 't1',
      sessionId: 'sess1',
      principal: ADV,
      plan: 'advanced',
      slots: { capacity: 6, running: 0 },
    });
    expect(a.metered && a.decision).toBe('start');
    return { host, clock, store };
  }
  const closes = (s: MemoryStore<SimEvent>): number =>
    s.events.filter((e) => e.t === 'sim_close').length;

  it('without a principal ended() is refused and bills nothing; the run stays tracked', async () => {
    const { host, clock, store } = await adapter();
    clock.advance(5_000);
    for (const p of [undefined, '', 'someone@example.com', '__proto__']) {
      const r = await host.ended('sess1', 'ended', p as unknown as string);
      expect(r.metered && !r.ok && r.error.code).toBe('invalid_request');
    }
    expect(host.tracked).toBe(1);
    expect(closes(store)).toBe(0);
    const ok = await host.ended('sess1', 'ended', ADV);
    expect(ok).toEqual({ metered: true, ok: true, billedMs: 5_000 });
  });

  it('another principal can neither end nor bill the run, also after housekeeping stopped tracking it', async () => {
    const { host, clock, store } = await adapter();
    const foreign = await host.ended('sess1', 'ended', FREE);
    expect(foreign.metered && !foreign.ok && foreign.error.code).toBe('invalid_state');
    expect(host.tracked).toBe(1);
    expect(closes(store)).toBe(0);
    // lease runs out, housekeeping bills it and stops tracking it
    clock.advance(31_000);
    const hk = await host.housekeeping();
    expect(hk.metered && hk.ok && hk.closed).toBe(1);
    expect(host.tracked).toBe(0);
    // the foreign caller still learns nothing (same answer as an unknown id), the owner gets the bill
    const late = await host.ended('sess1', 'lease', FREE);
    const unknown = await host.ended('nosuch', 'lease', FREE);
    expect(late).toEqual(unknown);
    expect(late.metered && !late.ok && late.error.code).toBe('invalid_state');
    const own = await host.ended('sess1', 'lease', ADV);
    expect(own).toEqual({ metered: true, ok: true, billedMs: 30_000 });
    expect(closes(store)).toBe(1);
  });

  it('flag off: ended() stays inert whatever the principal', async () => {
    const host = await SimHostAdapter.open(new MemoryStore<SimEvent>(), {
      config: parseConfig({}),
      clock: new FakeClock(NOON),
    });
    expect(await host.ended('sess1', 'ended', undefined as unknown as string)).toEqual({
      metered: false,
    });
  });
});

// ------------------------------------------------------------------ numeric validation

const BAD_NUMBERS: [string, number][] = [
  ['NaN', Number.NaN],
  ['negative', -1],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['non-integer', 1.5],
  ['unsafe integer', 2 ** 53],
];

/** A real journal: a grant, an admitted + settled call and an admitted open call. */
async function realJournal(): Promise<PlanEvent[]> {
  const s = await setup();
  expect((await s.engine.grant(ADV, 'advanced', NOV, 'g1')).ok).toBe(true);
  const a = await s.engine.admit({ ...req(ADV), reqId: 'rq1' });
  expect(admitCode(a)).toBe('ok');
  expect((await s.engine.settle('rq1', 1234)).ok).toBe(true);
  expect(admitCode(await s.engine.admit({ ...req(ADV), reqId: 'rq2' }))).toBe('ok');
  return structuredClone((s.store as MemoryStore).events);
}

async function replayProblem(events: PlanEvent[]): Promise<string | undefined> {
  const store = new MemoryStore();
  store.events = events;
  const s = await setup({}, { store });
  const kind = s.engine.storeProblem?.kind;
  if (kind) expect(admitCode(await s.engine.admit(req(ADV)))).toBe('system_unavailable');
  return kind;
}

type Mut = (e: PlanEvent[]) => void;
const first = <T extends PlanEvent['t']>(evs: PlanEvent[], t: T, n = 0) =>
  evs.filter((e) => e.t === t)[n] as Extract<PlanEvent, { t: T }> & Record<string, unknown>;

describe('replay numeric validation: the credits/spend journal refuses bad numbers explicitly', () => {
  it('the unmodified journal replays cleanly', async () => {
    expect(await replayProblem(await realJournal())).toBeUndefined();
  });

  const fields: [string, (v: number) => Mut][] = [
    ['reserve.credits', (v) => (e) => void (first(e, 'reserve').credits = v)],
    ['reserve.usdMicro', (v) => (e) => void (first(e, 'reserve').usdMicro = v)],
    ['reserve.ttlAt', (v) => (e) => void (first(e, 'reserve').ttlAt = v)],
    ['reserve.periodSeq', (v) => (e) => void (first(e, 'reserve').periodSeq = v)],
    ['reserve.parts[0].credits', (v) => (e) => void (first(e, 'reserve').parts[0]!.credits = v)],
    ['settle.deducted', (v) => (e) => void (first(e, 'settle').deducted = v)],
    [
      'settle.spend.actualMicro',
      (v) => (e) => void ((first(e, 'settle').spend as { actualMicro: number }).actualMicro = v),
    ],
    ['account.allowance', (v) => (e) => void (first(e, 'account').allowance = v)],
    ['account.granted', (v) => (e) => void (first(e, 'account').granted = v)],
    ['account.periodEnd', (v) => (e) => void (first(e, 'account').periodEnd = v)],
    ['grant.periodEnd', (v) => (e) => void (first(e, 'grant').periodEnd = v)],
    ['event.at', (v) => (e) => void ((e[0] as { at: number }).at = v)],
    ['event.seq', (v) => (e) => void ((e[0] as { seq: number }).seq = v)],
  ];
  for (const [name, mut] of fields)
    for (const [label, v] of BAD_NUMBERS)
      it(`${name} = ${label} -> corrupt, nothing admitted`, async () => {
        const evs = await realJournal();
        mut(v)(evs);
        expect(await replayProblem(evs)).toBe('corrupt');
      });

  it('a duplicate reserve id, a second settle, a settle of an unknown id or a duplicate grant ref -> corrupt', async () => {
    const muts: [string, Mut][] = [
      [
        'duplicate reserve',
        (e) => e.push({ ...first(e, 'reserve'), seq: e.length + 1 } as PlanEvent),
      ],
      ['second settle', (e) => e.push({ ...first(e, 'settle'), seq: e.length + 1 } as PlanEvent)],
      [
        'settle of unknown id',
        (e) => e.push({ ...first(e, 'settle'), reqId: 'nope', seq: e.length + 1 } as PlanEvent),
      ],
      [
        'settle deducts more than reserved',
        (e) => void (first(e, 'settle').deducted = first(e, 'reserve').credits + 1),
      ],
      [
        'duplicate grant ref',
        (e) => e.push({ ...first(e, 'grant'), seq: e.length + 1 } as PlanEvent),
      ],
      [
        'release of a settled reservation',
        (e) =>
          e.push({
            t: 'release',
            principal: ADV,
            reqId: 'rq1',
            reason: 'failed',
            credits: first(e, 'reserve').credits,
            parts: first(e, 'reserve').parts,
            periodSeq: first(e, 'reserve').periodSeq,
            dayKey: first(e, 'reserve').dayKey,
            spend: { k: 'release', reservedMicro: 0, countedMicro: 0, alerts: [] },
            seq: e.length + 1,
            at: NOON,
          } as PlanEvent),
      ],
      ['reqId __proto__', (e) => void (first(e, 'reserve', 1).reqId = '__proto__')],
    ];
    for (const [name, mut] of muts) {
      const evs = await realJournal();
      mut(evs);
      expect(await replayProblem(evs), name).toBe('corrupt');
    }
  });
});

describe('API numeric validation: bad numbers are refused, nothing is written', () => {
  it('settle(actualMicro) with NaN / Infinity / negative / fractional / unsafe -> invalid_request', async () => {
    const s = await setup();
    const a = await s.engine.admit(req(FREE));
    expect(admitCode(a)).toBe('ok');
    const id = a.ok && a.metered ? a.reservation.reqId : '';
    const before = (s.store as MemoryStore).events.length;
    for (const [label, v] of BAD_NUMBERS) {
      const r = await s.engine.settle(id, v);
      expect(!r.ok && r.error.code, label).toBe('invalid_request');
    }
    expect((s.store as MemoryStore).events).toHaveLength(before);
    expect(s.engine.reservation(id)?.state).toBe('open');
  });

  it('admit(inputTokens) unsafe integer -> invalid_request', async () => {
    const s = await setup();
    expect(admitCode(await s.engine.admit({ ...req(FREE), inputTokens: 2 ** 53 }))).toBe(
      'invalid_request',
    );
    expect((s.store as MemoryStore).appendCalls).toBe(0);
  });

  it('ownerResume(extraDayMicro) bad numbers -> invalid_request, spend state unchanged', async () => {
    const s = await setup();
    const spend = s.engine.spendState();
    for (const [label, v] of BAD_NUMBERS) {
      const r = await s.engine.ownerResume({ extraDayMicro: v });
      expect(!r.ok && r.error.code, label).toBe('invalid_request');
    }
    expect(s.engine.spendState()).toEqual(spend);
    expect((s.store as MemoryStore).appendCalls).toBe(0);
  });

  it('grant() period with bad numbers (also for legacy) -> invalid_request', async () => {
    const s = await setup();
    for (const [label, v] of BAD_NUMBERS) {
      for (const period of [
        { start: v, end: NOV.end },
        { start: NOV.start, end: v },
      ]) {
        const r1 = await s.engine.grant(ADV, 'advanced', period, `g-${label}-a`);
        expect(!r1.ok && r1.error.code, `${label} advanced`).toBe('invalid_request');
        const r2 = await s.engine.grant(LEG, 'legacy', period, `g-${label}-l`);
        expect(!r2.ok && r2.error.code, `${label} legacy`).toBe('invalid_request');
      }
    }
    expect((s.store as MemoryStore).appendCalls).toBe(0);
  });

  it('reqId / ref that are prototype keys -> invalid_request', async () => {
    const s = await setup();
    for (const k of ['__proto__', 'constructor', 'prototype']) {
      expect(admitCode(await s.engine.admit({ ...req(FREE), reqId: k }))).toBe('invalid_request');
      const g = await s.engine.grant(ADV, 'advanced', NOV, k);
      expect(!g.ok && g.error.code).toBe('invalid_request');
      const p = await s.engine.addPack(ADV, 'ai300', k);
      expect(!p.ok && p.error.code).toBe('invalid_request');
    }
    expect((s.store as MemoryStore).appendCalls).toBe(0);
  });

  it('a clock that reads NaN, Infinity, negative or fractional -> system_unavailable, nothing written', async () => {
    for (const [label, v] of BAD_NUMBERS.filter(([l]) => l !== 'unsafe integer')) {
      const s = await setup();
      s.clock.t = v;
      expect(admitCode(await s.engine.admit(req(FREE))), label).toBe('system_unavailable');
      const g = await s.engine.grant(ADV, 'advanced', NOV, `g-${label}`);
      expect(!g.ok && g.error.code, label).toBe('system_unavailable');
      const o = await s.engine.ownerPause();
      expect(!o.ok && o.error.code, label).toBe('system_unavailable');
      expect((s.store as MemoryStore).appendCalls, label).toBe(0);
      // not poisoned: a good clock works again
      s.clock.t = NOON;
      expect(admitCode(await s.engine.admit(req(FREE))), label).toBe('ok');
    }
  });

  it('sim minutes in the config: NaN / Infinity / negative / fractional are refused (no coercion)', () => {
    for (const [label, v] of BAD_NUMBERS.filter(([l]) => l !== 'unsafe integer')) {
      expect(() => parseConfig({ sim: { plans: { free: { monthlyMinutes: v } } } }), label).toThrow(
        ConfigError,
      );
      expect(() => parseConfig({ sim: { plans: { pro: { dailyMinutes: v } } } }), label).toThrow(
        ConfigError,
      );
    }
  });
});
