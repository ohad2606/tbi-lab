/**
 * TBI-018 s3d-2: host plumbing for sim admission, no metering (docs/plans/S3D-HOST-WIRING-DESIGN.md
 * section 12 item 2). `POST /sessions` now awaits `SessionHost.admitCreate`; without an enabled
 * adapter it is exactly `create`, so every HTTP answer (status, body, headers) is identical with and
 * without a disabled SimHostAdapter. `HostSession` takes an optional pre-generated id.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_IDENTITY, principalFor, startTestGate, ticketFor } from '../../identity/test-gate.js';
import { parseConfig } from '../../plans/config.js';
import type { SimEvent } from '../../plans/simminutes.js';
import { SimHostAdapter } from '../../plans/simhost.js';
import { MemoryStore } from '../../plans/store.js';
import { FakeClock } from '../../plans/time.js';
import { DEFAULT_POLICY, Policy, type PolicyConfig } from '../../policy/policy.js';
import { RateLimiter } from '../../policy/rate.js';
import type { ResourceProbe } from '../../policy/resources.js';
import { sessionDir, type HostConfig } from '../config.js';
import { createHttpServer } from '../http.js';
import { HostSession, SESSION_ID_RE, newSessionId } from '../session.js';
import { createRequest, fakeHost } from './support.js';

const parent = mkdtempSync(join(tmpdir(), 'tbi-s3d2-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));

const A = principalFor('user-a');
const B = principalFor('user-b');
const C = principalFor('user-c');
const plenty: ResourceProbe = { freeDiskMb: () => 1e9, availableMemoryMb: () => 1e9 };
const starved: ResourceProbe = { freeDiskMb: () => 0, availableMemoryMb: () => 1e9 };

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

function preview(tweak: (c: PolicyConfig) => void): Policy {
  const c = structuredClone(DEFAULT_POLICY);
  tweak(c);
  return new Policy(c, 1);
}

/** A disabled adapter (the default plans config) and its store (must never be written). */
async function disabledAdapter() {
  const store = new MemoryStore<SimEvent>();
  const adapter = await SimHostAdapter.open(store, {
    config: parseConfig({}),
    clock: new FakeClock(Date.parse('2026-11-23T10:00:00Z')),
  });
  expect(adapter.enabled).toBe(false);
  return { store, adapter };
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Random or time-dependent values of a 201 body, replaced by their shape (format checked). */
function normalize(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(normalize);
  if (body === null || typeof body !== 'object') return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (k === 'sessionId' && typeof v === 'string' && SESSION_ID_RE.test(v)) out[k] = '<id>';
    else if (k === 'token' && typeof v === 'string' && /^[A-Za-z0-9_-]{32}$/.test(v))
      out[k] = '<token>';
    else if (k === 'createdAt' && typeof v === 'string' && !Number.isNaN(Date.parse(v)))
      out[k] = '<time>';
    else out[k] = normalize(v);
  }
  return out;
}

async function answer(r: Response): Promise<Answer> {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    if (k !== 'date') headers[k] = v;
  });
  const text = await r.text();
  let body: unknown;
  try {
    body = normalize(JSON.parse(text));
  } catch {
    body = text;
  }
  return { status: r.status, headers, body };
}

