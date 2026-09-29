/**
 * Runtime R2 heavy acceptance, part 2: isolation, failure injection, lease, host-process
 * shutdown/crash and resource measurements, through the Session Host on the REAL runtime.
 * Every case checks: terminal reason inspectable, no QEMU left, no private directory left,
 * artifact unchanged. Run on a provisioned machine: npm run test:r2.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  TEST_IDENTITY,
  TEST_SUBJECT,
  TEST_TICKET_KEY,
  principalFor,
  ticketFor,
} from '../identity/test-gate.js';
import { RUNTIME_HOME, artifact, assertProvisioned, recordEvidence } from '../harness/env.js';
import { alive, gone, serialText, waitEvent, waitState } from '../host/tests/support.js';
import type { HostSession } from '../host/session.js';
import type { SessionHost } from '../host/host.js';
import { gateMirrors, gateRequest, loadRequest, open, realHost } from './r2-support.js';

assertProvisioned();
const REPEAT = 3;
const SCRATCH = mkdtempSync(join(RUNTIME_HOME, 'r2-scratch-'));
const host = realHost({ tmpParent: SCRATCH });
const evidence: Record<string, unknown> = {};
afterAll(async () => {
  await host.shutdown();
  recordEvidence('r2-failures', evidence);
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(KEYS, { recursive: true, force: true });
});

const fileSha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const ARTIFACTS = ['TbiNvs', 'TbiGpioProof', 'TbiRestart'] as const;
const artifactsIntact = () => {
  for (const n of ARTIFACTS) expect(fileSha(artifact(n).path), n).toBe(artifact(n).sha256);
};

/** A session reached a terminal state and released everything. */
async function released(s: HostSession, pid: number | null, dir: string) {
  await s.done();
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  expect(gone(dir), 'private directory removed').toBe(true);
  const st = s.status();
  expect(['ended', 'failed']).toContain(st.state);
  expect(st.reason).toBeTruthy();
  return st;
}

const pidOf = async (s: HostSession) => {
  await expect.poll(() => s.status().runtime.pid, { timeout: 10_000 }).not.toBeNull();
  return s.status().runtime.pid!;
};

describe('R2 isolation (real runtime)', () => {
  it(`two concurrent sessions of one artifact, x${REPEAT}: private flash, terminate A leaves B running`, async () => {
    const rows = [];
    for (let i = 0; i < REPEAT; i++) {
      const a = open(host, loadRequest('TbiNvs'));
      const b = open(host, loadRequest('TbiNvs'));
      expect(a.id).not.toBe(b.id);
      expect(a.privateDir).not.toBe(b.privateDir);
      // Identifiers cannot cross: A's id with B's token is the same 404 as an unknown session.
      expect(host.get(a.id, b.token, principalFor())).toMatchObject({ ok: false, status: 404 });
      expect(host.get(b.id, a.token, principalFor())).toMatchObject({ ok: false, status: 404 });
      a.run();
      b.run();
      await waitEvent(a, () => serialText(a).includes('TBI-NVS-DONE'), 60_000);
      await waitEvent(b, () => serialText(b).includes('TBI-NVS-DONE'), 60_000);
      // Each guest wrote its own flash copy and saw a fresh image (boot count 1, not 2).
      expect(serialText(a)).toContain('TBI-NVS-BOOTS=1');
      expect(serialText(b)).toContain('TBI-NVS-BOOTS=1');
      const [pa, pb] = [await pidOf(a), await pidOf(b)];
      expect(pa).not.toBe(pb);
      const [da, db] = [a.privateDir, b.privateDir];
      const simB = BigInt(b.status().simNs);
      await host.terminate(a);
      const sa = await released(a, pa, da);
      expect(sa).toMatchObject({ state: 'ended', reason: 'terminated' });
      // B is untouched and still advancing.
      expect(b.state).toBe('running');
      expect(alive(pb)).toBe(true);
      await expect
        .poll(() => BigInt(b.status().simNs) > simB + 200_000_000n, { timeout: 30_000 })
        .toBe(true);
      b.stop();
      await waitState(b, 'ended', 30_000);
      const sb = await released(b, pb, db);
      expect(sb.reason).toBe('stopped');
      rows.push({ a: sa.reason, b: sb.reason });
    }
    artifactsIntact();
    evidence.isolation = rows;
  });

  it('two concurrent gate sessions produce the same stream as one alone (no shared state)', async () => {
    const END = 15_500_000_000n;
    const events = (s: HostSession) =>
      JSON.stringify(
        s.log
          .since(0)
          .filter((e) => e.type !== 'state' && e.simNs !== null && BigInt(e.simNs) <= END)
          .map(({ seq: _s, ...r }) => r),
      );
    const start = () => {
      const s = open(host, gateRequest('TbiGpioProof'));
      for (const m of gateMirrors()) host.command(s, m);
      s.run();
      return s;
    };
    const finish = async (s: HostSession) => {
      await expect
        .poll(() => BigInt(s.status().simNs) >= END, { timeout: 180_000, interval: 50 })
        .toBe(true);
      s.stop();
      await waitState(s, 'ended', 30_000);
      await s.done();
      return events(s);
    };
    const solo = await finish(start());
    const [x, y] = [start(), start()];
    const [ex, ey] = await Promise.all([finish(x), finish(y)]);
    expect(ex).toBe(solo);
    expect(ey).toBe(solo);
    evidence.concurrentGate = [solo, ex, ey].map((t) =>
      createHash('sha256').update(t).digest('hex').slice(0, 16),
    );
  });
});

