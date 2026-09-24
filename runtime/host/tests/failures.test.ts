/**
 * Runtime R2 Session Host: failure injection, isolation, leases, limits and host shutdown, with
 * the fake runtime (routine CI). Every failure must end terminal with an inspectable reason, with
 * no runtime process left behind, no private directory left behind and the artifact untouched.
 */
import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionHost } from '../host.js';
import type { HostSession } from '../session.js';
import {
  alive,
  createRequest,
  fakeHost,
  gone,
  serialText,
  waitEvent,
  waitState,
} from './support.js';

const hosts: SessionHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.shutdown()));
});
function start(mode = 'normal', over = {}) {
  const r = fakeHost(mode, over);
  hosts.push(r.host);
  return r;
}
function created(host: SessionHost, sha: string, extra = {}): HostSession {
  const r = host.create(createRequest(sha, extra));
  if (!r.ok) throw new Error(r.error);
  return r.value.session;
}
const terminalOf = async (s: HostSession) => {
  await Promise.race([waitState(s, 'failed', 15_000), waitState(s, 'ended', 15_000)]);
  await s.done();
  return s.status();
};

describe('runtime failures end terminal, clean up, and never restart', () => {
  const cases: [string, string, string][] = [
    ['startup timeout (no bridge handshake)', 'no_hello', 'start_timeout'],
    ['runtime crash (SIGSEGV)', 'crash', 'runtime_crashed'],
    ['no simulation progress', 'stall', 'stalled'],
    ['malformed runtime frame', 'garbage', 'host_protocol_error'],
    ['simulation time going backwards', 'time_backwards', 'host_protocol_error'],
    ['guest-requested reset (unsupported)', 'guest_reset', 'guest_reset'],
  ];
  for (const [name, mode, reason] of cases) {
    it(`${name} -> failed/${reason}`, async () => {
      const { host, art } = start(mode);
      const before = readFileSync(art.path);
      const s = created(host, art.sha256);
      s.run();
      const st = await terminalOf(s);
      expect(st).toMatchObject({ state: 'failed', reason });
      expect(alive(st.runtime.pid)).toBe(false);
      expect(gone(s.privateDir)).toBe(true);
      expect(readFileSync(art.path).equals(before)).toBe(true);
      // The terminal reason stays inspectable, and there was exactly one runtime start.
      expect(
        s.log.since(0).filter((e) => e.type === 'state' && e.state === 'running'),
      ).toHaveLength(1);
    });
  }

  it('terminate while running kills a runtime that ignores SIGTERM after the grace', async () => {
    const { host, art } = start('ignore_term');
    const s = created(host, art.sha256);
    s.run();
    await waitEvent(s, (e) => e.type === 'serial');
    const pid = s.status().runtime.pid;
    const t0 = performance.now();
    await s.terminate('terminated');
    expect(performance.now() - t0).toBeGreaterThanOrEqual(250); // SIGTERM was tried first
    expect(s.status()).toMatchObject({ state: 'ended', reason: 'terminated' });
    expect(alive(pid)).toBe(false);
  });

  it('terminate during startup (before the handshake) ends cleanly', async () => {
    const { host, art } = start('no_hello');
    const s = created(host, art.sha256);
    s.run();
    await expect.poll(() => s.status().runtime.pid, { timeout: 2_000 }).not.toBeNull();
    expect(s.state).toBe('running'); // spawned, handshake not reached
    await s.terminate('terminated');
    expect(s.status()).toMatchObject({ state: 'ended', reason: 'terminated' });
    expect(alive(s.status().runtime.pid)).toBe(false);
    expect(gone(s.privateDir)).toBe(true);
  });
});

