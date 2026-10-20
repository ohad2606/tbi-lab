/**
 * Build service (Sprint 7) against a fake provider: queueing and limits, cache hits, cleanup,
 * the artifact store (server-side hashing, atomic write-once, LRU with leases), and the HTTP
 * contract. No toolchain; the real Arduino build is the heavy suite.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openAccessPolicy } from '../../policy/testing.js';
import { sourceKey } from '@tbi-lab/domain';
import { createBuildHttpServer, PREBUILT_IMAGE_BYTES } from '../http.js';
import { validateBuildRequest } from '../protocol.js';
import { BuildService, DEFAULT_LIMITS, type ServiceLimits } from '../service.js';
import { FEATURES_ANALYZER } from '../features.js';
import { ArtifactStore } from '../store.js';
import {
  TEST_TICKET_KEY,
  principalFor,
  startTestGate,
  testIdentity,
} from '../../identity/test-gate.js';
import { Grants } from '../grants.js';
import { FakeProvider, fakeImage, sketch, tempDir } from './support.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The principal a test gate asserts for `user-a` (cross-user cases: ownership.test.ts). */
const A = principalFor('user-a');

function setup(
  limits: Partial<ServiceLimits> = {},
  store: Partial<{ capBytes: number; graceMs: number }> = {},
  systemKeys: ReadonlySet<string> = new Set(),
) {
  const storeDir = tempDir('tbi-store-');
  const work = tempDir('tbi-work-');
  const state = tempDir('tbi-state-');
  cleanup.push(storeDir, work, state);
  const provider = new FakeProvider();
  const grants = new Grants(join(state, 'grants.db'));
  const artifacts = new ArtifactStore({
    dir: storeDir,
    capBytes: store.capBytes ?? 256 * 1024 * 1024,
    graceMs: store.graceMs ?? 0,
    onEvicted: (sha) => grants.dropArtifact(sha),
  });
  const service = new BuildService(
    [provider],
    artifacts,
    work,
    { ...DEFAULT_LIMITS, ...limits },
    { grants, ticketKey: TEST_TICKET_KEY, systemKeys, ...openAccessPolicy() },
  );
  return { service, provider, artifacts, grants, storeDir, work, state };
}

async function finish(
  service: BuildService,
  out: ReturnType<BuildService['submit']>,
  principal = A,
) {
  if ('cached' in out) return out.cached;
  await service.whenIdle();
  return service.status(out.buildId, out.token, principal)!.result!;
}

describe('request validation', () => {
  it('refuses unknown fields, bad names, NUL bytes and wrong protocol', () => {
    expect(() => validateBuildRequest({ ...sketch('x'), extra: 1 })).toThrow('unknown_field');
    expect(() => validateBuildRequest({ ...sketch('x'), protocol: 'x' })).toThrow(
      'unsupported_protocol',
    );
    expect(() =>
      validateBuildRequest({ ...sketch('x'), files: [{ name: '../etc/passwd', text: '' }] }),
    ).toThrow('bad_file_name');
    expect(() =>
      validateBuildRequest({ ...sketch('x'), files: [{ name: 'a.ino', text: 'a\u0000' }] }),
    ).toThrow('bad_file_text');
    expect(validateBuildRequest(sketch('void setup(){}'))).toEqual(sketch('void setup(){}'));
  });
});

