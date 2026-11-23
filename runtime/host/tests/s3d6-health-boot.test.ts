/**
 * TBI-018 s3d-6 (design §10 R-1b, m8; s3d-4 ops review LOW-4):
 *   - the health-only socket's `capacity` carries `waiting` and `metered` counts with an ENABLED adapter,
 *     and nothing else new (no principal, ticket or session id); flag-off it is exactly `{live, max}`;
 *   - checkSimBounds: 1 <= beatMs < leaseMs, housekeepingMs >= host housekeeping, endWaitMs <= 12000;
 *   - hostSimFromEnv: no flag = undefined; a valid env builds the admission config (registry, intervals).
 * Real SimHostAdapter (MemoryStore + FakeClock), real HTTP servers and test gates, fake runtime.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { TEST_IDENTITY, principalFor, startTestGate, ticketFor } from '../../identity/test-gate.js';
import { parseConfig, type PlanId } from '../../plans/config.js';
import { HostSimBootError } from '../../plans/hostboot.js';
import type { SimEvent } from '../../plans/simminutes.js';
import { SimHostAdapter } from '../../plans/simhost.js';
import { MemoryStore } from '../../plans/store.js';
import { FakeClock } from '../../plans/time.js';
import { DEFAULT_POLICY, Policy } from '../../policy/policy.js';
import type { ResourceProbe } from '../../policy/resources.js';
import type { HostConfig } from '../config.js';
import { MAX_SIM_END_WAIT_MS, checkSimBounds } from '../host.js';
import { createHealthServer, createHttpServer } from '../http.js';
import { TicketRegistry } from '../queueTickets.js';
import { hostSimFromEnv, simRefusalLine } from '../simboot.js';
import { createRequest, fakeHost } from './support.js';

const parent = mkdtempSync(join(tmpdir(), 'tbi-s3d6-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));
const PRINCIPALS = [principalFor('user-a'), principalFor('user-b')];
const plenty: ResourceProbe = { freeDiskMb: () => 1e9, availableMemoryMb: () => 1e9 };

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const listen0 = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
};

async function world(enabled: boolean, freePaused?: () => boolean) {
  const clock = new FakeClock(Date.parse('2026-11-23T10:00:00Z'));
  const adapter = await SimHostAdapter.open(new MemoryStore<SimEvent>(), {
    config: parseConfig({ metering: { enabled } }),
    clock,
    ...(freePaused ? { freePaused } : {}),
  });
  const c = structuredClone(DEFAULT_POLICY);
  c.global.runtime.maxLiveSessions = 4;
  const { host, art } = fakeHost('normal', {
    tmpParent: parent,
    policy: new Policy(c, 1),
    probe: plenty,
    maxSessions: 1, // the second principal queues
    simPlans: adapter,
    simAdmission: {
      planMap: new Map<string, PlanId>([['preview', 'legacy']]),
      pollAfterS: 15,
      tickets: new TicketRegistry({ ttlMs: 600_000, cap: 100, perPrincipalCap: 2, clock }),
      beatMs: 10_000,
      housekeepingMs: 60_000,
      endWaitMs: 2_000,
    },
  });
  const api = createHttpServer(host, TEST_IDENTITY);
  const health = createHealthServer(host);
  const apiPort = await listen0(api);
  const healthPort = await listen0(health);
  const gates = await Promise.all(
    ['user-a', 'user-b'].map((u) =>
      startTestGate({ host: '127.0.0.1', port: apiPort }, TEST_IDENTITY, u),
    ),
  );
  closers.push(async () => {
    for (const g of gates) g.close();
    for (const s of [api, health]) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    await host.shutdown();
  });
  const post = async (who: number) => {
    const r = await fetch(`${gates[who]!.base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'tbi-queue': '1' },
      body: JSON.stringify(
        createRequest(art.sha256, { ticket: ticketFor(art.sha256, PRINCIPALS[who]!) }),
      ),
    });
    return { status: r.status, text: await r.text() };
  };
  const healthBody = async () => {
    const r = await fetch(`http://127.0.0.1:${healthPort}/health`);
    return { status: r.status, text: await r.text() };
  };
  return { host, post, healthBody };
}

describe('s3d-6: /health capacity counts', () => {
  it('flag-off (disabled adapter): exactly {live, max}', async () => {
    const w = await world(false);
    const h = await w.healthBody();
    expect(h.status).toBe(200);
    expect((JSON.parse(h.text) as { capacity: unknown }).capacity).toEqual({ live: 0, max: 1 });
    // BETA-G2 slice 2: byte-identical flag-off (no freePaused key, same key order), even with a probe
    expect(h.text).toContain('"capacity":{"live":0,"max":1}}');
    expect(h.text).not.toContain('freePaused');
    const probed = await world(false, () => true);
    expect((await probed.healthBody()).text).toBe(h.text);
  });

  it('BETA-G2: enabled, the kill switch state is a boolean `freePaused` (fail closed on a throwing probe)', async () => {
    for (const [probe, want] of [
      [() => false, false],
      [() => true, true],
      [
        () => {
          throw new Error('/secret/path EACCES');
        },
        true,
      ],
    ] as const) {
      const w = await world(true, probe);
      const h = await w.healthBody();
      expect((JSON.parse(h.text) as { capacity: unknown }).capacity).toEqual({
        live: 0,
        max: 1,
        waiting: 0,
        metered: 0,
        freePaused: want,
      });
      expect(h.text).not.toContain('secret');
    }
  });

  it('enabled: waiting and metered counts follow starts and the queue; no identifier in the body', async () => {
    const w = await world(true);
    const cap = async () => {
      const h = await w.healthBody();
      return { text: h.text, capacity: (JSON.parse(h.text) as { capacity: unknown }).capacity };
    };
    expect((await cap()).capacity).toEqual({
      live: 0,
      max: 1,
      waiting: 0,
      metered: 0,
      freePaused: false,
    });

    const a = await w.post(0);
    expect(a.status).toBe(201);
    expect((await cap()).capacity).toEqual({
      live: 1,
      max: 1,
      waiting: 0,
      metered: 1,
      freePaused: false,
    });

    const b = await w.post(1);
    expect(b.status).toBe(202);
    const after = await cap();
    expect(after.capacity).toEqual({ live: 1, max: 1, waiting: 1, metered: 1, freePaused: false });

    const { sessionId, token } = JSON.parse(a.text) as { sessionId: string; token: string };
    const { queued } = JSON.parse(b.text) as { queued: { ticket: string } };
    for (const secret of [sessionId, token, queued.ticket, ...PRINCIPALS])
      expect(after.text).not.toContain(secret);
  });
});

describe('s3d-6: checkSimBounds (LOW-4)', () => {
  const base = { leaseMs: 30_000, housekeepingMs: 250 } as HostConfig;
  const sim = (o: Record<string, number>) =>
    ({
      ...base,
      simAdmission: { planMap: new Map(), pollAfterS: 15, ...o },
    }) as unknown as HostConfig;
  it('accepts the defaults and in-bound values', () => {
    expect(() => checkSimBounds(sim({}))).not.toThrow();
    expect(() =>
      checkSimBounds(sim({ beatMs: 29_999, housekeepingMs: 250, endWaitMs: MAX_SIM_END_WAIT_MS })),
    ).not.toThrow();
    expect(() => checkSimBounds(base)).not.toThrow(); // no sim admission: nothing to check
  });
  it.each([
    [{ beatMs: 0 }, /beatMs/],
    [{ beatMs: 30_000 }, /beatMs/],
    [{ beatMs: 1.5 }, /beatMs/],
    [{ housekeepingMs: 249 }, /housekeepingMs/],
    [{ endWaitMs: MAX_SIM_END_WAIT_MS + 1 }, /endWaitMs/],
    [{ endWaitMs: -1 }, /endWaitMs/],
  ])('refuses %o', (o, re) => {
    expect(() => checkSimBounds(sim(o))).toThrow(re);
  });
  it('the end wait bound stays below the units TimeoutStopSec=20 with room for stopping runtimes', () => {
    expect(MAX_SIM_END_WAIT_MS).toBeLessThanOrEqual(12_000);
  });
});

describe('s3d-6: hostSimFromEnv', () => {
  const host = {
    policy: new Policy(DEFAULT_POLICY, 1),
    leaseMs: 30_000,
    housekeepingMs: 250,
  };
  it('no flag: undefined', async () => {
    expect(await hostSimFromEnv({}, host)).toBeUndefined();
  });

  it('valid env: adapter, plan map, intervals and a ticket registry; the lock is held until release', async () => {
    const d = mkdtempSync(join(parent, 'env-'));
    const f = join(d, 'sim.json');
    writeFileSync(f, JSON.stringify({ metering: { enabled: true } }));
    const state = join(d, 'state');
    mkdirSync(state, { mode: 0o700 });
    chmodSync(state, 0o700);
    const env = {
      TBI_HOST_SIM_PLANS_CONFIG: f,
      TBI_HOST_SIM_PLANS_STATE: state,
      TBI_HOST_SIM_PLAN_MAP: 'preview=legacy,system=legacy',
    };
    const b = await hostSimFromEnv(env, host);
    expect(b).toBeDefined();
    expect(b!.simPlans.enabled).toBe(true);
    expect(b!.simAdmission.beatMs).toBe(10_000);
    expect(b!.simAdmission.housekeepingMs).toBe(5_000);
    expect(b!.simAdmission.pollAfterS).toBe(15);
    expect([...b!.simAdmission.planMap]).toEqual([
      ['preview', 'legacy'],
      ['system', 'legacy'],
    ]);
    expect(JSON.parse(b!.logLine)).toEqual({ event: 'sim_boot', recovered: 0, compaction: 'no' });
    await expect(hostSimFromEnv(env, host)).rejects.toThrow(/locked by another host/);
    b!.lock.release();
    const again = await hostSimFromEnv(env, host);
    again!.lock.release();
  });

  it('refusal line: the HostSimBootError text, otherwise only the error class', () => {
    expect(simRefusalLine(new HostSimBootError('x refused'))).toBe('tbi-session-host: x refused');
    const line = simRefusalLine(new TypeError('/secret/path p_user'));
    expect(line).toContain('TypeError');
    expect(line).not.toContain('secret');
  });
});
