/**
 * Sprint 8 closure: the sandboxed runtime's task limit (TasksMax of the QEMU unit) against QEMU's
 * real thread use, on the staging instance or, with TBI_S8_INSTANCE=tbi, the deployed dev-lab
 * instance (fresh test principals per run). Skipped unless that instance is running and
 * passwordless sudo is available.
 *
 * Observed on dev-lab (2026-10-05): a session's QEMU was killed (SIGTRAP) 5 s after start when
 * the kernel rejected a thread at TasksMax=32. QEMU idles at 4 tasks; about 5 s into a run the
 * emulated flash is read in a burst and QEMU's block I/O thread pool (default at most 64
 * workers, idle ones exit after ~10 s) spawns workers for it: 6–24 tasks observed. The legitimate ceiling is therefore
 * 4 + 64 + 1 (the unit's ExecStopPost) = 69 tasks, whatever a few sample runs show.
 *
 * Proves:
 * - the unit's limit covers that ceiling with headroom, and is still a finite bound;
 * - real sessions of the owner's example (input bursts included) never hit the limit, stay
 *   running, and after Stop leave no unit, cgroup or process behind, cycle after cycle.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const N = process.env.TBI_S8_INSTANCE ?? 'tbi-s8';
const CYCLES = Number(process.env.TBI_S8_QEMU_CYCLES ?? 5);
const run = Date.now().toString(36);
const sudo = (...args: string[]) => spawnSync('sudo', ['-n', ...args], { encoding: 'utf8' });
const HAVE = existsSync(`/etc/systemd/system/${N}-build.service`) && sudo('true').status === 0;
const SLICE = `/sys/fs/cgroup/system.slice/system-${N.replaceAll('-', '\\x2d')}\\x2dqemu.slice`;

/** QEMU's legitimate maximum: idle threads + its block thread pool's default maximum + ExecStopPost. */
const QEMU_BASELINE = 4;
const QEMU_THREAD_POOL_MAX = 64;
const QEMU_CEILING = QEMU_BASELINE + QEMU_THREAD_POOL_MAX + 1;
/** Spare tasks the limit must keep above that ceiling. */
const HEADROOM = 8;

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/s8-input-echo-session.json', import.meta.url), 'utf8'),
) as {
  profile: string;
  files: { name: string; text: string }[];
  request: Record<string, unknown>;
};

const relays: ChildProcess[] = [];
let BUILD = '';
let HOST = '';

