/**
 * Sprint 14: one structured `session_end` line per terminal session (diagnostics.ts), through
 * the real Session Host and HTTP adapter with the fake runtime (routine CI, no QEMU). Every path
 * writes exactly one bounded line with the documented category and severity, nothing private,
 * and a sink that throws changes nothing about the session.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { directLauncher } from '../../harness/launcher.js';
import type { TicketFeatures } from '../../identity/ticket.js';
import { principalFor, startTestGate, ticketFor, TEST_IDENTITY } from '../../identity/test-gate.js';
import type { HostConfig } from '../config.js';
import {
  REASON_CLASS,
  SESSION_END_MAX_LINE,
  SESSION_END_V,
  emitSessionEnd,
  sessionEndRecord,
  type SessionEndFacts,
} from '../diagnostics.js';
import type { SessionHost } from '../host.js';
import { createHttpServer } from '../http.js';
import type { HostSession } from '../session.js';
import {
  FAKE_RUNTIME,
  alive,
  createRequest,
  fakeHost,
  gone,
  waitEvent,
  waitState,
} from './support.js';

const FIELDS = new Set([
  'event',
  'v',
  'ref',
  'who',
  'state',
  'reason',
  'category',
  'severity',
  'from',
  'ran',
  'lifeMs',
  'runMs',
  'simMs',
  'outcome',
  'exitCode',
  'signal',
  'code',
]);

const hosts: SessionHost[] = [];
const servers: Server[] = [];
const gates: (() => void)[] = [];
afterEach(async () => {
  for (const close of gates.splice(0)) close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await Promise.all(hosts.splice(0).map((h) => h.shutdown()));
});

/** A fake host whose diagnostics go to `lines`. */
function start(mode = 'normal', over: Partial<HostConfig> = {}) {
  const lines: string[] = [];
  const r = fakeHost(mode, { diagnostics: (l) => void lines.push(l), ...over });
  hosts.push(r.host);
  return { ...r, lines };
}
function created(host: SessionHost, sha: string, extra = {}): HostSession {
  const r = host.create(createRequest(sha, extra), principalFor());
  if (!r.ok) throw new Error(r.error);
  return r.value.session;
}
const terminal = async (s: HostSession) => {
  await Promise.race([waitState(s, 'failed', 15_000), waitState(s, 'ended', 15_000)]);
  await s.done();
};

/**
 * The one line for `s`: newline-terminated, bounded, only documented fields, and none of the
 * session's secrets or any path.
 */
function only(lines: string[], s: HostSession, secrets: string[] = []): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  const line = lines[0]!;
  expect(line.endsWith('\n')).toBe(true);
  expect(line.indexOf('\n')).toBe(line.length - 1);
  expect(line.length - 1).toBeLessThanOrEqual(SESSION_END_MAX_LINE);
  for (const secret of [s.token, s.tokenHash, s.id, s.owner, s.privateDir, ...secrets])
    expect(line).not.toContain(secret);
  expect(line).not.toContain('/');
  expect(line).not.toMatch(/bearer|token|cookie|@/i);
  const rec = JSON.parse(line) as Record<string, unknown>;
  for (const k of Object.keys(rec)) expect(FIELDS.has(k), k).toBe(true);
  expect(rec).toMatchObject({
    event: 'session_end',
    v: SESSION_END_V,
    ref: s.id.slice(0, 8),
    who: s.owner.slice(0, 10),
    state: s.state,
    reason: s.status().reason,
  });
  return rec;
}

