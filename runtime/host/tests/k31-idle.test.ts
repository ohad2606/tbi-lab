/**
 * K3-1: the host idle limit (`idleMs`, TBI_HOST_IDLE_MS; unset or 0 = off). A session whose user has
 * not interacted (run, an ACCEPTED command, `POST /sessions/:id/presence`) for `idleMs` is ended by
 * housekeeping with `idle_timeout`, even while its event stream is attached. Status reads, the event
 * stream and lease refreshes never count as interaction. The lease, the lifetime and the meter are
 * unchanged; presence resets only the idle clock. Off: every response is exactly as before.
 *
 * In-process only: real HTTP server + test gates, fake runtime, short real timers.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_IDENTITY, principalFor, startTestGate, ticketFor } from '../../identity/test-gate.js';
import { parseConfig, type PlanId } from '../../plans/config.js';
import type { SimEvent } from '../../plans/simminutes.js';
import { SimHostAdapter } from '../../plans/simhost.js';
import { MemoryStore } from '../../plans/store.js';
import { FakeClock } from '../../plans/time.js';
import { DEFAULT_POLICY, Policy } from '../../policy/policy.js';
import type { ResourceProbe } from '../../policy/resources.js';
import { HOST_TUNABLE_ENV, hostTunablesFromEnv, type HostConfig } from '../config.js';
import { REASON_CLASS, sessionEndRecord } from '../diagnostics.js';
import { createHttpServer } from '../http.js';
import { TicketRegistry } from '../queueTickets.js';
import type { HostSession } from '../session.js';
import { createRequest, fakeHost } from './support.js';

const parent = mkdtempSync(join(tmpdir(), 'tbi-k31-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));

const A = principalFor('user-a');
const PRINCIPALS = [A, principalFor('user-b')];
const plenty: ResourceProbe = { freeDiskMb: () => 1e9, availableMemoryMb: () => 1e9 };

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4_000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(5);
  }
};
const terminals = (s: HostSession) =>
  s.log.since(0).filter((e) => e.type === 'state' && (e.state === 'ended' || e.state === 'failed'));
const terminalEvent = (s: HostSession) => terminals(s)[0];

/** A host behind a real HTTP server and two test gates (user-a, user-b). */
async function serve(over: Partial<HostConfig> = {}) {
  const { host, art } = fakeHost('normal', { tmpParent: parent, ...over });
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
  const base = (who = 0) => gates[who]!.base;
  const create = async (who = 0) => {
    const r = await fetch(`${base(who)}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        createRequest(art.sha256, { ticket: ticketFor(art.sha256, PRINCIPALS[who]!) }),
      ),
    });
    const text = await r.text();
    return {
      status: r.status,
      text,
      body: JSON.parse(text) as {
        sessionId: string;
        token: string;
        status: Record<string, unknown>;
      },
    };
  };
  const call = (
    path: string,
    token: string,
    init: RequestInit & { who?: number } = {},
  ): Promise<Response> =>
    fetch(`${base(init.who ?? 0)}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  const presence = (id: string, token: string, init: RequestInit & { who?: number } = {}) =>
    call(`/sessions/${id}/presence`, token, { method: 'POST', ...init });
  const session = (id: string, token: string, who = A): HostSession => {
    const g = host.get(id, token, who);
    if (!g.ok) throw new Error('no session');
    return g.value;
  };
  /** Attach an event stream (kept open until the returned abort is called). */
  const attach = async (id: string, token: string) => {
    const ctrl = new AbortController();
    const res = await call(`/sessions/${id}/events`, token, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    // consume in the background so the stream is never back-pressured
    const reader = res.body!.getReader();
    void (async () => {
      try {
        for (;;) if ((await reader.read()).done) break;
      } catch {
        // aborted
      }
    })();
    closers.push(() => ctrl.abort());
    return () => ctrl.abort();
  };
  const pb = createRequest(art.sha256).circuit.components.find(
    (x) => x.type === 'component.push_button',
  )!.id;
  let seq = 0;
  const command = (id: string, token: string, at?: number) => {
    const n = at ?? ++seq;
    return call(`/sessions/${id}/commands`, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        category: 'transient',
        seq: n,
        action: n % 2 === 1 ? 'press' : 'release',
        component: pb,
      }),
    });
  };
  return { host, art, server, base, create, call, presence, session, attach, command };
}

