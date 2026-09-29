/**
 * Runtime R2: the HTTP + Server-Sent Events adapter against a real listening server (fake
 * runtime). Untrusted input never crashes the host; tokens scope every session route.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestGate, principalFor, TEST_IDENTITY } from '../../identity/test-gate.js';
import type { SessionHost } from '../host.js';
import { createHttpServer } from '../http.js';
import type { SessionEvent } from '../protocol.js';
import { createRequest, fakeHost } from './support.js';

let open: { host: SessionHost; server: Server }[] = [];
const gates: (() => void)[] = [];
afterEach(async () => {
  for (const close of gates.splice(0)) close();
  for (const { host, server } of open) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await host.shutdown();
  }
  open = [];
});

async function serve(over = {}) {
  const { host, art } = fakeHost('normal', over);
  const identity = TEST_IDENTITY;
  const server = createHttpServer(host, identity);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  // Reached through a test gate that asserts one user (the deployment's oauth2-proxy role).
  const gate = await startTestGate(
    { host: '127.0.0.1', port: (server.address() as AddressInfo).port },
    identity,
    'user-a',
  );
  gates.push(gate.close);
  open.push({ host, server });
  return { host, art, base: gate.base, identity, server };
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Read SSE events until `stop` says so (or the stream ends). */
async function readEventsAs(
  url: string,
  stop: (e: SessionEvent) => boolean,
  headers: Record<string, string> = {},
) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  const reader = res.body!.getReader();
  const events: SessionEvent[] = [];
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').find((l) => l.startsWith('data: '));
      if (!data) continue;
      const e = JSON.parse(data.slice(6)) as SessionEvent;
      events.push(e);
      if (stop(e)) {
        ctrl.abort();
        return events;
      }
    }
  }
  return events;
}