describe('session_end: user stop, client release, disconnect, timeout, shutdown', () => {
  it('stop while running: user_stop/info, from stopping, ran, runtime completed', async () => {
    const { host, art, lines } = start();
    const s = created(host, art.sha256);
    s.run();
    await waitEvent(s, (e) => e.type === 'serial');
    expect(lines).toHaveLength(0); // nothing before the session is terminal
    s.stop();
    await terminal(s);
    const rec = only(lines, s, [art.sha256]);
    expect(rec).toMatchObject({
      state: 'ended',
      reason: 'stopped',
      category: 'user_stop',
      severity: 'info',
      from: 'stopping',
      ran: true,
      outcome: 'completed',
      exitCode: 0,
      signal: null,
    });
    expect(rec.runMs).toEqual(expect.any(Number));
    expect(rec.lifeMs as number).toBeGreaterThanOrEqual(rec.runMs as number);
    expect(rec.simMs as number).toBeGreaterThan(0);
    // Idempotent ends never write a second line.
    await s.terminate('terminated');
    s.stop();
    await s.failNow('internal');
    expect(lines).toHaveLength(1);
  });

  it('stop before run: user_stop, from ready, never ran, no runtime fields', () => {
    const { host, art, lines } = start();
    const s = created(host, art.sha256);
    s.stop();
    const rec = only(lines, s);
    expect(rec).toMatchObject({ reason: 'stopped', category: 'user_stop', from: 'ready' });
    expect(rec.ran).toBe(false);
    expect(rec).not.toHaveProperty('runMs');
    expect(rec).not.toHaveProperty('outcome');
    expect(rec.simMs).toBe(0);
  });

  it('HTTP DELETE: client_release/info (the runtime was terminated by the host)', async () => {
    const { host, art, lines } = start();
    const server = createHttpServer(host, TEST_IDENTITY);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const gate = await startTestGate(
      { host: '127.0.0.1', port: (server.address() as AddressInfo).port },
      TEST_IDENTITY,
      'user-a',
    );
    gates.push(gate.close);
    const res = await fetch(`${gate.base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createRequest(art.sha256)),
    });
    const { sessionId, token } = (await res.json()) as { sessionId: string; token: string };
    const auth = { authorization: `Bearer ${token}` };
    await fetch(`${gate.base}/sessions/${sessionId}/run`, { method: 'POST', headers: auth });
    const s = host.get(sessionId, token, principalFor());
    if (!s.ok) throw new Error(s.error);
    await waitEvent(s.value, (e) => e.type === 'serial');
    const del = await fetch(`${gate.base}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(((await del.json()) as { state: string }).state).toBe('ended');
    expect(only(lines, s.value, [token, gate.base])).toMatchObject({
      state: 'ended',
      reason: 'terminated',
      category: 'client_release',
      severity: 'info',
      from: 'stopping',
      ran: true,
      outcome: 'terminated',
    });
  });

  it('lease expiry: disconnect/info', async () => {
    const { host, art, lines } = start('normal', { leaseMs: 300 });
    const s = created(host, art.sha256);
    s.run();
    await terminal(s);
    expect(only(lines, s)).toMatchObject({
      reason: 'lease_expired',
      category: 'disconnect',
      severity: 'info',
      outcome: 'terminated',
    });
  });

  it('lifetime: timeout/info, runtime outcome timeout', async () => {
    const { host, art, lines } = start();
    const s = created(host, art.sha256, { limits: { maxLifetimeMs: 800 } });
    s.streams++; // keep the lease
    s.run();
    await terminal(s);
    expect(only(lines, s)).toMatchObject({
      state: 'ended',
      reason: 'lifetime_exceeded',
      category: 'timeout',
      severity: 'info',
      outcome: 'timeout',
      signal: 'SIGKILL', // the harness's own kill at the limit
    });
  });

  it('host shutdown: host_shutdown/info, one line per session, running or not', async () => {
    const lines: string[] = [];
    const { host, art } = fakeHost('normal', { diagnostics: (l) => void lines.push(l) });
    const a = created(host, art.sha256);
    const b = created(host, art.sha256);
    a.run();
    await waitEvent(a, (e) => e.type === 'serial');
    await host.shutdown();
    expect(lines).toHaveLength(2);
    const recs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const rec of recs)
      expect(rec).toMatchObject({ reason: 'host_shutdown', category: 'host_shutdown' });
    expect(recs.find((r) => r.ref === a.id.slice(0, 8))).toMatchObject({ ran: true });
    expect(recs.find((r) => r.ref === b.id.slice(0, 8))).toMatchObject({
      ran: false,
      from: 'ready',
    });
  });
});

