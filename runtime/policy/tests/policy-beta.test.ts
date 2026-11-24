/**
 * FW-FREE (BACKLOG row 15): the public-beta policy file (deploy/dev-lab/s8/policy.beta.json).
 * Its `free` plan is the default and is the `preview` plan with ONE difference: Advanced prebuilt
 * binaries are off. Checked here: the file itself (fail closed), plan resolution, the refusal on
 * the upload route (HTTP and direct service call, before the body is read, nothing stored, no
 * upload-rate token taken, nothing logged beyond the admission event) and the lease of a prebuilt
 * image uploaded earlier under `preview` by a principal that is now `free`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Grants } from '../../builder/grants.js';
import { PREBUILT_IMAGE_BYTES, createBuildHttpServer } from '../../builder/http.js';
import { BuildService, DEFAULT_LIMITS } from '../../builder/service.js';
import { ArtifactStore } from '../../builder/store.js';
import { FakeProvider, fakeImage, sketch, tempDir } from '../../builder/tests/support.js';
import {
  TEST_IDENTITY,
  TEST_TICKET_KEY,
  principalFor,
  startTestGate,
} from '../../identity/test-gate.js';
import { Policy, validatePolicy, type PolicyConfig } from '../policy.js';
import { RateLimiter } from '../rate.js';
import type { ResourceProbe } from '../resources.js';

const S8 = new URL('../../../deploy/dev-lab/s8/', import.meta.url);
const readPolicy = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(name, S8), 'utf8')) as unknown;

// Synthetic principals of the test identity (never real account ids).
const FREE_USER = 'beta-free-user';
const PREVIEW_USER = 'beta-preview-user';
const OTHER_USER = 'beta-other-user';
const FREE = principalFor(FREE_USER);
const PREVIEW = principalFor(PREVIEW_USER);
const OTHER = principalFor(OTHER_USER);

const dirs: string[] = [];
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const plenty: ResourceProbe = { freeDiskMb: () => 1e9, availableMemoryMb: () => 1e9 };

/** policy.beta.json as shipped, with optional synthetic assignments. */
function beta(assignments: Record<string, string> = {}): PolicyConfig {
  const c = validatePolicy(readPolicy('policy.beta.json'));
  return { ...c, assignments };
}

/** Shared on-disk state (store, grants, rates) that several services can be opened over. */
function state() {
  const storeDir = tempDir('tbi-beta-store-');
  const stateDir = tempDir('tbi-beta-state-');
  dirs.push(storeDir, stateDir);
  const grants = new Grants(join(stateDir, 'grants.db'));
  const store = new ArtifactStore({
    dir: storeDir,
    capBytes: 64 * 4 * 1024 * 1024,
    graceMs: 0,
    onEvicted: (sha) => grants.dropArtifact(sha),
  });
  const ratesPath = join(stateDir, 'rates.db');
  closers.push(() => grants.close());
  return { storeDir, store, grants, ratesPath };
}

function serviceOver(s: ReturnType<typeof state>, config: PolicyConfig) {
  const work = tempDir('tbi-beta-work-');
  dirs.push(work);
  const service = new BuildService(
    [new FakeProvider()],
    s.store,
    work,
    { ...DEFAULT_LIMITS, timeoutMs: 1500 },
    {
      grants: s.grants,
      ticketKey: TEST_TICKET_KEY,
      systemKeys: new Set(),
      policy: new Policy(config, 1),
      rates: new RateLimiter(s.ratesPath),
      probe: plenty,
    },
  );
  closers.push(async () => {
    await service.whenIdle();
    service.close();
  });
  return service;
}

async function serve(service: BuildService) {
  const server = createBuildHttpServer(service, { leaseMs: 60_000, identity: TEST_IDENTITY });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  const gate = async (subject: string | null) => {
    const g = await startTestGate(target, TEST_IDENTITY, subject);
    closers.push(g.close);
    return g.base;
  };
  return { target, gate };
}