describe('K3-1: configuration', () => {
  it('TBI_HOST_IDLE_MS is an operator tunable: unset, empty and 0 are off; digits set idleMs', () => {
    expect(HOST_TUNABLE_ENV.TBI_HOST_IDLE_MS).toBe('idleMs');
    expect(hostTunablesFromEnv({})).not.toHaveProperty('idleMs');
    expect(hostTunablesFromEnv({ TBI_HOST_IDLE_MS: '0' })).toEqual({ idleMs: 0 });
    expect(hostTunablesFromEnv({ TBI_HOST_IDLE_MS: '' })).not.toHaveProperty('idleMs');
    expect(hostTunablesFromEnv({ TBI_HOST_IDLE_MS: '000' })).toEqual({ idleMs: 0 });
    expect(hostTunablesFromEnv({ TBI_HOST_IDLE_MS: '300000' })).toEqual({ idleMs: 300_000 });
  });

  it('TBI_HOST_IDLE_MS set below two minutes is refused at config load (0 stays off)', () => {
    for (const v of ['1', '60000', '119999'])
      expect(() => hostTunablesFromEnv({ TBI_HOST_IDLE_MS: v })).toThrow(
        /TBI_HOST_IDLE_MS.*120000/,
      );
    expect(hostTunablesFromEnv({ TBI_HOST_IDLE_MS: '120000' })).toEqual({ idleMs: 120_000 });
    expect(hostTunablesFromEnv({ TBI_HOST_IDLE_MS: '0' })).toEqual({ idleMs: 0 });
  });

  it.each(['5m', '3e5', ' 60000', '60000\n', '-1', '+60000', '60000.0', ' '])(
    'TBI_HOST_IDLE_MS=%j (set, not all digits) is refused, not silently off',
    (v) => {
      expect(() => hostTunablesFromEnv({ TBI_HOST_IDLE_MS: v })).toThrow(
        /^TBI_HOST_IDLE_MS must be 0 \(off\) or a whole number of ms, at least 120000 \(a safe integer\)$/,
      );
    },
  );

  it('the other tunables still ignore a value that is not all digits', () => {
    for (const name of Object.keys(HOST_TUNABLE_ENV).filter((n) => n !== 'TBI_HOST_IDLE_MS'))
      expect(hostTunablesFromEnv({ [name]: '5m' })).toEqual({});
  });

  it('fails closed at construction when on and idleMs <= housekeepingMs (or not a safe integer); 0/absent boot', async () => {
    expect(() => fakeHost('normal', { tmpParent: parent, idleMs: 50 })).toThrow(/idleMs/);
    expect(() => fakeHost('normal', { tmpParent: parent, idleMs: 10 })).toThrow(/idleMs/);
    expect(() => fakeHost('normal', { tmpParent: parent, idleMs: 1.5e3 + 0.5 })).toThrow(/idleMs/);
    for (const idleMs of [0, undefined, 51, 300_000]) {
      const { host } = fakeHost('normal', {
        tmpParent: parent,
        ...(idleMs !== undefined ? { idleMs } : {}),
      });
      await host.shutdown();
    }
  });

  it('idle_timeout is a classified, orderly end reason', () => {
    expect(REASON_CLASS.idle_timeout).toEqual({ category: 'timeout', severity: 'info' });
  });
});

/** The exact status keys of today's host (the off snapshot). */
const STATUS_KEYS = [
  'sessionId',
  'state',
  'reason',
  'simNs',
  'lastEventSeq',
  'createdAt',
  'endedAt',
  'lifetimeMs',
  'runtime',
  'revisions',
  'pace',
];