describe('BuildService', () => {
  it('an over-size source is refused before it is held in a build record (security audit #4)', () => {
    const { service, provider } = setup();
    const max = provider.profile.maxSourceBytes;
    expect(() => service.submit(sketch('x'.repeat(max + 1)), A)).toThrow('source_too_large');
    expect((service as unknown as { records: Map<string, unknown> }).records.size).toBe(0);
    // Exactly at the limit is still accepted.
    expect('buildId' in service.submit(sketch('x'.repeat(max)), A)).toBe(true);
  });

  it('builds, publishes a server-hashed artifact, cleans its job directory, then serves cache hits', async () => {
    const { service, provider, storeDir, work } = setup();
    const req = sketch('void setup() {}\nvoid loop() {}\n');
    const first = await finish(service, service.submit(req, A));
    expect(first.ok).toBe(true);
    expect(first.key).toBe(sourceKey(req.profile, req.files));
    const sha = createHash('sha256').update(fakeImage(req.files[0]!.text)).digest('hex');
    expect(first.artifact).toEqual({ sha256: sha, bytes: 4 * 1024 * 1024, origin: 'build' });
    expect(statSync(join(storeDir, `${sha}.bin`)).mode & 0o777).toBe(0o444);
    expect(readdirSync(work)).toEqual([]); // job directory removed
    // Same input: no compilation, same result, immediately.
    const again = service.submit(req, A);
    expect('cached' in again).toBe(true);
    expect(provider.builds).toBe(1);
    expect(service.lookup(first.key, A)?.artifact?.sha256).toBe(sha);
    expect(service.lookup('0'.repeat(64), A)).toBeNull();
  });

  it('Sprint 18: a build analysed by an older feature analyzer is built again, not reused', async () => {
    const { service, provider, grants } = setup();
    const req = sketch('void setup() {}\nvoid loop() {}\n');
    const first = await finish(service, service.submit(req, A));
    expect('cached' in service.submit(req, A)).toBe(true);
    // The record as a pre-Sprint-18 service stored it: no analyzer version.
    const stored = grants.findBuild(A, first.key)!;
    const { analyzer, ...old } = stored;
    expect(analyzer).toBe(FEATURES_ANALYZER);
    grants.recordBuild(A, old);
    expect(service.lookup(first.key, A)).toBeNull();
    const again = await finish(service, service.submit(req, A));
    expect(provider.builds).toBe(2);
    expect(again.artifact?.sha256).toBe(first.artifact?.sha256);
    // Rebuilt: the record is current again, and is reused.
    expect('cached' in service.submit(req, A)).toBe(true);
    expect(provider.builds).toBe(2);
  });

  it('one compilation at a time, three queued, then busy; identical pending input is shared', async () => {
    const { service, provider } = setup({ timeoutMs: 1500 });
    const a = service.submit(sketch('#stall a'), A);
    const b = service.submit(sketch('b'), A);
    const c = service.submit(sketch('c'), A);
    const d = service.submit(sketch('d'), A);
    expect(() => service.submit(sketch('e'), A)).toThrow('busy');
    const same = service.submit(sketch('c'), A);
    expect(same).toEqual(c);
    if ('cached' in a || 'cached' in b) throw new Error('unexpected cache hit');
    expect(service.status(a.buildId, a.token, A)?.state).toBe('building');
    expect(service.status(b.buildId, b.token, A)?.position).toBe(0);
    expect(service.status(b.buildId, 'wrong-token-wrong-token', A)).toBeNull();
    await expect.poll(() => provider.builds).toBe(1);
    void d;
    await service.whenIdle(); // the stalled build times out; the queue drains
    expect(provider.builds).toBe(4);
  });

  it('a build over the hard timeout is stopped and reported; the job directory is removed', async () => {
    const { service, work } = setup({ timeoutMs: 300 });
    const r = await finish(service, service.submit(sketch('#stall'), A));
    expect(r).toMatchObject({ ok: false, failure: 'timeout' });
    expect(readdirSync(work)).toEqual([]);
  });

  it('a build over the temporary-storage limit is stopped', async () => {
    const { service, work } = setup({ maxTempBytes: 1024 * 1024, watchdogMs: 50 });
    const r = await finish(service, service.submit(sketch('#fill'), A));
    expect(r).toMatchObject({ ok: false, failure: 'storage_limit' });
    expect(readdirSync(work)).toEqual([]);
  });

  it('after eviction the same source compiles afresh into the same artifact identity', async () => {
    // A store of one image: publishing another build evicts the first (the real LRU).
    const { service, provider, artifacts, storeDir } = setup({}, { capBytes: 4 * 1024 * 1024 });
    const req = sketch('void setup() {}\nvoid loop() { /* a */ }\n');
    const first = await finish(service, service.submit(req, A));
    const sha = first.artifact!.sha256;
    await finish(service, service.submit(sketch('void setup() {}\nvoid loop() { /* b */ }\n'), A));
    expect(artifacts.exists(sha)).toBe(false);
    expect(existsSync(join(storeDir, `${sha}.bin`))).toBe(false);
    expect(service.lookup(first.key, A)).toBeNull();
    expect(provider.builds).toBe(2);
    // Eviction changed availability only: the same source is not a cache hit, compiles again,
    // and the server-computed identity is the same.
    const again = service.submit(req, A);
    expect('cached' in again).toBe(false);
    const rebuilt = await finish(service, again);
    expect(provider.builds).toBe(3);
    expect(rebuilt.key).toBe(first.key);
    expect(rebuilt.artifact).toEqual(first.artifact);
    expect(artifacts.exists(sha)).toBe(true);
    expect(service.lookup(first.key, A)?.artifact?.sha256).toBe(sha);
  });

  it('compile errors keep their diagnostics and are not cached', async () => {
    const { service, provider } = setup();
    const r = await finish(service, service.submit(sketch('#error'), A));
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]).toMatchObject({ file: 'sketch.ino', line: 2, column: 3 });
    await finish(service, service.submit(sketch('#error'), A));
    expect(provider.builds).toBe(2);
  });

  it('sweeps job directories left by a previous process', async () => {
    const { service, work } = setup();
    const stale = join(work, 'job-stale');
    mkdirSync(stale);
    writeFileSync(join(stale, 'left-over'), '');
    await service.sweep();
    expect(existsSync(stale)).toBe(false);
  });
});

