/**
 * BETA-G2 (docs/plans/BETA-G2-FREE-LIMITS.md) over HTTP with an ENABLED sim adapter (fake runtime):
 *  (a) the per-session time cap of a Free user is its host policy plan's runtime.maxLifetimeMs (the
 *      policy plan is the one TBI_HOST_SIM_PLAN_MAP maps to `free`); a stricter client limit still wins;
 *  (d)+(e) the kill switch refuses a NEW Free admission with 429 + the public limit `free_paused`
 *      (key limit.sim.free_paused), while a non-free principal still starts.
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
import type { ResourceProbe } from '../../policy/resources.js';
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

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

function policy(): Policy {
  const c = structuredClone(DEFAULT_POLICY);
  c.plans.free = structuredClone(c.plans.preview!);
  c.plans.free.runtime.maxLifetimeMs = FREE_LIFETIME;
  c.defaultPlan = 'free';
  c.assignments = { [B]: 'preview' };
  c.global.runtime.maxLiveSessions = 6;
  return new Policy(c, 1);
}

async function world(paused: () => boolean = () => false) {
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
    policy: policy(),
    probe: plenty,
    maxSessions: 6,
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
  const post = async (who: number, limits?: { maxLifetimeMs: number }) => {
    const r = await fetch(`${gates[who]!.base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'tbi-queue': '1' },
      body: JSON.stringify(
        createRequest(art.sha256, {
          ticket: ticketFor(art.sha256, PRINCIPALS[who]!),
          ...(limits ? { limits } : {}),
        }),
      ),
    });
    return {
      status: r.status,
      body: (await r.json()) as {
        status?: { lifetimeMs: number | null };
        sim?: { plan: string };
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
    expect(legacy.body.status?.lifetimeMs).toBe(DEFAULT_POLICY.plans.preview!.runtime.maxLifetimeMs);
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
