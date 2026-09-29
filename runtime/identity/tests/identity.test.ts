/**
 * Sprint 8 Phase 1 — the identity boundary (D-S8-1): principal derivation, the gate's header
 * handling (the test gate mirrors the deployment's oauth2-proxy + internal proxy), backends
 * refusing requests without an identity, and unix-socket listening.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBuildHttpServer } from '../../builder/http.js';
import { BuildService, DEFAULT_LIMITS } from '../../builder/service.js';
import { ArtifactStore } from '../../builder/store.js';
import { Grants } from '../../builder/grants.js';
import { FakeProvider } from '../../builder/tests/support.js';
import { createHttpServer } from '../../host/http.js';
import { fakeHost } from '../../host/tests/support.js';
import { listen, parseListen } from '../listen.js';
import {
  derivePrincipal,
  identityConfig,
  isPrincipal,
  principalOf,
  type IdentityConfig,
} from '../principal.js';
import { gateHeaders, startTestGate, testIdentity } from '../test-gate.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const req = (headers: Record<string, string | string[]>) =>
  ({ headers }) as unknown as IncomingMessage;

describe('principal derivation', () => {
  const cfg = testIdentity('google');

  it('the same account always gives the same opaque principal; different accounts differ', () => {
    const a = derivePrincipal(cfg, '109876543210987654321');
    expect(derivePrincipal(cfg, '109876543210987654321')).toBe(a);
    expect(derivePrincipal(cfg, '109876543210987654322')).not.toBe(a);
    expect(isPrincipal(a)).toBe(true);
    expect(a).not.toContain('109876543210987654321'); // opaque: no provider identifier inside
  });

  it('is namespaced by the (provider-neutral) issuer label and depends on the key', () => {
    const other = identityConfig({ issuer: 'another-idp', key: cfg.key });
    expect(derivePrincipal(other, 'x')).not.toBe(derivePrincipal(cfg, 'x'));
    const rekeyed = identityConfig({ issuer: 'google', key: randomBytes(32) });
    expect(derivePrincipal(rekeyed, 'x')).not.toBe(derivePrincipal(cfg, 'x'));
  });

  it('only a single, well-formed subject header yields a principal', () => {
    expect(principalOf(req({}), cfg)).toBeNull(); // missing identity
    expect(principalOf(req({ 'x-forwarded-user': '' }), cfg)).toBeNull();
    expect(principalOf(req({ 'x-forwarded-user': ['a', 'b'] }), cfg)).toBeNull(); // repeated
    expect(principalOf(req({ 'x-forwarded-user': 'a b' }), cfg)).toBeNull();
    expect(principalOf(req({ 'x-forwarded-user': 'x'.repeat(257) }), cfg)).toBeNull();
    expect(principalOf(req({ 'x-forwarded-user': '12345' }), cfg)).toBe(
      derivePrincipal(cfg, '12345'),
    );
    // Other headers never count, whatever they claim.
    expect(principalOf(req({ 'x-tbi-principal': 'p_' + 'a'.repeat(26) }), cfg)).toBeNull();
  });

  it('refuses weak configuration', () => {
    expect(() => identityConfig({ issuer: 'google', key: Buffer.alloc(16) })).toThrow(/32 bytes/);
    expect(() => identityConfig({ issuer: 'Google IdP', key: randomBytes(32) })).toThrow(/issuer/);
    expect(() =>
      identityConfig({ issuer: 'google', key: randomBytes(32), subjectHeader: 'authorization' }),
    ).toThrow(/header/);
  });
});

describe('the gate strips client identity and asserts its own', () => {
  it('forged subject, email and X-TBI-* headers are removed; the gate subject is set', () => {
    const cfg = testIdentity();
    const out = gateHeaders(
      req({
        'x-forwarded-user': 'victim',
        'x-forwarded-email': 'victim@example.com',
        'x-tbi-principal': 'p_forged',
        'x-tbi-anything': '1',
        accept: 'application/json',
      }),
      cfg,
      'real-user',
    );
    expect(out).toEqual({ accept: 'application/json', 'x-forwarded-user': 'real-user' });
    // Not signed in: nothing asserted at all, even though the client sent a subject.
    expect(gateHeaders(req({ 'x-forwarded-user': 'victim' }), cfg, null)).toEqual({});
  });
});

async function serveBuild(identity: IdentityConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'tbi-id-store-'));
  const work = mkdtempSync(join(tmpdir(), 'tbi-id-work-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => rmSync(work, { recursive: true, force: true }));
  const service = new BuildService(
    [new FakeProvider()],
    new ArtifactStore({ dir, capBytes: 64 << 20, graceMs: 0 }),
    work,
    DEFAULT_LIMITS,
    { grants: new Grants(':memory:'), ticketKey: randomBytes(32), systemKeys: new Set() },
  );
  const server = createBuildHttpServer(service, {
    leaseMs: 60_000,
    identity,
    allowPrebuiltBinary: () => true,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => void server.close());
  return { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
}

async function serveHost(identity: IdentityConfig) {
  const { host } = fakeHost('normal');
  const server = createHttpServer(host, identity);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(async () => {
    server.closeAllConnections();
    server.close();
    await host.shutdown();
  });
  return { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
}

describe('backends answer nothing without a gate-asserted identity', () => {
  it('build service: 401 identity_required on every route but health', async () => {
    const identity = testIdentity();
    const target = await serveBuild(identity);
    const anon = await startTestGate(target, identity, null);
    cleanup.push(anon.close);
    expect((await fetch(`${anon.base}/v1/health`)).status).toBe(200);
    for (const [method, path] of [
      ['POST', '/v1/builds'],
      ['GET', `/v1/lookup?key=${'0'.repeat(64)}`],
      ['POST', '/v1/artifacts'],
      ['POST', `/v1/artifacts/${'0'.repeat(64)}/lease`],
      ['GET', '/v1/nowhere'],
    ] as const) {
      const r = await fetch(`${anon.base}${path}`, { method });
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(await r.json()).toEqual({ error: 'identity_required' });
    }
    // A client-sent subject does not help when the gate asserts none.
    const forged = await fetch(`${anon.base}/v1/lookup?key=${'0'.repeat(64)}`, {
      headers: { 'x-forwarded-user': 'victim' },
    });
    expect(forged.status).toBe(401);
    // Signed in: the same request reaches the service (here: nothing found).
    const user = await startTestGate(target, identity, 'user-a');
    cleanup.push(user.close);
    expect((await fetch(`${user.base}/v1/lookup?key=${'0'.repeat(64)}`)).status).toBe(404);
  });

  it('Session Host: 401 on every session route, health stays open', async () => {
    const identity = testIdentity();
    const target = await serveHost(identity);
    const anon = await startTestGate(target, identity, null);
    cleanup.push(anon.close);
    expect((await fetch(`${anon.base}/health`)).status).toBe(200);
    for (const [method, path] of [
      ['POST', '/sessions'],
      ['GET', `/sessions/${'0'.repeat(32)}`],
      ['GET', `/sessions/${'0'.repeat(32)}/events`],
      ['DELETE', `/sessions/${'0'.repeat(32)}`],
    ] as const)
      expect((await fetch(`${anon.base}${path}`, { method })).status, `${method} ${path}`).toBe(
        401,
      );
  });
});

describe('listening', () => {
  it('parses unix and TCP listen addresses', () => {
    expect(parseListen('unix:/run/tbi-build/api.sock')).toEqual({
      unix: '/run/tbi-build/api.sock',
    });
    expect(parseListen('127.0.0.1:7420')).toEqual({ host: '127.0.0.1', port: 7420 });
    expect(() => parseListen('unix:relative.sock')).toThrow(/absolute/);
    expect(() => parseListen('0.0.0.0')).toThrow(/bad listen/);
  });

  it('a unix socket is created 0660, replaces a stale socket, never another file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tbi-id-sock-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'api.sock');
    const open = async () => {
      const s: Server = createServer((_q, r) => r.end('ok'));
      await listen(s, { unix: path });
      return s;
    };
    const first = await open();
    expect(statSync(path).mode & 0o777).toBe(0o660);
    first.close(); // the socket file stays (as after a crash)
    const second = await open();
    const body = await new Promise<string>((resolve) => {
      const r = require_request(path, resolve);
      r.end();
    });
    expect(body).toBe('ok');
    second.close();
    rmSync(path, { force: true });
    writeFileSync(path, 'not a socket');
    await expect(open()).rejects.toThrow();
  });
});

import { request as httpRequest } from 'node:http';
function require_request(socketPath: string, done: (body: string) => void) {
  return httpRequest({ socketPath, path: '/' }, (res) => {
    let b = '';
    res.on('data', (c: Buffer) => (b += c.toString()));
    res.on('end', () => done(b));
  });
}
