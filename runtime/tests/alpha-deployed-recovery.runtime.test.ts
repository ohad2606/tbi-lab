/**
 * Alpha capacity acceptance, supplementary: disconnect and timeout recovery on a DEPLOYED instance
 * (TBI_S8_INSTANCE=tbi), through its real sockets, sandbox and policy. The c5 harness covers Stop
 * and a killed QEMU; this covers the two endings it does not:
 * - disconnect: the client's event stream is cut and nothing else arrives; after the lease the host
 *   ends the session `lease_expired`, its QEMU unit stops and its directory is removed;
 * - timeout: a session whose lifetime is shortened by the client (limits.maxLifetimeMs, only ever
 *   stricter than the host) ends `lifetime_exceeded` while the client is active, and is cleaned up.
 * Both run beside a third session that must keep running, unaffected.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { artifact } from '../harness/env.js';
import { loadRequest } from './r2-support.js';
import { deployedLimits } from './deployed-limits.js';

const N = process.env.TBI_S8_INSTANCE ?? '';
const sudo = (...args: string[]) => spawnSync('sudo', ['-n', ...args], { encoding: 'utf8' });
const HAVE =
  N !== '' &&
  sudo('test', '-f', `/etc/systemd/system/${N}-session-host.service`).status === 0 &&
  sudo('true').status === 0;
const SESSIONS = `/var/lib/${N}-runtime/sessions`;
const REAL_POLICY =
  process.env.TBI_S8_POLICY ??
  new URL('../../deploy/dev-lab/s8/policy.json', import.meta.url).pathname;
/** Three concurrent sessions are needed (on the 1-vCPU DEV host the policy admits one: skipped). */
const ENOUGH = HAVE && deployedLimits(N, REAL_POLICY).maxLive >= 3;
const R1_IMAGE = '5f177cbe95f490dce1f6efe7dda501e03762d523b79771968f967b297d3a44af';
const LEASE_MS = 30_000; // Session Host default leaseMs (not overridden by the unit)
const run = Date.now().toString(36);
const u = (name: string) => `alpha-rec-${name}-${run}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const relays: ChildProcess[] = [];
let BUILD = '';
let HOST = '';

async function relay(socket: string): Promise<string> {
  const port = 5800 + Math.floor(Math.random() * 300);
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
interface S {
  user: string;
  id: string;
  token: string;
}
const headers = (s: S) => as(s.user, { authorization: `Bearer ${s.token}` });
const status = async (s: S) =>
  (await (await fetch(`${HOST}/sessions/${s.id}`, { headers: headers(s) })).json()) as {
    state: string;
    reason?: string;
  };

async function session(user: string, limits?: { maxLifetimeMs: number }): Promise<S> {
  const bytes = readFileSync(artifact('TbiGpioProof').path);
  expect(
    (await fetch(`${BUILD}/v1/artifacts`, { method: 'POST', headers: as(user), body: bytes }))
      .status,
  ).toBe(200);
  const l = (await (
    await fetch(`${BUILD}/v1/artifacts/${R1_IMAGE}/lease`, { method: 'POST', headers: as(user) })
  ).json()) as { ticket: string };
  const r = await fetch(`${HOST}/sessions`, {
    method: 'POST',
    headers: as(user, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      ...loadRequest('TbiGpioProof'),
      artifact: { sha256: R1_IMAGE },
      ticket: l.ticket,
      ...(limits ? { limits } : {}),
    }),
  });
  expect(r.status, user).toBe(201);
  const b = (await r.json()) as { sessionId: string; token: string };
  const s = { user, id: b.sessionId, token: b.token };
  expect(
    (await fetch(`${HOST}/sessions/${s.id}/run`, { method: 'POST', headers: headers(s) })).status,
  ).toBe(202);
  for (let i = 0; i < 40 && (await status(s)).state !== 'running'; i++) await sleep(250);
  expect((await status(s)).state).toBe('running');
  return s;
}
const unitActive = (s: S) =>
  sudo('systemctl', 'is-active', `${N}-qemu@${s.id}.service`).stdout.trim() === 'active';
const dirExists = (s: S) => sudo('test', '-e', `${SESSIONS}/s-${s.id}`).status === 0;
async function cleanedUp(s: S) {
  for (let i = 0; i < 60 && (unitActive(s) || dirExists(s)); i++) await sleep(500);
  expect(unitActive(s), 'qemu unit').toBe(false);
  expect(dirExists(s), 'session dir').toBe(false);
}

beforeAll(async () => {
  if (!HAVE) return;
  BUILD = await relay(`/run/${N}-build/api.sock`);
  HOST = await relay(`/run/${N}-runtime/api.sock`);
}, 60_000);
afterAll(() => {
  for (const r of relays) if (r.pid) sudo('pkill', '-TERM', '-P', String(r.pid));
});

describe.skipIf(!ENOUGH)(`Alpha: disconnect and timeout recovery (${N})`, () => {
  it('a cut client ends lease_expired; a lifetime ends lifetime_exceeded; a bystander is unaffected', async () => {
    const live: S[] = [];
    const streams: AbortController[] = [];
    try {
      const bystander = await session(u('ok'));
      live.push(bystander);
      // The bystander holds its event stream, as the real client does (it also holds its lease).
      const hold = new AbortController();
      streams.push(hold);
      void fetch(`${HOST}/sessions/${bystander.id}/events?after=0`, {
        headers: headers(bystander),
        signal: hold.signal,
      })
        .then((r) => r.body?.cancel())
        .catch(() => undefined);
      const gone = await session(u('gone'));
      live.push(gone);
      const short = await session(u('short'), { maxLifetimeMs: 20_000 });
      live.push(short);
      expect(await status(short)).toMatchObject({ state: 'running' });
      // The host reports the enforced (client-shortened) lifetime, from the release that adds
      // `lifetimeMs` (Alpha Phase D); an older host omits it.
      const reported = (
        (await (
          await fetch(`${HOST}/sessions/${short.id}`, { headers: headers(short) })
        ).json()) as { lifetimeMs?: number }
      ).lifetimeMs;
      if (reported !== undefined) expect(reported).toBe(20_000);
      console.log(`lifetimeMs reported by the host: ${String(reported)}`);
      // The disconnecting client: an event stream that is cut, then silence.
      const ac = new AbortController();
      const stream = await fetch(`${HOST}/sessions/${gone.id}/events?after=0`, {
        headers: headers(gone),
        signal: ac.signal,
      });
      expect(stream.status).toBe(200);
      await sleep(2000);
      ac.abort();
      const cutAt = Date.now();
      // Meanwhile the other two clients stay active (polling holds their lease).
      let shortEnded: { state: string; reason?: string } | null = null;
      while (Date.now() - cutAt < LEASE_MS + 15_000) {
        expect((await status(bystander)).state, 'bystander').toBe('running');
        const st = await status(short);
        if (!shortEnded && st.state === 'ended') shortEnded = st;
        await sleep(2000);
      }
      expect(shortEnded).toMatchObject({ state: 'ended', reason: 'lifetime_exceeded' });
      await cleanedUp(short);
      // Only now does the disconnected client come back: its session ended with the lease.
      expect(await status(gone)).toMatchObject({ state: 'ended', reason: 'lease_expired' });
      await cleanedUp(gone);
      // The host admits the returning user again; the bystander still runs.
      const back = await session(u('gone'));
      live.push(back);
      await fetch(`${HOST}/sessions/${back.id}`, { method: 'DELETE', headers: headers(back) });
      await cleanedUp(back);
      expect((await status(bystander)).state).toBe('running');
    } finally {
      for (const s of live)
        await fetch(`${HOST}/sessions/${s.id}`, { method: 'DELETE', headers: headers(s) });
      for (const a of streams) a.abort();
    }
    for (const s of live) await cleanedUp(s);
  }, 300_000);
});