describe('K3-1: off (unset or 0) is byte-identical', () => {
  for (const [label, over] of [
    ['unset', {}],
    ['0', { idleMs: 0 }],
  ] as const) {
    it(`${label}: 201 body, GET status and run answers carry no idleMs; same keys in the same order`, async () => {
      const w = await serve(over);
      const c = await w.create();
      expect(c.status).toBe(201);
      expect(Object.keys(c.body)).toEqual(['sessionId', 'token', 'status']);
      expect(Object.keys(c.body.status)).toEqual(STATUS_KEYS);
      expect(c.text).not.toContain('idleMs');
      const st = await w.call(`/sessions/${c.body.sessionId}`, c.body.token);
      const stText = await st.text();
      expect(Object.keys(JSON.parse(stText))).toEqual(STATUS_KEYS);
      expect(stText).not.toContain('idleMs');
      const run = await w.call(`/sessions/${c.body.sessionId}/run`, c.body.token, {
        method: 'POST',
      });
      expect(run.status).toBe(202);
      expect(Object.keys((await run.json()) as object)).toEqual(STATUS_KEYS);
      // the in-process status has the same keys in the same order as the wire one
      const s = w.session(c.body.sessionId, c.body.token);
      expect(JSON.stringify(Object.keys(s.status()))).toBe(JSON.stringify(STATUS_KEYS));
    });
  }

  it('off: presence is a 204 no-op (empty body, the usual safety headers, no event); nothing idles out', async () => {
    const w = await serve({});
    const c = await w.create();
    await w.attach(c.body.sessionId, c.body.token);
    const s = w.session(c.body.sessionId, c.body.token);
    const seq = s.log.lastSeq;
    const before = s.lastInteraction;
    const r = await w.presence(c.body.sessionId, c.body.token);
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    expect(r.headers.get('content-type')).toBeNull();
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(s.log.lastSeq).toBe(seq);
    expect(s.lastInteraction).toBe(before);
    await sleep(300);
    expect(s.state).toBe('ready');
  });
});