describe('session_end: runtime failures', () => {
  const cases: [string, string, Record<string, unknown>][] = [
    [
      'crash',
      'crash',
      { reason: 'runtime_crashed', category: 'crash', severity: 'error', signal: 'SIGSEGV' },
    ],
    [
      'stall',
      'stall',
      { reason: 'stalled', category: 'stall', severity: 'warning', outcome: 'stalled' },
    ],
    [
      'no_hello',
      'start timeout',
      { reason: 'start_timeout', category: 'startup', severity: 'error', simMs: 0 },
    ],
    [
      'garbage',
      'malformed frame',
      { reason: 'host_protocol_error', category: 'protocol', severity: 'error' },
    ],
    [
      'guest_reset',
      'runtime exited on its own',
      { reason: 'guest_reset', category: 'runtime_exit', severity: 'warning', exitCode: 0 },
    ],
  ];
  for (const [mode, name, want] of cases)
    it(`${name}: ${String(want.category)}/${String(want.severity)}`, async () => {
      const { host, art, lines } = start(mode);
      const s = created(host, art.sha256);
      s.run();
      await terminal(s);
      expect(only(lines, s)).toMatchObject({
        state: 'failed',
        from: 'running',
        ran: true,
        ...want,
      });
    });

  it('a launcher that throws: startup/error, without its message', async () => {
    const secret = '/var/lib/tbi-runtime/sessions/s-0123/private';
    const { host, art, lines } = start('normal', {
      launch: () => {
        throw new Error(`bad session directory: ${secret}`);
      },
    });
    const s = created(host, art.sha256);
    const orig = console.error;
    console.error = () => undefined; // the existing operator line, unchanged (failures.test.ts)
    try {
      s.run();
      await terminal(s);
    } finally {
      console.error = orig;
    }
    expect(only(lines, s, [secret, 'bad session'])).toMatchObject({
      reason: 'start_failed',
      category: 'startup',
      severity: 'error',
      outcome: 'start_failed',
    });
  });

  it('runtime that does not quit within the grace after stop: internal/error, outcome terminated', async () => {
    // The runtime process outlives the fake firmware's clean quit (exec sleep): the host's quit
    // grace expires and the harness kills it itself.
    const { host, art, lines } = start('normal', {
      quitGraceMs: 300,
      launch: (spec) =>
        directLauncher({
          ...spec,
          qemu: '/bin/sh',
          args: ['-c', `"${FAKE_RUNTIME}" "$@"; exec sleep 30`, 'sh', ...spec.args],
        }),
    });
    const s = created(host, art.sha256);
    s.run();
    await waitEvent(s, (e) => e.type === 'serial');
    s.stop();
    await terminal(s);
    expect(alive(s.status().runtime.pid)).toBe(false);
    expect(only(lines, s)).toMatchObject({
      state: 'failed',
      reason: 'internal',
      category: 'internal',
      severity: 'error',
      from: 'stopping',
      outcome: 'terminated',
      signal: 'SIGKILL',
    });
  });

  it('storage limit while running (housekeeping): resource_exhaustion/warning', async () => {
    const { host, art, lines } = start('normal', { maxSessionStorageBytes: (4 << 20) + 4096 });
    const s = created(host, art.sha256);
    s.run();
    await waitEvent(s, (e) => e.type === 'serial');
    writeFileSync(`${s.privateDir}/extra`, Buffer.alloc(8192)); // the directory grows
    await terminal(s);
    expect(only(lines, s)).toMatchObject({
      state: 'failed',
      reason: 'storage_limit',
      category: 'resource_exhaustion',
      severity: 'warning',
      from: 'running',
      outcome: 'terminated',
    });
  });

  it('storage limit at creation: resource_exhaustion, never ran', () => {
    const { host, art, lines } = start('normal', { maxSessionStorageBytes: 1024 });
    const s = created(host, art.sha256);
    expect(only(lines, s)).toMatchObject({
      reason: 'storage_limit',
      category: 'resource_exhaustion',
      from: 'creating',
      ran: false,
    });
  });
});

