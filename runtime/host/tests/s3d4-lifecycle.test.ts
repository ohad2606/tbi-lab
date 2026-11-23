/**
 * TBI-018 s3d-4: the metered run lifecycle (docs/plans/S3D-HOST-WIRING-DESIGN.md sections 5, 8, 11):
 * beat timer, `remainingMs` stop, new end reasons, `ended` on every terminal path (exactly one sim_close),
 * adapter housekeeping with an in-flight guard, shutdown awaiting pending `ended` (bounded), and the
 * s3d-3b review notes (quota re-check after admit, ticket bookkeeping inside the guarded try).
 *
 * Real SimHostAdapter (MemoryStore + FakeClock: the meter's clock moves only when a test steps it),
 * real HTTP server and test gates, fake runtime. Host timers are real but short.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_IDENTITY, principalFor, startTestGate, ticketFor } from '../../identity/test-gate.js';
import { parseConfig, type PlanId } from '../../plans/config.js';
import { limitError } from '../../plans/limits.js';
import type { SimEvent } from '../../plans/simminutes.js';
import { SimHostAdapter, type HostBeat, type HostHousekeeping } from '../../plans/simhost.js';
import { MemoryStore } from '../../plans/store.js';
import { FakeClock } from '../../plans/time.js';
import { DEFAULT_POLICY, Policy } from '../../policy/policy.js';
import type { ResourceProbe } from '../../policy/resources.js';
import type { HostConfig } from '../config.js';
import { SessionHost } from '../host.js';
import { createHttpServer } from '../http.js';
import { TicketRegistry } from '../queueTickets.js';
import type { HostSession } from '../session.js';
import { createRequest, fakeHost } from './support.js';

const parent = mkdtempSync(join(tmpdir(), 'tbi-s3d4-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));

const A = principalFor('user-a');
const B = principalFor('user-b');
const PRINCIPALS = [A, B];
const plenty: ResourceProbe = { freeDiskMb: () => 1e9, availableMemoryMb: () => 1e9 };
/** `advanced` has a one-minute monthly allowance here, so a run can use it up in three beats */
const PLANS = parseConfig({
  metering: { enabled: true },
  sim: { plans: { advanced: { monthlyMinutes: 1, dailyMinutes: null } } },
});
const LEASE = PLANS.sim.leaseMs;

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