/** A root-run relay: 127.0.0.1:<port> → unix socket (the gate's role for this test). */
async function relay(socket: string): Promise<string> {
  const port = 4600 + Math.floor(Math.random() * 300);
  const code = `
    const net = require('node:net');
    net.createServer((c) => { const u = net.connect(${JSON.stringify(socket)}); c.pipe(u).pipe(c);
      u.on('error', () => c.destroy()); c.on('error', () => u.destroy()); })
      .listen(${port}, '127.0.0.1', () => console.log('ready'));`;
  const child = spawn('sudo', ['-n', process.execPath, '-e', code], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  relays.push(child);
  await new Promise<void>((resolve) => child.stdout!.on('data', () => resolve()));
  return `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  if (!HAVE) return;
  BUILD = await relay(`/run/${N}-build/api.sock`);
  HOST = await relay(`/run/${N}-runtime/api.sock`);
});
afterAll(() => {
  // The relays run as root: stop them through sudo, by their exact process ids.
  for (const r of relays) if (r.pid) sudo('pkill', '-TERM', '-P', String(r.pid));
});

const as = (user: string, extra: Record<string, string> = {}) => ({
  'x-forwarded-user': user,
  ...extra,
});
const tasksMax = () =>
  Number(
    sudo(
      'systemctl',
      'show',
      '-p',
      'TasksMax',
      '--value',
      `${N}-qemu@${'0'.repeat(32)}.service`,
    ).stdout.trim(),
  );

async function buildSketch(user: string): Promise<string> {
  const r = await fetch(`${BUILD}/v1/builds`, {
    method: 'POST',
    headers: as(user, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      protocol: 'tbi-lab.build/1',
      profile: fixture.profile,
      files: fixture.files,
    }),
  });
  const body = (await r.json()) as {
    build?: { artifact: { sha256: string } };
    buildId?: string;
    token?: string;
  };
  if (r.status === 200) return body.build!.artifact.sha256;
  expect(r.status).toBe(202);
  for (;;) {
    await new Promise((res) => setTimeout(res, 1000));
    const s = (await (
      await fetch(`${BUILD}/v1/builds/${body.buildId}`, {
        headers: as(user, { authorization: `Bearer ${body.token}` }),
      })
    ).json()) as { state: string; result?: { ok: boolean; artifact?: { sha256: string } } };
    if (s.state === 'succeeded' || s.state === 'failed') {
      expect(s.result?.ok).toBe(true);
      return s.result!.artifact!.sha256;
    }
  }
}

describe.skipIf(!HAVE)('Sprint 8 runtime task limit (real QEMU under the deployed unit)', () => {
  it('the QEMU unit’s TasksMax covers QEMU’s own ceiling with headroom, and stays finite', () => {
    const limit = tasksMax();
    expect(Number.isFinite(limit)).toBe(true); // "infinity" parses to NaN
    expect(limit).toBeGreaterThanOrEqual(QEMU_CEILING + HEADROOM);
    expect(limit).toBeLessThanOrEqual(128);
  });

  it(
    'real sessions with input bursts never hit the limit and leave nothing behind',
    { timeout: 120_000 + CYCLES * 60_000 },
    async () => {
      const limit = tasksMax();
      const sha = await buildSketch(`qtasks-${run}-build`);
      const unitsBefore = sudo(
        'systemctl',
        'list-units',
        '--no-legend',
        '--state=active',
        `${N}-qemu@*`,
      ).stdout.trim();
      const peaks: number[] = [];
      for (let i = 0; i < CYCLES; i++) {
        const user = `qtasks-${run}-${i}`; // fresh principal per cycle (session rate limits)
        const lease = (await (
          await fetch(`${BUILD}/v1/artifacts/${sha}/lease`, { method: 'POST', headers: as(user) })
        ).json()) as { ticket: string };
        const created = await fetch(`${HOST}/sessions`, {
          method: 'POST',
          headers: as(user, { 'content-type': 'application/json' }),
          body: JSON.stringify({
            ...fixture.request,
            artifact: { sha256: sha },
            ticket: lease.ticket,
          }),
        });
        expect(created.status).toBe(201);
        const { sessionId, token } = (await created.json()) as { sessionId: string; token: string };
        const auth = as(user, { authorization: `Bearer ${token}` });
        const unit = `${N}-qemu@${sessionId}.service`;
        const cgroup = `${SLICE}/${unit}`;
        expect(
          (await fetch(`${HOST}/sessions/${sessionId}/run`, { method: 'POST', headers: auth }))
            .status,
        ).toBe(202);
        const state = async () =>
          (
            (await (await fetch(`${HOST}/sessions/${sessionId}`, { headers: auth })).json()) as {
              state: string;
            }
          ).state;
        for (let t = 0; t < 100 && (await state()) !== 'running'; t++)
          await new Promise((r) => setTimeout(r, 100));
        expect(await state()).toBe('running');
        const pid = sudo('systemctl', 'show', '-p', 'MainPID', '--value', unit).stdout.trim();
        const running = Date.now();
        // Idle, then inputs, held past the flash burst (~5.4 s into the run).
        await new Promise((r) => setTimeout(r, 3000));
        let seq = 1;
        for (let k = 0; k < 10; k++)
          for (const action of ['press', 'release'] as const) {
            await fetch(`${HOST}/sessions/${sessionId}/commands`, {
              method: 'POST',
              headers: { ...auth, 'content-type': 'application/json' },
              body: JSON.stringify({ seq: seq++, category: 'transient', action, component: 'SW2' }),
            });
            await new Promise((r) => setTimeout(r, 200));
          }
        await new Promise((r) => setTimeout(r, Math.max(0, 10_000 - (Date.now() - running))));
        expect(await state()).toBe('running');
        const peak = Number(sudo('cat', `${cgroup}/pids.peak`).stdout.trim());
        expect(sudo('cat', `${cgroup}/pids.events`).stdout).toMatch(/^max 0$/m); // no fork rejected
        expect(peak).toBeGreaterThanOrEqual(QEMU_BASELINE);
        expect(peak).toBeLessThanOrEqual(QEMU_CEILING);
        expect(peak).toBeLessThanOrEqual(limit - HEADROOM);
        peaks.push(peak);

        // Stop: the unit, its cgroup and every QEMU task are gone.
        await fetch(`${HOST}/sessions/${sessionId}`, { method: 'DELETE', headers: auth });
        expect(sudo('systemctl', 'is-active', unit).stdout.trim()).not.toBe('active');
        for (let t = 0; t < 30 && existsSync(cgroup); t++)
          await new Promise((r) => setTimeout(r, 100));
        expect(existsSync(cgroup)).toBe(false);
        expect(sudo('test', '-e', `/proc/${pid}`).status).not.toBe(0);
      }
      // Nothing accumulated across the cycles.
      expect(
        sudo(
          'systemctl',
          'list-units',
          '--no-legend',
          '--state=active',
          `${N}-qemu@*`,
        ).stdout.trim(),
      ).toBe(unitsBefore);
      console.log(`QEMU task peaks over ${CYCLES} sessions (limit ${limit}): ${peaks.join(', ')}`);
    },
  );
});