describe('session_end: user content and artifacts (not host faults)', () => {
  const features = (over: Partial<TicketFeatures>) => ({
    internalPull: [],
    gpioInterrupt: [],
    restart: false,
    unsupported: [],
    ...over,
  });

  it('unsupported_feature, invalid_attachment: user_content/info, from creating', () => {
    const { host, art, lines } = start();
    const f = created(host, art.sha256, {
      ticket: ticketFor(art.sha256, principalFor(), features({ unsupported: ['wifi'] })),
    });
    expect(only(lines, f)).toMatchObject({
      reason: 'unsupported_feature',
      category: 'user_content',
      severity: 'info',
      from: 'creating',
    });
    expect(lines[0]).not.toContain('wifi'); // detail is never copied
    lines.length = 0;
    const a = created(host, art.sha256, {
      attachments: [{ gpio: 6, component: 'R1', terminal: 'a' }],
    });
    expect(only(lines, a)).toMatchObject({
      reason: 'invalid_attachment',
      category: 'user_content',
    });
  });

  it('electrical_error while running: user_content/info with the engine code only', async () => {
    const { host, art, lines } = start();
    const req = createRequest(art.sha256, {}, { parallelPsu: true });
    const r = host.create(req, principalFor());
    if (!r.ok) throw new Error(r.error);
    const s = r.value.session;
    s.run();
    await waitEvent(s, (e) => e.type === 'serial');
    const psu2 = req.circuit.components.filter((c) => c.type === 'instrument.lab_psu')[1]!.id;
    host.command(s, {
      category: 'mirror',
      seq: 1,
      projectRevision: 5,
      component: psu2,
      control: { outputEnabled: true },
    });
    await terminal(s);
    const rec = only(lines, s, [psu2]);
    expect(rec).toMatchObject({
      reason: 'electrical_error',
      category: 'user_content',
      severity: 'info',
      code: 'psu_parallel',
      from: 'running',
      outcome: 'completed', // the host asked the runtime to quit
    });
  });

  it('mirror_failed: user_content/info', async () => {
    const { host, art, lines } = start();
    const s = created(host, art.sha256);
    s.run();
    await waitEvent(s, (e) => e.type === 'serial');
    host.command(s, {
      category: 'mirror',
      seq: 1,
      projectRevision: 5,
      component: 'PSU1',
      control: { currentLimit: -1 },
    });
    await terminal(s);
    const rec = only(lines, s);
    expect(rec).toMatchObject({ reason: 'mirror_failed', category: 'user_content' });
    expect(rec).not.toHaveProperty('code');
  });

  it('artifact unknown / hash mismatch: artifact_integrity', () => {
    const { host, art, lines } = start();
    const unknown = created(host, 'a'.repeat(64));
    expect(only(lines, unknown, ['a'.repeat(16)])).toMatchObject({
      reason: 'artifact_unknown',
      category: 'artifact_integrity',
      severity: 'warning',
      ran: false,
    });
    lines.length = 0;
    writeFileSync(`${art.dir}/${'b'.repeat(64)}.bin`, Buffer.alloc(16));
    const bad = created(host, 'b'.repeat(64));
    expect(only(lines, bad, ['b'.repeat(16)])).toMatchObject({
      reason: 'artifact_hash_mismatch',
      category: 'artifact_integrity',
      severity: 'error',
    });
  });
});

describe('diagnostics never affect the session', () => {
  /** What a session exposes to its client after a stop while running. */
  async function stopRun(over: Partial<HostConfig>) {
    const { host, art } = fakeHost('normal', over);
    hosts.push(host);
    const s = created(host, art.sha256);
    s.run();
    await waitEvent(s, (e) => e.type === 'serial');
    const pid = s.status().runtime.pid;
    s.stop();
    await terminal(s);
    const st = s.status();
    return {
      status: { state: st.state, reason: st.reason, outcome: st.runtime.outcome },
      states: s.log
        .since(0)
        .filter((e) => e.type === 'state')
        .map((e) => [e.state, e.type === 'state' ? e.reason : undefined]),
      alive: alive(pid),
      dirGone: gone(s.privateDir),
    };
  }

  it('a throwing sink: same state, same events, same cleanup as a working one', async () => {
    let calls = 0;
    const throwing = await stopRun({
      diagnostics: () => {
        calls++;
        throw new Error('journal unavailable');
      },
    });
    const working = await stopRun({ diagnostics: () => undefined });
    expect(calls).toBe(1);
    expect(throwing).toEqual(working);
    expect(throwing).toMatchObject({
      status: { state: 'ended', reason: 'stopped' },
      alive: false,
      dirGone: true,
    });
  });

  it('a throwing sink at a creation failure still yields the failed session', () => {
    const { host } = fakeHost('normal', {
      diagnostics: () => {
        throw new Error('x');
      },
    });
    hosts.push(host);
    const s = created(host, 'c'.repeat(64));
    expect(s.status()).toMatchObject({ state: 'failed', reason: 'artifact_unknown' });
  });
});

