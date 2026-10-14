/**
 * Sprint 11 (R1) post-deploy validation on a DEPLOYED instance: the staging instance
 * (TBI_S8_INSTANCE=tbi-s8) or dev-lab (TBI_S8_INSTANCE=tbi). Skipped unless TBI_S8_INSTANCE is set,
 * that instance is installed and passwordless sudo is available. Fresh test principals per run;
 * nothing is reinstalled and the instance's policy applies.
 *
 * Everything goes through the instance's real sockets (a root relay plays the gate and sets the
 * subject header), the real build service and the real sandboxed QEMU:
 * - the two curated examples end to end: the example program built as the app builds it, the
 *   session request the app sends (fixtures kept equal to the app), live part parameters mirrored
 *   (ADR-010), the electrical result checked against the expected state;
 * - the command boundary: malformed and oversized bodies, unknown component, unsupported control,
 *   out-of-range value, rate limit, another user's session;
 * - the matrix and the capacitor refused for ESP32 projects (QEMU never started);
 * - cleanup: after Stop and after DELETE the QEMU unit is inactive and the session directory gone.
 *
 * TBI_S11_EXPECT=s10 asserts the opposite side of the compatibility matrix instead: a Sprint 10
 * host refuses the R1 parts and the live-parameter commands EXPLICITLY (never silently).
 * /health is printed so the run records which release answered.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addComponent, addWire, createSnapshot, type ProjectDocument } from '@tbi-lab/domain';
import { PROTOCOL, type CreateSessionRequest } from '../host/protocol.js';
import { deployedLimits } from './deployed-limits.js';

const N = process.env.TBI_S8_INSTANCE ?? '';
const EXPECT = process.env.TBI_S11_EXPECT === 's10' ? 's10' : 'r1';
const sudo = (...args: string[]) => spawnSync('sudo', ['-n', ...args], { encoding: 'utf8' });
const HAVE =
  N !== '' &&
  sudo('test', '-f', `/etc/systemd/system/${N}-session-host.service`).status === 0 &&
  sudo('true').status === 0;
const SESSIONS = `/var/lib/${N}-runtime/sessions`;
/** The installed policy (install.sh TBI_S8_POLICY; default policy.json), resolved on the host. */
const REAL_POLICY =
  process.env.TBI_S8_POLICY ??
  new URL('../../deploy/dev-lab/s8/policy.json', import.meta.url).pathname;
const LIMITS = HAVE ? deployedLimits(N, REAL_POLICY) : { perUser: 1, maxLive: 1, deferAt: 1 };
const run = Date.now().toString(36);
const u = (name: string) => `s11-${name}-${run}`;

const relays: ChildProcess[] = [];
let BUILD = '';
let HOST = '';