describe('R2 failure injection (real runtime)', () => {
  it(`QEMU crash (SIGSEGV), x${REPEAT}: failed(runtime_crashed), never restarted`, async () => {
    for (let i = 0; i < REPEAT; i++) {
      const s = open(host, gateRequest('TbiGpioProof'));
      const dir = s.privateDir;
      s.run();
      const pid = await pidOf(s);
      await expect
        .poll(() => BigInt(s.status().simNs) >= 500_000_000n, { timeout: 30_000 })
        .toBe(true);
      process.kill(pid, 'SIGSEGV');
      const st = await released(s, pid, dir);
      expect(st).toMatchObject({ state: 'failed', reason: 'runtime_crashed' });
      expect(
        s.log.since(0).filter((e) => e.type === 'state' && e.state === 'running'),
      ).toHaveLength(1);
    }
    artifactsIntact();
  });

  it(`guest reset request (esp_restart), x${REPEAT}: failed(guest_reset), booted exactly once`, async () => {
    for (let i = 0; i < REPEAT; i++) {
      const s = open(host, loadRequest('TbiRestart'));
      const dir = s.privateDir;
      s.run();
      const pid = await pidOf(s);
      await waitState(s, 'failed', 60_000);
      const st = await released(s, pid, dir);
      expect(st.reason).toBe('guest_reset');
      expect(serialText(s)).toContain('TBI-RESTART-REQUEST');
      expect(serialText(s).match(/^rst:/gm)).toHaveLength(1);
    }
  });

  it('invalid firmware (erased flash, correctly hashed): failed(stalled), artifact untouched', async () => {
    const dir = mkdtempSync(join(SCRATCH, 'art-'));
    const img = Buffer.alloc(4 << 20, 0xff);
    const sha = createHash('sha256').update(img).digest('hex');
    writeFileSync(join(dir, `${sha}.bin`), img, { mode: 0o444 });
    const h = realHost({ tmpParent: SCRATCH, artifactsDir: dir, stallTimeoutMs: 3000 });
    try {
      const s = open(h, {
        ...loadRequest('TbiGpioProof'),
        artifact: { sha256: sha },
        ticket: ticketFor(sha), // a run ticket names exactly one artifact
      });
      const pdir = s.privateDir;
      s.run();
      const pid = await pidOf(s);
      await waitState(s, 'failed', 30_000);
      const st = await released(s, pid, pdir);
      expect(st.reason).toBe('stalled');
      expect(serialText(s)).toMatch(/invalid header: 0xffffffff/);
      expect(fileSha(join(dir, `${sha}.bin`))).toBe(sha);
    } finally {
      await h.shutdown();
    }
  });

  it(`terminate during startup and while running, x${REPEAT}: ended(terminated), nothing left`, async () => {
    const rows = [];
    for (let i = 0; i < REPEAT; i++) {
      const early = open(host, gateRequest('TbiGpioProof'));
      const d1 = early.privateDir;
      early.run();
      const p1 = await pidOf(early); // spawned; the bridge handshake has not necessarily happened
      await host.terminate(early);
      const s1 = await released(early, p1, d1);
      const late = open(host, gateRequest('TbiGpioProof'));
      const d2 = late.privateDir;
      late.run();
      const p2 = await pidOf(late);
      await expect
        .poll(() => BigInt(late.status().simNs) >= 1_000_000_000n, { timeout: 30_000 })
        .toBe(true);
      await Promise.all([host.terminate(late), host.terminate(late)]); // idempotent
      const s2 = await released(late, p2, d2);
      rows.push({ startup: s1.reason, running: s2.reason });
      expect(s1).toMatchObject({ state: 'ended', reason: 'terminated' });
      expect(s2).toMatchObject({ state: 'ended', reason: 'terminated' });
    }
    evidence.terminate = rows;
    artifactsIntact();
  });

  it('client gone: the lease expires, the session is terminated and released', async () => {
    const h = realHost({ tmpParent: SCRATCH, leaseMs: 1500, housekeepingMs: 100 });
    try {
      const s = open(h, gateRequest('TbiGpioProof'));
      const dir = s.privateDir;
      s.run();
      const pid = await pidOf(s);
      const t0 = performance.now();
      await waitState(s, 'ended', 15_000);
      const st = await released(s, pid, dir);
      expect(st.reason).toBe('lease_expired');
      evidence.leaseExpiryWallMs = Math.round(performance.now() - t0);
    } finally {
      await h.shutdown();
    }
  });
});