async function answer(r: Response) {
  return { status: r.status, retryAfter: r.headers.get('retry-after'), text: await r.text() };
}

const uploadRateEvents = (ratesPath: string, who: string): number => {
  const db = new DatabaseSync(ratesPath);
  try {
    return (
      db
        .prepare(
          `SELECT count(*) AS n FROM rate_event WHERE principal = ? AND action = 'prebuilt-upload'`,
        )
        .get(who) as { n: number }
    ).n;
  } finally {
    db.close();
  }
};

const blobs = (dir: string) => readdirSync(dir).filter((f) => !f.startsWith('.'));

describe('policy.beta.json (fail closed)', () => {
  it('validates; defaultPlan is free; preview and system are kept', () => {
    const c = validatePolicy(readPolicy('policy.beta.json'));
    expect(c.defaultPlan).toBe('free');
    expect(Object.keys(c.plans).sort()).toEqual(['free', 'preview', 'system']);
    expect(c.plans.free!.capabilities.allowPrebuiltBinary).toBe(false);
    expect(c.assignments).toEqual({});
  });

  it('free without capabilities, without allowPrebuiltBinary, or with a non-boolean, is refused', () => {
    const noCaps = readPolicy('policy.beta.json') as PolicyConfig;
    delete (noCaps.plans.free as Partial<PolicyConfig['plans'][string]>).capabilities;
    expect(() => validatePolicy(noCaps)).toThrow(/free\.capabilities/);
    expect(() => new Policy(noCaps, 1)).toThrow(/free\.capabilities/);

    const noFlag = readPolicy('policy.beta.json') as PolicyConfig;
    delete (noFlag.plans.free!.capabilities as Partial<{ allowPrebuiltBinary: boolean }>)
      .allowPrebuiltBinary;
    expect(() => validatePolicy(noFlag)).toThrow(/free\.capabilities/);

    for (const bad of ['false', 0, null]) {
      const c = readPolicy('policy.beta.json') as PolicyConfig;
      (c.plans.free!.capabilities as { allowPrebuiltBinary: unknown }).allowPrebuiltBinary = bad;
      expect(() => validatePolicy(c), String(bad)).toThrow(/free\.capabilities/);
    }
  });

  it('an unknown defaultPlan (or a missing free plan behind defaultPlan free) is refused', () => {
    const unknown = readPolicy('policy.beta.json') as PolicyConfig;
    unknown.defaultPlan = 'pro';
    expect(() => validatePolicy(unknown)).toThrow(/defaultPlan/);
    const noFree = readPolicy('policy.beta.json') as PolicyConfig;
    delete noFree.plans.free;
    expect(() => validatePolicy(noFree)).toThrow(/defaultPlan/);
  });

  it('free equals preview field by field except capabilities.allowPrebuiltBinary', () => {
    const c = validatePolicy(readPolicy('policy.beta.json'));
    const leaves = (o: unknown, at = ''): [string, unknown][] =>
      o !== null && typeof o === 'object'
        ? Object.entries(o).flatMap(([k, v]) => leaves(v, at ? `${at}.${k}` : k))
        : [[at, o]];
    const free = new Map(leaves(c.plans.free));
    const preview = new Map(leaves(c.plans.preview));
    expect([...free.keys()].sort()).toEqual([...preview.keys()].sort());
    const differing = [...free.keys()].filter((k) => free.get(k) !== preview.get(k));
    expect(differing).toEqual(['capabilities.allowPrebuiltBinary']);
    expect(free.get('capabilities.allowPrebuiltBinary')).toBe(false);
    expect(preview.get('capabilities.allowPrebuiltBinary')).toBe(true);
  });

  it('is policy.alpha.json plus the free plan and defaultPlan free: preview, system, global unchanged', () => {
    const b = validatePolicy(readPolicy('policy.beta.json'));
    const a = validatePolicy(readPolicy('policy.alpha.json'));
    expect(a.defaultPlan).toBe('preview'); // the alpha file itself is untouched
    expect(b.plans.preview).toEqual(a.plans.preview);
    expect(b.plans.system).toEqual(a.plans.system);
    expect(b.global).toEqual(a.global);
    expect(b.assignments).toEqual(a.assignments);
    expect(b.version).toBe(a.version);
  });
});

