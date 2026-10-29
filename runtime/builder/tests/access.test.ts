/**
 * Sprint 23B: the build service applies the same access view as the Session Host (every request
 * but its health check), fails closed, and is unchanged without it.
 */
import { rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessView, deriveEmailTag } from '../../identity/access.js';
import {
  TEST_IDENTITY,
  TEST_TICKET_KEY,
  principalFor,
  startTestGate,
} from '../../identity/test-gate.js';
import { openAccessPolicy } from '../../policy/testing.js';
import { Grants } from '../grants.js';
import { createBuildHttpServer } from '../http.js';
import { BuildService, DEFAULT_LIMITS, revokeBuildsOnReload } from '../service.js';
import { ArtifactStore } from '../store.js';
import { FakeProvider, sketch, tempDir } from './support.js';

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function serve(withAccess: boolean) {
  const [storeDir, work, state, adm] = ['store', 'work', 'state', 'adm'].map((n) =>
    tempDir(`tbi-acc-${n}-`),
  ) as [string, string, string, string];
  dirs.push(storeDir, work, state, adm);
  const grants = new Grants(join(state, 'grants.db'));
  const store = new ArtifactStore({ dir: storeDir, capBytes: 1 << 26, graceMs: 0 });
  const service = new BuildService([new FakeProvider()], store, work, DEFAULT_LIMITS, {
    grants,
    ticketKey: TEST_TICKET_KEY,
    systemKeys: new Set(),
    ...openAccessPolicy(),
  });
  const file = join(adm, 'access.json');
  const access = withAccess ? new AccessView(file) : null;
  const server = createBuildHttpServer(service, {
    leaseMs: 60_000,
    identity: TEST_IDENTITY,
    access,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  const gate = async (sub: string | null, email: string | null = null) => {
    const g = await startTestGate(target, TEST_IDENTITY, sub, email);
    closers.push(g.close);
    return g.base;
  };
  const writeView = (principals: string[], emailTags: string[] = []) => {
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        generated: '2026-10-29T10:00:00Z',
        seq: 1,
        owner: {
          principal: principals[0] ?? null,
          emailTag: deriveEmailTag(TEST_IDENTITY, 'owner@example.invalid'),
        },
        authorized: { principals, emailTags },
        revoked: { principals: [], emailTags: [] },
      }),
    );
    access?.reload();
  };
  return { gate, writeView, service, access, file };
}

const lookup = async (base: string) =>
  (await fetch(`${base}/v1/lookup?key=${'0'.repeat(64)}`)).status;

describe('build service access view', () => {
  it('fails closed without a valid view; health stays open', async () => {
    const s = await serve(true);
    const a = await s.gate('user-a');
    expect((await fetch(`${a}/v1/health`)).status).toBe(200);
    const r = await fetch(`${a}/v1/lookup?key=${'0'.repeat(64)}`);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'access_view_unavailable' });
    expect(await lookup(await s.gate(null))).toBe(401);
  });

  it('authorized by principal or email tag; others 403 account_disabled; reload applies at once', async () => {
    const s = await serve(true);
    s.writeView(
      [principalFor('user-a')],
      [deriveEmailTag(TEST_IDENTITY, 'pending@example.invalid')],
    );
    expect(await lookup(await s.gate('user-a'))).toBe(404); // allowed: no such build
    expect(await lookup(await s.gate('user-p', 'pending@example.invalid'))).toBe(404);
    const b = await fetch(`${await s.gate('user-b')}/v1/lookup?key=${'0'.repeat(64)}`, {
      headers: { 'x-forwarded-email': 'pending@example.invalid', 'x-tbi-owner': '1' }, // forged
    });
    expect(b.status).toBe(403);
    expect(await b.json()).toEqual({ error: 'account_disabled' });
    s.writeView([]);
    expect(await lookup(await s.gate('user-a'))).toBe(403);
  });

  it('without TBI_ACCESS_VIEW any gate identity is served (RC4)', async () => {
    const s = await serve(false);
    expect(await lookup(await s.gate('user-z'))).toBe(404);
  });
});

