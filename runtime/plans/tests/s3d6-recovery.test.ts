/**
 * TBI-018 s3d-6: boot recovery and compaction (design S3D-HOST-WIRING-DESIGN §7, §11).
 *   - SimMeter.closeAllOpen('host') bills min(now, lastBeat + lease), closes every open session (also one
 *     whose lease has not run out), one append, idempotent;
 *   - SimHostAdapter.recoverAtBoot / compactAtBoot guards;
 *   - bootSimPlans: restart on the same journal closes the previous process's sessions with 'host', the
 *     principal is not blocked by sim_concurrent afterwards; compaction past the threshold leaves a
 *     `.pre-compact` copy (never overwritten); a failed copy skips compaction; a failed compaction refuses.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import {
  bootSimPlans,
  PRE_COMPACT_SUFFIX,
  preCompactName,
  SIM_JOURNAL_FILE,
  SIM_LOCK_FILE,
  type HostSimBootDeps,
  type HostSimPlans,
} from '../hostboot.js';
import { SimHostAdapter } from '../simhost.js';
import { SimMeter, type SimEvent } from '../simminutes.js';
import { JournalStore, MemoryStore } from '../store.js';
import { FakeClock } from '../time.js';
import { ADV, FREE, NOON } from './helpers.js';

const LEASE = 30_000;
const CFG = parseConfig({ metering: { enabled: true } });
const OFF_CFG = parseConfig({ metering: { enabled: false } });
const S1 = 'a'.repeat(32);
const S2 = 'b'.repeat(32);

const closes = (events: SimEvent[]) =>
  events.filter((e): e is Extract<SimEvent, { t: 'sim_close' }> => e.t === 'sim_close');

describe('SimMeter.closeAllOpen', () => {
  it('closes every open session with the given reason, billed min(now, lastBeat + lease)', async () => {
    const store = new MemoryStore<SimEvent>();
    const clock = new FakeClock(NOON);
    const m = await SimMeter.open(store, { config: CFG, clock, beatPersistMs: 0 });
    expect((await m.open(S1, ADV, 'advanced')).ok).toBe(true);
    expect((await m.open(S2, FREE, 'free')).ok).toBe(true);
    clock.advance(10_000);
    expect((await m.heartbeat(S1, ADV)).ok).toBe(true); // S1 last beat at +10 s
    clock.advance(5_000); // now +15 s: S1 lease alive (10+30), S2 alive (0+30)
    const before = store.appendCalls;
    const r = await m.closeAllOpen('host');
    expect(r).toEqual({ ok: true, metered: true, closed: 2 });
    expect(store.appendCalls).toBe(before + 1); // one append for all of them
    const c = closes(store.events);
    expect(c.map((e) => [e.sessionId, e.reason, e.billedMs])).toEqual([
      [S1, 'host', 15_000],
      [S2, 'host', 15_000],
    ]);
    expect(m.openCount).toBe(0);
  });

  it('a crash long ago bills only up to lastBeat + lease, never to now', async () => {
    const store = new MemoryStore<SimEvent>();
    const clock = new FakeClock(NOON);
    const m = await SimMeter.open(store, { config: CFG, clock, beatPersistMs: 0 });
    await m.open(S1, ADV, 'advanced');
    clock.advance(20_000);
    await m.heartbeat(S1, ADV);
    // a meter that is NOT swept at open would still hold it; closeAllOpen bills lastBeat + lease
    clock.advance(10 * 60_000);
    expect(await m.closeAllOpen('host')).toEqual({ ok: true, metered: true, closed: 1 });
    expect(closes(store.events)[0]?.billedMs).toBe(20_000 + LEASE);
  });

  it('an in-memory (unjournaled) beat is flushed first, so the bill uses it', async () => {
    const store = new MemoryStore<SimEvent>();
    const clock = new FakeClock(NOON);
    const m = await SimMeter.open(store, { config: CFG, clock }); // default persist interval lease/3
    await m.open(S1, ADV, 'advanced');
    clock.advance(1_000);
    await m.heartbeat(S1, ADV); // in memory only
    expect(store.events.some((e) => e.t === 'sim_beat')).toBe(false);
    clock.advance(1_000);
    await m.closeAllOpen('host');
    expect(store.events.map((e) => e.t)).toEqual(['sim_open', 'sim_beat', 'sim_close']);
    expect(closes(store.events)[0]?.billedMs).toBe(2_000);
  });

  it('idempotent: a second call closes nothing and writes nothing', async () => {
    const store = new MemoryStore<SimEvent>();
    const clock = new FakeClock(NOON);
    const m = await SimMeter.open(store, { config: CFG, clock });
    await m.open(S1, ADV, 'advanced');
    await m.closeAllOpen('host');
    const n = store.appendCalls;
    expect(await m.closeAllOpen('host')).toEqual({ ok: true, metered: true, closed: 0 });
    expect(store.appendCalls).toBe(n);
    expect(closes(store.events)).toHaveLength(1);
  });

  it('metering off: unmetered, nothing written; journal problem: system_unavailable', async () => {
    const off = new MemoryStore<SimEvent>();
    const m0 = await SimMeter.open(off, { config: OFF_CFG, clock: new FakeClock(NOON) });
    expect(await m0.closeAllOpen('host')).toEqual({ ok: true, metered: false });
    expect(off.appendCalls).toBe(0);

    const store = new MemoryStore<SimEvent>();
    const m = await SimMeter.open(store, { config: CFG, clock: new FakeClock(NOON) });
    await m.open(S1, ADV, 'advanced');
    store.failOnCall = 'always';
    await m.closeAllOpen('host'); // append fails -> meter failed closed
    const r = await m.closeAllOpen('host');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('system_unavailable');
  });

  it('a non-finite clock is system_unavailable and closes nothing', async () => {
    const store = new MemoryStore<SimEvent>();
    const clock = new FakeClock(NOON);
    const m = await SimMeter.open(store, { config: CFG, clock });
    await m.open(S1, ADV, 'advanced');
    clock.t = Number.NaN;
    const r = await m.closeAllOpen('host');
    expect(r.ok).toBe(false);
    expect(m.openCount).toBe(1);
  });
});

describe('SimHostAdapter boot recovery guards', () => {
  const slots = { capacity: 4, running: 0 };
  it('recoverAtBoot refuses (closes nothing) once this process tracks a run', async () => {
    const store = new MemoryStore<SimEvent>();
    const a = await SimHostAdapter.open(store, { config: CFG, clock: new FakeClock(NOON) });
    const s = await a.admit({
      ticket: 't1',
      sessionId: S1,
      principal: ADV,
      plan: 'advanced',
      slots,
    });
    expect(s.metered && s.decision).toBe('start');
    const r = await a.recoverAtBoot();
    expect(r.metered && !r.ok && r.error.code).toBe('invalid_state');
    expect(a.openMeterSessions).toBe(1);
  });

  it('compactAtBoot skips while a meter session is open', async () => {
    const store = new MemoryStore<SimEvent>();
    const clock = new FakeClock(NOON);
    const m = await SimMeter.open(store, { config: CFG, clock });
    await m.open(S1, ADV, 'advanced'); // a session of a "previous process"
    const a = await SimHostAdapter.open(store, { config: CFG, clock });
    expect(await a.compactAtBoot()).toEqual({ metered: true, ok: true, skipped: true });
    expect(store.events).toHaveLength(1);
  });

  it('metering off: both answer unmetered', async () => {
    const a = await SimHostAdapter.open(new MemoryStore<SimEvent>(), {
      config: OFF_CFG,
      clock: new FakeClock(NOON),
    });
    expect(await a.recoverAtBoot()).toEqual({ metered: false });
    expect(await a.compactAtBoot()).toEqual({ metered: false });
  });
});

// ------------------------------------------------------------------ bootSimPlans (real journal files)

const parent = mkdtempSync(join(tmpdir(), 'plans-s3d6-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));
const HOST = { policyPlanNames: ['preview', 'system'], housekeepingMs: 250 };
const booted: HostSimPlans[] = [];
afterAll(() => booted.forEach((b) => b.lock.release()));

function envFor(dir: string) {
  const d = mkdtempSync(join(parent, 'c-'));
  const f = join(d, 'sim.json');
  writeFileSync(f, JSON.stringify({ metering: { enabled: true } }));
  return {
    TBI_HOST_SIM_PLANS_CONFIG: f,
    TBI_HOST_SIM_PLANS_STATE: dir,
    TBI_HOST_SIM_PLAN_MAP: 'preview=legacy,system=legacy',
  };
}
const stateDir = () => {
  const d = join(mkdtempSync(join(parent, 's-')), 'state');
  mkdirSync(d, { mode: 0o700 });
  chmodSync(d, 0o700);
  return d;
};
async function boot(dir: string, deps: HostSimBootDeps) {
  const b = await bootSimPlans(envFor(dir), LEASE, HOST, deps);
  if (!b) throw new Error('no adapter');
  booted.push(b);
  return b;
}
const journal = (dir: string) => new JournalStore<SimEvent>(join(dir, SIM_JOURNAL_FILE));

describe('bootSimPlans: restart recovery', () => {
  it("a previous process's open sessions are closed with 'host' at boot; the principal can start again", async () => {
    const dir = stateDir();
    const clock = new FakeClock(NOON);
    const first = await boot(dir, { clock });
    const slots = { capacity: 4, running: 0 };
    const a = await first.adapter.admit({
      ticket: 't1',
      sessionId: S1,
      principal: ADV,
      plan: 'advanced',
      slots,
    });
    expect(a.metered && a.decision).toBe('start');
    clock.advance(12_000);
    await first.adapter.heartbeat(S1, ADV); // journaled (first beat past lease/3 = 10 s)
    clock.advance(3_000);
    // "crash": no ended(), the lock is left behind with a dead pid
    first.lock.release();
    expect(first.boot).toEqual({ recovered: 0, compaction: { kind: 'no' } });

    clock.advance(5_000); // restart 20 s after open, inside the lease (beat at 12 s + 30 s)
    const second = await boot(dir, { clock });
    expect(second.boot.recovered).toBe(1);
    const ev = (await journal(dir).load()).events;
    const c = closes(ev);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ sessionId: S1, reason: 'host', billedMs: 20_000 });
    // without recovery this would be sim_concurrent until the lease ran out
    const again = await second.adapter.admit({
      ticket: 't2',
      sessionId: S2,
      principal: ADV,
      plan: 'advanced',
      slots,
    });
    expect(again.metered && again.decision).toBe('start');
    second.lock.release();

    const third = await boot(dir, { clock });
    expect(third.boot.recovered).toBe(1); // S2 of the second process
    third.lock.release();
    // a fourth boot: nothing left to recover, nothing written by recovery
    const lines = readFileSync(join(dir, SIM_JOURNAL_FILE), 'utf8');
    const fourth = await boot(dir, { clock });
    expect(fourth.boot.recovered).toBe(0);
    expect(readFileSync(join(dir, SIM_JOURNAL_FILE), 'utf8')).toBe(lines);
    fourth.lock.release();
  });

  it('a crash long ago bills at most lastBeat + lease (the open-time sweep closes it with lease)', async () => {
    const dir = stateDir();
    const clock = new FakeClock(NOON);
    const first = await boot(dir, { clock });
    await first.adapter.admit({
      ticket: 't1',
      sessionId: S1,
      principal: ADV,
      plan: 'advanced',
      slots: { capacity: 4, running: 0 },
    });
    first.lock.release();
    clock.advance(3_600_000);
    const second = await boot(dir, { clock });
    second.lock.release();
    const c = closes((await journal(dir).load()).events);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ sessionId: S1, billedMs: LEASE });
    expect(second.boot.recovered).toBe(0); // already closed by the sweep in SimMeter.open
  });

  it('the journal and the boot report carry no principal, ticket or token beyond the meter facts', async () => {
    const dir = stateDir();
    const b = await boot(dir, { clock: new FakeClock(NOON) });
    b.lock.release();
    expect(JSON.stringify(b.boot)).not.toMatch(/p_|ticket|token/);
  });
});

describe('bootSimPlans: compaction at boot', () => {
  async function journalWith(dir: string, sessions: number, clock: FakeClock) {
    const b = await boot(dir, { clock });
    for (let i = 0; i < sessions; i++) {
      const id = `${i}`.padStart(32, 'c');
      const a = await b.adapter.admit({
        ticket: `t${i}`,
        sessionId: id,
        principal: ADV,
        plan: 'advanced',
        slots: { capacity: 4, running: 0 },
      });
      expect(a.metered && a.decision).toBe('start');
      clock.advance(1_000);
      await b.adapter.ended(id, 'ended', ADV);
    }
    b.lock.release();
  }

  it('below the threshold: no compaction, no copy', async () => {
    const dir = stateDir();
    const clock = new FakeClock(NOON);
    await journalWith(dir, 2, clock);
    const b = await boot(dir, { clock, compactAfterEvents: 100 });
    b.lock.release();
    expect(b.boot.compaction).toEqual({ kind: 'no' });
    expect(readdirSync(dir).filter((f) => f.endsWith(PRE_COMPACT_SUFFIX))).toEqual([]);
  });

  it('past the threshold: a .pre-compact copy of the old journal, then one snapshot; the state is unchanged', async () => {
    const dir = stateDir();
    const clock = new FakeClock(NOON);
    await journalWith(dir, 3, clock);
    const old = readFileSync(join(dir, SIM_JOURNAL_FILE), 'utf8');
    const before = (await SimMeter.open(journal(dir), { config: CFG, clock })).stateJson();
    const b = await boot(dir, { clock, compactAfterEvents: 2 });
    b.lock.release();
    expect(b.boot.compaction).toEqual({ kind: 'done', copy: preCompactName(clock.now()) });
    const copy = join(dir, preCompactName(clock.now()));
    expect(readFileSync(copy, 'utf8')).toBe(old);
    const ev = (await journal(dir).load()).events;
    expect(ev.map((e) => e.t)).toEqual(['sim_snapshot']);
    const m = await SimMeter.open(journal(dir), { config: CFG, clock });
    const strip = (j: string) => {
      const s = JSON.parse(j) as { seq: number };
      s.seq = 0;
      return s;
    };
    expect(strip(m.stateJson())).toEqual(strip(before));
    // the reopened meter still bills the month's usage (3 runs of 1 s)
    const rem = m.remaining(ADV, 'advanced');
    expect(rem.ok && rem.metered && rem.usedMonthMs).toBe(3_000);
  });

  it('a copy is never overwritten: same timestamp twice -> the second compaction is skipped', async () => {
    const dir = stateDir();
    const clock = new FakeClock(NOON);
    await journalWith(dir, 3, clock);
    const name = preCompactName(clock.now());
    writeFileSync(join(dir, name), 'operator copy', { mode: 0o600 });
    const old = readFileSync(join(dir, SIM_JOURNAL_FILE), 'utf8');
    const b = await boot(dir, { clock, compactAfterEvents: 2 });
    b.lock.release();
    expect(b.boot.compaction).toEqual({ kind: 'copy_failed' });
    expect(readFileSync(join(dir, name), 'utf8')).toBe('operator copy');
    expect(readFileSync(join(dir, SIM_JOURNAL_FILE), 'utf8')).toBe(old);
  });

  it('a failed copy skips compaction (journal untouched) and boot continues', async () => {
    const dir = stateDir();
    const clock = new FakeClock(NOON);
    await journalWith(dir, 3, clock);
    const old = readFileSync(join(dir, SIM_JOURNAL_FILE), 'utf8');
    const b = await boot(dir, {
      clock,
      compactAfterEvents: 2,
      copyJournal: () => {
        throw new Error('ENOSPC');
      },
    });
    b.lock.release();
    expect(b.boot.compaction).toEqual({ kind: 'copy_failed' });
    expect(readFileSync(join(dir, SIM_JOURNAL_FILE), 'utf8')).toBe(old);
  });

  it('a failed compaction refuses to start, releases the lock; the journal is still readable', async () => {
    const dir = stateDir();
    const clock = new FakeClock(NOON);
    await journalWith(dir, 3, clock);
    const old = readFileSync(join(dir, SIM_JOURNAL_FILE), 'utf8');
    // a directory where JournalStore.replace puts its temp file makes the replace fail
    mkdirSync(join(dir, `${SIM_JOURNAL_FILE}.compact-tmp`));
    writeFileSync(join(dir, `${SIM_JOURNAL_FILE}.compact-tmp`, 'x'), '');
    await expect(
      bootSimPlans(envFor(dir), LEASE, HOST, { clock, compactAfterEvents: 2 }),
    ).rejects.toThrow(/state unusable; refusing to start/);
    expect(existsSync(join(dir, SIM_LOCK_FILE))).toBe(false);
    expect(readFileSync(join(dir, SIM_JOURNAL_FILE), 'utf8')).toBe(old);
  });

  it('a bad threshold refuses', async () => {
    const dir = stateDir();
    await expect(bootSimPlans(envFor(dir), LEASE, HOST, { compactAfterEvents: 0 })).rejects.toThrow(
      /refusing to start/,
    );
  });
});