/* ---------------- the host as a process (the esbuild bundle, as deployed) ---------------- */

const BUNDLE = join(process.cwd(), 'runtime/host/dist/session-host.mjs');

/** Key files outside the host's temporary root (whose emptiness the tests check). */
const KEYS = mkdtempSync(join(RUNTIME_HOME, 'r2-keys-'));
function keyFile(name: string, key: Buffer): string {
  const file = join(KEYS, name);
  writeFileSync(file, key, { mode: 0o600 });
  return file;
}

async function startHostProcess(tmpParent: string, port: number, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [BUNDLE], {
    env: {
      PATH: process.env.PATH ?? '',
      TMPDIR: tmpParent,
      TBI_RUNTIME_HOME: RUNTIME_HOME,
      TBI_HOST_PORT: String(port),
      // Sprint 8: the host needs the gate identity and run-ticket keys (the test keys here).
      TBI_IDENTITY_KEY_FILE: keyFile('identity.key', TEST_IDENTITY.key),
      TBI_IDENTITY_ISSUER: TEST_IDENTITY.issuer,
      TBI_TICKET_KEY_FILE: keyFile('ticket.key', TEST_TICKET_KEY),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => d.toString().includes('listening') && resolve());
    child.once('exit', (c) => reject(new Error(`host exited ${c}`)));
  });
  return child;
}