describe('HTTP + SSE adapter', () => {
  it('create -> run -> ordered event stream -> resume by Last-Event-ID -> terminate', async () => {
    const { art, base } = await serve();
    const created = await fetch(`${base}/sessions`, json(createRequest(art.sha256)));
    expect(created.status).toBe(201);
    const { sessionId, token, status } = (await created.json()) as {
      sessionId: string;
      token: string;
      status: { state: string };
    };
    expect(status.state).toBe('ready');
    expect(sessionId).toMatch(/^[0-9a-f]{32}$/);
    const auth = { authorization: `Bearer ${token}` };
    const run = await fetch(`${base}/sessions/${sessionId}/run`, { method: 'POST', headers: auth });
    expect(run.status).toBe(202);
    const first = await readEventsAs(
      `${base}/sessions/${sessionId}/events`,
      (e) => e.seq >= 20,
      auth,
    );
    expect(first.map((e) => e.seq)).toEqual(Array.from({ length: first.length }, (_, i) => i + 1));
    // Reconnect: resume strictly after the last seen event, nothing repeated, nothing skipped.
    const again = await readEventsAs(`${base}/sessions/${sessionId}/events`, (e) => e.seq >= 30, {
      ...auth,
      'last-event-id': '20',
    });
    expect(again[0]!.seq).toBe(21);
    const del = await fetch(`${base}/sessions/${sessionId}`, { method: 'DELETE', headers: auth });
    expect(((await del.json()) as { state: string }).state).toBe('ended');
    // After termination the stream delivers the terminal state and closes.
    const tail = await readEventsAs(
      `${base}/sessions/${sessionId}/events?after=30`,
      () => false,
      auth,
    );
    // Sprint 8 (D-S8-5): a token in the URL is never accepted, only the Authorization header.
    const inUrl = await fetch(`${base}/sessions/${sessionId}/events?token=${token}`);
    expect(inUrl.status).toBe(404);
    await inUrl.body?.cancel();
    expect(tail.at(-1)).toMatchObject({ type: 'state', state: 'ended', reason: 'terminated' });
  });

  it('resume: retained id replays after it; evicted id gets resync first; future/malformed ids refused', async () => {
    const { host, art, base } = await serve({ eventLogCapacity: 8 });
    const created = (await (
      await fetch(`${base}/sessions`, json(createRequest(art.sha256)))
    ).json()) as {
      sessionId: string;
      token: string;
    };
    const { sessionId, token } = created;
    const s = host.get(sessionId, token, principalFor());
    if (!s.ok) throw new Error('no session');
    const session = s.value;
    session.run();
    await expect.poll(() => session.log.lastSeq, { timeout: 10_000 }).toBeGreaterThan(30);
    await host.terminate(session); // a finished stream: the replays below are complete and stable
    const last = session.log.lastSeq;
    const first = last - session.log.size + 1; // oldest retained event (capacity 8)
    expect(session.log.size).toBe(8);
    const url = `${base}/sessions/${sessionId}/events`;
    const readEvents = (u: string, until: (e: SessionEvent) => boolean, h = {}) =>
      readEventsAs(u, until, { authorization: `Bearer ${token}`, ...h });
    const seqs = (es: SessionEvent[]) => es.map((e) => e.seq);
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

    // Retained: exactly the events after the id, in order, no marker.
    const kept = await readEvents(url, () => false, { 'last-event-id': String(last - 3) });
    expect(seqs(kept)).toEqual(range(last - 2, last));
    expect(kept.some((e) => e.type === 'resync')).toBe(false);
    // Up to date: nothing is replayed (the terminal stream simply ends).
    expect(await readEvents(url, () => false, { 'last-event-id': String(last) })).toEqual([]);

    // Evicted: an explicit resync marker (how many were lost) BEFORE the oldest retained event.
    for (const id of ['2', String(first - 2)]) {
      const r = await readEvents(url, () => false, { 'last-event-id': id });
      expect(r[0]).toMatchObject({
        type: 'resync',
        seq: first - 1,
        missed: first - 1 - Number(id),
      });
      expect(seqs(r.slice(1))).toEqual(range(first, last));
    }
    // ?after= behaves the same; the header wins when both are present.
    const viaQuery = await readEvents(`${url}?after=2`, () => false);
    expect(viaQuery[0]).toMatchObject({ type: 'resync' });
    const both = await readEvents(`${url}?after=2`, () => false, {
      'last-event-id': String(last - 1),
    });
    expect(seqs(both)).toEqual([last]);
    // Absent or empty id: from the start, which is also behind the window -> resync first.
    const fresh = await readEvents(url, () => false, { 'last-event-id': '' });
    expect(fresh[0]).toMatchObject({ type: 'resync', missed: first - 1 });

    // Future and malformed ids are refused, never reinterpreted as another point in the stream.
    const status = async (headers: Record<string, string>, q = '') =>
      (await fetch(`${url}${q}`, { headers: { authorization: `Bearer ${token}`, ...headers } }))
        .status;
    expect(await status({ 'last-event-id': String(last + 1) })).toBe(409);
    expect(await status({}, `?after=${last + 1000}`)).toBe(409);
    for (const bad of ['abc', '-1', '1.5', '1e3', '0x7', '9'.repeat(16)])
      expect(await status({ 'last-event-id': bad }), bad).toBe(400);
    expect(await status({}, '?after=x')).toBe(400);
    // The host and the session are unaffected.
    expect(host.get(sessionId, token, principalFor()).ok).toBe(true);
  });

  it('commands over HTTP are acknowledged; rejections are explicit', async () => {
    const { art, base } = await serve();
    const req = createRequest(art.sha256);
    const pb = req.circuit.components.find((c) => c.type === 'component.push_button')!.id;
    const { sessionId, token } = (await (await fetch(`${base}/sessions`, json(req))).json()) as {
      sessionId: string;
      token: string;
    };
    const post = (body: unknown) =>
      fetch(`${base}/sessions/${sessionId}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    expect(
      (await post({ category: 'transient', seq: 1, action: 'press', component: pb })).status,
    ).toBe(202);
    const dup = await post({ category: 'transient', seq: 1, action: 'release', component: pb });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect((await post({ seq: 2, action: 'press', component: pb })).status).toBe(400);
  });

  it('untrusted input: wrong token, bad JSON, oversize, wrong type, traversal all fail safely', async () => {
    const { host, art, base } = await serve({ maxRequestBytes: 64 * 1024 });
    const { sessionId, token } = (await (
      await fetch(`${base}/sessions`, json(createRequest(art.sha256)))
    ).json()) as { sessionId: string; token: string };
    expect((await fetch(`${base}/sessions/${sessionId}`)).status).toBe(404);
    expect(
      (await fetch(`${base}/sessions/${sessionId}`, { headers: { authorization: 'Bearer nope' } }))
        .status,
    ).toBe(404);
    expect(
      (
        await fetch(`${base}/sessions/${'0'.repeat(32)}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${base}/sessions/..%2F..%2Fetc`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${base}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{nope',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: '{}',
        })
      ).status,
    ).toBe(415);
    const big = JSON.stringify({ pad: 'x'.repeat(200 * 1024) });
    expect(
      (
        await fetch(`${base}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: big,
        })
      ).status,
    ).toBe(413);
    expect((await fetch(`${base}/nothing`)).status).toBe(404);
    // The host is still healthy and the session untouched.
    const health = await fetch(`${base}/health`);
    expect(await health.json()).toMatchObject({
      protocol: 'tbi-lab.session/2',
      sessions: { ready: 1 },
    });
    expect(host.get(sessionId, token, principalFor()).ok).toBe(true);
  });
});
