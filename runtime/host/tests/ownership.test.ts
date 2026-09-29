/**
 * Sprint 8 Phase 2 — session ownership and run-ticket checks in the Session Host (D-S8-4/5),
 * adversarial: users A and B through their own gates against one host.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TEST_IDENTITY,
  TEST_TICKET_KEY,
  principalFor,
  startTestGate,
  ticketFor,
} from '../../identity/test-gate.js';
import { signTicket } from '../../identity/ticket.js';
import type { SessionHost } from '../host.js';
import { createHttpServer } from '../http.js';
import { createRequest, fakeHost } from './support.js';

const A = principalFor('user-a');
const B = principalFor('user-b');
let open: { host: SessionHost; server: Server; close: (() => void)[] }[] = [];
afterEach(async () => {
  for (const o of open) {
    for (const c of o.close) c();
    o.server.closeAllConnections();
    await new Promise((r) => o.server.close(r));
    await o.host.shutdown();
  }
  open = [];
});

async function twoUsers() {
  const { host, art } = fakeHost('normal');
  const server = createHttpServer(host, TEST_IDENTITY);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  const a = await startTestGate(target, TEST_IDENTITY, 'user-a');
  const b = await startTestGate(target, TEST_IDENTITY, 'user-b');
  open.push({ host, server, close: [a.close, b.close] });
  return { host, art, a: a.base, b: b.base };
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('sessions belong to the principal that created them', () => {
  it('B cannot read, run, command, watch, stop or delete A’s session, even with its id and token', async () => {
    const { host, art, a, b } = await twoUsers();
    const created = await fetch(`${a}/sessions`, post(createRequest(art.sha256)));
    expect(created.status).toBe(201);
    const { sessionId, token } = (await created.json()) as { sessionId: string; token: string };
    const auth = { authorization: `Bearer ${token}` };
    const tries: [string, string, RequestInit][] = [
      ['GET', '', {}],
      ['POST', '/run', {}],
      ['POST', '/stop', {}],
      ['GET', '/events', {}],
      ['DELETE', '', {}],
      [
        'POST',
        '/commands',
        { body: '{}', headers: { ...auth, 'content-type': 'application/json' } },
      ],
    ];
    const unknown = async (method: string, path: string, init: RequestInit) =>
      (await fetch(`${b}/sessions/${'0'.repeat(32)}${path}`, { method, headers: auth, ...init }))
        .status;
    for (const [method, path, init] of tries) {
      const r = await fetch(`${b}/sessions/${sessionId}${path}`, {
        method,
        headers: auth,
        ...init,
      });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.status).toBe(await unknown(method, path, init)); // indistinguishable
      await r.body?.cancel();
    }
    // A's session is untouched and still A's.
    const s = host.get(sessionId, token, A);
    expect(s.ok && s.value.state).toBe('ready');
    expect(host.get(sessionId, token, B).ok).toBe(false);
  });

  it('a session needs a valid ticket for this principal and exactly this artifact', async () => {
    const { art, a, b } = await twoUsers();
    const req = createRequest(art.sha256); // ticket for A
    // B presenting A's ticket (e.g. copied) is refused.
    expect((await fetch(`${b}/sessions`, post(req))).status).toBe(403);
    // A ticket for another artifact is refused.
    const other = createRequest(art.sha256, { ticket: ticketFor('a'.repeat(64), A) });
    expect((await fetch(`${a}/sessions`, post(other))).status).toBe(403);
    // Expired, forged and missing tickets are refused.
    const expired = signTicket(TEST_TICKET_KEY, {
      v: 1,
      principal: A,
      sha256: art.sha256,
      features: null,
      exp: Date.now() - 1,
    });
    expect((await fetch(`${a}/sessions`, post({ ...req, ticket: expired }))).status).toBe(403);
    const forged = signTicket(Buffer.alloc(32, 1), {
      v: 1,
      principal: A,
      sha256: art.sha256,
      features: null,
      exp: Date.now() + 60_000,
    });
    expect((await fetch(`${a}/sessions`, post({ ...req, ticket: forged }))).status).toBe(403);
    const { ticket: _dropped, ...noTicket } = req;
    expect((await fetch(`${a}/sessions`, post(noTicket))).status).toBe(400);
    // The rightful owner succeeds.
    expect((await fetch(`${a}/sessions`, post(req))).status).toBe(201);
  });

  it('a ticket for B lets B run the same artifact in B’s own, separate session', async () => {
    const { host, art, a, b } = await twoUsers();
    const ra = await fetch(`${a}/sessions`, post(createRequest(art.sha256)));
    const rb = await fetch(
      `${b}/sessions`,
      post(createRequest(art.sha256, { ticket: ticketFor(art.sha256, B) })),
    );
    expect([ra.status, rb.status]).toEqual([201, 201]);
    const sa = (await ra.json()) as { sessionId: string; token: string };
    const sb = (await rb.json()) as { sessionId: string; token: string };
    expect(sa.sessionId).not.toBe(sb.sessionId);
    expect(host.get(sb.sessionId, sb.token, B).ok).toBe(true);
    expect(host.get(sb.sessionId, sb.token, A).ok).toBe(false);
  });
});
