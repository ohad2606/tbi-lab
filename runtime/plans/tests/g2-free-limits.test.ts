/**
 * BETA-G2 (docs/plans/BETA-G2-FREE-LIMITS.md): free-plan limits for the public beta, on the existing
 * TBI-018 adapter. Covers (b) Free holds at most 4 of 6 slots, (c) a Free request queues when the Free
 * share is full, (d) the operator kill switch for NEW Free admissions (no restart; a probe failure counts
 * as paused) and (e) its machine-readable reason `free_paused` with HE + EN texts.
 * (a) the per-session time cap is the host policy plan lifetime (runtime/host/tests/g2-free-limits.test.ts).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseConfig } from '../config.js';
import { FREE_PAUSE_FILE, bootSimPlans, freePauseProbe, freePausedAt } from '../hostboot.js';
import { MESSAGE_KEY, limitError } from '../limits.js';
import { MESSAGES, renderLimit } from '../messages.js';
import type { SimEvent } from '../simminutes.js';
import { SimHostAdapter, type HostAdmit } from '../simhost.js';
import { MemoryStore } from '../store.js';
import { FakeClock } from '../time.js';
import { NOON } from './helpers.js';

const sid = (n: number): string => n.toString(16).padStart(32, '0');
const p = (n: number): string => `p_g2user${String(n).padStart(8, '0')}`;
let t = 0;
const ticket = (): string => `g2t${++t}`;

async function make(opts: { paused?: () => boolean } = {}) {
  const config = parseConfig({ metering: { enabled: true } });
  const clock = new FakeClock(NOON);
  const store = new MemoryStore<SimEvent>();
  const host = await SimHostAdapter.open(store, {
    config,
    clock,
    ...(opts.paused ? { freePaused: opts.paused } : {}),
  });
  return { host, clock, store, config };
}

const decision = (r: HostAdmit): string =>
  !r.metered ? 'unmetered' : r.decision === 'refused' ? `refused:${r.error.code}` : r.decision;

describe('BETA-G2 defaults', () => {
  it('Free may hold 4 slots (D-3), metering stays off by default', () => {
    expect(DEFAULT_CONFIG.metering.enabled).toBe(false);
    expect(DEFAULT_CONFIG.queue.freeSlotCap).toBe(4);
    expect(DEFAULT_CONFIG.queue.freeCapMode).toBe('fixed');
  });
});

describe('BETA-G2 (b)+(c): Free holds at most 4 of 6 slots; the rest queue', () => {
  it('4 Free start, the 5th Free queues, legacy and pro still get the 2 reserved slots', async () => {
    const { host } = await make();
    let running = 0;
    const admit = (n: number, plan: 'free' | 'legacy' | 'pro', tk = ticket()) =>
      host.admit({
        ticket: tk,
        sessionId: sid(n),
        principal: p(n),
        plan,
        slots: { capacity: 6, running },
      });
    for (let i = 1; i <= 4; i++) {
      expect(decision(await admit(i, 'free'))).toBe('start');
      running++;
    }
    const fifthTicket = ticket();
    const fifth = await admit(5, 'free', fifthTicket);
    expect(decision(fifth)).toBe('queued');
    expect(fifth.metered && fifth.decision === 'queued' && fifth.status.code).toBe('queue');
    // the 2 reserved slots go to non-free plans while the Free entry keeps waiting
    expect(decision(await admit(6, 'legacy'))).toBe('start');
    running++;
    expect(decision(await admit(7, 'pro'))).toBe('start');
    running++;
    // host full: everyone queues, nobody is displaced
    expect(decision(await admit(8, 'pro'))).toBe('queued');
    // a Free run ends: the waiting Free entry (5) may start on its next poll (Free share 3 < 4)
    expect(await host.ended(sid(1), 'ended', p(1))).toMatchObject({ ok: true });
    running--;
    const again = await host.admit({
      ticket: fifthTicket,
      sessionId: sid(5),
      principal: p(5),
      plan: 'free',
      slots: { capacity: 6, running },
      mode: 'poll',
    });
    // the pro waiter (8) ranks first and takes the one free slot; Free 5 keeps waiting
    expect(decision(again)).toBe('queued');
  });
});

describe('BETA-G2 (d): kill switch for new Free admissions', () => {
  it('no probe = never paused (default, unchanged behaviour)', async () => {
    const { host } = await make();
    const r = await host.admit({
      ticket: ticket(),
      sessionId: sid(1),
      principal: p(1),
      plan: 'free',
      slots: { capacity: 6, running: 0 },
    });
    expect(decision(r)).toBe('start');
  });

  it('paused: a new Free admission is refused free_paused and opens nothing; paid still starts', async () => {
    let paused = true;
    const { host, store } = await make({ paused: () => paused });
    const before = store.events.length;
    const r = await host.admit({
      ticket: ticket(),
      sessionId: sid(1),
      principal: p(1),
      plan: 'free',
      slots: { capacity: 6, running: 0 },
    });
    expect(decision(r)).toBe('refused:free_paused');
    expect(r.metered && r.decision === 'refused' && r.error.messageKey).toBe(
      'limit.sim.free_paused',
    );
    expect(store.events.length).toBe(before);
    expect(host.tracked).toBe(0);
    expect(host.waiting).toBe(0);
    for (const plan of ['legacy', 'advanced', 'pro'] as const) {
      const n = plan === 'legacy' ? 2 : plan === 'advanced' ? 3 : 4;
      expect(
        decision(
          await host.admit({
            ticket: ticket(),
            sessionId: sid(n),
            principal: p(n),
            plan,
            slots: { capacity: 6, running: n - 2 },
          }),
        ),
        plan,
      ).toBe('start');
    }
    // switched off again: Free admits at once, no restart
    paused = false;
    expect(
      decision(
        await host.admit({
          ticket: ticket(),
          sessionId: sid(9),
          principal: p(9),
          plan: 'free',
          slots: { capacity: 6, running: 3 },
        }),
      ),
    ).toBe('start');
  });

  it('a probe that throws or answers garbage counts as paused (fail closed)', async () => {
    for (const probe of [
      () => {
        throw new Error('EACCES');
      },
      () => 'yes' as unknown as boolean,
    ]) {
      const { host } = await make({ paused: probe });
      const r = await host.admit({
        ticket: ticket(),
        sessionId: sid(1),
        principal: p(1),
        plan: 'free',
        slots: { capacity: 6, running: 0 },
      });
      expect(decision(r)).toBe('refused:free_paused');
    }
  });

  it('pausing drops waiting Free entries (housekeeping and any admit) but never stops a running run', async () => {
    let paused = false;
    const { host } = await make({ paused: () => paused });
    // one Free run, and one Free waiter (host full)
    expect(
      decision(
        await host.admit({
          ticket: ticket(),
          sessionId: sid(1),
          principal: p(1),
          plan: 'free',
          slots: { capacity: 1, running: 0 },
        }),
      ),
    ).toBe('start');
    const waitTicket = ticket();
    expect(
      decision(
        await host.admit({
          ticket: waitTicket,
          sessionId: sid(2),
          principal: p(2),
          plan: 'free',
          slots: { capacity: 1, running: 1 },
        }),
      ),
    ).toBe('queued');
    expect(host.waiting).toBe(1);
    paused = true;
    const hk = await host.housekeeping();
    expect(hk.metered && hk.dropped).toEqual([
      {
        ticket: waitTicket,
        principal: p(2),
        reason: 'paused',
        error: limitError('free_paused'),
      },
    ]);
    expect(host.waiting).toBe(0);
    // the waiter's next poll: refused free_paused, not re-enqueued
    const poll = await host.admit({
      ticket: waitTicket,
      sessionId: sid(2),
      principal: p(2),
      plan: 'free',
      slots: { capacity: 1, running: 1 },
      mode: 'poll',
    });
    expect(decision(poll)).toBe('refused:free_paused');
    expect(host.waiting).toBe(0);
    // the running Free run is not touched by the kill switch
    const b = await host.heartbeat(sid(1), p(1));
    expect(b.metered && b.decision).toBe('continue');
    expect(host.tracked).toBe(1);
  });

  it('a paid admit while paused also drops waiting Free entries (so they never block it)', async () => {
    let paused = false;
    const { host } = await make({ paused: () => paused });
    const free = ticket();
    expect(
      decision(
        await host.admit({
          ticket: free,
          sessionId: sid(1),
          principal: p(1),
          plan: 'free',
          slots: { capacity: 1, running: 1 },
        }),
      ),
    ).toBe('queued');
    paused = true;
    const r = await host.admit({
      ticket: ticket(),
      sessionId: sid(2),
      principal: p(2),
      plan: 'legacy',
      slots: { capacity: 1, running: 0 },
    });
    expect(decision(r)).toBe('start');
    expect(r.metered && r.dropped.map((d) => [d.ticket, d.reason])).toEqual([[free, 'paused']]);
  });
});

describe('BETA-G2 (e): free_paused is a user-facing reason in HE and EN', () => {
  it('has its own message key and texts, no params', () => {
    expect(MESSAGE_KEY.free_paused).toBe('limit.sim.free_paused');
    for (const lang of ['he', 'en'] as const) {
      const text = renderLimit(lang, limitError('free_paused'));
      expect(text, lang).toBe(MESSAGES[lang]['limit.sim.free_paused']);
      expect(text.length, lang).toBeGreaterThan(10);
    }
  });
});

describe('BETA-G2 (d): the kill switch file in the sim state directory (hostboot)', () => {
  const parent = mkdtempSync(join(tmpdir(), 'plans-g2-'));
  afterAll(() => rmSync(parent, { recursive: true, force: true }));

  it('freePausedAt: absent = not paused; present (any type) = paused; unreadable path = paused', () => {
    const dir = mkdtempSync(join(parent, 'probe-'));
    const f = join(dir, FREE_PAUSE_FILE);
    expect(freePausedAt(f)).toBe(false);
    writeFileSync(f, '');
    expect(freePausedAt(f)).toBe(true);
    rmSync(f);
    mkdirSync(f);
    expect(freePausedAt(f)).toBe(true);
    rmSync(f, { recursive: true });
    // a path that cannot be checked (a parent is a regular file: ENOTDIR) fails closed
    const file = join(dir, 'plain');
    writeFileSync(file, '');
    expect(freePausedAt(join(file, FREE_PAUSE_FILE))).toBe(true);
  });

  it('a booted adapter refuses new Free admissions while the file exists, without a restart', async () => {
    const root = mkdtempSync(join(parent, 'boot-'));
    const cfg = join(root, 'sim.json');
    writeFileSync(cfg, JSON.stringify({ metering: { enabled: true } }));
    const state = join(root, 'state');
    const b = await bootSimPlans(
      {
        TBI_HOST_SIM_PLANS_CONFIG: cfg,
        TBI_HOST_SIM_PLANS_STATE: state,
        TBI_HOST_SIM_PLAN_MAP: 'preview=free,system=legacy',
      },
      30_000,
      { policyPlanNames: ['preview', 'system'], housekeepingMs: 250 },
      { clock: new FakeClock(NOON) },
    );
    expect(b).toBeDefined();
    try {
      const a = b!.adapter;
      const admit = (n: number, plan: 'free' | 'legacy') =>
        a.admit({
          ticket: ticket(),
          sessionId: sid(n),
          principal: p(n),
          plan,
          slots: { capacity: 6, running: a.tracked },
        });
      expect(decision(await admit(1, 'free'))).toBe('start');
      writeFileSync(join(state, FREE_PAUSE_FILE), '');
      expect(decision(await admit(2, 'free'))).toBe('refused:free_paused');
      expect(decision(await admit(3, 'legacy'))).toBe('start');
      rmSync(join(state, FREE_PAUSE_FILE));
      expect(decision(await admit(4, 'free'))).toBe('start');
    } finally {
      b!.lock.release();
    }
  });
});

describe('BETA-G2 slice 2: kill switch probe edge cases and operator lines', () => {
  const parent = mkdtempSync(join(tmpdir(), 'plans-g2s2-'));
  afterAll(() => rmSync(parent, { recursive: true, force: true }));
  const errno = (code: string | undefined): Error =>
    Object.assign(new Error(`lstat failed: /private/state/${FREE_PAUSE_FILE}`), { code });

  it('a symlink at the pause path is paused, dangling or live (lstat never follows it)', () => {
    const dir = mkdtempSync(join(parent, 'link-'));
    const f = join(dir, FREE_PAUSE_FILE);
    symlinkSync(join(dir, 'does-not-exist'), f);
    expect(freePausedAt(f)).toBe(true);
    rmSync(f);
    const target = join(dir, 'target');
    writeFileSync(target, '');
    symlinkSync(target, f);
    expect(freePausedAt(f)).toBe(true);
    rmSync(f);
    expect(freePausedAt(f)).toBe(false);
  });

  it('an error other than ENOENT (EACCES) = paused, logged ONCE per error code, code only (no path)', () => {
    const lines: string[] = [];
    let fail: string | null = 'EACCES';
    const probe = freePauseProbe(join(parent, 'x', FREE_PAUSE_FILE), {
      log: (l) => lines.push(l),
      stat: () => {
        if (fail) throw errno(fail);
        throw errno('ENOENT');
      },
    });
    expect(probe()).toBe(true);
    expect(probe()).toBe(true);
    expect(probe()).toBe(true);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: 'sim_free_pause_error', code: 'EACCES' },
      { event: 'sim_free_pause', paused: true },
    ]);
    // another distinct code: one more line; the same code again: none
    fail = 'EIO';
    expect(probe()).toBe(true);
    fail = 'EACCES';
    expect(probe()).toBe(true);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!)).toEqual({ event: 'sim_free_pause_error', code: 'EIO' });
    // recovers (ENOENT): one "off" transition line
    fail = null;
    expect(probe()).toBe(false);
    expect(probe()).toBe(false);
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[3]!)).toEqual({ event: 'sim_free_pause', paused: false });
    for (const l of lines) {
      expect(l).not.toContain('/');
      expect(l).not.toContain(FREE_PAUSE_FILE);
    }
  });

  it('a code that is not a plain errno name is logged as "unknown" (never error text)', () => {
    const lines: string[] = [];
    for (const code of [undefined, 'EACCES /private/state', 'x'.repeat(100)]) {
      const probe = freePauseProbe('/nowhere', {
        log: (l) => lines.push(l),
        stat: () => {
          throw errno(code);
        },
      });
      expect(probe()).toBe(true);
    }
    const errors = lines
      .map((l) => JSON.parse(l))
      .filter((l) => l.event === 'sim_free_pause_error');
    expect(errors).toEqual([
      { event: 'sim_free_pause_error', code: 'unknown' },
      { event: 'sim_free_pause_error', code: 'unknown' },
      { event: 'sim_free_pause_error', code: 'unknown' },
    ]);
    for (const l of lines) expect(l).not.toContain('private');
  });

  it('ENOTDIR from a real parent that is a file: paused + logged once; touch/rm transitions logged once each', () => {
    const dir = mkdtempSync(join(parent, 'real-'));
    const plain = join(dir, 'plain');
    writeFileSync(plain, '');
    const lines: string[] = [];
    const bad = freePauseProbe(join(plain, FREE_PAUSE_FILE), { log: (l) => lines.push(l) });
    expect(bad()).toBe(true);
    expect(bad()).toBe(true);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: 'sim_free_pause_error', code: 'ENOTDIR' },
      { event: 'sim_free_pause', paused: true },
    ]);

    lines.length = 0;
    const f = join(dir, FREE_PAUSE_FILE);
    const probe = freePauseProbe(f, { log: (l) => lines.push(l) });
    expect(probe()).toBe(false);
    expect(lines).toEqual([]); // the default state (off) is never logged
    writeFileSync(f, '');
    expect(probe()).toBe(true);
    expect(probe()).toBe(true);
    rmSync(f);
    expect(probe()).toBe(false);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: 'sim_free_pause', paused: true },
      { event: 'sim_free_pause', paused: false },
    ]);
  });
});