async function relay(socket: string): Promise<string> {
  const port = 5500 + Math.floor(Math.random() * 300);
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
type Answer = { status: number; body: Record<string, unknown> };
const answer = async (r: Response): Promise<Answer> => ({
  status: r.status,
  body: (await r.json().catch(() => ({}))) as Record<string, unknown>,
});

interface Fixture {
  request: Omit<CreateSessionRequest, 'artifact' | 'ticket'>;
}
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Fixture;
const exampleProgram = (id: string): string =>
  (
    JSON.parse(
      readFileSync(new URL(`../../app/src/examples/data/${id}.json`, import.meta.url), 'utf8'),
    ) as { programs: Record<string, { text: string }> }
  ).programs.U1!.text;

/** Build the example's program through the build service (as the app does); its sha256. */
async function buildProgram(user: string, text: string): Promise<string> {
  const s = await fetch(`${BUILD}/v1/builds`, {
    method: 'POST',
    headers: as(user, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      protocol: 'tbi-lab.build/1',
      profile: 'esp32-arduino-3.3.12',
      files: [{ name: 'sketch.ino', text }],
    }),
  }).then(answer);
  expect([200, 202]).toContain(s.status);
  // 200: a cached build of the same source (example programs are shared), returned directly.
  if (s.status === 200) {
    const b = s.body.build as { ok: boolean; artifact?: { sha256: string } };
    expect(b.ok).toBe(true);
    return b.artifact!.sha256;
  }
  const t0 = Date.now();
  for (;;) {
    const st = (await (
      await fetch(`${BUILD}/v1/builds/${s.body.buildId as string}`, {
        headers: as(user, { authorization: `Bearer ${s.body.token as string}` }),
      })
    ).json()) as { state: string; result?: { artifact?: { sha256: string } } };
    if (st.state === 'succeeded') return st.result!.artifact!.sha256;
    if (st.state === 'failed') throw new Error(`build failed: ${JSON.stringify(st)}`);
    if (Date.now() - t0 > 400_000) throw new Error(`build stuck in ${st.state}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

class Session {
  seq = 0;
  rev: number;
  after = 0;
  constructor(
    readonly user: string,
    readonly id: string,
    readonly token: string,
    req: Fixture['request'],
  ) {
    this.rev = req.circuit.projectRevision;
  }
  get path() {
    return `${HOST}/sessions/${this.id}`;
  }
  headers(user = this.user, extra: Record<string, string> = {}) {
    return as(user, { authorization: `Bearer ${this.token}`, ...extra });
  }
  status(user = this.user) {
    return fetch(this.path, { headers: this.headers(user) }).then(answer);
  }
  command(body: unknown, user = this.user): Promise<Answer> {
    return fetch(`${this.path}/commands`, {
      method: 'POST',
      headers: this.headers(user, { 'content-type': 'application/json' }),
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }).then(answer);
  }
  mirror(component: string, control: Record<string, unknown>) {
    return this.command({
      category: 'mirror',
      seq: ++this.seq,
      projectRevision: ++this.rev,
      component,
      control,
    });
  }
  /** Read the event stream from the last position until `pred` holds for an event. */
  async until(
    pred: (e: Record<string, unknown>) => boolean,
    ms = 60_000,
  ): Promise<Record<string, unknown>> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(`${this.path}/events?after=${this.after}`, {
        headers: this.headers(),
        signal: ac.signal,
      });
      expect(r.status).toBe(200);
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('event stream ended before the expected event');
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame
            .split('\n')
            .find((l) => l.startsWith('data: '))
            ?.slice(6);
          if (!data) continue;
          const e = JSON.parse(data) as Record<string, unknown>;
          this.after = e.seq as number;
          if (pred(e)) {
            ac.abort();
            return e;
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
  serialIncludes(text: string, ms = 90_000) {
    let seen = '';
    return this.until((e) => {
      if (e.type === 'serial') seen += Buffer.from(e.data as string, 'base64').toString();
      return seen.includes(text);
    }, ms);
  }
  outcome(pred: (o: Outcome) => boolean, ms?: number) {
    return this.until((e) => e.type === 'electrical' && pred(e.outcome as Outcome), ms);
  }
  run() {
    return fetch(`${this.path}/run`, { method: 'POST', headers: this.headers() }).then(answer);
  }
  stop() {
    return fetch(`${this.path}/stop`, { method: 'POST', headers: this.headers() }).then(answer);
  }
  end() {
    return fetch(this.path, { method: 'DELETE', headers: this.headers() }).then(answer);
  }
}

interface Outcome {
  components: Record<
    string,
    { current?: number; currents?: Record<string, number>; state?: Record<string, unknown> }
  >;
}

async function create(
  user: string,
  req: Fixture['request'],
  sha: string,
): Promise<{ a: Answer; s?: Session }> {
  const l = await fetch(`${BUILD}/v1/artifacts/${sha}/lease`, {
    method: 'POST',
    headers: as(user),
  }).then(answer);
  expect(l.status).toBe(200);
  const a = await fetch(`${HOST}/sessions`, {
    method: 'POST',
    headers: as(user, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      ...req,
      protocol: PROTOCOL,
      artifact: { sha256: sha },
      ticket: l.body.ticket,
    }),
  }).then(answer);
  if (a.status !== 201) return { a };
  return { a, s: new Session(user, a.body.sessionId as string, a.body.token as string, req) };
}

/** After the session ends: its QEMU unit is not active and its directory is gone. */
async function cleanedUp(s: Session) {
  const unit = `${N}-qemu@${s.id}.service`;
  for (let i = 0; i < 60; i++) {
    const active = sudo('systemctl', 'is-active', unit).stdout.trim() === 'active';
    const dir = sudo('test', '-e', `${SESSIONS}/s-${s.id}`).status === 0;
    if (!active && !dir) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(sudo('systemctl', 'is-active', unit).stdout.trim()).not.toBe('active');
  expect(sudo('test', '-e', `${SESSIONS}/s-${s.id}`).status).not.toBe(0);
}

async function endedState(s: Session) {
  for (let i = 0; i < 60; i++) {
    const st = await s.status();
    if (['ended', 'failed'].includes(st.body.state as string)) return st;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('session did not end');
}

/** The esp32-bench example with one part added across the supply; the bench's pad attachments. */
function withPart(
  type: 'component.capacitor' | 'display.led_matrix_8x8',
  [pos, neg]: [string, string],
): Fixture['request'] {
  const base = fixture('s10-bench-session.json').request;
  const doc = JSON.parse(
    readFileSync(new URL('../../app/src/examples/data/esp32-bench.json', import.meta.url), 'utf8'),
  ) as ProjectDocument;
  const c = addComponent(doc, type, { x: 4000, y: 900 });
  if (!c.ok) throw new Error(c.error);
  let d = c.doc;
  for (const [ac, at, bc, bt] of [
    ['PSU1', 'positive', c.id, pos],
    [c.id, neg, 'GND1', 'ref'],
  ] as const) {
    const w = addWire(
      d,
      { kind: 'terminal', component: ac, terminal: at },
      { kind: 'terminal', component: bc, terminal: bt },
    );
    if (!w.ok) throw new Error(w.error);
    d = w.doc;
  }
  return { ...base, circuit: createSnapshot(d) };
}

let program = '';
beforeAll(async () => {
  if (!HAVE) return;
  BUILD = await relay(`/run/${N}-build/api.sock`);
  HOST = await relay(`/run/${N}-runtime/api.sock`);
  const h = await (await fetch(`${HOST}/health`)).json();
  console.log(`${N} /health: ${JSON.stringify(h)} (expecting ${EXPECT})`);
  program = await buildProgram(u('build'), exampleProgram('esp32-motion-relay'));
  expect(exampleProgram('esp32-night-light')).toBe(exampleProgram('esp32-motion-relay'));
}, 600_000);
afterAll(() => {
  for (const r of relays) if (r.pid) sudo('pkill', '-TERM', '-P', String(r.pid));
});

describe.skipIf(!HAVE || EXPECT !== 'r1')(`Sprint 11 R1 on the deployed instance (${N})`, () => {
  it('esp32-motion-relay: motion pulls the relay in (LED + buzzer); no motion releases it; Stop cleans up', async () => {
    const req = fixture('r1-motion-relay-session.json').request;
    const { a, s } = await create(u('motion'), req, program);
    expect(a.status).toBe(201);
    try {
      expect((await s!.run()).status).toBe(202);
      await s!.serialIncludes('TBI-BANKS-SWEEP-DONE');
      expect(await s!.mirror('U2', { params: { motion: true } })).toMatchObject({
        status: 202,
        body: { accepted: true },
      });
      const on = await s!.outcome(
        (o) =>
          o.components.K1!.state!.energized === true &&
          (o.components.D2!.current ?? 0) > 1e-3 &&
          o.components.BZ1!.state!.sounding === true,
      );
      const oc = on.outcome as Outcome;
      expect(oc.components.Q1!.state).toMatchObject({ region: 'saturation' });
      console.log(
        `motion: D2 ${oc.components.D2!.current} A, BZ1 ${oc.components.BZ1!.current} A, coil ${oc.components.K1!.currents!.coil} A`,
      );
      expect((await s!.mirror('U2', { params: { motion: false } })).status).toBe(202);
      await s!.outcome(
        (o) =>
          o.components.K1!.state!.energized === false &&
          Math.abs(o.components.D2!.current ?? 0) < 1e-9,
      );
      expect((await s!.stop()).status).toBe(202);
      expect((await endedState(s!)).body.state).toBe('ended');
      await cleanedUp(s!);
    } finally {
      await s?.end();
    }
  }, 300_000);

  it('esp32-night-light: dark lights all three channels; bright turns them off; DELETE cleans up', async () => {
    const req = fixture('r1-night-light-session.json').request;
    const { a, s } = await create(u('night'), req, program);
    expect(a.status).toBe(201);
    try {
      expect((await s!.run()).status).toBe(202);
      await s!.serialIncludes('TBI-BANKS-SWEEP-DONE');
      const ch = (o: Outcome) => o.components.D1!.currents!;
      expect((await s!.mirror('LDR1', { params: { illuminance: 1 } })).status).toBe(202);
      const dark = await s!.outcome((o) =>
        ['red', 'green', 'blue'].every((k) => (ch(o)[k] ?? 0) > 1e-3),
      );
      console.log(`dark: D1 ${JSON.stringify(ch(dark.outcome as Outcome))}`);
      expect((await s!.mirror('LDR1', { params: { illuminance: 300 } })).status).toBe(202);
      await s!.outcome((o) =>
        ['red', 'green', 'blue'].every((k) => Math.abs(ch(o)[k] ?? 0) < 1e-9),
      );
    } finally {
      await s?.end();
    }
    await cleanedUp(s!);
  }, 300_000);

  it('command boundary: malformed, oversized, unknown, unsupported, out of range, rate-limited, foreign user', async () => {
    const req = fixture('r1-night-light-session.json').request;
    const { a, s } = await create(u('cmd'), req, program);
    expect(a.status).toBe(201);
    try {
      expect((await s!.run()).status).toBe(202);
      await s!.serialIncludes('TBI-BANKS-SWEEP-DONE');
      // Malformed structure: 400 (never applied).
      expect((await s!.command('{not json')).status).toBe(400);
      expect(
        (await s!.command({ category: 'mirror', seq: 1, projectRevision: 1, component: 'LDR1' }))
          .status,
      ).toBe(400);
      const bad = (params: unknown) => ({
        category: 'mirror',
        seq: ++s!.seq,
        projectRevision: ++s!.rev,
        component: 'LDR1',
        control: { params },
      });
      expect((await s!.command(bad({ 'Bad Key': 1 }))).status).toBe(400);
      expect(
        (await s!.command(bad(Object.fromEntries([...Array(9)].map((_, i) => [`k${i}`, 1])))))
          .status,
      ).toBe(400);
      // Oversized body: refused before parsing (8 KiB bound).
      expect((await s!.command(JSON.stringify({ pad: 'x'.repeat(9000) }))).status).toBe(413);
      // Well-formed but refused by the session: 409 with the explicit reason.
      expect(await s!.mirror('NOPE9', { params: { illuminance: 5 } })).toMatchObject({
        status: 409,
        body: { accepted: false, reason: 'unknown_component' },
      });
      expect(await s!.mirror('LDR1', { params: { motion: true } })).toMatchObject({
        status: 409,
        body: { reason: 'unsupported_control' },
      });
      expect(await s!.mirror('LDR1', { closed: true })).toMatchObject({
        status: 409,
        body: { reason: 'unsupported_control' },
      });
      expect(await s!.mirror('LDR1', { params: { illuminance: -5 } })).toMatchObject({
        status: 409,
        body: { reason: 'invalid_value' },
      });
      expect(await s!.mirror('LDR1', { params: { illuminance: 'dark' } })).toMatchObject({
        status: 409,
        body: { reason: 'invalid_value' },
      });
      // Another user: the session does not exist for them, even with its token.
      expect((await s!.status(u('other'))).status).toBe(404);
      expect(
        (
          await s!.command(
            {
              category: 'mirror',
              seq: 999,
              projectRevision: 9999,
              component: 'LDR1',
              control: { params: { illuminance: 1 } },
            },
            u('other'),
          )
        ).status,
      ).toBe(404);
      // The session is still running and still takes a valid change.
      expect((await s!.status()).body.state).toBe('running');
      await new Promise((r) => setTimeout(r, 1100)); // a fresh rate window
      // Rate: more than 50 commands within one second; the excess is refused explicitly.
      const flood = await Promise.all(
        [...Array(70)].map(() => s!.mirror('LDR1', { params: { illuminance: 300 } })),
      );
      const reasons = flood.map((f) => (f.body.accepted ? 'accepted' : f.body.reason));
      const limited = reasons.filter((r) => r === 'rate_limited').length;
      console.log(
        `flood of 70: ${limited} rate_limited, ${reasons.filter((r) => r === 'accepted').length} accepted`,
      );
      expect(limited).toBeGreaterThan(0);
      expect(
        reasons.every((r) => ['accepted', 'rate_limited', 'stale_revision'].includes(r as string)),
      ).toBe(true);
      await new Promise((r) => setTimeout(r, 1100));
      expect((await s!.mirror('LDR1', { params: { illuminance: 1 } })).status).toBe(202);
      expect((await s!.status()).body.state).toBe('running');
    } finally {
      await s?.end();
    }
    await cleanedUp(s!);
  }, 300_000);

  it.each([
    ['component.capacitor', 'a', 'b'],
    ['display.led_matrix_8x8', 'r1', 'c1'],
  ] as const)(
    '%s is refused for an ESP32 project before QEMU starts',
    async (type, pos, neg) => {
      const req = withPart(type, [pos, neg]);
      const { a, s } = await create(u(type.split('.')[1]!.replaceAll('_', '')), req, program);
      // Refused at create (catalog guard) — either as a 4xx or as a failed session; never running.
      if (s) {
        const st = await s.status();
        expect(st.body).toMatchObject({ state: 'failed', reason: 'electrical_error' });
        expect((st.body.detail as { code: string }).code).toBe('unsupported_component');
        expect((st.body.runtime as { pid: number | null }).pid).toBeNull();
        await s.end();
        await cleanedUp(s);
      } else expect(a.status).toBeGreaterThanOrEqual(400);
      console.log(`${type}: ${a.status} ${JSON.stringify(a.body.status ?? a.body)}`);
    },
    120_000,
  );

  it('admission under the real policy: the per-user quota, the host-wide limit; ownership', async () => {
    const req = fixture('r1-night-light-session.json').request;
    const live: Session[] = [];
    try {
      for (let i = 0; i < LIMITS.perUser; i++) {
        const { a, s } = await create(u('quota'), req, program);
        expect(a.status, `quota ${i}`).toBe(201);
        live.push(s!);
      }
      const again = await create(u('quota'), req, program);
      expect(again.a).toMatchObject({ status: 429, body: { error: 'session_quota' } });
      for (let i = 1; live.length < LIMITS.maxLive; i++) {
        const { a, s } = await create(u(`fill${i}`), req, program);
        expect(a.status, `fill${i}`).toBe(201);
        live.push(s!);
      }
      const other = await create(u('quota2'), req, program);
      expect(other.a).toMatchObject({ status: 503, body: { error: 'runtime_capacity' } });
      const s = live[0]!;
      expect((await s.status(u('quota2'))).status).toBe(404);
      expect(
        (await fetch(s.path, { method: 'DELETE', headers: s.headers(u('quota2')) })).status,
      ).toBe(404);
      expect((await s.status()).status).toBe(200);
    } finally {
      for (const s of live) await s.end();
    }
    for (const s of live) await cleanedUp(s);
  }, 300_000);
});

describe.skipIf(!HAVE || EXPECT !== 's10')(`a Sprint 10 host refuses R1 explicitly (${N})`, () => {
  it('the motion example: refused as an unsupported component (QEMU never starts)', async () => {
    const req = fixture('r1-motion-relay-session.json').request;
    const { a, s } = await create(u('s10m'), req, program);
    console.log(`s10 host, motion example: ${a.status} ${JSON.stringify(a.body.status ?? a.body)}`);
    if (s) {
      const st = await s.status();
      expect(st.body).toMatchObject({ state: 'failed', reason: 'electrical_error' });
      expect((st.body.detail as { code: string }).code).toBe('unsupported_component');
      await s.end();
      await cleanedUp(s);
    } else expect(a.status).toBeGreaterThanOrEqual(400);
  }, 120_000);

  it('a live-parameter command: refused as malformed (400), never applied', async () => {
    const req = fixture('s10-bench-session.json').request;
    const { a, s } = await create(u('s10p'), req, program);
    expect(a.status).toBe(201);
    try {
      expect((await s!.run()).status).toBe(202);
      const r = await s!.mirror('PSU1', { params: { setpointVoltage: 3 } });
      console.log(`s10 host, params command: ${r.status} ${JSON.stringify(r.body)}`);
      expect(r.status).toBe(400);
    } finally {
      await s?.end();
    }
    await cleanedUp(s!);
  }, 300_000);
});
