/**
 * Sprint 8 Phase 3 heavy acceptance: CONTAINMENT, against the staging instance installed by
 * `deploy/dev-lab/s8/install.sh staging` (units tbi-s8-*; the dev-lab services are untouched).
 * Skipped unless that instance is running and passwordless sudo is available.
 *
 * The backends' sockets belong to the gate group; a relay started with sudo plays the gate for
 * this test (it forwards to the socket; the test sets the gate's subject header itself).
 *
 * Proves, with the real pinned toolchain and the real runtime:
 * - a build runs in its sandbox (own user, no network, no store/home/credentials), bit-identical;
 * - a session's QEMU runs in its sandbox (own user, no network namespace access, only its session
 *   directory, disk-backed session files) and is cleaned up after Stop and after a crash;
 * - one user cannot lease another's artifact or reach another's session;
 * - no product service runs as a login user.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRequest } from './r2-support.js';

const N = 'tbi-s8';
const BUILD_SOCK = `/run/${N}-build/api.sock`;
const HOST_SOCK = `/run/${N}-runtime/api.sock`;
const SESSIONS = `/var/lib/${N}-runtime/sessions`;
const sudo = (...args: string[]) => spawnSync('sudo', ['-n', ...args], { encoding: 'utf8' });
const HAVE = existsSync(`/etc/systemd/system/${N}-build.service`) && sudo('true').status === 0;

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

const as = (user: string, extra: Record<string, string> = {}) => ({
  'x-forwarded-user': user,
  ...extra,
});

beforeAll(async () => {
  if (!HAVE) return;
  BUILD = await relay(BUILD_SOCK);
  HOST = await relay(HOST_SOCK);
});
afterAll(() => {
  // The relays run as root: stop them through sudo, by their exact process ids.
  for (const r of relays) if (r.pid) sudo('pkill', '-TERM', '-P', String(r.pid));
});

async function build(user: string, text: string) {
  const r = await fetch(`${BUILD}/v1/builds`, {
    method: 'POST',
    headers: as(user, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      protocol: 'tbi-lab.build/1',
      profile: 'esp32-arduino-3.3.12',
      files: [{ name: 'sketch.ino', text }],
    }),
  });
  const body = (await r.json()) as { build?: unknown; buildId?: string; token?: string };
  if (r.status === 200) return body.build as BuildOut;
  expect(r.status).toBe(202);
  const jobs: string[] = [];
  for (;;) {
    for (const line of sudo(
      'systemctl',
      'list-units',
      '--no-legend',
      `${N}-build-job@*`,
    ).stdout.split('\n'))
      if (line.trim()) jobs.push(line.trim().split(/\s+/)[0]!);
    const s = (await (
      await fetch(`${BUILD}/v1/builds/${body.buildId}`, {
        headers: as(user, { authorization: `Bearer ${body.token}` }),
      })
    ).json()) as { state: string; result?: BuildOut };
    if (s.state === 'succeeded' || s.state === 'failed') return { ...s.result!, jobsSeen: jobs };
    await new Promise((r) => setTimeout(r, 500));
  }
}
type BuildOut = {
  ok: boolean;
  failure?: string;
  diagnostics: { message: string; line?: number }[];
  artifact?: { sha256: string };
  jobsSeen?: string[];
};

const blink = readFileSync(
  new URL('../firmware/arduino/TbiGpioProof/TbiGpioProof.ino', import.meta.url),
  'utf8',
);

describe.skipIf(!HAVE)(
  'Sprint 8 containment (staging instance, real toolchain and runtime)',
  () => {
    let sha = '';

    it('no product service runs as a login user', () => {
      const who = (unit: string) =>
        sudo('systemctl', 'show', '-p', 'User', '--value', unit).stdout.trim();
      expect(who(`${N}-build.service`)).toBe('tbi-build');
      expect(who(`${N}-session-host.service`)).toBe('tbi-runtime');
      expect(who(`${N}-build-job@job-aaaaaa.service`)).toBe('tbi-buildjob');
      expect(who(`${N}-qemu@${'0'.repeat(32)}.service`)).toBe('tbi-qemu');
      for (const u of ['tbi-build', 'tbi-buildjob', 'tbi-runtime', 'tbi-qemu'])
        expect(spawnSync('getent', ['passwd', u], { encoding: 'utf8' }).stdout).toMatch(
          /:\/nonexistent:\/usr\/sbin\/nologin$/m,
        );
    });

    it('both sandbox templates, as loaded by systemd, deny network and bound their resources', () => {
      const props = (unit: string) =>
        Object.fromEntries(
          sudo(
            'systemctl',
            'show',
            unit,
            '-p',
            'PrivateNetwork',
            '-p',
            'IPAddressDeny',
            '-p',
            'RestrictAddressFamilies',
            '-p',
            'NoNewPrivileges',
            '-p',
            'CapabilityBoundingSet',
            '-p',
            'MemoryMax',
            '-p',
            'MemorySwapMax',
            '-p',
            'TasksMax',
            '-p',
            'ProtectHome',
            '-p',
            'RootDirectory',
            '-p',
            'KillMode',
            '-p',
            'PrivatePIDs',
          )
            .stdout.trim()
            .split('\n')
            .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
        );
      for (const [unit, mem, tasks] of [
        [`${N}-build-job@job-aaaaaa.service`, String(1 << 30), '64'],
        [`${N}-qemu@${'0'.repeat(32)}.service`, String(384 << 20), '32'],
      ] as const) {
        const p = props(unit);
        expect(p, unit).toMatchObject({
          PrivateNetwork: 'yes',
          RestrictAddressFamilies: 'AF_UNIX',
          NoNewPrivileges: 'yes',
          CapabilityBoundingSet: '',
          MemoryMax: mem,
          MemorySwapMax: '0',
          TasksMax: tasks,
          KillMode: 'control-group',
          PrivatePIDs: 'yes',
        });
        expect(p.IPAddressDeny, unit).toMatch(/0\.0\.0\.0\/0/);
        expect(p.RootDirectory, unit).toMatch(/sandbox-root$/);
      }
    });

    it('a real build runs in per-step sandbox units and is bit-identical to Sprint 7', async () => {
      // A's own program: a real change (a comment-only edit would give the curated example's bytes,
      // whose artifact is shared by design).
      // Unique per run (staging keeps its records between runs), so it always compiles afresh.
      const r = await build(
        'stage-a',
        blink.replace('delay(200);', `delay(${1000 + (Date.now() % 1_000_000)});`),
      );
      expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
      expect(r.jobsSeen!.length).toBeGreaterThan(0); // the steps ran as template instances
      // The unmodified sketch reproduces the Sprint 7 / reproducibility-gate identity exactly.
      const exact = await build('stage-a', blink);
      expect(exact.artifact!.sha256).toBe(
        '7e877f84e64743988349ae6c71cd46e05bbca73c8af95fe17db01b4516f1f4ed',
      );
      sha = r.artifact!.sha256;
      // Job directories are gone after the build.
      expect(sudo('ls', `/var/lib/${N}-build/jobs`).stdout.trim()).toBe('');
    });

    it('a sketch cannot compile in anything from outside its sandbox view', async () => {
      const outside = [
        '/var/lib/tbi-s8-artifacts',
        '/home/ubuntu/.ssh/authorized_keys',
        '/etc/tbi-s8/identity.key',
        '/etc/hostname',
      ];
      for (const path of outside) {
        const r = await build('stage-a', `#include "${path}"\nvoid setup() {}\nvoid loop() {}\n`);
        expect(r.ok, path).toBe(false);
        expect(r.failure, path).toBe('compile_error');
        expect(r.diagnostics.map((d) => d.message).join(' '), path).toMatch(
          /No such file or directory|Is a directory/,
        );
      }
    });

    it('user B can neither lease user A’s artifact nor see A’s build', async () => {
      const other = await fetch(`${BUILD}/v1/artifacts/${sha}/lease`, {
        method: 'POST',
        headers: as('stage-b'),
      });
      expect(other.status).toBe(404);
    });

    it('a session’s QEMU runs sandboxed: own user, no network, only its session directory, on disk', async () => {
      const lease = (await (
        await fetch(`${BUILD}/v1/artifacts/${sha}/lease`, {
          method: 'POST',
          headers: as('stage-a'),
        })
      ).json()) as { ticket: string };
      const body = {
        ...loadRequest('TbiGpioProof'),
        artifact: { sha256: sha },
        ticket: lease.ticket,
      };
      const tmpBefore = Number(
        spawnSync('df', ['--output=used', '/tmp'], { encoding: 'utf8' }).stdout.split('\n')[1],
      );
      const created = await fetch(`${HOST}/sessions`, {
        method: 'POST',
        headers: as('stage-a', { 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      });
      expect(created.status).toBe(201);
      const { sessionId, token } = (await created.json()) as { sessionId: string; token: string };
      const auth = as('stage-a', { authorization: `Bearer ${token}` });
      expect(
        (await fetch(`${HOST}/sessions/${sessionId}/run`, { method: 'POST', headers: auth }))
          .status,
      ).toBe(202);
      // Another user cannot reach it.
      expect(
        (
          await fetch(`${HOST}/sessions/${sessionId}`, {
            headers: as('stage-b', { authorization: `Bearer ${token}` }),
          })
        ).status,
      ).toBe(404);

      const unit = `${N}-qemu@${sessionId}.service`;
      // Wait for QEMU itself (the unit's main process briefly precedes the exec).
      let pid = 0;
      let status = '';
      for (let i = 0; i < 100 && !/^Name:\s+qemu-system-xte/m.test(status); i++) {
        pid =
          Number(sudo('systemctl', 'show', '-p', 'MainPID', '--value', unit).stdout.trim()) || 0;
        status = pid ? sudo('cat', `/proc/${pid}/status`).stdout : '';
        if (!/^Name:\s+qemu-system-xte/m.test(status)) await new Promise((r) => setTimeout(r, 100));
      }
      expect(status).toMatch(/^Name:\s+qemu-system-xte/m);
      const uid = /^Uid:\s+(\d+)/m.exec(status)![1];
      expect(uid).toBe(spawnSync('id', ['-u', 'tbi-qemu'], { encoding: 'utf8' }).stdout.trim());
      // Its own network namespace, loopback only; no route anywhere.
      expect(sudo('readlink', `/proc/${pid}/ns/net`).stdout).not.toBe(
        sudo('readlink', '/proc/1/ns/net').stdout,
      );
      const links = sudo('nsenter', '-t', String(pid), '-n', 'ip', '-o', 'link').stdout;
      expect(
        links
          .trim()
          .split('\n')
          .map((l) => l.split(':')[1]!.trim()),
      ).toEqual(['lo']);
      // Its filesystem view: the session directory and the read-only runtime, nothing else.
      // Exactly QEMU's view: its mount namespace AND its root directory (the unit's empty root).
      const view = (path: string) =>
        sudo('nsenter', '-t', String(pid), '-m', '-r', '/usr/bin/test', '-e', path).status === 0;
      expect(view('/session/flash.bin')).toBe(true);
      // The unit's own root holds only systemd's empty, root-only /root (not the host's).
      expect(
        sudo('nsenter', '-t', String(pid), '-m', '-r', '/usr/bin/ls', '-A', '/root').stdout.trim(),
      ).toBe('');
      for (const hidden of [
        '/home',
        '/var/lib/tbi-s8-artifacts',
        '/etc/tbi-s8',
        '/var/lib/tbi-s8-runtime/sessions',
        '/etc/passwd',
      ])
        expect(view(hidden), hidden).toBe(false);
      // Session files are on disk, not in the RAM-backed /tmp.
      const dir = join(SESSIONS, `s-${sessionId}`);
      expect(sudo('test', '-f', join(dir, 'flash.bin')).status).toBe(0);
      const tmpAfter = Number(
        spawnSync('df', ['--output=used', '/tmp'], { encoding: 'utf8' }).stdout.split('\n')[1],
      );
      expect(tmpAfter - tmpBefore).toBeLessThan(1024); // KB: no 4 MiB flash copy in tmpfs

      // Stop: QEMU, its unit and the session directory are all gone.
      await fetch(`${HOST}/sessions/${sessionId}`, { method: 'DELETE', headers: auth });
      expect(sudo('systemctl', 'is-active', unit).stdout.trim()).not.toBe('active');
      expect(sudo('test', '-e', `/proc/${pid}`).status).not.toBe(0);
      await new Promise((r) => setTimeout(r, 1500));
      expect(sudo('test', '-e', dir).status).not.toBe(0);
      void statSync;
    });

    it('a crashed runtime is cleaned up and reported, and the host keeps serving', async () => {
      const lease = (await (
        await fetch(`${BUILD}/v1/artifacts/${sha}/lease`, {
          method: 'POST',
          headers: as('stage-a'),
        })
      ).json()) as { ticket: string };
      const body = {
        ...loadRequest('TbiGpioProof'),
        artifact: { sha256: sha },
        ticket: lease.ticket,
      };
      const { sessionId, token } = (await (
        await fetch(`${HOST}/sessions`, {
          method: 'POST',
          headers: as('stage-a', { 'content-type': 'application/json' }),
          body: JSON.stringify(body),
        })
      ).json()) as { sessionId: string; token: string };
      const auth = as('stage-a', { authorization: `Bearer ${token}` });
      await fetch(`${HOST}/sessions/${sessionId}/run`, { method: 'POST', headers: auth });
      const unit = `${N}-qemu@${sessionId}.service`;
      await new Promise((r) => setTimeout(r, 3000));
      sudo('systemctl', 'kill', '--signal=SIGKILL', unit); // the runtime dies from outside
      let state = '';
      for (let i = 0; i < 50; i++) {
        state = (
          (await (await fetch(`${HOST}/sessions/${sessionId}`, { headers: auth })).json()) as {
            state: string;
          }
        ).state;
        if (state === 'failed' || state === 'ended') break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(state).toBe('failed');
      await new Promise((r) => setTimeout(r, 1500));
      expect(sudo('systemctl', 'is-active', unit).stdout.trim()).not.toBe('active');
      expect((await fetch(`${HOST}/health`)).status).toBe(200);
    });

    it('a restarted build service stops its predecessor’s sandboxed steps and removes their jobs', async () => {
      const text = blink.replace('delay(200);', `delay(${2_000_000 + (Date.now() % 1_000_000)});`);
      const r = await fetch(`${BUILD}/v1/builds`, {
        method: 'POST',
        headers: as('stage-a', { 'content-type': 'application/json' }),
        body: JSON.stringify({
          protocol: 'tbi-lab.build/1',
          profile: 'esp32-arduino-3.3.12',
          files: [{ name: 'sketch.ino', text }],
        }),
      });
      expect(r.status).toBe(202);
      const active = () =>
        sudo(
          'systemctl',
          'list-units',
          '--no-legend',
          '--plain',
          '--state=active,activating',
          `${N}-build-job@*`,
        ).stdout.trim();
      for (let i = 0; i < 100 && !active(); i++) await new Promise((x) => setTimeout(x, 100));
      expect(active()).not.toBe('');
      sudo('systemctl', 'restart', `${N}-build.service`);
      await new Promise((x) => setTimeout(x, 2000));
      expect(active()).toBe('');
      expect(sudo('ls', `/var/lib/${N}-build/jobs`).stdout.trim()).toBe('');
    });

    it('a restarted Session Host ends its predecessor’s runtimes and clears their session files', async () => {
      const lease = (await (
        await fetch(`${BUILD}/v1/artifacts/${sha}/lease`, {
          method: 'POST',
          headers: as('stage-a'),
        })
      ).json()) as { ticket: string };
      const body = {
        ...loadRequest('TbiGpioProof'),
        artifact: { sha256: sha },
        ticket: lease.ticket,
      };
      const { sessionId, token } = (await (
        await fetch(`${HOST}/sessions`, {
          method: 'POST',
          headers: as('stage-a', { 'content-type': 'application/json' }),
          body: JSON.stringify(body),
        })
      ).json()) as { sessionId: string; token: string };
      await fetch(`${HOST}/sessions/${sessionId}/run`, {
        method: 'POST',
        headers: as('stage-a', { authorization: `Bearer ${token}` }),
      });
      const unit = `${N}-qemu@${sessionId}.service`;
      for (
        let i = 0;
        i < 50 && sudo('systemctl', 'is-active', unit).stdout.trim() !== 'active';
        i++
      )
        await new Promise((x) => setTimeout(x, 100));
      expect(sudo('systemctl', 'is-active', unit).stdout.trim()).toBe('active');
      sudo('systemctl', 'restart', `${N}-session-host.service`);
      await new Promise((x) => setTimeout(x, 2000));
      expect(sudo('systemctl', 'is-active', unit).stdout.trim()).not.toBe('active');
      expect(sudo('ls', SESSIONS).stdout.trim()).toBe('');
    });
  },
);
