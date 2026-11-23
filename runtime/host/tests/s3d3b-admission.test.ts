/**
 * TBI-018 s3d-3b: admission over HTTP with an ENABLED sim adapter (docs/plans/S3D-HOST-WIRING-DESIGN.md
 * sections 2 steps 5-9, 3, 4, 8, 11). Real SimHostAdapter (MemoryStore, FakeClock), real TicketRegistry,
 * real HTTP server and test gates; the runtime is the fake one (nothing is run).
 *
 * Not covered here (s3d-4 run lifecycle): beats, `remainingMs` stops and `ended` on every terminal path.
 * Where a test needs a slot freed it ends the meter run by hand (`adapter.ended`), as s3d-4 will.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_IDENTITY, principalFor, startTestGate, ticketFor } from '../../identity/test-gate.js';
import type { Principal } from '../../identity/principal.js';
import { parseConfig, type PlanId } from '../../plans/config.js';
import { limitError, type LimitCode } from '../../plans/limits.js';
import type { SimEvent } from '../../plans/simminutes.js';
import { SimHostAdapter, type HostAdmit } from '../../plans/simhost.js';
import { MemoryStore } from '../../plans/store.js';
import { FakeClock } from '../../plans/time.js';
import { DEFAULT_POLICY, Policy } from '../../policy/policy.js';
import type { RateLimiter } from '../../policy/rate.js';
import type { ResourceProbe } from '../../policy/resources.js';
import type { HostConfig } from '../config.js';
import { SessionHost } from '../host.js';
import { createHttpServer } from '../http.js';
import { TicketRegistry, isQueueTicket } from '../queueTickets.js';
import { HostSession } from '../session.js';
import { createRequest, fakeHost } from './support.js';

const parent = mkdtempSync(join(tmpdir(), 'tbi-s3d3b-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));

const A = principalFor('user-a');
const B = principalFor('user-b');
const C = principalFor('user-c');
const PRINCIPALS = [A, B, C];
const plenty: ResourceProbe = { freeDiskMb: () => 1e9, availableMemoryMb: () => 1e9 };
const PLANS = parseConfig({ metering: { enabled: true } });
const MAX_WAIT = PLANS.queue.maxWaitMs;
const VANISH = PLANS.queue.vanishMs;

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

interface Opts {
  /** host maxSessions (capacity = min(policy cpus 1, maxSessions)); 0 = every request queues */
  maxSessions?: number;
  planMap?: ReadonlyMap<string, PlanId>;
  ticketCap?: number;
  rates?: Pick<RateLimiter, 'take'>;
  /** policy plan runtime.maxSessions (per principal) */
  perPrincipal?: number;
  /** wrap / replace the real adapter */
  simPlans?: (real: SimHostAdapter) => NonNullable<HostConfig['simPlans']>;
}

function policyWith(perPrincipal?: number): Policy {
  const c = structuredClone(DEFAULT_POLICY);
  if (perPrincipal !== undefined) c.plans.preview!.runtime.maxSessions = perPrincipal;
  // capacity = min(maxLiveSessions, host maxSessions); 4 lets maxSessions decide
  c.global.runtime.maxLiveSessions = 4;
  return new Policy(c, 1);
}

