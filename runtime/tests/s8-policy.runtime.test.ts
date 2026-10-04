/**
 * Sprint 8 Phase 4 staging validation: policy, quotas, rate limits and admission on the REAL
 * staging stack (`deploy/dev-lab/s8/install.sh staging`): sandboxed builds, sandboxed QEMU,
 * persistent rate windows. Skipped unless that instance is installed and sudo is available.
 *
 * For its duration the test installs a VALIDATION policy (the preview plan with limits small
 * enough to reach quickly) and restarts the two services; afterwards it restores the real policy
 * (deploy/dev-lab/s8/policy.json) and restarts them again.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type PolicyConfig } from '../policy/policy.js';
import { loadRequest } from './r2-support.js';

const N = 'tbi-s8';
const sudo = (...args: string[]) => spawnSync('sudo', ['-n', ...args], { encoding: 'utf8' });
const HAVE = existsSync(`/etc/systemd/system/${N}-build.service`) && sudo('true').status === 0;
const REAL_POLICY = new URL('../../deploy/dev-lab/s8/policy.json', import.meta.url).pathname;
const R1_IMAGE = '5f177cbe95f490dce1f6efe7dda501e03762d523b79771968f967b297d3a44af';

const relays: ChildProcess[] = [];
let BUILD = '';
let HOST = '';
const run = Date.now().toString(36); // unique sources per run (staging keeps its records)

function validationPolicy(tweak: (c: PolicyConfig) => void = () => {}): PolicyConfig {
  const c = structuredClone(DEFAULT_POLICY);
  const p = c.plans.preview!;
  p.build.submissions = { count: 3, windowMs: 600_000 };
  p.build.failures = { count: 20, windowMs: 600_000 };
  p.runtime.creations = { count: 3, windowMs: 600_000 };
  p.storage.prebuiltUploads = { count: 5, windowMs: 3_600_000 };
  c.global.build.maxQueueWaitMs = 600_000;
  tweak(c);
  return c;
}

function installPolicy(c: PolicyConfig | string, restart = [`${N}-build`, `${N}-session-host`]) {
  const tmp = `/tmp/claude-1001/policy-${process.pid}.json`;
  writeFileSync(tmp, typeof c === 'string' ? readFileSync(c, 'utf8') : JSON.stringify(c));
  sudo('install', '-m', '0400', tmp, `/etc/${N}/policy.json`);
  sudo('systemctl', 'restart', ...restart.map((u) => `${u}.service`));
}

async function relay(socket: string): Promise<string> {
  const port = 4900 + Math.floor(Math.random() * 300);
  const code = `const net=require('node:net');net.createServer((c)=>{const u=net.connect(${JSON.stringify(socket)});c.pipe(u).pipe(c);u.on('error',()=>c.destroy());c.on('error',()=>u.destroy())}).listen(${port},'127.0.0.1',()=>console.log('ready'));`;
  const child = spawn('sudo', ['-n', process.execPath, '-e', code], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  relays.push(child);
  await new Promise<void>((resolve) => child.stdout!.on('data', () => resolve()));
  return `http://127.0.0.1:${port}`;
}

const as = (user: string, extra: Record<string, string> = {}) => ({
  'x-forwarded-user': user,
  ...extra,
});
const answer = async (r: Response) => ({
  status: r.status,
  retryAfter: r.headers.get('retry-after'),
  body: (await r.json()) as Record<string, unknown>,
});
const submit = (user: string, text: string) =>
  fetch(`${BUILD}/v1/builds`, {
    method: 'POST',
    headers: as(user, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      protocol: 'tbi-lab.build/1',
      profile: 'esp32-arduino-3.3.12',
      files: [{ name: 'sketch.ino', text }],
    }),
  }).then(answer);
const poll = async (user: string, id: string, token: string) =>
  (await (
    await fetch(`${BUILD}/v1/builds/${id}`, {
      headers: as(user, { authorization: `Bearer ${token}` }),
    })
  ).json()) as { state: string; result?: { failure?: string } };
async function until(user: string, id: string, token: string, states: string[], ms = 300_000) {
  const t0 = Date.now();
  for (;;) {
    const s = await poll(user, id, token);
    if (states.includes(s.state)) return s;
    if (Date.now() - t0 > ms) throw new Error(`build stuck in ${s.state}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const waitHealthy = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BUILD}/v1/health`)).ok && (await fetch(`${HOST}/health`)).ok) return;
    } catch {
      /* restarting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
};
const image = () =>
  readFileSync(join(process.env.TBI_RUNTIME_HOME ?? '', 'artifacts', `${R1_IMAGE}.bin`));
const upload = (user: string) =>
  fetch(`${BUILD}/v1/artifacts`, { method: 'POST', headers: as(user), body: image() }).then(answer);
async function session(user: string) {
  const lease = await fetch(`${BUILD}/v1/artifacts/${R1_IMAGE}/lease`, {
    method: 'POST',
    headers: as(user),
  }).then(answer);
  const body = {
    ...loadRequest('TbiGpioProof'),
    artifact: { sha256: R1_IMAGE },
    ticket: lease.body.ticket,
  };
  return fetch(`${HOST}/sessions`, {
    method: 'POST',
    headers: as(user, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  }).then(answer);
}
const end = (user: string, s: { body: Record<string, unknown> }) =>
  fetch(`${HOST}/sessions/${s.body.sessionId}`, {
    method: 'DELETE',
    headers: as(user, { authorization: `Bearer ${s.body.token}` }),
  });

beforeAll(async () => {
  if (!HAVE) return;
  installPolicy(validationPolicy());
  BUILD = await relay(`/run/${N}-build/api.sock`);
  HOST = await relay(`/run/${N}-runtime/api.sock`);
  await waitHealthy();
}, 60_000);
afterAll(() => {
  if (!HAVE) return;
  installPolicy(REAL_POLICY); // the instance goes back to its real policy
  for (const r of relays) if (r.pid) sudo('pkill', '-TERM', '-P', String(r.pid));
});

describe.skipIf(!HAVE)(
  'Sprint 8 Phase 4 on staging (real sandboxed build service and runtime)',
  () => {
    it('per-user build quota: A stops at its limit while B still gets in; the rate refuses with a wait; restarts keep it', async () => {
      // Fast-failing sources: real compiler runs, no 30 s compile each.
      const broken = (n: string) => `void setup( { // ${run} ${n}\n`;
      const a1 = await submit('p4-a', broken('a1'));
      const a2 = await submit('p4-a', broken('a2'));
      expect([a1.status, a2.status]).toEqual([202, 202]); // one compiling, one waiting
      const a3 = await submit('p4-a', broken('a3'));
      expect(a3).toMatchObject({ status: 429, body: { error: 'build_quota' } });
      const b1 = await submit('p4-b', broken('b1'));
      expect(b1.status).toBe(202); // another user is unaffected
      for (const [u, s] of [
        ['p4-a', a1],
        ['p4-a', a2],
        ['p4-b', b1],
      ] as const)
        expect(
          (await until(u, s.body.buildId as string, s.body.token as string, ['failed'])).result
            ?.failure,
        ).toBe('compile_error');
      // A's window (3 submissions) has room for one more, then refuses with a wait.
      expect((await submit('p4-a', broken('a4'))).status).toBe(202);
      const limited = await submit('p4-a', broken('a5'));
      expect(limited).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
      expect(Number(limited.retryAfter)).toBeGreaterThan(0);
      // The window survives a restart of the build service.
      sudo('systemctl', 'restart', `${N}-build.service`);
      await waitHealthy();
      expect((await submit('p4-a', broken('a6'))).body.error).toBe('rate_limited');
    });

    it('Advanced .bin allowed under policy; sessions: own limit, then host capacity — nobody else’s session touched', async () => {
      expect((await upload('p4-c')).status).toBe(200);
      expect((await upload('p4-d')).status).toBe(200);
      const c1 = await session('p4-c');
      expect(c1.status).toBe(201);
      const c2 = await session('p4-c');
      expect(c2).toMatchObject({ status: 429, body: { error: 'session_quota' } });
      const d1 = await session('p4-d'); // the 1-vCPU host's one live session is taken
      expect(d1).toMatchObject({ status: 503, body: { error: 'runtime_capacity' } });
      expect(Number(d1.retryAfter)).toBeGreaterThan(0);
      expect(JSON.stringify(d1.body)).not.toMatch(/p4-c|p_/); // nothing about who holds it
      const st = (await (
        await fetch(`${HOST}/sessions/${c1.body.sessionId}`, {
          headers: as('p4-c', { authorization: `Bearer ${c1.body.token}` }),
        })
      ).json()) as { state: string };
      expect(['ready', 'running']).toContain(st.state);
      await end('p4-c', c1);
    });

    it('a live session defers new builds (nothing stopped); the build starts once the session ends', async () => {
      expect((await upload('p4-e')).status).toBe(200);
      const s = await session('p4-e');
      expect(s.status).toBe(201);
      await fetch(`${HOST}/sessions/${s.body.sessionId}/run`, {
        method: 'POST',
        headers: as('p4-e', { authorization: `Bearer ${s.body.token}` }),
      });
      await new Promise((r) => setTimeout(r, 2500)); // the build service has seen the live session
      const b = await submit('p4-f', `void setup( { // ${run} deferred\n`);
      expect(b.status).toBe(202);
      await new Promise((r) => setTimeout(r, 4000));
      expect((await poll('p4-f', b.body.buildId as string, b.body.token as string)).state).toBe(
        'queued',
      );
      await end('p4-e', s);
      expect(
        (
          await until('p4-f', b.body.buildId as string, b.body.token as string, [
            'failed',
            'succeeded',
          ])
        ).state,
      ).toBe('failed'); // it ran (a deliberate compile error) once the CPU was free
    });

    it('unknown runtime capacity fails closed: with the Session Host down a build waits; it starts once health is fresh', async () => {
      sudo('systemctl', 'stop', `${N}-session-host.service`);
      try {
        await new Promise((r) => setTimeout(r, 6000)); // the last health reading has gone stale
        const b = await submit('p4-i', `void setup( { // ${run} stale health\n`);
        expect(b.status).toBe(202);
        await new Promise((r) => setTimeout(r, 4000));
        expect((await poll('p4-i', b.body.buildId as string, b.body.token as string)).state).toBe(
          'queued',
        );
        sudo('systemctl', 'start', `${N}-session-host.service`);
        await waitHealthy();
        expect(
          (await until('p4-i', b.body.buildId as string, b.body.token as string, ['failed'])).result
            ?.failure,
        ).toBe('compile_error'); // it ran (a deliberate compile error) once capacity was known
      } finally {
        sudo('systemctl', 'start', `${N}-session-host.service`);
      }
    });

    it('the session-creation rate refuses with a wait and survives a Session Host restart', async () => {
      expect((await upload('p4-g')).status).toBe(200);
      for (let i = 0; i < 3; i++) {
        const s = await session('p4-g');
        expect(s.status).toBe(201);
        await end('p4-g', s);
      }
      const limited = await session('p4-g');
      expect(limited).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
      sudo('systemctl', 'restart', `${N}-session-host.service`);
      await waitHealthy();
      expect((await session('p4-g')).body.error).toBe('rate_limited');
    });

    it('Advanced .bin denied by policy is refused before the upload is read', async () => {
      installPolicy(
        validationPolicy((c) => (c.plans.preview!.capabilities.allowPrebuiltBinary = false)),
        [`${N}-build`],
      );
      await waitHealthy();
      expect(await upload('p4-h')).toMatchObject({
        status: 403,
        body: { error: 'capability_disabled' },
      });
    });

    it('every decision left one bounded admission event (no identities beyond a short reference)', () => {
      const lines = sudo(
        'journalctl',
        '-u',
        `${N}-build`,
        '-u',
        `${N}-session-host`,
        '--since',
        '-15min',
        '--no-pager',
        '-q',
        '-o',
        'cat',
      )
        .stdout.split('\n')
        .filter((l) => l.includes('"event":"admission"'));
      const outcomes = new Set(lines.map((l) => (JSON.parse(l) as { outcome: string }).outcome));
      for (const o of [
        'admitted',
        'build_quota',
        'rate_limited',
        'session_quota',
        'runtime_capacity',
        'capability_disabled',
      ])
        expect(outcomes, o).toContain(o);
      for (const l of lines) {
        const e = JSON.parse(l) as Record<string, string>;
        expect(Object.keys(e).sort()).toEqual(
          e.who
            ? ['action', 'event', 'outcome', 'service', 'who']
            : ['action', 'event', 'outcome', 'service'],
        );
        if (e.who) expect(e.who).toMatch(/^p_[A-Za-z0-9_-]{8}$/);
      }
    });
  },
);