describe('several sources, one artifact', () => {
  it('each source keeps its own build record: cache hits and lookups answer for the source asked, also after a restart', async () => {
    const { service, provider, storeDir, state } = setup();
    const a = await finish(service, service.submit(sketch('#same // version a'), A));
    const b = await finish(service, service.submit(sketch('#same // version b'), A));
    expect(a.artifact!.sha256).toBe(b.artifact!.sha256); // identical bytes, stored once
    expect(a.key).not.toBe(b.key);
    expect(service.lookup(a.key, A)?.key).toBe(a.key);
    expect(service.lookup(b.key, A)?.key).toBe(b.key);
    const hit = service.submit(sketch('#same // version a'), A);
    expect('cached' in hit && hit.cached.key).toBe(a.key);
    expect(provider.builds).toBe(2);
    // A new process reads every source's record back (grants are persistent).
    const again = new Grants(join(state, 'grants.db'));
    expect(again.findBuild(A, a.key)?.key).toBe(a.key);
    expect(again.findBuild(A, b.key)?.key).toBe(b.key);
    again.close();
    void storeDir;
  });

  it('Sprint 7 manifests (build records inside) load as blobs only: users build again', async () => {
    const dir = tempDir('tbi-store-');
    cleanup.push(dir);
    const img = fakeImage('legacy');
    const sha = createHash('sha256').update(img).digest('hex');
    writeFileSync(join(dir, `${sha}.bin`), img);
    const record = { key: 'k1', ok: true, diagnostics: [] };
    writeFileSync(
      join(dir, `${sha}.json`),
      JSON.stringify({
        sha256: sha,
        bytes: img.length,
        origin: 'build',
        key: 'k1',
        result: record,
        createdAt: 'x',
      }),
    );
    const store = new ArtifactStore({ dir, capBytes: 64 * 1024 * 1024, graceMs: 0 });
    await store.load();
    // The blob is managed (evictable) and intact; the old record grants nobody anything.
    expect(store.manifest(sha)).toMatchObject({ sha256: sha, origin: 'build' });
    expect(store.exists(sha)).toBe(true);
    expect(store.isReference(sha)).toBe(false);
    void record;
  });
});