async function api(port: number, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      // The test plays the gate: it asserts the subject its tickets were minted for.
      'x-forwarded-user': TEST_SUBJECT,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

async function runningSession(port: number) {
  const c = await api(port, 'POST', '/sessions', undefined, gateRequest('TbiGpioProof'));
  expect(c.status).toBe(201);
  const { sessionId, token } = c.body as { sessionId: string; token: string };
  expect((await api(port, 'POST', `/sessions/${sessionId}/run`, token)).status).toBe(202);
  let pid = 0;
  await expect
    .poll(
      async () => {
        const s = await api(port, 'GET', `/sessions/${sessionId}`, token);
        pid = (s.body.runtime as { pid: number | null }).pid ?? 0;
        return pid > 0 && BigInt(s.body.simNs as string) > 200_000_000n;
      },
      { timeout: 30_000, interval: 100 },
    )
    .toBe(true);
  return { sessionId, token, pid };
}

const exited = (c: ChildProcess) =>
  new Promise<number | string | null>((r) => c.once('exit', (code, sig) => r(code ?? sig)));

describe('R2 host process (bundle): shutdown, crash, client disconnect', () => {
  it(`SIGTERM with active sessions, x${REPEAT}: every QEMU ends, the temp root is removed`, async () => {
    for (let i = 0; i < REPEAT; i++) {
      const tmp = mkdtempSync(join(SCRATCH, 'proc-'));
      const port = 7600 + i;
      const child = await startHostProcess(tmp, port);
      const a = await runningSession(port);
      const b = await runningSession(port);
      const exit = exited(child);
      child.kill('SIGTERM');
      expect(await exit).toBe(0);
      expect(alive(a.pid)).toBe(false);
      expect(alive(b.pid)).toBe(false);
      expect(readdirSync(tmp)).toEqual([]);
      rmSync(tmp, { recursive: true, force: true });
    }
    artifactsIntact();
  });

  it(`host crash (SIGKILL), x${REPEAT}: QEMU loses its peer and exits; the next host removes the stale root`, async () => {
    const rows = [];
    for (let i = 0; i < REPEAT; i++) {
      const tmp = mkdtempSync(join(SCRATCH, 'crash-'));
      const port = 7610 + i;
      const child = await startHostProcess(tmp, port);
      const { pid } = await runningSession(port);
      const exit = exited(child);
      child.kill('SIGKILL');
      await exit;
      const t0 = performance.now();
      await expect.poll(() => alive(pid), { timeout: 15_000, interval: 50 }).toBe(false);
      rows.push({ qemuGoneAfterHostKillMs: Math.round(performance.now() - t0) });
      // What the dead host left: its root (with its session dir) and possibly its short bridge
      // socket directory — all named after its pid, so the next host can sweep them.
      const left = readdirSync(tmp);
      expect(left.length).toBeGreaterThanOrEqual(1);
      expect(left.every((n) => n.startsWith(`tbi-host-${child.pid}-`))).toBe(true);
      const next = await startHostProcess(tmp, port);
      expect(readdirSync(tmp)).toHaveLength(1); // only the new host's (empty) root remains
      expect(readdirSync(join(tmp, readdirSync(tmp)[0]!))).toEqual([]);
      const e2 = exited(next);
      next.kill('SIGTERM');
      await e2;
      expect(
        readdirSync(tmp),
        `next pid ${next.pid}, crashed pid ${child.pid}: ${readdirSync(tmp)
          .map((n) => `${n}[${readdirSync(join(tmp, n)).join(',')}]`)
          .join(' ')}`,
      ).toEqual([]);
      rmSync(tmp, { recursive: true, force: true });
    }
    evidence.hostCrash = rows;
    artifactsIntact();
  });

  it('client disconnect over SSE: the session survives the lease, then is released', async () => {
    const tmp = mkdtempSync(join(SCRATCH, 'lease-'));
    const port = 7620;
    const child = await startHostProcess(tmp, port, { TBI_HOST_LEASE_MS: '2000' });
    try {
      const { sessionId, token, pid } = await runningSession(port);
      // Attach, read a little, then drop the connection (the WAN goes away).
      const ctl = new AbortController();
      // Sprint 8: the token travels in the header only; the test plays the gate.
      const r = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/events`, {
        signal: ctl.signal,
        headers: { authorization: `Bearer ${token}`, 'x-forwarded-user': TEST_SUBJECT },
      });
      const reader = r.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toMatch(/^id: 1\nevent: state\n/);
      // While attached, the lease never expires even with no requests.
      await new Promise((res) => setTimeout(res, 3000));
      expect(alive(pid)).toBe(true);
      ctl.abort();
      const t0 = performance.now();
      await expect.poll(() => alive(pid), { timeout: 10_000, interval: 50 }).toBe(false);
      const ms = performance.now() - t0;
      expect(ms).toBeGreaterThan(1500);
      const st = await api(port, 'GET', `/sessions/${sessionId}`, token);
      expect(st.body).toMatchObject({ state: 'ended', reason: 'lease_expired' });
      evidence.sseDisconnectToReleaseMs = Math.round(ms);
    } finally {
      const e = exited(child);
      child.kill('SIGTERM');
      await e;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/* ---------------- measurements (evidence only; not capacity claims) ---------------- */

function procStatus(pid: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of readFileSync(`/proc/${pid}/status`, 'utf8').split('\n')) {
    const m = /^(VmRSS|VmHWM):\s+(\d+) kB/.exec(l);
    if (m) out[m[1]!] = Number(m[2]) * 1024;
  }
  return out;
}

async function measure(h: SessionHost) {
  const t0 = performance.now();
  const s = open(h, gateRequest('TbiGpioProof'));
  const createMs = performance.now() - t0;
  s.run();
  const t1 = performance.now();
  await waitEvent(s, (e) => e.type === 'serial', 30_000);
  const firstSerialMs = performance.now() - t1;
  await expect
    .poll(() => BigInt(s.status().simNs) >= 10_000_000_000n, { timeout: 120_000, interval: 20 })
    .toBe(true);
  const wall10s = performance.now() - t1;
  const pid = s.status().runtime.pid!;
  const mem = procStatus(pid);
  const storage = s.storageBytes();
  s.stop();
  await waitState(s, 'ended', 30_000);
  await s.done();
  return {
    createMs: Math.round(createMs),
    runToFirstSerialMs: Math.round(firstSerialMs),
    wallMsFor10sSimulated: Math.round(wall10s),
    qemuRssBytes: mem.VmRSS,
    qemuPeakRssBytes: mem.VmHWM,
    sessionStorageBytes: storage,
    eventsLogged: s.log.lastSeq,
  };
}

describe('R2 resource measurements', () => {
  it('per-session cost on this host (1 and 2 concurrent sessions)', async () => {
    const one = [];
    for (let i = 0; i < REPEAT; i++) one.push(await measure(host));
    const two = await Promise.all([measure(host), measure(host)]);
    const hostRss = process.memoryUsage().rss;
    evidence.measurements = { one, two, testProcessRssBytes: hostRss };
    console.log('R2 measurements', evidence.measurements);
    for (const m of [...one, ...two]) expect(m.qemuRssBytes).toBeGreaterThan(0);
  });
});