let stderr: string[] = [];
beforeEach(() => {
  stderr = [];
  const orig = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, ...rest: never[]) => {
    stderr.push(String(chunk));
    return orig(chunk as string, ...rest);
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

type Adapter = NonNullable<HostConfig['simPlans']>;

interface Opts {
  plan?: PlanId;
  maxSessions?: number;
  perPrincipal?: number;
  beatMs?: number;
  housekeepingMs?: number;
  endWaitMs?: number;
  leaseMs?: number;
  simPlans?: (real: SimHostAdapter) => Adapter;
}

async function world(o: Opts = {}) {
  const clock = new FakeClock(Date.parse('2026-11-23T10:00:00Z'));
  const store = new MemoryStore<SimEvent>();
  const adapter = await SimHostAdapter.open(store, { config: PLANS, clock });
  const tickets = new TicketRegistry({ ttlMs: 600_000, cap: 100, perPrincipalCap: 2, clock });
  const c = structuredClone(DEFAULT_POLICY);
  if (o.perPrincipal !== undefined) c.plans.preview!.runtime.maxSessions = o.perPrincipal;
  c.global.runtime.maxLiveSessions = 4;
  const { host, art } = fakeHost('normal', {
    tmpParent: parent,
    policy: new Policy(c, 1),
    probe: plenty,
    maxSessions: o.maxSessions ?? 2,
    ...(o.leaseMs !== undefined ? { leaseMs: o.leaseMs } : {}),
    simPlans: o.simPlans ? o.simPlans(adapter) : adapter,
    simAdmission: {
      planMap: new Map<string, PlanId>([['preview', o.plan ?? 'legacy']]),
      pollAfterS: 15,
      tickets,
      beatMs: o.beatMs ?? 20,
      housekeepingMs: o.housekeepingMs ?? 60_000,
      endWaitMs: o.endWaitMs ?? 2_000,
    },
  });
  const server: Server = createHttpServer(host, TEST_IDENTITY);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  const gates = await Promise.all(
    ['user-a', 'user-b'].map((u) => startTestGate(target, TEST_IDENTITY, u)),
  );
  closers.push(async () => {
    for (const g of gates) g.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await host.shutdown();
  });
  const post = async (who: number, opt: { queue?: boolean; ticket?: string } = {}) => {
    const r = await fetch(`${gates[who]!.base}/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opt.queue ? { 'tbi-queue': '1' } : {}),
        ...(opt.ticket ? { 'tbi-queue-ticket': opt.ticket } : {}),
      },
      body: JSON.stringify(
        createRequest(art.sha256, { ticket: ticketFor(art.sha256, PRINCIPALS[who]!) }),
      ),
    });
    return {
      status: r.status,
      body: (await r.json()) as {
        sessionId?: string;
        token?: string;
        error?: string;
        queued?: { ticket: string };
        limit?: { code: string };
      },
    };
  };
  /** the host session behind a 201 */
  const session = (body: { sessionId?: string; token?: string }, who = A): HostSession => {
    const g = host.get(body.sessionId!, body.token!, who);
    if (!g.ok) throw new Error('no session');
    return g.value;
  };
  const closes = (id?: string) =>
    store.events.filter(
      (e): e is Extract<SimEvent, { t: 'sim_close' }> =>
        e.t === 'sim_close' && (id === undefined || e.sessionId === id),
    );
  return { host, art, adapter, store, tickets, clock, post, session, closes, gates };
}

const until = async (cond: () => boolean, ms = 3_000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const terminalEvent = (s: HostSession) =>
  s.log.since(0).find((e) => e.type === 'state' && (e.state === 'ended' || e.state === 'failed'));

describe('s3d-4: beats and the remainingMs stop', () => {
  it('beats the meter while the client lease lives; minutes used up -> stop at that beat, sim_minutes, billed = run time to that beat', async () => {
    const w = await world({ plan: 'advanced' });
    const beat = vi.spyOn(w.adapter, 'heartbeat');
    const ended = vi.spyOn(w.adapter, 'ended');
    const r = await w.post(0, { queue: true });
    expect(r.status).toBe(201);
    const s = w.session(r.body);
    for (let i = 0; i < 3 && !terminalEvent(s); i++) {
      const n = beat.mock.calls.length;
      w.clock.advance(20_000);
      await until(() => beat.mock.calls.length > n + 1 || terminalEvent(s) !== undefined);
    }
    await until(() => terminalEvent(s) !== undefined);
    expect(terminalEvent(s)).toMatchObject({
      state: 'ended',
      reason: 'sim_minutes',
      detail: { code: 'minutes_out', messageKey: 'limit.sim.minutes_out' },
    });
    expect(beat.mock.calls.every((c) => c[0] === r.body.sessionId && c[1] === A)).toBe(true);
    await until(() => ended.mock.calls.length === 1);
    const close = w.closes(r.body.sessionId);
    expect(close).toHaveLength(1);
    expect(close[0]).toMatchObject({ reason: 'cap', billedMs: 60_000 });
    // a beat after the end never happens and ended is not called twice
    await new Promise((res) => setTimeout(res, 80));
    const after = beat.mock.calls.length;
    await new Promise((res) => setTimeout(res, 80));
    expect(beat.mock.calls.length).toBe(after);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(w.closes()).toHaveLength(1);
  });

  it('the remainingMs timer fires without client traffic (next beat = min(beatMs, remainingMs))', async () => {
    let beats = 0;
    const w = await world({
      beatMs: 60_000,
      simPlans: (real) => ({
        enabled: real.enabled,
        hasWaiting: (p) => real.hasWaiting(p),
        cancel: (t, p) => real.cancel(t, p),
        ended: (id, why, p) => real.ended(id, why, p),
        housekeeping: () => real.housekeeping(),
        admit: async (req) => {
          const a = await real.admit(req);
          return a.metered && a.decision === 'start' ? { ...a, remainingMs: 40 } : a;
        },
        heartbeat: async () => {
          beats++;
          return { metered: true, decision: 'stop', error: limitError('sim_daily') };
        },
      }),
    });
    const r = await w.post(0, { queue: true });
    const s = w.session(r.body);
    await until(() => terminalEvent(s) !== undefined, 1_500);
    expect(beats).toBe(1);
    expect(terminalEvent(s)).toMatchObject({
      reason: 'sim_minutes',
      detail: { code: 'sim_daily' },
    });
    await until(() => w.closes(r.body.sessionId).length === 1);
  });

  it('a refused beat (host bug) is logged and does not stop the run; a throwing beat stops with sim_unavailable', async () => {
    let mode: 'refuse' | 'throw' = 'refuse';
    let beats = 0;
    const w = await world({
      simPlans: (real) => ({
        enabled: real.enabled,
        hasWaiting: (p) => real.hasWaiting(p),
        cancel: (t, p) => real.cancel(t, p),
        ended: (id, why, p) => real.ended(id, why, p),
        housekeeping: () => real.housekeeping(),
        admit: (req) => real.admit(req),
        heartbeat: async () => {
          beats++;
          if (mode === 'throw') throw new Error('boom');
          return { metered: true, decision: 'refused', error: limitError('invalid_state') };
        },
      }),
    });
    const r = await w.post(0, { queue: true });
    const s = w.session(r.body);
    await until(() => beats >= 3);
    expect(terminalEvent(s)).toBeUndefined();
    expect(stderr.some((l) => l.includes('"sim_beat_fault"') && l.includes('"refused"'))).toBe(
      true,
    );
    mode = 'throw';
    await until(() => terminalEvent(s) !== undefined);
    expect(terminalEvent(s)).toMatchObject({
      reason: 'sim_unavailable',
      detail: { code: 'system_unavailable' },
    });
    await until(() => w.closes(r.body.sessionId).length === 1);
    expect(stderr.join('')).not.toContain(A);
  });

  it('journal append failure mid-run: the running session stops with sim_unavailable, new admissions 503 (O-4)', async () => {
    const w = await world();
    const r = await w.post(0, { queue: true });
    const s = w.session(r.body);
    w.store.failOnCall = 'always';
    // a beat that persists: step past the persist interval
    w.clock.advance(LEASE / 2);
    await until(() => terminalEvent(s) !== undefined);
    expect(terminalEvent(s)).toMatchObject({ reason: 'sim_unavailable' });
    const again = await w.post(1, { queue: true });
    expect(again.status).toBe(503);
    expect(again.body.limit?.code).toBe('system_unavailable');
    expect(w.host.health().running ?? 0).toBe(0);
  });

  it('no beat without a client: the host lease ends the run, billed at most lastBeat + leaseMs (reason lease)', async () => {
    const w = await world({ beatMs: 60_000, leaseMs: 150 });
    const r = await w.post(0, { queue: true });
    const s = w.session(r.body);
    w.clock.advance(LEASE * 4);
    await until(() => terminalEvent(s) !== undefined);
    expect(terminalEvent(s)).toMatchObject({ reason: 'lease_expired' });
    await until(() => w.closes(r.body.sessionId).length === 1);
    expect(w.closes(r.body.sessionId)[0]).toMatchObject({ reason: 'lease', billedMs: LEASE });
  });
});

describe('s3d-4: ended on every terminal path, exactly one sim_close', () => {
  const paths: [
    string,
    (w: Awaited<ReturnType<typeof world>>, s: HostSession) => unknown,
    string,
  ][] = [
    ['terminate (DELETE)', (w, s) => w.host.terminate(s), 'ended'],
    ['failNow', (_w, s) => s.failNow('storage_limit'), 'ended'],
    ['account_disabled', (w) => w.host.revokeUnauthorized(() => false), 'ended'],
    ['host_shutdown', (w) => w.host.shutdown(), 'host'],
  ];
  for (const [name, act, reason] of paths)
    it(`${name}: ended once with close reason ${reason}`, async () => {
      const w = await world({ beatMs: 60_000 });
      const ended = vi.spyOn(w.adapter, 'ended');
      const r = await w.post(0, { queue: true });
      const s = w.session(r.body);
      await act(w, s);
      await until(() => ended.mock.calls.length >= 1);
      // a second terminal attempt never bills again
      await w.host.terminate(s);
      await s.failNow('storage_limit');
      await new Promise((res) => setTimeout(res, 50));
      expect(ended).toHaveBeenCalledTimes(1);
      expect(ended.mock.calls[0]).toEqual([r.body.sessionId, reason, A]);
      expect(w.closes()).toHaveLength(1);
      expect(w.closes()[0]).toMatchObject({ sessionId: r.body.sessionId, reason });
      expect(w.adapter.tracked).toBe(0);
    });

  it('a run whose artifact fails at prepare is ended once too (slot and meter released)', async () => {
    const w = await world({ beatMs: 60_000 });
    const ended = vi.spyOn(w.adapter, 'ended');
    const sha = 'f'.repeat(64);
    const res = await fetch(`${w.gates[0]!.base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'tbi-queue': '1' },
      body: JSON.stringify(createRequest(sha, { ticket: ticketFor(sha, A) })),
    });
    expect([201, 500]).toContain(res.status);
    await until(() => ended.mock.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(ended).toHaveBeenCalledTimes(1);
    expect(w.closes()).toHaveLength(1);
    expect(w.adapter.tracked).toBe(0);
  });

  it('ended / housekeeping that throw are logged and swallowed; the host keeps serving', async () => {
    const w = await world({
      beatMs: 60_000,
      housekeepingMs: 60,
      simPlans: (real) => ({
        enabled: real.enabled,
        hasWaiting: (p) => real.hasWaiting(p),
        cancel: (t, p) => real.cancel(t, p),
        admit: (req) => real.admit(req),
        heartbeat: (id, p) => real.heartbeat(id, p),
        ended: () => Promise.reject(new Error('boom')),
        housekeeping: () => {
          throw new Error('boom');
        },
      }),
    });
    const r = await w.post(0, { queue: true });
    await w.host.terminate(w.session(r.body));
    await until(() => stderr.some((l) => l.includes('"ended"')));
    await until(() => stderr.some((l) => l.includes('"housekeeping"')));
    expect((await w.post(1, { queue: true })).status).toBe(201);
  });
});