describe('sessionEndRecord (pure)', () => {
  const base: SessionEndFacts = {
    sessionId: '0123456789abcdef0123456789abcdef',
    owner: 'p_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    state: 'failed',
    reason: 'internal',
    from: 'running',
    ran: true,
    lifeMs: 1000,
    runMs: 900,
    simNs: 5_000_000n,
    runtime: { outcome: 'host_error', exitCode: null, signal: 'SIGKILL' },
    detail: undefined,
  };
  const line = (f: Partial<SessionEndFacts>) => {
    const out: string[] = [];
    emitSessionEnd(
      (l) => void out.push(l),
      () => ({ ...base, ...f }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.length - 1).toBeLessThanOrEqual(SESSION_END_MAX_LINE);
    return JSON.parse(out[0]!) as Record<string, unknown>;
  };

  it('every reason the host can produce has a category; table pinned', () => {
    expect(
      Object.fromEntries(
        Object.entries(REASON_CLASS).map(([k, v]) => [k, `${v.category}/${v.severity}`]),
      ),
    ).toEqual({
      stopped: 'user_stop/info',
      terminated: 'client_release/info',
      lease_expired: 'disconnect/info',
      lifetime_exceeded: 'timeout/info',
      host_shutdown: 'host_shutdown/info',
      unsupported_feature: 'user_content/info',
      invalid_attachment: 'user_content/info',
      electrical_error: 'user_content/info',
      mirror_failed: 'user_content/info',
      artifact_unknown: 'artifact_integrity/warning',
      artifact_hash_mismatch: 'artifact_integrity/error',
      artifact_missing: 'artifact_integrity/error',
      start_failed: 'startup/error',
      start_timeout: 'startup/error',
      stalled: 'stall/warning',
      runtime_crashed: 'crash/error',
      runtime_protocol_error: 'protocol/error',
      host_protocol_error: 'protocol/error',
      bridge_lost: 'protocol/error',
      guest_reset: 'runtime_exit/warning',
      storage_limit: 'resource_exhaustion/warning',
      internal: 'internal/error',
    });
  });

  it('the written line is exactly the record', () => {
    expect(line({})).toEqual(sessionEndRecord(base));
    expect(sessionEndRecord(base)).toMatchObject({
      ref: '01234567',
      who: 'p_ABCDEFGH',
      category: 'internal',
      outcome: 'host_error',
      simMs: 5,
    });
  });

  it('an unknown (future) reason is unknown/warning; a malformed one is not echoed', () => {
    expect(line({ reason: 'some_new_reason' })).toMatchObject({
      reason: 'some_new_reason',
      category: 'unknown',
      severity: 'warning',
    });
    expect(line({ reason: 'constructor' })).toMatchObject({ category: 'unknown' });
    expect(line({ reason: '/etc/passwd x' })).toMatchObject({
      reason: 'unknown',
      category: 'unknown',
    });
    expect(line({ reason: null })).toMatchObject({ reason: 'unknown', category: 'unknown' });
  });

  it('electrical code only when a short [a-z_] token, and only for electrical_error', () => {
    expect(line({ reason: 'electrical_error', detail: { code: 'no_ground' } }).code).toBe(
      'no_ground',
    );
    for (const code of ['/srv/x', 'A'.repeat(5), 'x'.repeat(41), 7, 'has space'])
      expect(line({ reason: 'electrical_error', detail: { code } })).not.toHaveProperty('code');
    expect(line({ reason: 'mirror_failed', detail: { code: 'no_ground' } })).not.toHaveProperty(
      'code',
    );
    expect(line({ reason: 'electrical_error', detail: null })).not.toHaveProperty('code');
  });

  it('values are bounded and sanitised', () => {
    const rec = line({
      sessionId: '../../not-an-id',
      lifeMs: Number.POSITIVE_INFINITY,
      runMs: -5,
      simNs: 10n ** 30n,
      from: 'weird' as never,
      runtime: { outcome: 'Bad Outcome' as never, exitCode: 1e9, signal: 'SIGKILL; rm -rf' },
    });
    expect(rec).toMatchObject({
      ref: 'unknown',
      lifeMs: 0,
      runMs: 0,
      simMs: 2 ** 31 - 1,
      from: 'unknown',
      outcome: 'unknown',
      exitCode: null,
      signal: null,
    });
  });

  it('a throwing fact source or sink never escapes', () => {
    expect(() =>
      emitSessionEnd(
        () => undefined,
        () => {
          throw new Error('x');
        },
      ),
    ).not.toThrow();
    expect(() =>
      emitSessionEnd(
        () => {
          throw new Error('x');
        },
        () => base,
      ),
    ).not.toThrow();
  });
});