describe('plan resolution under the beta policy', () => {
  it('an unassigned principal is free; one assigned preview is preview; system is unchanged', () => {
    const p = new Policy(beta({ [PREVIEW]: 'preview', [OTHER]: 'system' }), 1);
    expect(p.planName(FREE)).toBe('free');
    expect(p.plan(FREE).capabilities.allowPrebuiltBinary).toBe(false);
    expect(p.planName(PREVIEW)).toBe('preview');
    expect(p.plan(PREVIEW).capabilities.allowPrebuiltBinary).toBe(true);
    expect(p.planName(OTHER)).toBe('system');
    expect(p.plan(OTHER)).toEqual(validatePolicy(readPolicy('policy.alpha.json')).plans.system);
  });
});

describe('Advanced prebuilt upload under the beta policy', () => {
  it('direct service call: free is refused (nothing stored, no upload-rate token); preview uploads', async () => {
    const s = state();
    const service = serviceOver(s, beta({ [PREVIEW]: 'preview' }));
    await expect(service.publishPrebuilt(FREE, fakeImage('free'))).rejects.toMatchObject({
      code: 'capability_disabled',
      status: 403,
      retryAfterMs: undefined,
    });
    expect(blobs(s.storeDir)).toEqual([]);
    expect(s.grants.usage(FREE)).toEqual({ artifacts: 0, bytes: 0 });
    expect(uploadRateEvents(s.ratesPath, FREE)).toBe(0);

    const ok = await service.publishPrebuilt(PREVIEW, fakeImage('preview'));
    expect(ok.origin).toBe('prebuilt');
    expect(s.grants.usage(PREVIEW).artifacts).toBe(1);
    expect(uploadRateEvents(s.ratesPath, PREVIEW)).toBe(1);
  });

  it('HTTP: free gets exactly 403 {"error":"capability_disabled"}; preview 200; no identity 401', async () => {
    const s = state();
    const service = serviceOver(s, beta({ [PREVIEW]: 'preview' }));
    const { gate } = await serve(service);
    const upload = async (subject: string | null, seed: string) =>
      answer(
        await fetch(`${await gate(subject)}/v1/artifacts`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: new Uint8Array(fakeImage(seed)),
        }),
      );

    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const free = await upload(FREE_USER, 'free');
    vi.restoreAllMocks();
    expect(free).toEqual({
      status: 403,
      retryAfter: null,
      text: '{"error":"capability_disabled"}',
    });
    // Logged: the existing admission-event form only (no body, headers, plan or limits).
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      event: 'admission',
      service: 'build',
      action: 'artifacts',
      outcome: 'capability_disabled',
      who: FREE.slice(0, 10),
    });
    expect(blobs(s.storeDir)).toEqual([]);
    expect(s.grants.usage(FREE)).toEqual({ artifacts: 0, bytes: 0 });
    expect(uploadRateEvents(s.ratesPath, FREE)).toBe(0);

    const preview = await upload(PREVIEW_USER, 'preview');
    expect(preview.status).toBe(200);
    expect(JSON.parse(preview.text)).toMatchObject({ artifact: { origin: 'prebuilt' } });

    const anon = await upload(null, 'anon');
    expect(anon).toMatchObject({ status: 401, text: '{"error":"identity_required"}' });
  });

  it('HTTP: the refusal comes before the 4 MiB body is read (the client never sends it)', async () => {
    const s = state();
    const service = serviceOver(s, beta());
    const { target } = await serve(service);
    const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer before the body')), 5000);
      const req = httpRequest(
        {
          ...target,
          method: 'POST',
          path: '/v1/artifacts',
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(PREBUILT_IMAGE_BYTES),
            [TEST_IDENTITY.subjectHeader]: FREE_USER,
          },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => {
            clearTimeout(timer);
            resolve({ status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
            req.destroy();
          });
        },
      );
      req.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      req.write(Buffer.alloc(16)); // 16 of 4 194 304 bytes, then nothing more
    });
    expect(res).toEqual({ status: 403, text: '{"error":"capability_disabled"}' });
    expect(blobs(s.storeDir)).toEqual([]);
  });
});

