/**
 * TBI-018 s3d-3a: `DELETE /sessions/queue` and the flag-off identity of the queue surface
 * (docs/plans/S3D-HOST-WIRING-DESIGN.md sections 4, 10 R-1, 11).
 *
 *   - enabled sim adapter: 204 for an own, foreign, unknown, missing or malformed ticket (one answer,
 *     nothing revealed); adapter.cancel only for a well-formed ticket and only acts on the caller's
 *     own entry; a throwing / rejecting adapter is logged without a ticket and still 204;
 *   - other methods on /sessions/queue and the other session routes are unchanged;
 *   - flag-off (no adapter, or a disabled one): `DELETE /sessions/queue` stays today's 404 and the
 *     `Tbi-Queue*` headers change no answer.
 *
 * The SessionHost constructor still refuses an enabled adapter (the guard moves to boot in s3d-3b), so
 * the enabled cases swap one in after construction, as s3d2-admit-create.test.ts does.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_IDENTITY, principalFor, startTestGate } from '../../identity/test-gate.js';
import { parseConfig } from '../../plans/config.js';
import type { SimEvent } from '../../plans/simminutes.js';
import { SimHostAdapter } from '../../plans/simhost.js';
import { MemoryStore } from '../../plans/store.js';
import { FakeClock } from '../../plans/time.js';
import type { HostConfig } from '../config.js';
import { createHttpServer } from '../http.js';
import { newQueueTicket } from '../queueTickets.js';
import { newSessionId } from '../session.js';
import { createRequest, fakeHost } from './support.js';

const parent = mkdtempSync(join(tmpdir(), 'tbi-s3d3a-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));

const A = principalFor('user-a');
const B = principalFor('user-b');

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

const clock = () => new FakeClock(Date.parse('2026-11-23T10:00:00Z'));
const adapterOf = async (enabled: boolean) => {
  const store = new MemoryStore<SimEvent>();
  const adapter = await SimHostAdapter.open(store, {
    config: parseConfig({ metering: { enabled } }),
    clock: clock(),
  });
  return { store, adapter };
};

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

async function answer(r: Response): Promise<Answer> {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    if (k !== 'date') headers[k] = v;
  });
  return { status: r.status, headers, body: await r.text() };
}

type Mode = 'none' | 'disabled' | 'enabled';

/**
 * A host behind a real HTTP server, two test gates (user-a = 0, user-b = 1) and the raw server
 * address (no identity). `enabled`: an enabled adapter is swapped in after construction.
 */
async function world(mode: Mode, over: Partial<HostConfig> = {}) {
  const disabled = await adapterOf(false);
  const { host, art } = fakeHost('normal', {
    tmpParent: parent,
    ...(mode === 'none' ? {} : { simPlans: disabled.adapter }),
    ...over,
  });
  const enabled = mode === 'enabled' ? await adapterOf(true) : null;
  if (enabled) (host.config as { simPlans?: unknown }).simPlans = enabled.adapter;
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
  const call = async (gate: number | 'raw', method: string, path: string, headers = {}) =>
    answer(
      await fetch(
        `${gate === 'raw' ? `http://127.0.0.1:${target.port}` : gates[gate]!.base}${path}`,
        { method, headers },
      ),
    );
  const cancel = (gate: number | 'raw', ticket?: string) =>
    call(
      gate,
      'DELETE',
      '/sessions/queue',
      ticket === undefined ? {} : { 'tbi-queue-ticket': ticket },
    );
  return {
    host,
    art,
    call,
    cancel,
    bases: gates.map((g) => g.base),
    adapter: enabled?.adapter ?? null,
    store: enabled?.store,
    disabled,
  };
}

/** Put `principal` in the adapter's queue (capacity 0: queued, never started). */
async function enqueue(adapter: SimHostAdapter, principal: string) {
  const ticket = newQueueTicket();
  const r = await adapter.admit({
    ticket,
    sessionId: newSessionId(),
    principal,
    plan: 'legacy',
    slots: { capacity: 0, running: 0 },
  });
  expect(r).toMatchObject({ metered: true, decision: 'queued' });
  return ticket;
}

const NO_CONTENT = {
  status: 204,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  body: '',
};