describe('revocation stops build work (deny wins)', () => {
  it('queued and running builds of a disabled account fail account_disabled; other accounts go on', async () => {
    const s = await serve(true);
    const A = principalFor('user-a');
    const B = principalFor('user-b');
    const tagB = deriveEmailTag(TEST_IDENTITY, 'b@example.invalid');
    s.writeView([A, B], [tagB]);
    const lines: string[] = [];
    revokeBuildsOnReload(s.service, s.access!, (l) => void lines.push(l));
    const go = (text: string, who: typeof A, tag: string | null = null) => {
      const out = s.service.submit(sketch(text), who, tag);
      if ('cached' in out) throw new Error('unexpected cache hit');
      return out;
    };
    const status = (o: { buildId: string; token: string }, who: typeof A) =>
      s.service.status(o.buildId, o.token, who)!;
    const a1 = go('void setup() {} // #stall a1', A); // running (one worker)
    const a2 = go('void setup() {} // #stall a2', A); // queued
    const b1 = go('void setup() {} // #stall b1', B, tagB); // queued
    expect(status(a1, A).state).toBe('building');
    expect(status(b1, B).state).toBe('queued');

    // A's principal is revoked (deny wins), B untouched.
    writeFileSync(
      s.file,
      JSON.stringify({
        v: 1,
        generated: 'x',
        seq: 2,
        owner: {
          principal: null,
          emailTag: deriveEmailTag(TEST_IDENTITY, 'owner@example.invalid'),
        },
        authorized: { principals: [A, B], emailTags: [tagB] },
        revoked: { principals: [A], emailTags: [] },
      }),
    );
    s.access!.reload();
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    };
    await until(() => status(a1, A).state === 'failed' && status(b1, B).state === 'building');
    expect(status(a1, A).result?.failure).toBe('account_disabled');
    expect(status(a2, A).state).toBe('failed');
    expect(status(a2, A).result?.failure).toBe('account_disabled');
    expect(status(b1, B).state).toBe('building'); // B's build took the free worker
    expect(lines).toEqual([JSON.stringify({ event: 'builds_revoked', builds: 2 })]);
    expect(s.service.inFlight(A)).toBe(0);

    // B: principal still authorized, but the address it built with is revoked: stopped too.
    writeFileSync(
      s.file,
      JSON.stringify({
        v: 1,
        generated: 'x',
        seq: 3,
        owner: {
          principal: null,
          emailTag: deriveEmailTag(TEST_IDENTITY, 'owner@example.invalid'),
        },
        authorized: { principals: [B], emailTags: [] },
        revoked: { principals: [], emailTags: [tagB] },
      }),
    );
    s.access!.reload();
    await until(() => status(b1, B).state === 'failed');
    expect(status(b1, B).result?.failure).toBe('account_disabled');
    // A disabled account's failures do not count toward its build cool-down.
    s.service.close();
  });
});

describe('revocation after the compile (review N4)', () => {
  const setup = async () => {
    const s = await serve(true);
    const A = principalFor('user-a');
    s.writeView([A]);
    return { s, A };
  };

  it('landing during publish: no grant, the unheld artifact is dropped, the build fails account_disabled', async () => {
    const { s, A } = await setup();
    const store = s.service.store;
    const publish = store.publish.bind(store);
    let published: string | null = null;
    store.publish = async (...args: Parameters<typeof publish>) => {
      const artifact = await publish(...args);
      published = artifact.sha256;
      s.service.revokeUnauthorized(() => false); // the owner disables A right now
      return artifact;
    };
    const out = s.service.submit(sketch('void setup() {} // n4 publish'), A);
    if ('cached' in out) throw new Error('unexpected cache hit');
    await s.service.whenIdle();
    const st = s.service.status(out.buildId, out.token, A)!;
    expect(st.state).toBe('failed');
    expect(st.result?.failure).toBe('account_disabled');
    expect(published).not.toBeNull();
    expect(s.service.lookup(st.result!.key, A)).toBeNull(); // no cached build for A
    expect(s.service.lease(A, published!, 60_000)).toBeNull(); // no grant
    expect(store.manifest(published!)).toBeUndefined(); // nobody holds it: dropped
  });

  it('landing between the compile and publish: nothing is published', async () => {
    const { s, A } = await setup();
    const provider = (s.service as unknown as { providers: Map<string, FakeProvider> }).providers
      .values()
      .next().value!;
    const build = provider.build.bind(provider);
    provider.build = async (job) => {
      const out = await build(job);
      // Fires after the compile's own check, while the image is being read.
      setImmediate(() => s.service.revokeUnauthorized(() => false));
      return out;
    };
    const store = s.service.store;
    let publishes = 0;
    const publish = store.publish.bind(store);
    store.publish = async (...args: Parameters<typeof publish>) => {
      publishes++;
      return publish(...args);
    };
    const out = s.service.submit(sketch('void setup() {} // n4 read'), A);
    if ('cached' in out) throw new Error('unexpected cache hit');
    await s.service.whenIdle();
    const st = s.service.status(out.buildId, out.token, A)!;
    expect(st.result?.failure).toBe('account_disabled');
    expect(publishes).toBe(0);
  });
});
