/**
 * Sprint 8 Phase 2 — ownership and authorization in the build service (D-S8-2/3/4), adversarial:
 * two users, A and B, behind the same service.
 */
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { sourceKey } from '@tbi-lab/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { derivePrincipal } from '../../identity/principal.js';
import {
  TEST_IDENTITY,
  TEST_TICKET_KEY,
  principalFor,
  startTestGate,
} from '../../identity/test-gate.js';
import { verifyTicket } from '../../identity/ticket.js';
import { Grants } from '../grants.js';
import { createBuildHttpServer, PREBUILT_IMAGE_BYTES } from '../http.js';
import { BuildService, DEFAULT_LIMITS } from '../service.js';
import { ArtifactStore } from '../store.js';
import { FakeProvider, fakeImage, sketch, tempDir } from './support.js';

const A = principalFor('user-a');
const B = principalFor('user-b');
const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SYSTEM_TEXT = 'void setup() {}\nvoid loop() {} // curated example\n';
const SYSTEM_KEY = sourceKey(sketch(SYSTEM_TEXT).profile, sketch(SYSTEM_TEXT).files);

function world(opts: { capBytes?: number; reference?: Buffer } = {}) {
  const storeDir = tempDir('tbi-own-store-');
  const work = tempDir('tbi-own-work-');
  const state = tempDir('tbi-own-state-');
  dirs.push(storeDir, work, state);
  let refSha: string | undefined;
  if (opts.reference) {
    refSha = createHash('sha256').update(opts.reference).digest('hex');
    writeFileSync(join(storeDir, `${refSha}.bin`), opts.reference); // provisioned R1 image
  }
  const provider = new FakeProvider();
  const grants = new Grants(join(state, 'grants.db'));
  const store = new ArtifactStore({
    dir: storeDir,
    capBytes: opts.capBytes ?? 256 << 20,
    graceMs: 0,
    onEvicted: (sha) => grants.dropArtifact(sha),
  });
  const service = new BuildService([provider], store, work, DEFAULT_LIMITS, {
    grants,
    ticketKey: TEST_TICKET_KEY,
    systemKeys: new Set([SYSTEM_KEY]),
  });
  return { service, provider, store, grants, refSha };
}

async function build(service: BuildService, text: string, who = A) {
  const out = service.submit(sketch(text), who);
  if ('cached' in out) return { result: out.cached, cached: true };
  await service.whenIdle();
  return { result: service.status(out.buildId, out.token, who)!.result!, cached: false };
}

describe('artifacts and build records belong to their principal', () => {
  it('B can neither look up, see, lease nor run A’s build by knowing its source key or sha', async () => {
    const { service } = world();
    const { result: a } = await build(service, 'void setup() {} // A private');
    const sha = a.artifact!.sha256;
    expect(service.lookup(a.key, B)).toBeNull(); // no cache view
    expect(service.lease(B, sha, 60_000)).toBeNull(); // knowing the sha is not enough
    expect(service.lease(A, sha, 60_000)).not.toBeNull();
  });

  it('build status is visible to its owner only (a stolen token does not help)', async () => {
    const { service } = world();
    const out = service.submit(sketch('void setup() {} // A status'), A);
    if ('cached' in out) throw new Error('unexpected hit');
    await service.whenIdle();
    expect(service.status(out.buildId, out.token, B)).toBeNull();
    expect(service.status(out.buildId, out.token, A)?.state).toBe('succeeded');
  });

  it('identical private sources: B compiles again (no visible cache hit); the blob is stored once', async () => {
    const { service, provider, store } = world();
    const text = 'void setup() {} // same text, two users';
    const a = await build(service, text, A);
    const b = await build(service, text, B);
    expect(b.cached).toBe(false); // nothing about A leaks to B
    expect(provider.builds).toBe(2);
    expect(b.result.artifact).toEqual(a.result.artifact); // same identity, one blob
    expect(store.exists(a.result.artifact!.sha256)).toBe(true);
    // Each now has their own grant and record.
    expect(service.lookup(a.result.key, A)).not.toBeNull();
    expect(service.lookup(a.result.key, B)).not.toBeNull();
    const again = await build(service, text, B);
    expect(again.cached).toBe(true);
  });

  it('a pending build is shared only with its own owner', async () => {
    const { service } = world();
    const a = service.submit(sketch('#stall shared?'), A);
    const b = service.submit(sketch('#stall shared?'), B);
    expect(a).not.toEqual(b);
    const a2 = service.submit(sketch('#stall shared?'), A);
    expect(a2).toEqual(a);
  });

  it('curated system sources are shared records: built once, a cache hit for everyone', async () => {
    const { service, provider } = world();
    const a = await build(service, SYSTEM_TEXT, A);
    const b = await build(service, SYSTEM_TEXT, B);
    expect(b.cached).toBe(true);
    expect(provider.builds).toBe(1);
    expect(service.lease(B, a.result.artifact!.sha256, 60_000)).not.toBeNull();
  });

  it('R1 reference images stay global: anyone may lease them; their tickets declare nothing', () => {
    const ref = fakeImage('r1-reference');
    const { service, refSha } = world({ reference: ref });
    for (const who of [A, B]) {
      const lease = service.lease(who, refSha!, 60_000);
      expect(lease).not.toBeNull();
      expect(verifyTicket(TEST_TICKET_KEY, lease!.ticket)).toMatchObject({
        principal: who,
        sha256: refSha,
        features: null,
      });
    }
  });

  it('an Advanced prebuilt image is its uploader’s only, like any other firmware', async () => {
    const { service } = world();
    const img = fakeImage('prebuilt');
    const art = await service.publishPrebuilt(A, img);
    expect(service.lease(B, art.sha256, 60_000)).toBeNull();
    const lease = service.lease(A, art.sha256, 60_000);
    expect(verifyTicket(TEST_TICKET_KEY, lease!.ticket)).toMatchObject({
      principal: A,
      sha256: art.sha256,
      features: null, // never analysed
    });
    // B uploading the same bytes gets B's own grant (the blob stays one).
    await service.publishPrebuilt(B, img);
    expect(service.lease(B, art.sha256, 60_000)).not.toBeNull();
  });

  it('the run ticket binds principal, artifact, server-side features and expiry', async () => {
    const { service } = world();
    const { result } = await build(service, 'void setup() {} // ticket');
    const before = Date.now();
    const lease = service.lease(A, result.artifact!.sha256, 60_000)!;
    const t = verifyTicket(TEST_TICKET_KEY, lease.ticket)!;
    expect(t).toMatchObject({ v: 1, principal: A, sha256: result.artifact!.sha256 });
    expect(t.features).toEqual(result.features);
    expect(t.exp).toBeGreaterThanOrEqual(before + 60_000);
    // Tampering with any part is detected; an expired ticket is refused.
    const [payload, sig] = lease.ticket.split('.');
    const forged = Buffer.from(JSON.stringify({ ...t, principal: B })).toString('base64url');
    expect(verifyTicket(TEST_TICKET_KEY, `${forged}.${sig}`)).toBeNull();
    expect(verifyTicket(TEST_TICKET_KEY, `${payload}.${sig}x`)).toBeNull();
    expect(verifyTicket(Buffer.alloc(32, 7), lease.ticket)).toBeNull();
    expect(verifyTicket(TEST_TICKET_KEY, lease.ticket, t.exp + 1)).toBeNull();
  });

  it('eviction drops every grant on the blob: the owner sees Build required, nobody keeps access', async () => {
    const { service } = world({ capBytes: PREBUILT_IMAGE_BYTES });
    const { result: a } = await build(service, 'void setup() {} // first');
    await build(service, 'void setup() {} // second (evicts the first)');
    expect(service.lookup(a.key, A)).toBeNull();
    expect(service.lease(A, a.artifact!.sha256, 60_000)).toBeNull();
  });
});