describe('ArtifactStore', () => {
  it('LRU evicts managed artifacts above the cap, never leased ones, never provisioned references', async () => {
    let now = 1_000_000;
    const dir = tempDir('tbi-store-');
    cleanup.push(dir);
    // A provisioned reference image (no manifest) present before the store starts.
    const ref = fakeImage('reference');
    const refSha = createHash('sha256').update(ref).digest('hex');
    writeFileSync(join(dir, `${refSha}.bin`), ref);
    const store = new ArtifactStore({
      dir,
      capBytes: 2 * 4 * 1024 * 1024,
      graceMs: 1000,
      now: () => now,
    });
    await store.load();
    const a = await store.publish(fakeImage('a'), 'build');
    now += 10_000;
    const b = await store.publish(fakeImage('b'), 'build');
    store.lease(a.sha256, 60_000); // a is about to be used by a session
    now += 10_000;
    const c = await store.publish(fakeImage('c'), 'build');
    now += 10_000;
    await store.evict();
    expect(store.exists(a.sha256)).toBe(true); // leased
    expect(store.exists(b.sha256)).toBe(false); // least recently used, not leased
    expect(store.exists(c.sha256)).toBe(true);
    expect(store.exists(refSha)).toBe(true); // provisioned reference: never managed
    // Once the lease ends, a can go too (still above the cap only if more are added).
    now += 120_000;
    await store.publish(fakeImage('d'), 'build');
    now += 10_000;
    await store.evict();
    expect(store.managedBytes()).toBeLessThanOrEqual(2 * 4 * 1024 * 1024);
  });

  it('publishing is write-once and the identity is always computed by the store', async () => {
    const dir = tempDir('tbi-store-');
    cleanup.push(dir);
    const store = new ArtifactStore({ dir, capBytes: 64 * 1024 * 1024, graceMs: 0 });
    const img = fakeImage('same');
    const one = await store.publish(img, 'prebuilt');
    const two = await store.publish(img, 'prebuilt');
    expect(one.sha256).toBe(createHash('sha256').update(img).digest('hex'));
    expect(two).toEqual(one);
    expect(readdirSync(dir).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });
});

describe('HTTP contract', () => {
  const servers: import('node:http').Server[] = [];
  const gates: (() => void)[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    for (const close of gates.splice(0)) close();
  });

  /** The service behind a test gate that asserts `subject` (the deployment's oauth2-proxy role). */
  async function serve(subject: string | null = 'user-a') {
    const ctx = setup();
    const identity = testIdentity();
    const server = createBuildHttpServer(ctx.service, {
      leaseMs: 60_000,
      identity,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
    const gate = await startTestGate(target, identity, subject);
    gates.push(gate.close);
    return { ...ctx, identity, target, base: `${gate.base}/v1` };
  }

  it('submit → poll with the token → lookup by key; wrong token is 404', async () => {
    const { base, service } = await serve();
    const post = await fetch(`${base}/builds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sketch('void loop() {}')),
    });
    expect(post.status).toBe(202);
    const { buildId, token } = (await post.json()) as { buildId: string; token: string };
    await service.whenIdle();
    const bad = await fetch(`${base}/builds/${buildId}`, {
      headers: { authorization: 'Bearer ' + 'x'.repeat(32) },
    });
    expect(bad.status).toBe(404);
    const st = (await (
      await fetch(`${base}/builds/${buildId}`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { state: string; result: { key: string; artifact: { sha256: string } } };
    expect(st.state).toBe('succeeded');
    const look = await fetch(`${base}/lookup?key=${st.result.key}`);
    expect(look.status).toBe(200);
    expect(
      ((await look.json()) as { build: { artifact: { sha256: string } } }).build.artifact.sha256,
    ).toBe(st.result.artifact.sha256);
    expect((await fetch(`${base}/lookup?key=${'0'.repeat(64)}`)).status).toBe(404);
    // Lease an existing artifact; unknown ones are 404.
    expect(
      (await fetch(`${base}/artifacts/${st.result.artifact.sha256}/lease`, { method: 'POST' }))
        .status,
    ).toBe(200);
    expect(
      (await fetch(`${base}/artifacts/${'1'.repeat(64)}/lease`, { method: 'POST' })).status,
    ).toBe(404);
  });

  it('Advanced prebuilt image: the server computes the hash; only a merged 4 MiB image is accepted', async () => {
    const { base, storeDir } = await serve();
    const img = fakeImage('user image');
    const ok = await fetch(`${base}/artifacts`, { method: 'POST', body: img });
    expect(ok.status).toBe(200);
    const { artifact } = (await ok.json()) as { artifact: { sha256: string; origin: string } };
    expect(artifact.sha256).toBe(createHash('sha256').update(img).digest('hex'));
    expect(artifact.origin).toBe('prebuilt');
    expect(existsSync(join(storeDir, `${artifact.sha256}.bin`))).toBe(true);
    const wrongSize = await fetch(`${base}/artifacts`, {
      method: 'POST',
      body: Buffer.alloc(1000),
    });
    expect(wrongSize.status).toBe(422);
    const noMagic = Buffer.alloc(PREBUILT_IMAGE_BYTES);
    expect((await fetch(`${base}/artifacts`, { method: 'POST', body: noMagic })).status).toBe(422);
    const tooBig = await fetch(`${base}/artifacts`, {
      method: 'POST',
      body: Buffer.alloc(PREBUILT_IMAGE_BYTES + 1),
    });
    expect(tooBig.status).toBe(413);
  });

  it('refuses non-JSON builds and unknown profiles', async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/builds`, { method: 'POST', body: 'x' })).status).toBe(415);
    const unknown = await fetch(`${base}/builds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...sketch('x'), profile: 'esp32-micropython-1.29' }),
    });
    expect(unknown.status).toBe(400);
  });
});

describe('grants schema upgrades', () => {
  it('a Phase 2 database (no sizes) is upgraded in place and its sizes backfilled', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = tempDir('tbi-grants-up-');
    cleanup.push(dir);
    const file = join(dir, 'grants.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE artifact_grant (owner TEXT NOT NULL, sha256 TEXT NOT NULL,
      origin TEXT NOT NULL, source_key TEXT NOT NULL DEFAULT '', record TEXT,
      created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
      PRIMARY KEY (owner, sha256, source_key))`);
    old
      .prepare(`INSERT INTO artifact_grant VALUES (?, ?, 'prebuilt', '', NULL, 1, 1)`)
      .run(principalFor('user-a'), 'a'.repeat(64));
    old.close();
    const grants = new Grants(file);
    expect(grants.usage(principalFor('user-a'))).toEqual({ artifacts: 1, bytes: 0 });
    expect(grants.backfillBytes(() => 4 * 1024 * 1024)).toBe(1);
    expect(grants.usage(principalFor('user-a'))).toEqual({ artifacts: 1, bytes: 4 * 1024 * 1024 });
    grants.close();
    // Reopening is a no-op upgrade.
    const again = new Grants(file);
    expect(again.usage(principalFor('user-a')).bytes).toBe(4 * 1024 * 1024);
    again.close();
  });
});