describe('s3d-3a: DELETE /sessions/queue with an enabled sim adapter', () => {
  it('answers 204 for own, foreign, unknown, missing and malformed tickets, indistinguishably', async () => {
    const w = await world('enabled');
    const adapter = w.adapter as SimHostAdapter;
    const cancel = vi.spyOn(adapter, 'cancel');
    const mine = await enqueue(adapter, A);
    const theirs = await enqueue(adapter, B);
    expect(adapter.waiting).toBe(2);

    const answers = [
      await w.cancel(1, mine), // foreign: B cancels A's ticket
      await w.cancel(0, newQueueTicket()), // unknown
      await w.cancel(0), // missing
      await w.cancel(0, 'not-a-ticket'), // malformed
      await w.cancel(0, `${mine}A`), // malformed (too long)
      await w.cancel(0, `${mine}, ${theirs}`), // two values
    ];
    // nothing changed so far: both entries still wait
    expect(adapter.hasWaiting(A)).toBe(true);
    expect(adapter.hasWaiting(B)).toBe(true);
    answers.push(await w.cancel(0, mine)); // own
    answers.push(await w.cancel(0, mine)); // own, again (already gone)
    for (const a of answers) expect(a).toEqual({ ...NO_CONTENT, headers: answers[0]!.headers });
    expect(answers[0]!.headers).toMatchObject(NO_CONTENT.headers);
    expect(answers[0]!.headers['content-type']).toBeUndefined();

    expect(adapter.hasWaiting(A)).toBe(false);
    expect(adapter.hasWaiting(B)).toBe(true);
    // the adapter is asked only for well-formed tickets, always with the CALLER's principal
    expect(cancel.mock.calls).toEqual([
      [mine, B],
      [expect.any(String), A],
      [mine, A],
      [mine, A],
    ]);
    // nothing written to the meter journal by a cancel
    expect(w.store?.appendCalls).toBe(0);
    for (const t of [mine, theirs]) expect(stderr.join('')).not.toContain(t);
  });

  it('a throwing or rejecting adapter never fails the request: 204, one line without ticket or principal', async () => {
    for (const fault of ['throw', 'reject'] as const) {
      const w = await world('enabled');
      const adapter = w.adapter as SimHostAdapter;
      vi.spyOn(adapter, 'cancel').mockImplementation((() => {
        if (fault === 'throw') throw new Error(`boom ${A}`);
        return Promise.reject(new Error(`boom ${A}`));
      }) as never);
      const t = newQueueTicket();
      stderr = [];
      expect(await w.cancel(0, t)).toMatchObject({ status: 204, body: '' });
      const out = stderr.join('');
      expect(out).toContain('"event":"sim_queue_fault"');
      expect(out).toContain('"op":"cancel"');
      expect(out).not.toContain(t);
      expect(out).not.toContain(A);
      expect(out).not.toContain('boom');
    }
  });

  it('needs the gate identity like every session route: without one 401, adapter untouched', async () => {
    const w = await world('enabled');
    const cancel = vi.spyOn(w.adapter as SimHostAdapter, 'cancel');
    const r = await w.cancel('raw', newQueueTicket());
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toEqual({ error: 'identity required' });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('other methods and paths are unchanged (same answers as a flag-off host)', async () => {
    const on = await world('enabled');
    const off = await world('none');
    const t = newQueueTicket();
    const cases: [string, string][] = [
      ['GET', '/sessions/queue'],
      ['POST', '/sessions/queue'],
      ['PUT', '/sessions/queue'],
      ['PATCH', '/sessions/queue'],
      ['DELETE', '/sessions/queue/x'],
      ['DELETE', '/sessions/QUEUE'],
      ['DELETE', '/sessions'],
      ['DELETE', `/sessions/${'0'.repeat(32)}`],
      ['DELETE', '/queue'],
    ];
    for (const [method, path] of cases) {
      const a = await on.call(0, method, path, { 'tbi-queue-ticket': t });
      const b = await off.call(0, method, path, { 'tbi-queue-ticket': t });
      expect({ method, path, ...a }).toEqual({ method, path, ...b });
      expect(a.status).not.toBe(204);
    }
  });

  it('DELETE /sessions/:id still terminates the own session', async () => {
    const w = await world('enabled');
    // created directly (admission over HTTP with an enabled adapter is s3d-3b)
    const r = w.host.create(createRequest(w.art.sha256), A);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value.session;
    const a = await w.call(0, 'DELETE', `/sessions/${s.id}`, {
      authorization: `Bearer ${s.token}`,
    });
    expect(a.status).toBe(200);
    expect(JSON.parse(a.body)).toMatchObject({ sessionId: s.id, state: 'ended' });
  });
});

describe('s3d-3a: SessionHost queue surface', () => {
  it('hasWaiting: false flag-off; the adapter peek when enabled; fail closed (true) on a throw', async () => {
    for (const mode of ['none', 'disabled'] as const) {
      const w = await world(mode);
      expect(w.host.queueEnabled).toBe(false);
      expect(w.host.hasWaiting(A)).toBe(false);
    }
    const w = await world('enabled');
    const adapter = w.adapter as SimHostAdapter;
    expect(w.host.queueEnabled).toBe(true);
    expect(w.host.hasWaiting(A)).toBe(false);
    const t = await enqueue(adapter, A);
    expect(w.host.hasWaiting(A)).toBe(true);
    expect(w.host.hasWaiting(B)).toBe(false);
    expect(adapter.waiting).toBe(1); // the peek changed nothing
    vi.spyOn(adapter, 'hasWaiting').mockImplementation(() => {
      throw new Error('boom');
    });
    stderr = [];
    expect(w.host.hasWaiting(B)).toBe(true);
    expect(stderr.join('')).toContain('"op":"peek"');
    expect(stderr.join('')).not.toContain(B);
    expect(stderr.join('')).not.toContain(t);
  });

  it('cancelQueued never calls a disabled adapter, nor any adapter without a ticket', async () => {
    const w = await world('disabled');
    const cancel = vi.spyOn(w.disabled.adapter, 'cancel');
    await w.host.cancelQueued(newQueueTicket(), A);
    expect(cancel).not.toHaveBeenCalled();
    const on = await world('enabled');
    const c2 = vi.spyOn(on.adapter as SimHostAdapter, 'cancel');
    await on.host.cancelQueued(null, A);
    expect(c2).not.toHaveBeenCalled();
  });
});

describe('s3d-3a: flag-off identity (no adapter or a disabled one)', () => {
  it('DELETE /sessions/queue stays 404, whatever the ticket, exactly as without the hook', async () => {
    const plain = await world('none');
    const hooked = await world('disabled');
    const cancel = vi.spyOn(hooked.disabled.adapter, 'cancel');
    for (const t of [undefined, newQueueTicket(), 'bad']) {
      const a = await plain.cancel(0, t);
      const b = await hooked.cancel(0, t);
      expect(b).toEqual(a);
      expect(a.status).toBe(404);
      expect(JSON.parse(a.body)).toEqual({ error: 'no such session' });
    }
    expect((await hooked.cancel('raw')).status).toBe(401);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('Tbi-Queue / Tbi-Queue-Ticket headers change no answer of POST /sessions or GET /health', async () => {
    const normalize = (a: Answer) => ({
      ...a,
      headers: { ...a.headers, 'content-length': '<n>' },
      body: a.body
        .replace(/"sessionId":"[0-9a-f]{32}"/g, '"sessionId":"<id>"')
        .replace(/"token":"[A-Za-z0-9_-]+"/g, '"token":"<token>"')
        .replace(/"createdAt":"[^"]+"/g, '"createdAt":"<time>"'),
    });
    const run = async (mode: Mode, queueHeaders: boolean) => {
      const w = await world(mode, { maxSessions: 1 });
      const extra = queueHeaders ? { 'tbi-queue': '1', 'tbi-queue-ticket': newQueueTicket() } : {};
      const post = async (body: unknown) =>
        normalize(
          await answer(
            await fetch(`${w.bases[0]}/sessions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...extra },
              body: JSON.stringify(body),
            }),
          ),
        );
      return [
        await post({}),
        await post(createRequest(w.art.sha256)),
        await post(createRequest(w.art.sha256)), // session limit (maxSessions 1)
        normalize(await w.call(0, 'GET', '/health', extra)),
      ];
    };
    const baseline = await run('none', false);
    expect(baseline.map((a) => a.status)).toEqual([400, 201, 429, 200]);
    for (const mode of ['none', 'disabled'] as const)
      expect(await run(mode, true)).toEqual(baseline);
  });
});