describe('s3d-4: adapter housekeeping', () => {
  it('runs every housekeepingMs, never two at once; dropped tickets reach the registry', async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    let next: HostHousekeeping | null = null;
    const w = await world({
      housekeepingMs: 30,
      simPlans: (real) => ({
        enabled: real.enabled,
        hasWaiting: (p) => real.hasWaiting(p),
        cancel: (t, p) => real.cancel(t, p),
        admit: (req) => real.admit(req),
        heartbeat: (id, p) => real.heartbeat(id, p),
        ended: (id, why, p) => real.ended(id, why, p),
        housekeeping: () => {
          calls++;
          return new Promise<HostHousekeeping>((res) => {
            release = () =>
              res(next ?? { metered: true, ok: true, closed: 0, pruned: 0, dropped: [] });
          });
        },
      }),
    });
    await until(() => calls === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(1); // in-flight guard
    const ticket = 'q'.repeat(0) + (await import('../queueTickets.js')).newQueueTicket();
    w.tickets.issue(A, ticket);
    next = {
      metered: true,
      ok: true,
      closed: 0,
      pruned: 2,
      dropped: [{ ticket, principal: A, reason: 'timeout', error: limitError('queue_timeout') }],
    };
    release!();
    await until(() => w.tickets.lookup(ticket, A)?.kind === 'dropped');
    expect(w.tickets.lookup(ticket, A)).toMatchObject({
      kind: 'dropped',
      limit: { code: 'queue_timeout' },
    });
    await until(() => calls >= 2);
    expect(stderr.some((l) => l.includes('"pruned":2'))).toBe(true);
  });
});