/** A host behind a real HTTP server and three test gates (user-a, user-b, user-c). */
async function world(over: Partial<HostConfig>) {
  const { host, art } = fakeHost('normal', { tmpParent: parent, ...over });
  const server: Server = createHttpServer(host, TEST_IDENTITY);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  const gates = await Promise.all(
    ['user-a', 'user-b', 'user-c'].map((u) => startTestGate(target, TEST_IDENTITY, u)),
  );
  let down = false;
  const shutdown = async () => {
    if (down) return;
    down = true;
    await host.shutdown();
  };
  closers.push(async () => {
    for (const g of gates) g.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await shutdown();
  });
  const post = async (gate: number, init: RequestInit) =>
    answer(await fetch(`${gates[gate]!.base}/sessions`, { method: 'POST', ...init }));
  const json = (body: unknown): RequestInit => ({
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const valid = (gate: number) =>
    createRequest(art.sha256, { ticket: ticketFor(art.sha256, [A, B, C][gate]!) });
  return { host, art, post, json, valid, shutdown };
}

type World = Awaited<ReturnType<typeof world>>;

/**
 * Run one scenario on a host without the hook and on one with a disabled adapter. `over` is a
 * factory: each host gets its own policy and rate store.
 */
async function twin(over: () => Partial<HostConfig>, scenario: (w: World) => Promise<Answer[]>) {
  const plain = await scenario(await world(over()));
  const { store, adapter } = await disabledAdapter();
  const hooked = await scenario(await world({ ...over(), simPlans: adapter }));
  expect(store.appendCalls).toBe(0);
  expect(hooked).toEqual(plain);
  return plain;
}

describe('s3d-2: POST /sessions answers are identical with a disabled SimHostAdapter', () => {
  it('no policy: 415, 413, malformed JSON, invalid body, ticket invalid, 201, session limit, shutting down', async () => {
    const answers = await twin(
      () => ({ maxSessions: 1, maxRequestBytes: 64 * 1024 }),
      async (w) => {
        const out: Answer[] = [];
        out.push(await w.post(0, { body: '{}' })); // no content type
        out.push(await w.post(0, w.json(`"${'x'.repeat(70 * 1024)}"`)));
        out.push(await w.post(0, w.json('{not json')));
        out.push(await w.post(0, w.json({})));
        out.push(await w.post(0, w.json({ ...w.valid(0), ticket: ticketFor('0'.repeat(64), A) })));
        out.push(await w.post(0, w.json(w.valid(0))));
        out.push(await w.post(0, w.json(w.valid(0))));
        await w.shutdown();
        out.push(await w.post(0, w.json(w.valid(0))));
        return out;
      },
    );
    expect(answers.map((a) => a.status)).toEqual([415, 413, 400, 400, 403, 201, 429, 503]);
    expect(answers[4]!.body).toEqual({ error: 'ticket invalid' });
    expect(answers[5]!.body).toMatchObject({ sessionId: '<id>', token: '<token>' });
    expect(answers[6]!.body).toEqual({ error: 'session limit' });
    expect(answers[7]!.body).toEqual({ error: 'host shutting down' });
  });

  it('policy: admitted, session_quota, runtime_capacity (+ Retry-After)', async () => {
    const answers = await twin(
      () => ({
        policy: preview((c) => (c.global.runtime.maxLiveSessions = 2)),
        rates: new RateLimiter(':memory:'),
        probe: plenty,
      }),
      async (w) => [
        await w.post(0, w.json(w.valid(0))),
        await w.post(0, w.json(w.valid(0))),
        await w.post(1, w.json(w.valid(1))),
        await w.post(2, w.json(w.valid(2))),
      ],
    );
    expect(answers.map((a) => a.status)).toEqual([201, 429, 201, 503]);
    expect(answers[1]!.body).toEqual({ error: 'session_quota' });
    expect(answers[3]!.body).toEqual({ error: 'runtime_capacity', retryAfterS: 15 });
    expect(answers[3]!.headers['retry-after']).toBe('15');
  });

  it('policy: rate_limited after the creation allowance (+ Retry-After)', async () => {
    const answers = await twin(
      () => ({
        policy: preview((c) => {
          c.global.runtime.maxLiveSessions = 4;
          for (const plan of Object.values(c.plans)) {
            plan.runtime.maxSessions = 8;
            plan.runtime.creations.count = 1;
          }
        }),
        rates: new RateLimiter(':memory:'),
        probe: plenty,
      }),
      async (w) => [await w.post(0, w.json(w.valid(0))), await w.post(0, w.json(w.valid(0)))],
    );
    expect(answers.map((a) => a.status)).toEqual([201, 429]);
    expect((answers[1]!.body as { error: string }).error).toBe('rate_limited');
    expect(answers[1]!.headers['retry-after']).toMatch(/^\d+$/);
  });

  it('policy: storage_pressure from the resource check', async () => {
    const answers = await twin(
      () => ({ policy: preview(() => {}), rates: new RateLimiter(':memory:'), probe: starved }),
      async (w) => [await w.post(0, w.json(w.valid(0)))],
    );
    expect(answers[0]).toMatchObject({ status: 503, body: { error: 'storage_pressure' } });
  });
});

describe('s3d-2: SessionHost.admitCreate', () => {
  it('without an adapter (and with a disabled one) returns exactly what create returns', async () => {
    const { adapter } = await disabledAdapter();
    for (const simPlans of [undefined, adapter]) {
      const one = fakeHost('normal', { tmpParent: parent, maxSessions: 1, simPlans });
      const two = fakeHost('normal', { tmpParent: parent, maxSessions: 1, simPlans });
      closers.push(
        () => one.host.shutdown(),
        () => two.host.shutdown(),
      );
      const foreign = { ticket: ticketFor('0'.repeat(64), A) };
      for (const body of [{}, null, { ticket: 'x' }, createRequest(one.art.sha256, foreign)])
        expect(await one.host.admitCreate(body, A)).toEqual(two.host.create(body, A));
      const a = await one.host.admitCreate(createRequest(one.art.sha256), A, 'tag');
      const b = two.host.create(createRequest(two.art.sha256), A, 'tag');
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.value.session.emailTag).toBe('tag');
      expect(normalize(a.value.session.status())).toEqual(normalize(b.value.session.status()));
      expect(one.host.size).toBe(1);
      expect(await one.host.admitCreate(createRequest(one.art.sha256), A)).toEqual(
        two.host.create(createRequest(two.art.sha256), A),
      );
    }
  });

  // s3d-3b: an enabled adapter is now admitted (s3d3b-admission.test.ts); one that reaches a host
  // without policy / admission config (swapped in after construction) still creates nothing: 503.
  it('fails closed (503 system_unavailable, creates nothing) for an enabled adapter without its config', async () => {
    const { adapter } = await disabledAdapter();
    const { host, art } = fakeHost('normal', { tmpParent: parent, simPlans: adapter });
    closers.push(() => host.shutdown());
    const admit = vi.fn();
    (host.config as { simPlans?: unknown }).simPlans = { enabled: true, admit };
    expect(await host.admitCreate(createRequest(art.sha256), A)).toMatchObject({
      ok: false,
      status: 503,
      sim: { kind: 'limit', limit: { code: 'system_unavailable' } },
    });
    expect(admit).not.toHaveBeenCalled();
    expect(host.size).toBe(0);
  });
});

describe('s3d-2: HostSession optional pre-generated id', () => {
  it('without an id: a fresh random id of the usual format (unchanged default)', async () => {
    const { host, art } = fakeHost('normal', { tmpParent: parent });
    closers.push(() => host.shutdown());
    const r = host.create(createRequest(art.sha256), A);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.session.id).toMatch(SESSION_ID_RE);
    expect(newSessionId()).toMatch(SESSION_ID_RE);
    expect(newSessionId()).not.toBe(newSessionId());
  });

  it('a given id is the session id, its directory and its registry key', async () => {
    const { host, art } = fakeHost('normal', { tmpParent: parent });
    closers.push(() => host.shutdown());
    const id = newSessionId();
    const r = host.create(createRequest(art.sha256), A, null, { sessionId: id });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value.session;
    expect(s.id).toBe(id);
    expect(s.status().sessionId).toBe(id);
    expect(existsSync(sessionDir(host.tmpRoot, id))).toBe(true);
    expect(host.get(id, s.token, A)).toEqual({ ok: true, value: s });
  });

  it('a malformed id is refused (throws) before anything is admitted or created', async () => {
    const { host, art } = fakeHost('normal', { tmpParent: parent });
    closers.push(() => host.shutdown());
    for (const bad of ['', 'abc', 'A'.repeat(32), `${'0'.repeat(31)}g`, '0'.repeat(33), '../x'])
      expect(() => host.create(createRequest(art.sha256), A, null, { sessionId: bad })).toThrow(
        /malformed session id/,
      );
    expect(host.size).toBe(0);
    const request = createRequest(art.sha256);
    for (const bad of ['../../etc', 'f'.repeat(31), 42 as unknown as string])
      expect(
        () => new HostSession(host.config, host.tmpRoot, request as never, A, null, { id: bad }),
      ).toThrow(/malformed session id/);
  });

  it('a duplicate id is refused: a registered session (host) or an existing directory (session)', async () => {
    const rates = new RateLimiter(':memory:');
    const policy = preview((c) => {
      for (const plan of Object.values(c.plans)) plan.runtime.maxSessions = 8;
    });
    const { host, art } = fakeHost('normal', { tmpParent: parent, policy, rates, probe: plenty });
    closers.push(() => host.shutdown());
    const id = newSessionId();
    const first = host.create(createRequest(art.sha256), A, null, { sessionId: id });
    expect(first.ok).toBe(true);
    const creationsBefore = rates.check(A, 'session-create', { count: 1_000, windowMs: 3_600_000 });
    expect(() => host.create(createRequest(art.sha256), A, null, { sessionId: id })).toThrow(
      /duplicate session id/,
    );
    expect(host.size).toBe(1);
    // Refused before admission: no creation unit was consumed by the duplicate.
    expect(rates.check(A, 'session-create', { count: 1_000, windowMs: 3_600_000 })).toEqual(
      creationsBefore,
    );
    if (first.ok) expect(host.get(id, first.value.session.token, A).ok).toBe(true);

    const other = newSessionId();
    mkdirSync(sessionDir(host.tmpRoot, other));
    expect(
      () =>
        new HostSession(host.config, host.tmpRoot, createRequest(art.sha256) as never, A, null, {
          id: other,
        }),
    ).toThrow(/duplicate session id/);
  });
});
