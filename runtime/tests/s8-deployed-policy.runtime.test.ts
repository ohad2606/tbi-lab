/**
 * Sprint 8 post-deploy validation: policy and admission on a DEPLOYED instance under its REAL
 * policy (nothing is changed or reinstalled). Run with TBI_S8_INSTANCE=tbi for dev-lab (or tbi-s8
 * for staging); skipped otherwise. Fresh test principals per run, so the instance's own users and
 * earlier runs are unaffected. The Session Host is stopped briefly once (stale-health case).
 *
 * The values asserted are the preview plan of deploy/dev-lab/s8/policy.json, which must be the
 * installed policy byte for byte.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRequest } from './r2-support.js';

const N = process.env.TBI_S8_INSTANCE ?? '';
const STORE = N === 'tbi' ? '/var/lib/tbi-lab/artifacts' : `/var/lib/${N}-artifacts`;
const sudo = (...args: string[]) => spawnSync('sudo', ['-n', ...args], { encoding: 'utf8' });
const HAVE =
  N !== '' &&
  sudo('test', '-f', `/etc/systemd/system/${N}-build.service`).status === 0 &&
  sudo('true').status === 0;
const REAL_POLICY = new URL('../../deploy/dev-lab/s8/policy.json', import.meta.url).pathname;
const R1_IMAGE = '5f177cbe95f490dce1f6efe7dda501e03762d523b79771968f967b297d3a44af';
const run = Date.now().toString(36);
const u = (name: string) => `post-${name}-${run}`;

const relays: ChildProcess[] = [];
let BUILD = '';
let HOST = '';

async function relay(socket: string): Promise<string> {
  const port = 5200 + Math.floor(Math.random() * 300);
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
const poll = async (user: string, s: { body: Record<string, unknown> }) =>
  (await (
    await fetch(`${BUILD}/v1/builds/${s.body.buildId as string}`, {
      headers: as(user, { authorization: `Bearer ${s.body.token as string}` }),
    })
  ).json()) as { state: string; result?: { failure?: string } };
async function until(user: string, s: { body: Record<string, unknown> }, ms = 300_000) {
  const t0 = Date.now();
  for (;;) {
    const st = await poll(user, s);
    if (st.state === 'failed' || st.state === 'succeeded') return st;
    if (Date.now() - t0 > ms) throw new Error(`build stuck in ${st.state}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const healthy = async () => {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BUILD}/v1/health`)).ok && (await fetch(`${HOST}/health`)).ok) return;
    } catch {
      /* restarting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
};
const broken = (n: string) => `void setup( { // ${run} ${n}\n`;
const image = (sha: string) =>
  spawnSync('sudo', ['-n', 'cat', `${STORE}/${sha}.bin`], { maxBuffer: 1 << 26 }).stdout;
const upload = (user: string, bytes: Buffer) =>
  fetch(`${BUILD}/v1/artifacts`, { method: 'POST', headers: as(user), body: bytes }).then(answer);
const lease = (user: string, sha: string) =>
  fetch(`${BUILD}/v1/artifacts/${sha}/lease`, { method: 'POST', headers: as(user) }).then(answer);
async function session(user: string) {
  const l = await lease(user, R1_IMAGE); // the R1 reference image is a global system artifact
  return fetch(`${HOST}/sessions`, {
    method: 'POST',
    headers: as(user, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      ...loadRequest('TbiGpioProof'),
      artifact: { sha256: R1_IMAGE },
      ticket: l.body.ticket,
    }),
  }).then(answer);
}
const end = (user: string, s: { body: Record<string, unknown> }) =>
  fetch(`${HOST}/sessions/${s.body.sessionId as string}`, {
    method: 'DELETE',
    headers: as(user, { authorization: `Bearer ${s.body.token as string}` }),
  });

beforeAll(async () => {
  if (!HAVE) return;
  BUILD = await relay(`/run/${N}-build/api.sock`);
  HOST = await relay(`/run/${N}-runtime/api.sock`);
  await healthy();
}, 60_000);
afterAll(() => {
  if (!HAVE) return;
  sudo('systemctl', 'start', `${N}-session-host.service`); // in case a case stopped early
  for (const r of relays) if (r.pid) sudo('pkill', '-TERM', '-P', String(r.pid));
});

describe.skipIf(!HAVE)(`Sprint 8 policy on the deployed instance (${N}, real policy)`, () => {
  it('the installed policy is the repository policy, byte for byte', () => {
    expect(sudo('cmp', REAL_POLICY, `/etc/${N}/policy.json`).status).toBe(0);
  });

  it('preview build quota (1 active + 1 queued): a third is refused; another user still gets in', async () => {
    const a1 = await submit(u('a'), broken('a1'));
    const a2 = await submit(u('a'), broken('a2'));
    expect([a1.status, a2.status]).toEqual([202, 202]);
    expect(await submit(u('a'), broken('a3'))).toMatchObject({
      status: 429,
      body: { error: 'build_quota' },
    });
    const b1 = await submit(u('b'), broken('b1'));
    expect(b1.status).toBe(202);
    for (const [who, s] of [
      [u('a'), a1],
      [u('a'), a2],
      [u('b'), b1],
    ] as const)
      expect((await until(who, s)).result?.failure).toBe('compile_error');
  });

  it('Advanced .bin: allowed by the preview plan, private to the uploader, rate-limited at 10/h', async () => {
    // A private image: a sketch unique to this run (the example programs are global by design).
    const x = await submit(u('x'), `void setup() {} // ${run} private\nvoid loop() {}\n`);
    expect(x.status).toBe(202);
    const built = (await until(u('x'), x)) as { result?: { artifact?: { sha256: string } } };
    const sha = built.result!.artifact!.sha256;
    const bytes = image(sha);
    expect(bytes.length).toBeGreaterThan(0);
    expect((await lease(u('h'), sha)).status).toBe(404); // knowing the sha is not enough
    for (let i = 0; i < 10; i++)
      expect((await upload(u('g'), bytes)).status, `upload ${i}`).toBe(200);
    const limited = await upload(u('g'), bytes);
    expect(limited).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
    expect(Number(limited.retryAfter)).toBeGreaterThan(0);
    expect((await lease(u('g'), sha)).status).toBe(200); // the uploader's own artifact now
    expect((await lease(u('h'), sha)).status).toBe(404); // still nobody else's
  }, 400_000);

  it('sessions: one per preview user, one globally on this 1-vCPU host; ownership enforced', async () => {
    const c1 = await session(u('c'));
    expect(c1.status).toBe(201);
    try {
      expect(await session(u('c'))).toMatchObject({
        status: 429,
        body: { error: 'session_quota' },
      });
      const d1 = await session(u('d'));
      expect(d1).toMatchObject({ status: 503, body: { error: 'runtime_capacity' } });
      expect(Number(d1.retryAfter)).toBeGreaterThan(0);
      // Another user cannot see, drive or end the session, even with its token.
      const path = `${HOST}/sessions/${c1.body.sessionId as string}`;
      const auth = { authorization: `Bearer ${c1.body.token as string}` };
      expect((await fetch(path, { headers: as(u('d'), auth) })).status).toBe(404);
      expect((await fetch(path, { method: 'DELETE', headers: as(u('d'), auth) })).status).toBe(404);
      expect((await fetch(path, { headers: as(u('c'), auth) })).status).toBe(200);
    } finally {
      await end(u('c'), c1);
    }
  });

  it('a live session holds a queued build (nothing stopped); it compiles once the session ends', async () => {
    const s = await session(u('e'));
    expect(s.status).toBe(201);
    let b: Awaited<ReturnType<typeof submit>>;
    try {
      await fetch(`${HOST}/sessions/${s.body.sessionId as string}/run`, {
        method: 'POST',
        headers: as(u('e'), { authorization: `Bearer ${s.body.token as string}` }),
      });
      await new Promise((r) => setTimeout(r, 2500));
      b = await submit(u('f'), broken('held'));
      expect(b.status).toBe(202);
      await new Promise((r) => setTimeout(r, 4000));
      expect((await poll(u('f'), b)).state).toBe('queued');
    } finally {
      await end(u('e'), s);
    }
    expect((await until(u('f'), b)).result?.failure).toBe('compile_error');
  });

  it('stale runtime health admits no new compile; the build compiles once health is fresh', async () => {
    sudo('systemctl', 'stop', `${N}-session-host.service`);
    let b: Awaited<ReturnType<typeof submit>>;
    try {
      await new Promise((r) => setTimeout(r, 6000));
      b = await submit(u('i'), broken('stale'));
      expect(b.status).toBe(202);
      await new Promise((r) => setTimeout(r, 4000));
      expect((await poll(u('i'), b)).state).toBe('queued');
    } finally {
      sudo('systemctl', 'start', `${N}-session-host.service`);
    }
    await healthy();
    expect((await until(u('i'), b)).result?.failure).toBe('compile_error');
  });

  it('admission events are bounded: fixed keys, a 10-character reference, nothing else', () => {
    const lines = sudo(
      'journalctl',
      '-u',
      `${N}-build`,
      '-u',
      `${N}-session-host`,
      '--since',
      '-20min',
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
    expect(readFileSync(REAL_POLICY, 'utf8')).not.toMatch(/@/); // no addresses in the policy
  });
});