describe('s3d-4: shutdown awaits pending ended (bounded)', () => {
  it('waits for a slow ended', async () => {
    let done = false;
    const w = await world({
      beatMs: 60_000,
      simPlans: (real) => ({
        enabled: real.enabled,
        hasWaiting: (p) => real.hasWaiting(p),
        cancel: (t, p) => real.cancel(t, p),
        admit: (req) => real.admit(req),
        heartbeat: (id, p) => real.heartbeat(id, p),
        housekeeping: () => real.housekeeping(),
        ended: async (id, why, p) => {
          await new Promise((r) => setTimeout(r, 150));
          const e = await real.ended(id, why, p);
          done = true;
          return e;
        },
      }),
    });
    await w.post(0, { queue: true });
    await w.host.shutdown();
    expect(done).toBe(true);
    expect(w.closes()).toHaveLength(1);
    expect(w.closes()[0]).toMatchObject({ reason: 'host' });
  });

  it('gives up after endWaitMs on an ended that never answers, with one log line', async () => {
    const w = await world({
      beatMs: 60_000,
      endWaitMs: 100,
      simPlans: (real) => ({
        enabled: real.enabled,
        hasWaiting: (p) => real.hasWaiting(p),
        cancel: (t, p) => real.cancel(t, p),
        admit: (req) => real.admit(req),
        heartbeat: (id, p) => real.heartbeat(id, p),
        housekeeping: () => real.housekeeping(),
        ended: () => new Promise(() => {}),
      }),
    });
    await w.post(0, { queue: true });
    const t0 = Date.now();
    await w.host.shutdown();
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(stderr.some((l) => l.includes('"sim_end_wait_timeout"'))).toBe(true);
  });
});