async function world(o: Opts = {}) {
  const clock = new FakeClock(Date.parse('2026-11-23T10:00:00Z'));
  const store = new MemoryStore<SimEvent>();
  const adapter = await SimHostAdapter.open(store, { config: PLANS, clock });
  const tickets = new TicketRegistry({
    ttlMs: MAX_WAIT + VANISH,
    cap: o.ticketCap ?? 100,
    perPrincipalCap: 2,
    clock,
  });
  const { host, art } = fakeHost('normal', {
    tmpParent: parent,
    policy: policyWith(o.perPrincipal),
    probe: plenty,
    maxSessions: o.maxSessions ?? 1,
    simPlans: o.simPlans ? o.simPlans(adapter) : adapter,
    simAdmission: {
      planMap: o.planMap ?? new Map<string, PlanId>([['preview', 'legacy']]),
      pollAfterS: 15,
      tickets,
    },
    ...(o.rates ? { rates: o.rates as RateLimiter } : {}),
  });
  const server: Server = createHttpServer(host, TEST_IDENTITY);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  const gates = await Promise.all(
    ['user-a', 'user-b', 'user-c'].map((u) => startTestGate(target, TEST_IDENTITY, u)),
  );
  closers.push(async () => {
    for (const g of gates) g.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await host.shutdown();
  });
  /** POST /sessions as gate `who`; `queue`: send `Tbi-Queue: 1`; `ticket`: `Tbi-Queue-Ticket`. */
  const post = async (
    who: number,
    opt: { queue?: boolean; ticket?: string; runTicket?: string } = {},
  ) => {
    const r = await fetch(`${gates[who]!.base}/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opt.queue ? { 'tbi-queue': '1' } : {}),
        ...(opt.ticket ? { 'tbi-queue-ticket': opt.ticket } : {}),
      },
      body: JSON.stringify(
        createRequest(art.sha256, {
          ticket: opt.runTicket ?? ticketFor(art.sha256, PRINCIPALS[who]!),
        }),
      ),
    });
    const text = await r.text();
    return {
      status: r.status,
      retryAfter: r.headers.get('retry-after'),
      body: JSON.parse(text) as Record<string, unknown> & {
        queued?: { ticket: string; position: number; pollAfterS: number };
        limit?: { code: string; messageKey: string; params: Record<string, unknown> };
        sessionId?: string;
        token?: string;
        sim?: unknown;
      },
    };
  };
  const cancel = async (who: number, ticket: string) =>
    (
      await fetch(`${gates[who]!.base}/sessions/queue`, {
        method: 'DELETE',
        headers: { 'tbi-queue-ticket': ticket },
      })
    ).status;
  return { host, art, adapter, store, tickets, clock, post, cancel };
}

/** End a run's meter session by hand (s3d-4 will do it on every terminal path). */
async function freeSlot(w: Awaited<ReturnType<typeof world>>, sessionId: string, who: Principal) {
  expect(await w.adapter.ended(sessionId, 'ended', who)).toMatchObject({ metered: true, ok: true });
}

const queueLimit = (n: number) => ({
  code: 'queue',
  messageKey: 'limit.sim.queue',
  params: { n },
});

describe('s3d-3b: metered POST /sessions, queue-capable client', () => {
  it('a free slot starts at once: 201 with the additive sim field, one meter session', async () => {
    const w = await world();
    const r = await w.post(0, { queue: true });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ sim: { plan: 'legacy', remainingMs: null } });
    expect(Object.keys(r.body).sort()).toEqual(['sessionId', 'sim', 'status', 'token']);
    expect(w.adapter.tracked).toBe(1);
    expect(w.adapter.planOf(r.body.sessionId!)).toBe('legacy');
    expect(w.host.size).toBe(1);
  });

  it('capacity full -> 202 + position + Retry-After; slot freed -> the poll starts; re-poll = same 201 (O-5)', async () => {
    const w = await world();
    const first = await w.post(1, { queue: true });
    expect(first.status).toBe(201);

    const q = await w.post(0, { queue: true });
    expect(q.status).toBe(202);
    expect(q.retryAfter).toBe('15');
    expect(q.body).toEqual({
      queued: { ticket: expect.any(String), position: 1, pollAfterS: 15 },
      limit: queueLimit(1),
    });
    const ticket = q.body.queued!.ticket;
    expect(isQueueTicket(ticket)).toBe(true);
    expect(w.tickets.lookup(ticket, A)).toEqual({ kind: 'waiting' });
    expect(w.adapter.hasWaiting(A)).toBe(true);

    // still full: the poll keeps its place
    const again = await w.post(0, { queue: true, ticket });
    expect(again.status).toBe(202);
    expect(again.body.queued).toEqual({ ticket, position: 1, pollAfterS: 15 });

    // B's run ends (host and meter)
    const s = w.host.get(first.body.sessionId!, first.body.token!, B);
    expect(s.ok).toBe(true);
    if (s.ok) await w.host.terminate(s.value);
    await freeSlot(w, first.body.sessionId!, B);

    const started = await w.post(0, { queue: true, ticket });
    expect(started.body).toMatchObject({ sessionId: expect.any(String) });
    expect(started.status).toBe(201);
    expect(started.body.sim).toEqual({ plan: 'legacy', remainingMs: null });
    expect(w.tickets.lookup(ticket, A)).toEqual({
      kind: 'started',
      sessionId: started.body.sessionId,
    });
    expect(w.adapter.hasWaiting(A)).toBe(false);

    // a lost answer: the same poll again gets the same session and token, nothing new is admitted
    const admit = vi.spyOn(w.adapter, 'admit');
    const replay = await w.post(0, { queue: true, ticket });
    expect(replay.status).toBe(201);
    expect(replay.body.sessionId).toBe(started.body.sessionId);
    expect(replay.body.token).toBe(started.body.token);
    expect(admit).not.toHaveBeenCalled();
    expect(w.adapter.tracked).toBe(1);
    // no ticket value in any log line
    expect(stderr.join('')).not.toContain(ticket);
  });

  it('two concurrent polls of one ticket when the slot frees: one run, both get the same 201', async () => {
    const w = await world({ maxSessions: 0 });
    const ticket = (await w.post(0, { queue: true })).body.queued!.ticket;
    w.host.config.maxSessions = 1;
    const [x, y] = await Promise.all([
      w.post(0, { queue: true, ticket }),
      w.post(0, { queue: true, ticket }),
    ]);
    expect([x.status, y.status]).toEqual([201, 201]);
    expect(x.body.sessionId).toBe(y.body.sessionId);
    expect(x.body.token).toBe(y.body.token);
    expect(w.adapter.tracked).toBe(1);
    expect(w.host.size).toBe(1);
  });

  it('max wait -> 429 queue_timeout on the poll, and the entry is never recreated', async () => {
    const w = await world({ maxSessions: 0 });
    const q = await w.post(0, { queue: true });
    expect(q.status).toBe(202);
    const ticket = q.body.queued!.ticket;
    w.clock.advance(MAX_WAIT);
    for (let i = 0; i < 2; i++) {
      const r = await w.post(0, { queue: true, ticket });
      expect(r.status).toBe(429);
      expect(r.body).toEqual({
        error: 'queue_timeout',
        limit: { code: 'queue_timeout', messageKey: 'limit.sim.queue_timeout', params: {} },
      });
      expect(w.adapter.waiting).toBe(0);
    }
  });

  it('a vanished waiter is dropped (another admission ticks) and its poll answers queue_timeout', async () => {
    const w = await world({ maxSessions: 0 });
    const a = await w.post(0, { queue: true });
    const ticket = a.body.queued!.ticket;
    w.clock.advance(VANISH);
    const b = await w.post(1, { queue: true });
    expect(b.status).toBe(202);
    expect(b.body.queued!.position).toBe(1); // A is gone
    expect(w.tickets.lookup(ticket, A)).toMatchObject({ kind: 'dropped', reason: 'limit' });
    const r = await w.post(0, { queue: true, ticket });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('queue_timeout');
    expect(w.adapter.hasWaiting(A)).toBe(false);
  });

  it('cancel (3a review note 1): DELETE then poll does not re-enqueue', async () => {
    const w = await world({ maxSessions: 0 });
    const q = await w.post(0, { queue: true });
    const ticket = q.body.queued!.ticket;
    expect(await w.cancel(1, ticket)).toBe(204); // foreign: nothing changes
    expect(w.adapter.hasWaiting(A)).toBe(true);
    expect(w.tickets.lookup(ticket, A)).toEqual({ kind: 'waiting' });
    expect(await w.cancel(0, ticket)).toBe(204);
    expect(w.adapter.hasWaiting(A)).toBe(false);
    expect(w.tickets.lookup(ticket, A)).toMatchObject({ kind: 'dropped' });
    const admit = vi.spyOn(w.adapter, 'admit');
    const r = await w.post(0, { queue: true, ticket });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('queue_timeout');
    expect(admit).not.toHaveBeenCalled();
    expect(w.adapter.waiting).toBe(0);
  });

  it('two tabs of one principal: the newer ticket takes the entry; the older poll gets 409 queue_replaced', async () => {
    const take = vi.fn((): { ok: true } => ({ ok: true }));
    const w = await world({ maxSessions: 0, rates: { take } as never });
    await w.post(1, { queue: true }); // B waits first
    const t1 = (await w.post(0, { queue: true })).body.queued!.ticket;
    const tab2 = await w.post(0, { queue: true });
    expect(tab2.status).toBe(202);
    const t2 = tab2.body.queued!.ticket;
    expect(t2).not.toBe(t1);
    expect(tab2.body.queued!.position).toBe(2); // kept A's place
    expect(w.adapter.waiting).toBe(2);
    expect(take).toHaveBeenCalledTimes(3);

    const old = await w.post(0, { queue: true, ticket: t1 });
    expect(old.status).toBe(409);
    expect(old.body).toEqual({
      error: 'queue_replaced',
      limit: { code: 'queue_replaced', messageKey: 'limit.sim.queue_replaced', params: {} },
    });
    expect(take).toHaveBeenCalledTimes(3); // no rate unit on that poll
    // the older tab did not take the entry back: the newer tab still waits in the same place
    const newer = await w.post(0, { queue: true, ticket: t2 });
    expect(newer.status).toBe(202);
    expect(newer.body.queued).toEqual({ ticket: t2, position: 2, pollAfterS: 15 });
    expect(take).toHaveBeenCalledTimes(3);
    // queue_replaced is distinct from queue_timeout
    w.clock.advance(MAX_WAIT);
    expect((await w.post(0, { queue: true, ticket: t1 })).status).toBe(409);
    expect((await w.post(0, { queue: true, ticket: t2 })).body.error).toBe('queue_timeout');
  });

  it('an unknown or foreign ticket is a new admission with a fresh ticket', async () => {
    const w = await world({ maxSessions: 0 });
    const b = (await w.post(1, { queue: true })).body.queued!.ticket;
    const r = await w.post(0, { queue: true, ticket: b }); // B's ticket from A
    expect(r.status).toBe(202);
    expect(r.body.queued!.ticket).not.toBe(b);
    expect(w.tickets.lookup(b, B)).toEqual({ kind: 'waiting' });
    expect(w.adapter.waiting).toBe(2);
  });

  it('a run ticket that expired while waiting: 403 and the entry is cancelled', async () => {
    const w = await world({ maxSessions: 0 });
    const t = (await w.post(0, { queue: true })).body.queued!.ticket;
    const stale = ticketFor(w.art.sha256, A, null, 1);
    await new Promise((r) => setTimeout(r, 20));
    const r = await w.post(0, { queue: true, ticket: t, runTicket: stale });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'ticket invalid' });
    expect(w.adapter.hasWaiting(A)).toBe(false);
    expect(w.tickets.lookup(t, A)).toMatchObject({ kind: 'dropped' });
  });

  it('registry eviction cancels the evicted waiter in the adapter too (3a review note 2)', async () => {
    const w = await world({ maxSessions: 0, ticketCap: 2 });
    const a = (await w.post(0, { queue: true })).body.queued!.ticket;
    await w.post(1, { queue: true });
    expect(w.adapter.waiting).toBe(2);
    await w.post(2, { queue: true }); // registry at its cap: A's (oldest) waiting ticket is evicted
    await vi.waitFor(() => expect(w.adapter.hasWaiting(A)).toBe(false));
    expect(w.tickets.lookup(a, A)).toBeNull();
    expect(w.adapter.hasWaiting(B)).toBe(true);
    expect(w.adapter.hasWaiting(C)).toBe(true);
    expect(w.tickets.size).toBe(2);
  });

  it('registry (M2): a ticketless flood from one principal and from many never grows past the caps', async () => {
    const w = await world({ maxSessions: 0, ticketCap: 4 });
    for (let i = 0; i < 10; i++) expect((await w.post(0, { queue: true })).status).toBe(202);
    expect(w.tickets.size).toBe(2); // its waiting ticket and the one it replaced
    expect(w.adapter.waiting).toBe(1);
    for (let i = 0; i < 10; i++) await w.post(i % 3, { queue: true });
    expect(w.tickets.size).toBeLessThanOrEqual(4);
    expect(w.adapter.waiting).toBeLessThanOrEqual(3);
    // every waiting entry in the adapter still has a registry ticket (evicted ones were cancelled)
    expect(w.tickets.counts().waiting).toBe(w.adapter.waiting);
  });

  it('session_quota (host, legacy refusal) is checked before the adapter', async () => {
    const w = await world({ maxSessions: 4, perPrincipal: 1 });
    expect((await w.post(0, { queue: true })).status).toBe(201);
    const admit = vi.spyOn(w.adapter, 'admit');
    const r = await w.post(0, { queue: true });
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: 'session_quota' });
    expect(admit).not.toHaveBeenCalled();
  });
});

describe('s3d-3b: legacy client (no Tbi-Queue: 1)', () => {
  it("capacity full: 503 runtime_capacity (today's answer), nothing left in the queue or registry", async () => {
    const w = await world({ maxSessions: 0 });
    const r = await w.post(0, { ticket: 'ignored' });
    expect(r.status).toBe(503);
    expect(r.retryAfter).toBe('15');
    expect(r.body).toEqual({ error: 'runtime_capacity', retryAfterS: 15 });
    expect(w.adapter.waiting).toBe(0);
    expect(w.tickets.size).toBe(0);
  });

  it('a free slot starts as for a queue-capable client (201, sim is additive)', async () => {
    const w = await world();
    const r = await w.post(0);
    expect(r.status).toBe(201);
    expect(r.body.sim).toEqual({ plan: 'legacy', remainingMs: null });
    expect(w.tickets.size).toBe(0);
  });

  it('while its principal waits in another tab: 503 runtime_capacity, the entry untouched (M3)', async () => {
    const w = await world({ maxSessions: 0 });
    await w.post(1, { queue: true });
    const t = (await w.post(0, { queue: true })).body.queued!.ticket;
    const admit = vi.spyOn(w.adapter, 'admit');
    const r = await w.post(0, { ticket: t });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'runtime_capacity', retryAfterS: 15 });
    expect(admit).not.toHaveBeenCalled();
    expect(w.adapter.waiting).toBe(2);
    const poll = await w.post(0, { queue: true, ticket: t });
    expect(poll.body.queued).toEqual({ ticket: t, position: 2, pollAfterS: 15 });
  });

  it("legacy mode in the adapter never takes another tab's entry, even past the host peek", async () => {
    const w = await world({ maxSessions: 0 });
    const t = (await w.post(0, { queue: true })).body.queued!.ticket;
    vi.spyOn(w.host, 'hasWaiting').mockReturnValue(false); // a race: the peek missed it
    const r = await w.post(0);
    expect(r.status).toBe(503);
    expect(w.adapter.waiting).toBe(1);
    vi.restoreAllMocks();
    expect((await w.post(0, { queue: true, ticket: t })).body.queued!.ticket).toBe(t);
  });
});

describe('s3d-3b: answer table rows (design section 3), both client kinds', () => {
  const refusedWith = (code: LimitCode, params: Record<string, string | number> = {}) =>
    ((): Promise<HostAdmit> =>
      Promise.resolve({
        metered: true,
        decision: 'refused',
        error: limitError(code, params),
        dropped: [],
      })) as never;

  const rows: [LimitCode, Record<string, string | number>, number, string, string | null][] = [
    ['minutes_out', { date: '01.12.2026' }, 429, 'minutes_out', null],
    ['minutes_out_free', { date: '01.12.2026' }, 429, 'minutes_out_free', null],
    ['sim_daily', {}, 429, 'sim_daily', null],
    ['sim_concurrent', {}, 429, 'sim_concurrent', null],
    ['sim_cooldown', { n: 42 }, 429, 'sim_cooldown', '42'],
    ['queue_full', {}, 429, 'queue_full', null],
    ['queue_timeout', {}, 429, 'queue_timeout', null],
    ['queue_vanished', {}, 429, 'queue_timeout', null],
    ['system_unavailable', {}, 503, 'system_unavailable', null],
    ['invalid_principal', {}, 403, 'system_unavailable', null],
    ['invalid_request', {}, 400, 'system_unavailable', null],
    ['invalid_state', {}, 409, 'system_unavailable', null],
    ['lease_lost', {}, 409, 'system_unavailable', null],
  ];
  for (const [code, params, status, shown, retry] of rows)
    it(`refused ${code} -> ${status} ${shown}`, async () => {
      for (const queue of [true, false]) {
        const w = await world({
          simPlans: (real) => {
            vi.spyOn(real, 'admit').mockImplementation(refusedWith(code, params));
            return real;
          },
        });
        const r = await w.post(0, { queue });
        expect(r.status, `${code} queue=${queue}`).toBe(status);
        expect(r.body.error).toBe(shown);
        expect(r.body.limit!.code).toBe(shown);
        expect(r.retryAfter).toBe(retry);
        expect(w.host.size).toBe(0);
      }
    });

  it('enabled adapter answering unmetered, or a malformed result: 503 system_unavailable, nothing starts', async () => {
    for (const bad of [{ metered: false }, { metered: true, decision: 'maybe' }, null]) {
      const w = await world({
        simPlans: (real) => {
          vi.spyOn(real, 'admit').mockResolvedValue(bad as never);
          return real;
        },
      });
      const r = await w.post(0, { queue: true });
      expect(r.status).toBe(503);
      expect(r.body).toEqual({
        error: 'system_unavailable',
        limit: { code: 'system_unavailable', messageKey: 'limit.system.unavailable', params: {} },
      });
      expect(w.host.size).toBe(0);
    }
  });

  it('a policy plan without a mapping (m13): 503, the adapter is not asked', async () => {
    const w = await world({ planMap: new Map([['system', 'legacy']]) });
    const admit = vi.spyOn(w.adapter, 'admit');
    const r = await w.post(0, { queue: true });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('system_unavailable');
    expect(admit).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('"event":"sim_admission_fault","op":"plan"');
  });
});

describe('s3d-3b: adapter failure (M1)', () => {
  for (const fault of ['throw', 'reject'] as const)
    it(`admit that ${fault}s: 503 system_unavailable, nothing started or queued, host keeps serving`, async () => {
      const w = await world();
      const spy = vi.spyOn(w.adapter, 'admit').mockImplementation((() => {
        if (fault === 'throw') throw new Error(`boom ${A}`);
        return Promise.reject(new Error(`boom ${A}`));
      }) as never);
      for (const queue of [true, false]) {
        const r = await w.post(0, { queue });
        expect(r.status).toBe(503);
        expect(r.body.error).toBe('system_unavailable');
      }
      expect(w.host.size).toBe(0);
      expect(w.adapter.waiting).toBe(0);
      expect(w.tickets.size).toBe(0);
      const out = stderr.join('');
      expect(out).toContain('"op":"admit"');
      expect(out).not.toContain('boom');
      spy.mockRestore();
      expect((await w.post(0, { queue: true })).status).toBe(201);
    });

  it('HostSession construction fails after start: ended is awaited (one meter close), 500', async () => {
    const w = await world();
    const ended = vi.spyOn(w.adapter, 'ended');
    vi.spyOn(HostSession.prototype, 'prepare').mockImplementation(() => {
      throw new Error('boom');
    });
    const r = await w.post(0, { queue: true });
    expect(r.status).toBe(500);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]![1]).toBe('ended');
    expect(ended.mock.calls[0]![2]).toBe(A);
    expect(w.adapter.tracked).toBe(0);
    expect(JSON.stringify(w.store.events).match(/"t":"sim_close"/g)).toHaveLength(1);
  });

  it('ended that throws on that path is logged and swallowed (still 500, host alive)', async () => {
    const w = await world();
    vi.spyOn(w.adapter, 'ended').mockRejectedValue(new Error(`boom ${A}`));
    vi.spyOn(HostSession.prototype, 'prepare').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect((await w.post(0, { queue: true })).status).toBe(500);
    expect(stderr.join('')).toContain('"op":"ended"');
    expect(stderr.join('')).not.toContain(A);
  });
});

describe('s3d-3b: client gone while admit is pending (section 2 step 9, m2)', () => {
  it('a start for a gone client never becomes a session; the meter run is ended', async () => {
    const w = await world();
    const ended = vi.spyOn(w.adapter, 'ended');
    const r = await w.host.admitCreate(
      createRequest(w.art.sha256, { ticket: ticketFor(w.art.sha256, A) }),
      A,
      null,
      {
        queueCapable: true,
        ticket: null,
        gone: () => true,
      },
    );
    expect(r.ok).toBe(false);
    expect(w.host.size).toBe(0);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(w.adapter.tracked).toBe(0);
    expect(w.tickets.size).toBe(0);
  });

  it('a queued gone client leaves no queue entry and no ticket', async () => {
    const w = await world({ maxSessions: 0 });
    const r = await w.host.admitCreate(
      createRequest(w.art.sha256, { ticket: ticketFor(w.art.sha256, A) }),
      A,
      null,
      {
        queueCapable: true,
        ticket: null,
        gone: () => true,
      },
    );
    expect(r.ok).toBe(false);
    expect(w.adapter.waiting).toBe(0);
    expect(w.tickets.size).toBe(0);
  });
});

describe('s3d-3b: construction guard (moved to boot)', () => {
  it('an enabled adapter with policy and admission config constructs; boot still refuses the flags', async () => {
    const w = await world();
    expect(w.host).toBeInstanceOf(SessionHost);
    expect(w.host.queueEnabled).toBe(true);
  });
});

describe('s3d-3b: flag-off identity under a policy, with queue headers', () => {
  it('no adapter and a disabled adapter answer exactly alike (capacity full: 503 runtime_capacity)', async () => {
    const run = async (withAdapter: boolean) => {
      const off = withAdapter
        ? await SimHostAdapter.open(new MemoryStore<SimEvent>(), {
            config: parseConfig({}),
            clock: new FakeClock(0),
          })
        : undefined;
      const { host, art } = fakeHost('normal', {
        tmpParent: parent,
        policy: policyWith(4),
        probe: plenty,
        maxSessions: 1,
        ...(off ? { simPlans: off } : {}),
      });
      const server = createHttpServer(host, TEST_IDENTITY);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
      const gate = await startTestGate(target, TEST_IDENTITY, 'user-a');
      closers.push(async () => {
        gate.close();
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
        await host.shutdown();
      });
      const out: unknown[] = [];
      for (let i = 0; i < 2; i++) {
        const r = await fetch(`${gate.base}/sessions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'tbi-queue': '1',
            'tbi-queue-ticket': 'AAAAAAAAAAAAAAAAAAAAAA',
          },
          body: JSON.stringify(createRequest(art.sha256)),
        });
        const body = (await r.json()) as Record<string, unknown>;
        out.push({
          status: r.status,
          retry: r.headers.get('retry-after'),
          keys: Object.keys(body).sort(),
          error: body.error,
        });
      }
      return out;
    };
    const plain = await run(false);
    expect(plain).toEqual([
      { status: 201, retry: null, keys: ['sessionId', 'status', 'token'], error: undefined },
      { status: 503, retry: '15', keys: ['error', 'retryAfterS'], error: 'runtime_capacity' },
    ]);
    expect(await run(true)).toEqual(plain);
  });
});
