/**
 * BETA-G2 harness, offline: what `queue_full` means at queue.maxLength on the REAL Session Host (HTTP,
 * identity gate, enabled adapter, default queue 20 / 16, fake runtime), driven by the harness's own
 * fill loop and identity plan (runtime/tests/g2-load.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TEST_IDENTITY, principalFor, startTestGate, ticketFor } from '../../identity/test-gate.js';
import { parseConfig, type PlanId } from '../../plans/config.js';
import type { SimEvent } from '../../plans/simminutes.js';
import { SimHostAdapter } from '../../plans/simhost.js';
import { MemoryStore } from '../../plans/store.js';
import { FakeClock } from '../../plans/time.js';
import { DEFAULT_POLICY, Policy } from '../../policy/policy.js';
import type { ResourceProbe } from '../../policy/resources.js';
import { g2FillQueue, g2PaidPlan } from '../../tests/g2-load.js';
import { createHttpServer } from '../http.js';
import { TicketRegistry } from '../queueTickets.js';
import { createRequest, fakeHost } from './support.js';

const parent = mkdtempSync(join(tmpdir(), 'tbi-g2full-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));
const plenty: ResourceProbe = { freeDiskMb: () => 1e9, availableMemoryMb: () => 1e9 };
const PLANS = parseConfig({ metering: { enabled: true } });

const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const LIVE_FREE = names('live-free-', 4);
const LIVE_PAID = names('live-paid-', 2);
const FREE = names('free-', 17);
const { needed } = g2PaidPlan(PLANS.queue, 0);
const PAID = names('paid-', needed);

describe('queue_full at maxLength with paid waiters (real host)', () => {
  it('Free stops at maxFree; paid waiters fill to maxLength; only then is a paid join refused', async () => {
    const clock = new FakeClock(Date.parse('2026-11-23T10:00:00Z'));
    const adapter = await SimHostAdapter.open(new MemoryStore<SimEvent>(), {
      config: PLANS,
      clock,
      freePaused: () => false,
    });
    const c = structuredClone(DEFAULT_POLICY);
    c.plans.free = structuredClone(c.plans.preview!);
    c.defaultPlan = 'free';
    c.assignments = Object.fromEntries(
      [...LIVE_PAID, ...PAID].map((u) => [principalFor(u), 'preview']),
    );
    c.global.runtime.maxLiveSessions = 6;
    const { host, art } = fakeHost('normal', {
      tmpParent: parent,
      policy: new Policy(c, 1),
      probe: plenty,
      maxSessions: 6,
      simPlans: adapter,
      simAdmission: {
        planMap: new Map<string, PlanId>([
          ['free', 'free'],
          ['preview', 'legacy'],
          ['system', 'legacy'],
        ]),
        pollAfterS: 15,
        tickets: new TicketRegistry({
          ttlMs: PLANS.queue.maxWaitMs + PLANS.queue.vanishMs,
          cap: 100,
          perPrincipalCap: 2,
          clock,
        }),
      },
    });
    const server: Server = createHttpServer(host, TEST_IDENTITY);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
    const gates = new Map<string, Awaited<ReturnType<typeof startTestGate>>>();
    try {
      for (const u of [...LIVE_FREE, ...LIVE_PAID, ...FREE, ...PAID])
        gates.set(u, await startTestGate(target, TEST_IDENTITY, u));
      const join = async (user: string) => {
        const r = await fetch(`${gates.get(user)!.base}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'tbi-queue': '1' },
          body: JSON.stringify(
            createRequest(art.sha256, { ticket: ticketFor(art.sha256, principalFor(user)) }),
          ),
        });
        const body = (await r.json()) as { error?: string; queued?: { ticket: string } };
        return { status: r.status, error: body.error, ticket: body.queued?.ticket };
      };
      const noPoll = async () => {};
      for (const u of [...LIVE_FREE, ...LIVE_PAID]) expect((await join(u)).status).toBe(201);

      const free = await g2FillQueue(FREE, join, noPoll);
      expect(free.accepted).toHaveLength(PLANS.queue.maxFree);
      expect(free.refused).toEqual({ status: 429, error: 'queue_full' });

      const paid = await g2FillQueue(PAID, join, noPoll);
      expect(paid.accepted).toHaveLength(PLANS.queue.maxLength - PLANS.queue.maxFree);
      expect(paid.refused).toEqual({ status: 429, error: 'queue_full' });
      expect(adapter.waiting).toBe(PLANS.queue.maxLength);

      // why the two preview identities of a run cannot be used: they hold seats and never wait
      expect(await join(LIVE_PAID[0]!)).not.toMatchObject({ status: 202 });
      expect(adapter.waiting).toBe(PLANS.queue.maxLength);
    } finally {
      for (const g of gates.values()) g.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await host.shutdown();
    }
  });
});