describe('s3d-4: s3d-3b review notes', () => {
  it('(a) the per-principal quota is re-checked after the awaited admit: violated -> session_quota, the run is ended', async () => {
    let gate: (() => void) | null = null;
    const w = await world({
      perPrincipal: 1,
      beatMs: 60_000,
      simPlans: (real) => ({
        enabled: real.enabled,
        hasWaiting: (p) => real.hasWaiting(p),
        cancel: (t, p) => real.cancel(t, p),
        heartbeat: (id, p) => real.heartbeat(id, p),
        housekeeping: () => real.housekeeping(),
        ended: (id, why, p) => real.ended(id, why, p),
        admit: async (req) => {
          await new Promise<void>((r) => (gate = r));
          return real.admit(req);
        },
      }),
    });
    const ended = vi.spyOn(w.host.config.simPlans!, 'ended');
    const pending = w.post(0, { queue: true });
    await until(() => gate !== null);
    // meanwhile the same principal got a session on another path (legacy create)
    const other = w.host.create(
      createRequest(w.art.sha256, { ticket: ticketFor(w.art.sha256, A) }),
      A,
    );
    expect(other.ok).toBe(true);
    gate!();
    const r = await pending;
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('session_quota');
    await until(() => ended.mock.calls.length === 1);
    expect(w.closes()).toHaveLength(1);
    expect(w.adapter.tracked).toBe(0);
    expect(w.host.capacity().live).toBe(1);
  });
});

describe('s3d-4: flag-off unchanged', () => {
  it('a host without an adapter has no beat or meter calls and its sessions end as before', async () => {
    const { host, art } = fakeHost('normal', { tmpParent: parent });
    closers.push(() => host.shutdown());
    const c = host.create(createRequest(art.sha256, { ticket: ticketFor(art.sha256, A) }), A);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    await host.terminate(c.value.session);
    expect(terminalEvent(c.value.session)).toMatchObject({ reason: 'terminated' });
    expect(SessionHost.prototype).toBeDefined();
  });
});

