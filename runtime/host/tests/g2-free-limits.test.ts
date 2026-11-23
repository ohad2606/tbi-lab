/**
 * BETA-G2 (docs/plans/BETA-G2-FREE-LIMITS.md) over HTTP with an ENABLED sim adapter (fake runtime):
 *  (a) the per-session time cap of a Free user is its host policy plan's runtime.maxLifetimeMs (the
 *      policy plan is the one TBI_HOST_SIM_PLAN_MAP maps to `free`); a stricter client limit still wins;
 *  (d)+(e) the kill switch refuses a NEW Free admission with 429 + the public limit `free_paused`
 *      (key limit.sim.free_paused), while a non-free principal still starts.
 * Slice 2 (ops review minors): free_paused carries Retry-After (30 s) and does not consume the
 * creation-rate token (no admission happens, so nothing goes unmetered); a Free ticket waiting when the
 * pause turns on answers free_paused on its next poll.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { TEST_IDENTITY, principalFor, startTestGate, ticketFor } from '../../identity/test-gate.js';
import { parseConfig, type PlanId } from '../../plans/config.js';
import type { SimEvent } from '../../plans/simminutes.js';
import { SimHostAdapter } from '../../plans/simhost.js';
import { MemoryStore } from '../../plans/store.js';
import { FakeClock } from '../../plans/time.js';
import { DEFAULT_POLICY, Policy } from '../../policy/policy.js';
import { RateLimiter } from '../../policy/rate.js';
import type { ResourceProbe } from '../../policy/resources.js';
import { FREE_PAUSED_RETRY_S } from '../host.js';
import { createHttpServer } from '../http.js';
import { TicketRegistry } from '../queueTickets.js';
import { createRequest, fakeHost } from './support.js';

const parent = mkdtempSync(join(tmpdir(), 'tbi-g2-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));

const A = principalFor('user-a'); // policy plan `free` (default) -> PlanId free
const B = principalFor('user-b'); // policy plan `preview` (assigned) -> PlanId legacy
const PRINCIPALS = [A, B];
const plenty: ResourceProbe = { freeDiskMb: () => 1e9, availableMemoryMb: () => 1e9 };
const PLANS = parseConfig({ metering: { enabled: true } });
const MIN = 60_000;
const FREE_LIFETIME = 10 * MIN;
/**
 * The answer to a poll of a ticket the pause dropped, after the pause was lifted (observed behaviour):
 * the host's ticket registry remembers WHY the ticket was dropped, so the poll keeps answering
 * free_paused (with Retry-After) until the ticket expires; it is never re-queued. The client starts a
 * new wait with a new join (no ticket).
 */
const AFTER_UNPAUSE_POLL = { status: 429, code: 'free_paused', retryAfter: '30' };

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

function policy(freeCreations?: number): Policy {
  const c = structuredClone(DEFAULT_POLICY);
  c.plans.free = structuredClone(c.plans.preview!);
  c.plans.free.runtime.maxLifetimeMs = FREE_LIFETIME;
  if (freeCreations !== undefined) {
    c.plans.free.runtime.creations = { count: freeCreations, windowMs: 10 * MIN };
    // so a second start is limited by the creation rate, not by the per-principal session count
    c.plans.free.runtime.maxSessions = 4;
  }
  c.defaultPlan = 'free';
  c.assignments = { [B]: 'preview' };
  c.global.runtime.maxLiveSessions = 6;
  return new Policy(c, 1);
}

interface WorldOptions {
  /** host maxSessions (default 6) */
  maxSessions?: number;
  /** creation-rate count of the Free policy plan; with it the host gets a real RateLimiter */
  freeCreations?: number;
}