describe('lease of a prebuilt image by a principal that is now free (uploaded earlier under preview)', () => {
  async function history() {
    const s = state();
    // Before: the principal is on preview, uploads a prebuilt image and builds a sketch; one more
    // sketch compiles to exactly the bytes of a second prebuilt upload.
    const before = serviceOver(s, beta({ [FREE]: 'preview' }));
    const prebuilt = await before.publishPrebuilt(FREE, fakeImage('uploaded-earlier'));
    const built = before.submit(sketch('void setup(){} // built'), FREE);
    const both = before.submit(sketch('void setup(){} // both'), FREE);
    await before.whenIdle();
    await before.publishPrebuilt(FREE, fakeImage('void setup(){} // both'));
    const result = (out: typeof built) =>
      'cached' in out ? out.cached : before.status(out.buildId, out.token, FREE)!.result!;
    const builtSha = result(built).artifact!.sha256;
    const bothSha = result(both).artifact!.sha256;
    expect(bothSha).toBe(
      createHash('sha256').update(fakeImage('void setup(){} // both')).digest('hex'),
    );
    // After: the same state, the beta policy with no assignment — the principal is free.
    const after = serviceOver(s, beta());
    return { s, after, prebuiltSha: prebuilt.sha256, builtSha, bothSha };
  }

  it('direct service call: the prebuilt image is refused as capability_disabled; built firmware still leases', async () => {
    const { after, prebuiltSha, builtSha, bothSha } = await history();
    expect(() => after.lease(FREE, prebuiltSha, 60_000)).toThrow(
      expect.objectContaining({ code: 'capability_disabled', status: 403 }),
    );
    expect(after.lease(FREE, builtSha, 60_000)?.ticket).toBeTruthy();
    // The same bytes produced by our own builder for this principal: built firmware, allowed.
    expect(after.lease(FREE, bothSha, 60_000)?.ticket).toBeTruthy();
    // Someone else's image stays "not found" (no grant), whatever its kind.
    expect(after.lease(OTHER, prebuiltSha, 60_000)).toBeNull();
  });

  it('HTTP: 403 {"error":"capability_disabled"} for the prebuilt image, 200 for built, 404 for others', async () => {
    const { after, prebuiltSha, builtSha } = await history();
    const { gate } = await serve(after);
    const lease = async (subject: string | null, sha: string) =>
      answer(await fetch(`${await gate(subject)}/v1/artifacts/${sha}/lease`, { method: 'POST' }));
    expect(await lease(FREE_USER, prebuiltSha)).toEqual({
      status: 403,
      retryAfter: null,
      text: '{"error":"capability_disabled"}',
    });
    const ok = await lease(FREE_USER, builtSha);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toMatchObject({ sha256: builtSha });
    expect(await lease(OTHER_USER, prebuiltSha)).toMatchObject({
      status: 404,
      text: '{"error":"not_found"}',
    });
    expect(await lease(null, prebuiltSha)).toMatchObject({
      status: 401,
      text: '{"error":"identity_required"}',
    });
  });

  it('a principal moved back to preview may lease its prebuilt image again (nothing was deleted)', async () => {
    const { s, prebuiltSha } = await history();
    const again = serviceOver(s, beta({ [FREE]: 'preview' }));
    expect(again.lease(FREE, prebuiltSha, 60_000)?.ticket).toBeTruthy();
  });
});