describe('K3-1: on', () => {
  const IDLE = 400;

  it('status, 201 and run answers carry idleMs (additive, last)', async () => {
    const w = await serve({ idleMs: IDLE });
    const c = await w.create();
    expect(Object.keys(c.body.status)).toEqual([...STATUS_KEYS, 'idleMs']);
    expect(c.body.status.idleMs).toBe(IDLE);
    const st = (await (await w.call(`/sessions/${c.body.sessionId}`, c.body.token)).json()) as {
      idleMs: number;
    };
    expect(st.idleMs).toBe(IDLE);
  });

  it('a ready session with an open stream and no interaction ends idle_timeout (the clock starts at creation)', async () => {
    const w = await serve({ idleMs: IDLE });
    const t0 = performance.now();
    const c = await w.create();
    await w.attach(c.body.sessionId, c.body.token);
    const s = w.session(c.body.sessionId, c.body.token);
    await until(() => terminalEvent(s) !== undefined);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(IDLE);
    expect(terminalEvent(s)).toMatchObject({ state: 'ended', reason: 'idle_timeout' });
    expect(s.status()).toMatchObject({ state: 'ended', reason: 'idle_timeout' });
  });

  it('a running session with an open stream: GET status and the stream never reset the clock', async () => {
    const w = await serve({ idleMs: IDLE });
    const c = await w.create();
    await w.attach(c.body.sessionId, c.body.token);
    const run = await w.call(`/sessions/${c.body.sessionId}/run`, c.body.token, { method: 'POST' });
    expect(run.status).toBe(202);
    const s = w.session(c.body.sessionId, c.body.token);
    const t0 = performance.now();
    // status polls every 50 ms (each one refreshes the LEASE, never the idle clock)
    const poll = setInterval(
      () => void w.call(`/sessions/${c.body.sessionId}`, c.body.token).then((r) => r.text()),
      50,
    );
    try {
      await until(() => terminalEvent(s) !== undefined);
    } finally {
      clearInterval(poll);
    }
    expect(performance.now() - t0).toBeGreaterThanOrEqual(IDLE - 20);
    expect(performance.now() - t0).toBeLessThan(IDLE + 1_500);
    expect(terminalEvent(s)).toMatchObject({ state: 'ended', reason: 'idle_timeout' });
    expect(terminals(s)).toHaveLength(1);
  });

  it('presence resets the clock (204, empty); a session kept present outlives several idleMs, then idles out once presence stops', async () => {
    const w = await serve({ idleMs: IDLE });
    const c = await w.create();
    await w.attach(c.body.sessionId, c.body.token);
    const s = w.session(c.body.sessionId, c.body.token);
    const answers: number[] = [];
    const keep = setInterval(
      () =>
        void w
          .presence(c.body.sessionId, c.body.token)
          .then(async (r) => answers.push(r.status) && (await r.text())),
      100,
    );
    await sleep(IDLE * 3);
    clearInterval(keep);
    expect(s.state).toBe('ready');
    expect(answers.length).toBeGreaterThan(5);
    expect(new Set(answers)).toEqual(new Set([204]));
    // presence emits nothing: only the creating->ready state events are in the log
    expect(s.log.since(0).every((e) => e.type === 'state')).toBe(true);
    await until(() => terminalEvent(s) !== undefined);
    expect(terminalEvent(s)).toMatchObject({ reason: 'idle_timeout' });
  });

  it('only an ACCEPTED command resets the clock; a rejected one does not', async () => {
    const w = await serve({ idleMs: IDLE });
    const c = await w.create();
    await w.attach(c.body.sessionId, c.body.token);
    await w.call(`/sessions/${c.body.sessionId}/run`, c.body.token, { method: 'POST' });
    const s = w.session(c.body.sessionId, c.body.token);
    await sleep(IDLE / 2);
    const before = s.lastInteraction;
    // a malformed command (400) and a duplicate seq (409) are not interaction
    const bad = await w.call(`/sessions/${c.body.sessionId}/commands`, c.body.token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(bad.status).toBe(400);
    expect(s.lastInteraction).toBe(before);
    const ok = await w.command(c.body.sessionId, c.body.token);
    expect(ok.status).toBe(202);
    expect(s.lastInteraction).toBeGreaterThan(before);
    const after = s.lastInteraction;
    const dup = await w.command(c.body.sessionId, c.body.token, 1);
    expect(dup.status).toBe(409);
    expect(s.lastInteraction).toBe(after);
    // commands keep it alive past idleMs
    const keep = setInterval(() => void w.command(c.body.sessionId, c.body.token), 100);
    await sleep(IDLE * 2);
    clearInterval(keep);
    expect(s.state).toBe('running');
  });

  it('run counts as interaction', async () => {
    const w = await serve({ idleMs: IDLE });
    const c = await w.create();
    const s = w.session(c.body.sessionId, c.body.token);
    const before = s.lastInteraction;
    await sleep(20);
    await w.call(`/sessions/${c.body.sessionId}/run`, c.body.token, { method: 'POST' });
    expect(s.lastInteraction).toBeGreaterThan(before);
  });

  it('presence never extends the lifetime: present every 50 ms, the session still ends lifetime_exceeded', async () => {
    const { host, art } = fakeHost('normal', { tmpParent: parent, idleMs: 300 });
    closers.push(() => host.shutdown());
    const c = host.create(
      createRequest(art.sha256, {
        ticket: ticketFor(art.sha256, A),
        limits: { maxLifetimeMs: 900 },
      }),
      A,
    );
    if (!c.ok) throw new Error('create failed');
    const s = c.value.session;
    const lifetime = s.status().lifetimeMs;
    expect(s.run().ok).toBe(true);
    const keep = setInterval(() => {
      host.get(s.id, s.token, A);
      host.presence(s);
    }, 50);
    try {
      await until(() => terminalEvent(s) !== undefined);
    } finally {
      clearInterval(keep);
    }
    expect(terminalEvent(s)).toMatchObject({ state: 'ended', reason: 'lifetime_exceeded' });
    expect(s.status().lifetimeMs).toBe(lifetime);
  });

  it('the lease is unchanged: no stream and no request ends lease_expired before idle, exactly once', async () => {
    const { host, art } = fakeHost('normal', { tmpParent: parent, idleMs: 2_000, leaseMs: 200 });
    closers.push(() => host.shutdown());
    const c = host.create(createRequest(art.sha256, { ticket: ticketFor(art.sha256, A) }), A);
    if (!c.ok) throw new Error('create failed');
    const s = c.value.session;
    await until(() => terminalEvent(s) !== undefined);
    expect(terminalEvent(s)).toMatchObject({ reason: 'lease_expired' });
    await sleep(150);
    expect(terminals(s)).toHaveLength(1);
  });

  it('presence does not refresh lastActivity beyond what host.get (every authenticated request) does', async () => {
    const { host, art } = fakeHost('normal', { tmpParent: parent, idleMs: 2_000 });
    closers.push(() => host.shutdown());
    const c = host.create(createRequest(art.sha256, { ticket: ticketFor(art.sha256, A) }), A);
    if (!c.ok) throw new Error('create failed');
    const s = c.value.session;
    const lease = s.lastActivity;
    await sleep(10);
    host.presence(s);
    expect(s.lastActivity).toBe(lease);
    expect(s.lastInteraction).toBeGreaterThan(lease);
  });
});

describe('K3-1: the presence route', () => {
  it('wrong token, another principal, unknown id: the same 404 as every session route', async () => {
    const w = await serve({ idleMs: 400 });
    const c = await w.create();
    const s = w.session(c.body.sessionId, c.body.token);
    const before = s.lastInteraction;
    const answers = await Promise.all([
      w.presence(c.body.sessionId, 'wrong-token'),
      w.presence(c.body.sessionId, c.body.token, { who: 1 }),
      w.presence('0'.repeat(32), c.body.token),
      w.presence('not-an-id', c.body.token),
      fetch(`${w.base()}/sessions/${c.body.sessionId}/presence`, { method: 'POST' }),
    ]);
    const bodies = await Promise.all(answers.map((r) => r.text()));
    expect(answers.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
    expect(new Set(bodies)).toEqual(new Set([JSON.stringify({ error: 'no such session' })]));
    expect(s.lastInteraction).toBe(before);
  });

  it('only POST /sessions/:id/presence exactly; other methods and longer paths are 404', async () => {
    const w = await serve({ idleMs: 400 });
    const c = await w.create();
    const id = c.body.sessionId;
    const r1 = await w.call(`/sessions/${id}/presence`, c.body.token);
    const r2 = await w.call(`/sessions/${id}/presence/x`, c.body.token, { method: 'POST' });
    const r3 = await w.call(`/sessions/${id}/presence`, c.body.token, { method: 'PUT' });
    expect([r1.status, r2.status, r3.status]).toEqual([404, 404, 404]);
  });

  it('ignores body and query (never parsed): malformed JSON, any content type, a large body -> still 204', async () => {
    const w = await serve({ idleMs: 400 });
    const c = await w.create();
    const id = c.body.sessionId;
    const r1 = await w.call(`/sessions/${id}/presence?x=1&token=${c.body.token}`, c.body.token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(r1.status).toBe(204);
    expect(await r1.text()).toBe('');
    const r2 = await w
      .presence(id, c.body.token, {
        headers: { 'content-type': 'text/plain' },
        body: 'x'.repeat(256 * 1024),
      })
      .catch(() => null);
    // either answered 204 or the connection was cut while draining; never a parse error
    if (r2) expect(r2.status).toBe(204);
    // the host is unaffected
    const st = await w.call(`/sessions/${id}`, c.body.token);
    expect(st.status).toBe(200);
  });

  it('a terminal session: presence answers like the other routes, resurrects nothing, emits nothing', async () => {
    const w = await serve({ idleMs: 400 });
    const c = await w.create();
    const s = w.session(c.body.sessionId, c.body.token);
    await w.call(`/sessions/${c.body.sessionId}`, c.body.token, { method: 'DELETE' });
    expect(s.state).toBe('ended');
    const seq = s.log.lastSeq;
    const before = s.lastInteraction;
    const r = await w.presence(c.body.sessionId, c.body.token);
    expect(r.status).toBe(204);
    expect(s.state).toBe('ended');
    expect(s.status().reason).toBe('terminated');
    expect(s.log.lastSeq).toBe(seq);
    expect(s.lastInteraction).toBe(before);
    await sleep(500);
    expect(terminals(s)).toHaveLength(1);
  });

  it('gets no rate exemption: it takes the per-principal request rate like every route', async () => {
    const c0 = structuredClone(DEFAULT_POLICY);
    c0.plans.preview!.requests = { count: 3, windowMs: 60_000 };
    const w = await serve({ idleMs: 400, policy: new Policy(c0, 1), probe: plenty });
    const c = await w.create(); // 1
    const r2 = await w.presence(c.body.sessionId, c.body.token); // 2
    const r3 = await w.presence(c.body.sessionId, c.body.token); // 3
    const r4 = await w.presence(c.body.sessionId, c.body.token); // 4: limited
    expect([c.status, r2.status, r3.status, r4.status]).toEqual([201, 204, 204, 429]);
  });

  it('logs nothing per presence (no token, principal or session id anywhere)', async () => {
    const w = await serve({ idleMs: 400 });
    const c = await w.create();
    stderr = [];
    for (let i = 0; i < 5; i++) await (await w.presence(c.body.sessionId, c.body.token)).text();
    expect(stderr).toEqual([]);
  });
});

describe('K3-1: metered idle end', () => {
  const PLANS = parseConfig({ metering: { enabled: true } });

  it('ends through the single adapter.ended path, once, as `ended` (one sim_close)', async () => {
    const clock = new FakeClock(Date.parse('2026-11-24T10:00:00Z'));
    const store = new MemoryStore<SimEvent>();
    const adapter = await SimHostAdapter.open(store, { config: PLANS, clock });
    const ended = vi.spyOn(adapter, 'ended');
    const tickets = new TicketRegistry({ ttlMs: 600_000, cap: 100, perPrincipalCap: 2, clock });
    const pol = structuredClone(DEFAULT_POLICY);
    pol.global.runtime.maxLiveSessions = 4;
    const w = await serve({
      idleMs: 400,
      policy: new Policy(pol, 1),
      probe: plenty,
      simPlans: adapter,
      simAdmission: {
        planMap: new Map<string, PlanId>([['preview', 'legacy']]),
        pollAfterS: 15,
        tickets,
        beatMs: 50,
        housekeepingMs: 60_000,
        endWaitMs: 2_000,
      },
    });
    const c = await w.create();
    expect(c.status).toBe(201);
    await w.attach(c.body.sessionId, c.body.token);
    await w.call(`/sessions/${c.body.sessionId}/run`, c.body.token, { method: 'POST' });
    const s = w.session(c.body.sessionId, c.body.token);
    await until(() => terminalEvent(s) !== undefined);
    expect(terminalEvent(s)).toMatchObject({ state: 'ended', reason: 'idle_timeout' });
    await until(() => ended.mock.calls.length === 1);
    await sleep(200);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]).toEqual([c.body.sessionId, 'ended', A]);
    const closes = store.events.filter((e) => e.t === 'sim_close');
    expect(closes).toHaveLength(1);
    expect(w.host.capacity().metered).toBe(0);
  });
});

describe('K3-1: diagnostics', () => {
  it('the session_end line classifies idle_timeout', () => {
    const line = sessionEndRecord({
      sessionId: 'a'.repeat(32),
      owner: A,
      state: 'ended',
      reason: 'idle_timeout',
      from: 'running',
      ran: true,
      lifeMs: 1000,
      runMs: 900,
      detail: undefined,
      simNs: 0n,
      runtime: null,
    });
    expect(line).toMatchObject({ reason: 'idle_timeout', category: 'timeout', severity: 'info' });
  });
});