describe('s3d-4: ops review', () => {
  const passThrough = (real: SimHostAdapter): Adapter => ({
    enabled: real.enabled,
    hasWaiting: (p) => real.hasWaiting(p),
    cancel: (t, p) => real.cancel(t, p),
    admit: (req) => real.admit(req),
    heartbeat: (id, p) => real.heartbeat(id, p),
    ended: (id, why, p) => real.ended(id, why, p),
    housekeeping: () => real.housekeeping(),
  });

  it('MEDIUM-1: a heartbeat that never answers stops the run (sim_unavailable) after max(1, leaseMs - beatMs); a late answer is ignored', async () => {
    let beats = 0;
    let late: ((b: HostBeat) => void) | null = null;
    const w = await world({
      beatMs: 20,
      leaseMs: 400,
      simPlans: (real) => ({
        ...passThrough(real),
        heartbeat: () => {
          beats++;
          return new Promise<HostBeat>((r) => (late = r));
        },
      }),
    });
    const ended = vi.spyOn(w.host.config.simPlans!, 'ended');
    const r = await w.post(0, { queue: true });
    expect(r.status).toBe(201);
    const s = w.session(r.body);
    const t0 = Date.now();
    // the client is there the whole time (the beat only runs while the host lease lives)
    const keep = setInterval(() => w.session(r.body), 20);
    try {
      await until(() => terminalEvent(s) !== undefined, 3_000);
    } finally {
      clearInterval(keep);
    }
    // first beat at ~20 ms, timeout 400 - 20 = 380 ms after it
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(beats).toBe(1);
    expect(terminalEvent(s)).toMatchObject({
      state: 'ended',
      reason: 'sim_unavailable',
      detail: { code: 'system_unavailable' },
    });
    const faults = stderr.filter((l) => l.includes('"sim_beat_fault"'));
    expect(faults).toEqual([`${JSON.stringify({ event: 'sim_beat_fault', op: 'timeout' })}\n`]);
    expect(stderr.join('')).not.toContain(A);
    expect(stderr.join('')).not.toContain(r.body.sessionId!);
    await until(() => ended.mock.calls.length === 1);
    // the late answer changes nothing: no second stop, no new beat, no second ended
    late!({ metered: true, decision: 'stop', error: limitError('sim_daily') });
    await new Promise((res) => setTimeout(res, 80));
    expect(terminalEvent(s)).toMatchObject({ reason: 'sim_unavailable' });
    expect(beats).toBe(1);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(w.closes(r.body.sessionId)).toHaveLength(1);
  });

  it('MEDIUM-1: a heartbeat that answers in time is not timed out', async () => {
    let beats = 0;
    const w = await world({
      beatMs: 20,
      leaseMs: 400,
      simPlans: (real) => ({
        ...passThrough(real),
        heartbeat: async (id, p) => {
          beats++;
          await new Promise((res) => setTimeout(res, 100));
          return real.heartbeat(id, p);
        },
      }),
    });
    const r = await w.post(0, { queue: true });
    const s = w.session(r.body);
    const keep = setInterval(() => w.session(r.body), 20);
    try {
      await until(() => beats >= 4, 3_000);
    } finally {
      clearInterval(keep);
    }
    expect(terminalEvent(s)).toBeUndefined();
    expect(stderr.some((l) => l.includes('"timeout"'))).toBe(false);
  });

  const LIMIT = { code: 'system_unavailable', messageKey: 'limit.system.unavailable' };
  it('LOW-2: sim stop then shutdown: the first request wins for reason AND detail', async () => {
    const w = await world({ beatMs: 60_000 });
    const r = await w.post(0, { queue: true });
    const s = w.session(r.body);
    expect(s.run()).toEqual({ ok: true });
    const first = s.terminate('sim_unavailable', structuredClone(LIMIT));
    const second = s.terminate('host_shutdown');
    await Promise.all([first, second]);
    expect(terminalEvent(s)).toMatchObject({
      state: 'ended',
      reason: 'sim_unavailable',
      detail: LIMIT,
    });
  });

  it('LOW-2: shutdown then sim stop: host_shutdown without the later detail', async () => {
    const w = await world({ beatMs: 60_000 });
    const r = await w.post(0, { queue: true });
    const s = w.session(r.body);
    expect(s.run()).toEqual({ ok: true });
    const first = s.terminate('host_shutdown');
    const second = s.terminate('sim_minutes', { code: 'sim_daily' });
    await Promise.all([first, second]);
    const e = terminalEvent(s);
    expect(e).toMatchObject({ state: 'ended', reason: 'host_shutdown' });
    expect((e as { detail?: unknown }).detail).toBeUndefined();
  });

  it('LOW-2: both orders while creating', async () => {
    const { HostSession } = await import('../session.js');
    const prepare = vi.spyOn(HostSession.prototype, 'prepare').mockImplementation(() => {});
    const w = await world({ beatMs: 60_000 });
    const r = await w.post(0, { queue: true });
    const s = w.session(r.body);
    expect(s.state).toBe('creating');
    await s.terminate('sim_unavailable', structuredClone(LIMIT));
    await s.terminate('host_shutdown');
    prepare.mockRestore();
    s.prepare();
    expect(terminalEvent(s)).toMatchObject({ reason: 'sim_unavailable', detail: LIMIT });
  });

  it('LOW-3: a metered session still creating at shutdown is ended (host) inside the bounded wait', async () => {
    const { HostSession } = await import('../session.js');
    vi.spyOn(HostSession.prototype, 'prepare').mockImplementation(() => {});
    const w = await world({ beatMs: 60_000 });
    const ended = vi.spyOn(w.host.config.simPlans!, 'ended');
    const r = await w.post(0, { queue: true });
    expect(r.status).toBe(201);
    expect(w.session(r.body).state).toBe('creating');
    await w.host.shutdown();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]).toEqual([r.body.sessionId, 'host', A]);
    expect(w.closes(r.body.sessionId)).toHaveLength(1);
    expect(w.closes(r.body.sessionId)[0]).toMatchObject({ reason: 'host' });
  });
});