async function world(paused: () => boolean = () => false, o: WorldOptions = {}) {
  const clock = new FakeClock(Date.parse('2026-11-23T10:00:00Z'));
  const adapter = await SimHostAdapter.open(new MemoryStore<SimEvent>(), {
    config: PLANS,
    clock,
    freePaused: paused,
  });
  const tickets = new TicketRegistry({
    ttlMs: PLANS.queue.maxWaitMs + PLANS.queue.vanishMs,
    cap: 100,
    perPrincipalCap: 2,
    clock,
  });
  const { host, art } = fakeHost('normal', {
    tmpParent: parent,
    policy: policy(o.freeCreations),
    probe: plenty,
    maxSessions: o.maxSessions ?? 6,
    ...(o.freeCreations !== undefined ? { rates: new RateLimiter(':memory:') } : {}),
    maxLifetimeMs: 60 * MIN,
    simPlans: adapter,
    simAdmission: {
      planMap: new Map<string, PlanId>([
        ['free', 'free'],
        ['preview', 'legacy'],
        ['system', 'legacy'],
      ]),
      pollAfterS: 15,
      tickets,
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
  const post = async (who: number, limits?: { maxLifetimeMs: number }, queueTicket?: string) => {
    const r = await fetch(`${gates[who]!.base}/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'tbi-queue': '1',
        ...(queueTicket ? { 'tbi-queue-ticket': queueTicket } : {}),
      },
      body: JSON.stringify(
        createRequest(art.sha256, {
          ticket: ticketFor(art.sha256, PRINCIPALS[who]!),
          ...(limits ? { limits } : {}),
        }),
      ),
    });
    return {
      status: r.status,
      retryAfter: r.headers.get('retry-after'),
      body: (await r.json()) as {
        status?: { lifetimeMs: number | null };
        sim?: { plan: string };
        queued?: { ticket: string; position: number };
        error?: string;
        limit?: { code: string; messageKey: string; params: Record<string, unknown> };
      },
    };
  };
  return { host, adapter, post };
}

describe('BETA-G2 (a): Free session time cap = the Free policy plan lifetime', () => {
  it('a Free run gets the Free lifetime; a legacy run keeps its own; a stricter client wins', async () => {
    const w = await world();
    const free = await w.post(0);
    expect(free.status).toBe(201);
    expect(free.body.sim?.plan).toBe('free');
    expect(free.body.status?.lifetimeMs).toBe(FREE_LIFETIME);
    const legacy = await w.post(1);
    expect(legacy.status).toBe(201);
    expect(legacy.body.sim?.plan).toBe('legacy');
    expect(legacy.body.status?.lifetimeMs).toBe(
      DEFAULT_POLICY.plans.preview!.runtime.maxLifetimeMs,
    );
  });

  it('a client limit stricter than the Free cap wins; a longer one never does', async () => {
    const w = await world();
    const strict = await w.post(0, { maxLifetimeMs: MIN });
    expect(strict.status).toBe(201);
    expect(strict.body.status?.lifetimeMs).toBe(MIN);
  });

  it('a client asking for more than the Free cap still gets the Free cap', async () => {
    const w = await world();
    const longer = await w.post(0, { maxLifetimeMs: 50 * MIN });
    expect(longer.status).toBe(201);
    expect(longer.body.status?.lifetimeMs).toBe(FREE_LIFETIME);
  });
});

describe('BETA-G2 (d)+(e): kill switch over HTTP', () => {
  it('paused: a Free POST /sessions is 429 free_paused, nothing starts; legacy still starts', async () => {
    let paused = true;
    const w = await world(() => paused);
    const r = await w.post(0);
    expect(r.status).toBe(429);
    expect(r.body.limit).toEqual({
      code: 'free_paused',
      messageKey: 'limit.sim.free_paused',
      params: {},
    });
    expect(w.host.size).toBe(0);
    expect(w.adapter.tracked).toBe(0);
    expect(w.adapter.waiting).toBe(0);
    const legacy = await w.post(1);
    expect(legacy.status).toBe(201);
    paused = false;
    const again = await w.post(0);
    expect(again.status).toBe(201);
    expect(again.body.sim?.plan).toBe('free');
  });
});

describe('BETA-G2 slice 2: free_paused refusal details', () => {
  it('free_paused carries Retry-After: 30 (constant), like sim_cooldown carries one', async () => {
    const w = await world(() => true);
    const r = await w.post(0);
    expect(r.status).toBe(429);
    expect(r.body.limit?.code).toBe('free_paused');
    expect(r.retryAfter).toBe(String(FREE_PAUSED_RETRY_S));
    expect(FREE_PAUSED_RETRY_S).toBe(30);
  });

  it('a paused Free refusal does not consume the creation-rate token; a real admission still does', async () => {
    let paused = true;
    const w = await world(() => paused, { freeCreations: 1 });
    for (let i = 0; i < 3; i++) {
      const r = await w.post(0);
      expect(r.status).toBe(429);
      expect(r.body.limit?.code).toBe('free_paused');
    }
    expect(w.host.size).toBe(0);
    paused = false;
    // the one token is still there: the admission starts (and is metered)
    const ok = await w.post(0);
    expect(ok.status).toBe(201);
    expect(ok.body.sim?.plan).toBe('free');
    expect(w.adapter.tracked).toBe(1);
    // and it consumed the token: no unmetered or unlimited way around the rate
    const next = await w.post(0);
    expect(next.status).toBe(429);
    expect(next.body.error).toBe('rate_limited');
  });

  it('a Free ticket waiting when the pause turns on: free_paused on the next poll and after unpause; a new join waits again', async () => {
    let paused = false;
    const w = await world(() => paused, { maxSessions: 1 });
    const legacy = await w.post(1);
    expect(legacy.status).toBe(201);
    const q = await w.post(0);
    expect(q.status).toBe(202);
    const t = q.body.queued!.ticket;
    expect(w.adapter.waiting).toBe(1);
    paused = true;
    const p1 = await w.post(0, undefined, t);
    expect(p1.status).toBe(429);
    expect(p1.body.limit?.code).toBe('free_paused');
    expect(p1.retryAfter).toBe(String(FREE_PAUSED_RETRY_S));
    expect(w.adapter.waiting).toBe(0);
    paused = false;
    const p2 = await w.post(0, undefined, t);
    expect({ status: p2.status, code: p2.body.limit?.code, retryAfter: p2.retryAfter }).toEqual(
      AFTER_UNPAUSE_POLL,
    );
    expect(w.host.size).toBe(1);
    expect(w.adapter.waiting).toBe(0);
    // a new join (no ticket) waits again: the slot is still taken by the legacy run
    const fresh = await w.post(0);
    expect(fresh.status).toBe(202);
    expect(fresh.body.queued!.ticket).not.toBe(t);
    expect(w.adapter.waiting).toBe(1);
  });
});