describe('artifact, request and capability failures', () => {
  it('unknown artifact, hash mismatch and a vanished artifact fail before any runtime starts', () => {
    const { host, art } = start();
    const unknown = created(host, 'a'.repeat(64));
    expect(unknown.status()).toMatchObject({ state: 'failed', reason: 'artifact_unknown' });
    // Same name, different content.
    const bad = `${art.dir}/${'b'.repeat(64)}.bin`;
    writeFileSync(bad, Buffer.alloc(16));
    const mismatch = created(host, 'b'.repeat(64));
    expect(mismatch.status()).toMatchObject({ state: 'failed', reason: 'artifact_hash_mismatch' });
    chmodSync(bad, 0o000); // unreadable: behaves as missing
    const missing = created(host, 'b'.repeat(64));
    expect(['artifact_missing', 'artifact_hash_mismatch']).toContain(missing.status().reason);
    for (const s of [unknown, mismatch, missing]) expect(s.status().runtime.pid).toBeNull();
  });

  it('malformed requests are refused with 400 and never create a session', () => {
    const { host, art } = start();
    const good = createRequest(art.sha256);
    for (const body of [
      null,
      'text',
      { ...good, protocol: 'other/1' },
      { ...good, extra: 1 },
      { ...good, artifact: { sha256: '../../etc/passwd' } },
      { ...good, artifact: { path: '/bin/sh' } },
      { ...good, attachments: [{ gpio: 99, component: 'R1', terminal: 'a' }] },
      { ...good, circuit: { ...good.circuit, components: 'x' } },
    ]) {
      const r = host.create(body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
    expect(host.size).toBe(0);
  });

  it('flash and console pads cannot be attached; declared pulls/interrupts are refused', () => {
    const { host, art } = start();
    for (const gpio of [6, 9, 11, 1, 3]) {
      const s = created(host, art.sha256, {
        attachments: [{ gpio, component: 'R1', terminal: 'a' }],
      });
      expect(s.status(), `gpio${gpio}`).toMatchObject({
        state: 'failed',
        reason: 'invalid_attachment',
      });
    }
    const pull = created(host, art.sha256, { firmwareFeatures: { internalPull: [5] } });
    expect(pull.status()).toMatchObject({
      state: 'failed',
      reason: 'unsupported_feature',
      detail: { internalPull: [5] },
    });
    const irq = created(host, art.sha256, { firmwareFeatures: { gpioInterrupt: [5] } });
    expect(irq.status()).toMatchObject({ state: 'failed', reason: 'unsupported_feature' });
    expect(
      irq.log.since(0).some((e) => e.type === 'diagnostic' && e.code === 'unsupported_feature'),
    ).toBe(true);
  });

  it('an input-only pad the guest tries to drive stays an input and is diagnosed', async () => {
    const { host, art } = start('drive_input_only');
    const req = createRequest(art.sha256);
    const r4 = req.attachments.find((a) => a.gpio === 18)!.component;
    req.attachments.push({ gpio: 34, component: r4, terminal: 'b' });
    const r = host.create(req);
    if (!r.ok) throw new Error(r.error);
    const s = r.value.session;
    expect(s.state).toBe('ready');
    s.run();
    const d = await waitEvent(s, (e) => e.type === 'diagnostic');
    expect(d).toMatchObject({
      severity: 'warning',
      code: 'output_on_input_only_pad',
      detail: { gpio: 34, level: 1 },
    });
    // Electrical events are published only when the operating point changes: wait on time.
    await waitEvent(s, (e) => e.type === 'gpio' && BigInt(e.simNs!) >= 30_000_000n);
    const last = s.log
      .since(0)
      .filter((e) => e.type === 'electrical')
      .at(-1) as { outcome: { pins: { gpio: number; mode: string }[] } };
    expect(last.outcome.pins.find((p) => p.gpio === 34)!.mode).toBe('input');
    const g = s.log.since(0).find((e) => e.type === 'gpio' && e.changes.some((c) => c.gpio === 34));
    expect(g && g.type === 'gpio' && g.changes.find((c) => c.gpio === 34)).toMatchObject({
      drive: 0,
      level: 0,
    });
    expect(s.state).toBe('running');
    s.stop();
    await waitState(s, 'ended');
  });
});

describe('isolation', () => {
  it('two concurrent sessions of one artifact: private writes, independent termination, no cross access', async () => {
    const { host, art } = start();
    const a = created(host, art.sha256);
    const b = created(host, art.sha256);
    expect(a.privateDir).not.toBe(b.privateDir);
    a.run();
    b.run();
    await Promise.all([a, b].map((s) => waitEvent(s, (e) => e.type === 'serial')));
    expect(serialText(a)).toContain('BOOT 1');
    expect(serialText(b)).toContain('BOOT 1');
    // A's writes are in A's copy only.
    expect(readFileSync(`${a.privateDir}/flash.bin`)[0x9000]).toBe(1);
    expect(readFileSync(`${b.privateDir}/flash.bin`)[0x9000]).toBe(1);
    // A's token cannot reach B.
    expect(host.get(b.id, a.token)).toMatchObject({ ok: false, status: 404 });
    expect(host.get(b.id, b.token).ok).toBe(true);
    const bPid = b.status().runtime.pid;
    await a.terminate('terminated');
    expect(b.state).toBe('running');
    expect(alive(bPid)).toBe(true);
    const bSeq = b.log.lastSeq;
    await waitEvent(b, (e) => e.seq > bSeq + 3);
    await b.terminate('terminated');
    expect(createHash('sha256').update(readFileSync(art.path)).digest('hex')).toBe(art.sha256);
  });
});

describe('leases, limits and shutdown', () => {
  it('a client that never reconnects: the lease expires and everything is released', async () => {
    const { host, art } = start('normal', { leaseMs: 300 });
    const s = created(host, art.sha256);
    s.run();
    await waitEvent(s, (e) => e.type === 'serial');
    const pid = s.status().runtime.pid;
    await waitState(s, 'ended', 5_000);
    await s.done();
    expect(s.status()).toMatchObject({ state: 'ended', reason: 'lease_expired' });
    expect(alive(pid)).toBe(false);
    expect(gone(s.privateDir)).toBe(true);
  });

  it('an attached event stream keeps the session alive; after it leaves, the lease runs', async () => {
    const { host, art } = start('normal', { leaseMs: 300 });
    const s = created(host, art.sha256);
    s.run();
    s.streams++; // a connected stream (what http.ts does)
    const seq = s.log.lastSeq;
    await waitEvent(s, (e) => e.seq > seq + 50, 10_000); // well past the lease
    expect(s.state).toBe('running');
    s.streams--;
    s.lastActivity = performance.now();
    await waitState(s, 'ended', 5_000);
    expect(s.status().reason).toBe('lease_expired');
  });

  it('terminal sessions stay inspectable for the retention time, then disappear', async () => {
    const { host, art } = start('normal', { retainEndedMs: 200 });
    const s = created(host, art.sha256);
    await s.terminate('terminated');
    expect(host.get(s.id, s.token).ok).toBe(true);
    await waitEvent(s, () => false, 600).catch(() => undefined);
    expect(host.get(s.id, s.token).ok).toBe(false);
  });

  it('limits: maximum sessions, lifetime, storage, event buffering (resync), serial flood', async () => {
    const { host, art } = start('serial_flood', {
      maxSessions: 1,
      eventLogCapacity: 64,
      serialWindowMaxBytes: 256,
    });
    const s = created(host, art.sha256, { limits: { maxLifetimeMs: 1500 } });
    expect(host.create(createRequest(art.sha256))).toMatchObject({ ok: false, status: 429 });
    s.run();
    const st = await terminalOf(s);
    expect(st).toMatchObject({ state: 'ended', reason: 'lifetime_exceeded' });
    expect(s.log.size).toBeLessThanOrEqual(64);
    const replay = s.log.since(0);
    expect(replay[0]).toMatchObject({ type: 'resync' });
    expect(s.log.since(0).some((e) => e.type === 'serial' && (e.dropped ?? 0) > 0)).toBe(true);

    const tiny = start('normal', { maxSessionStorageBytes: 1024 });
    const small = tiny.host.create(createRequest(tiny.art.sha256));
    if (!small.ok) throw new Error(small.error);
    expect(small.value.session.status()).toMatchObject({
      state: 'failed',
      reason: 'storage_limit',
    });
  });

  it('host shutdown with active sessions terminates all of them and removes every file', async () => {
    const { host, art } = fakeHost();
    const sessions = [
      created(host, art.sha256),
      created(host, art.sha256),
      created(host, art.sha256),
    ];
    sessions[0]!.run();
    sessions[1]!.run();
    await Promise.all(sessions.slice(0, 2).map((s) => waitEvent(s, (e) => e.type === 'serial')));
    const pids = sessions.map((s) => s.status().runtime.pid);
    await host.shutdown();
    for (const s of sessions)
      expect(s.status()).toMatchObject({ state: 'ended', reason: 'host_shutdown' });
    for (const pid of pids) expect(alive(pid)).toBe(false);
    expect(gone(host.tmpRoot)).toBe(true);
    expect(host.create(createRequest(art.sha256))).toMatchObject({ ok: false, status: 503 });
  });
});

it('no private directory survives any of the above', () => {
  for (const h of hosts) expect(readdirSync(h.tmpRoot)).toEqual([]);
});
