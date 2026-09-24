/**
 * Runtime R2: the HTTP + Server-Sent Events adapter against a real listening server (fake
 * runtime). Untrusted input never crashes the host; tokens scope every session route.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionHost } from '../host.js';
import { createHttpServer } from '../http.js';
import type { SessionEvent } from '../protocol.js';
import { createRequest, fakeHost } from './support.js';

let open: { host: SessionHost; server: Server }[] = [];
afterEach(async () => {
  for (const { host, server } of open) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await host.shutdown();
  }
  open = [];
});

async function serve(over = {}) {
  const { host, art } = fakeHost('normal', over);
  const server = createHttpServer(host);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  open.push({ host, server });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { host, art, base };
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Read SSE events until `stop` says so (or the stream ends). */
async function readEvents(
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
    const first = await readEvents(
      `${base}/sessions/${sessionId}/events?token=${token}`,
      (e) => e.seq >= 20,
    );
    expect(first.map((e) => e.seq)).toEqual(Array.from({ length: first.length }, (_, i) => i + 1));
    // Reconnect: resume strictly after the last seen event, nothing repeated, nothing skipped.
    const again = await readEvents(`${base}/sessions/${sessionId}/events`, (e) => e.seq >= 30, {
      ...auth,
      'last-event-id': '20',
    });
    expect(again[0]!.seq).toBe(21);
    const del = await fetch(`${base}/sessions/${sessionId}`, { method: 'DELETE', headers: auth });
    expect(((await del.json()) as { state: string }).state).toBe('ended');
    // After termination the stream delivers the terminal state and closes.
    const tail = await readEvents(
      `${base}/sessions/${sessionId}/events?token=${token}&after=30`,
      () => false,
    );
    expect(tail.at(-1)).toMatchObject({ type: 'state', state: 'ended', reason: 'terminated' });
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
      protocol: 'tbi-lab.session/1',
      sessions: { ready: 1 },
    });
    expect(host.get(sessionId, token).ok).toBe(true);
  });
});