describe('over HTTP: not yours and not present are the same answer', () => {
  it('lease, lookup, status and prebuilt upload for users A and B through their gates', async () => {
    const { service } = world({ reference: fakeImage('r1') });
    let prebuiltAllowed = true;
    const server = createBuildHttpServer(service, {
      leaseMs: 60_000,
      identity: TEST_IDENTITY,
      allowPrebuiltBinary: () => prebuiltAllowed,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => server.close());
    const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
    const ga = await startTestGate(target, TEST_IDENTITY, 'user-a');
    const gb = await startTestGate(target, TEST_IDENTITY, 'user-b');
    closers.push(ga.close, gb.close);
    expect(derivePrincipal(TEST_IDENTITY, 'user-a')).toBe(A);

    const submit = await fetch(`${ga.base}/v1/builds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sketch('void setup() {} // over http')),
    });
    const { buildId, token } = (await submit.json()) as { buildId: string; token: string };
    await service.whenIdle();
    const mine = (await (
      await fetch(`${ga.base}/v1/builds/${buildId}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { result: { key: string; artifact: { sha256: string } } };
    const sha = mine.result.artifact.sha256;

    const answer = async (r: Response) => ({ status: r.status, body: await r.text() });
    const unknown = await answer(
      await fetch(`${gb.base}/v1/artifacts/${'e'.repeat(64)}/lease`, { method: 'POST' }),
    );
    const notMine = await answer(
      await fetch(`${gb.base}/v1/artifacts/${sha}/lease`, { method: 'POST' }),
    );
    expect(notMine).toEqual(unknown); // indistinguishable
    expect(notMine.status).toBe(404);
    expect(await answer(await fetch(`${gb.base}/v1/lookup?key=${mine.result.key}`))).toEqual(
      await answer(await fetch(`${gb.base}/v1/lookup?key=${'f'.repeat(64)}`)),
    );
    expect(
      (
        await fetch(`${gb.base}/v1/builds/${buildId}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
    const own = await fetch(`${ga.base}/v1/artifacts/${sha}/lease`, { method: 'POST' });
    expect(own.status).toBe(200);
    expect(
      verifyTicket(TEST_TICKET_KEY, ((await own.json()) as { ticket: string }).ticket),
    ).toMatchObject({
      principal: A,
      sha256: sha,
    });

    // Advanced prebuilt follows the same rules, and the capability can switch it off.
    const img = fakeImage('advanced');
    const up = await fetch(`${ga.base}/v1/artifacts`, { method: 'POST', body: img });
    const { artifact } = (await up.json()) as { artifact: { sha256: string } };
    expect(
      (await fetch(`${gb.base}/v1/artifacts/${artifact.sha256}/lease`, { method: 'POST' })).status,
    ).toBe(404);
    prebuiltAllowed = false;
    const refused = await fetch(`${ga.base}/v1/artifacts`, { method: 'POST', body: img });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'capability_disabled' });
  });
});
