/**
 * TEST ONLY: a stand-in for the deployment's authenticating gate (oauth2-proxy + the internal
 * reverse proxy), for tests and local development. Like the real gate it
 * - removes any identity header a client sent (the subject header and every `x-tbi-*` header),
 * - asserts exactly one subject (or none, for "not signed in"),
 * - streams responses unbuffered (Server-Sent Events pass straight through).
 * Two gates with different subjects in front of one backend are two users.
 */
import { randomBytes } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  derivePrincipal,
  identityConfig,
  type IdentityConfig,
  type Principal,
} from './principal.js';
import { signTicket, type TicketFeatures } from './ticket.js';

/** A per-process identity configuration for tests (random key). */
export function testIdentity(issuer = 'test'): IdentityConfig {
  return identityConfig({ issuer, key: randomBytes(32) });
}

export type GateTarget = { socketPath: string } | { host: string; port: number };

/** Headers forwarded to the backend: client identity removed, the gate's subject asserted. */
export function gateHeaders(
  req: IncomingMessage,
  identity: IdentityConfig,
  subject: string | null,
  email: string | null = null,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === identity.subjectHeader || k.startsWith('x-tbi-') || k === 'x-forwarded-email')
      continue;
    out[k] = v;
  }
  if (subject !== null) out[identity.subjectHeader] = subject;
  // Sprint 23B: oauth2-proxy also sets the session's verified address (and deletes a client's).
  if (email !== null) out['x-forwarded-email'] = email;
  return out;
}

export function createTestGate(
  target: GateTarget,
  identity: IdentityConfig,
  subject: () => string | null,
  email: () => string | null = () => null,
): Server {
  return createServer((req, res) => {
    const upstream = httpRequest(
      {
        ...('socketPath' in target
          ? { socketPath: target.socketPath }
          : { host: target.host, port: target.port }),
        method: req.method,
        path: req.url,
        headers: gateHeaders(req, identity, subject(), email()),
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        res.flushHeaders();
        up.pipe(res);
        // A backend that drops the connection mid-response drops the client's too (as the real
        // proxies do), so clients see the disconnect and resume.
        up.on('close', () => {
          if (!up.complete) res.destroy();
        });
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
    res.on('close', () => upstream.destroy());
  });
}

/** Start a gate on an ephemeral loopback port; returns its base URL and a closer. */
export async function startTestGate(
  target: GateTarget,
  identity: IdentityConfig,
  subject: string | null,
  email: string | null = null,
): Promise<{ base: string; close: () => void }> {
  const gate = createTestGate(
    target,
    identity,
    () => subject,
    () => email,
  );
  await new Promise<void>((r) => gate.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${(gate.address() as AddressInfo).port}`,
    close: () => {
      gate.closeAllConnections();
      gate.close();
    },
  };
}

/**
 * TEST ONLY: fixed identity and ticket keys, so test helpers can mint a valid run ticket for the
 * principal a test gate asserts (subject `user-a` unless stated).
 */
export const TEST_IDENTITY: IdentityConfig = identityConfig({
  issuer: 'test',
  key: Buffer.from('tbi-lab test identity key -- tests only, not a secret'),
});
export const TEST_TICKET_KEY = Buffer.from(
  'tbi-lab test run-ticket key -- tests only, not a secret',
);
export const TEST_SUBJECT = 'user-a';
export const principalFor = (subject = TEST_SUBJECT): Principal =>
  derivePrincipal(TEST_IDENTITY, subject);

/** A run ticket as the build service would issue it after a lease (default: 10 minutes). */
export function ticketFor(
  sha256: string,
  principal: Principal = principalFor(),
  features: TicketFeatures | null = null,
  ttlMs = 600_000,
): string {
  return signTicket(TEST_TICKET_KEY, {
    v: 1,
    principal,
    sha256,
    features,
    exp: Date.now() + ttlMs,
  });
}
