/**
 * Sprint 13 overnight security fixes, verified on a DEPLOYED instance (staging, then DEV): the
 * real gate identity header, build service, Session Host and sandboxed QEMU units.
 *
 *   TBI_S13_SEC_DEPLOYED=<instance: tbi | tbi-s8> npx vitest run --config vitest.runtime.config.ts \
 *     runtime/tests/s13-deployed-security.runtime.test.ts
 *
 * Non-destructive: fresh test principals; only the test's own builds and sessions (the crash case
 * kills only the test's own session QEMU unit, as c5-deployed's fault stage does). Nothing is
 * installed, restarted or reconfigured. Run on the previous release too: the report records which
 * controls that release lacks (the before/after evidence).
 *
 * Checks (the `pass` record):
 *  - buildOwnership: another user, or a wrong token, cannot read a build (404).
 *  - sourceLimitAtSubmit (audit #4): a sketch over 64 KiB is refused at submit with 413
 *    `source_too_large`, before any build record (no buildId); a body over 1 MiB is 413.
 *  - streamCap (audit #1): 4 event streams per session; the 5th is 429; a freed slot is reusable.
 *  - isolation: another user can neither read, stream, command nor end the session (404).
 *  - shutdownNonBlocking (audit #2): while a session ends, the host keeps answering (/health
 *    polled back to back): worst latency <= 150 ms.
 *  - crashContained: the session's QEMU unit killed -> the session reports a terminal state, the
 *    Session Host process survives (same PID), health answers, the user starts again.
 *  - noServerTextToClients (audit #6): no client-visible response or event of this run names a
 *    server path, and the failed state carries the reason code without an `error` text.
 *  - noLeftovers.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { recordEvidence } from '../harness/env.js';
import { Circuit } from '../host/tests/r1-support.js';
import { PROTOCOL } from '../host/protocol.js';

const INSTANCE = process.env.TBI_S13_SEC_DEPLOYED ?? '';
const sudo = (...args: string[]) => spawnSync('sudo', ['-n', ...args], { encoding: 'utf8' });
const HAVE =
  INSTANCE !== '' &&
  sudo('test', '-f', `/etc/systemd/system/${INSTANCE}-session-host.service`).status === 0;
const RUN = Date.now().toString(36);
const SERVER_PATH = /\/(srv|home|var|run|usr|etc|tmp|opt|root|proc)\//;

const relays: ChildProcess[] = [];
async function relay(socket: string): Promise<string> {
  const port = 5960 + Math.floor(Math.random() * 30);
  const code = `const net=require('node:net');net.createServer((c)=>{const u=net.connect(${JSON.stringify(socket)});c.pipe(u).pipe(c);u.on('error',()=>c.destroy());c.on('error',()=>u.destroy())}).listen(${port},'127.0.0.1',()=>console.log('ready'));`;
  const child = spawn('sudo', ['-n', process.execPath, '-e', code], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  relays.push(child);
  await new Promise<void>((r) => child.stdout!.on('data', () => r()));
  return `http://127.0.0.1:${port}`;
}
afterAll(() => {
  for (const r of relays)
    for (const c of spawnSync('pgrep', ['-P', String(r.pid)])
      .stdout.toString()
      .split(/\s+/)
      .filter(Boolean))
      sudo('kill', c);
});

const as = (user: string, extra: Record<string, string> = {}) => ({
  'x-forwarded-user': user,
  ...extra,
});
/** Every client-visible body of the run, for the server-path scan. */
const seen: string[] = [];
const json = async (r: Response) => {
  const text = await r.text();
  seen.push(text);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: r.status, body };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hostPid = () =>
  sudo(
    'systemctl',
    'show',
    '-p',
    'MainPID',
    '--value',
    `${INSTANCE}-session-host.service`,
  ).stdout.trim();

function circuit(): Circuit {
  const c = new Circuit().psu(3.3);
  const r = c.add('component.resistor');
  const d = c.add('component.led');
  c.ohms(r, 220).wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref');
  return c.pad(2, `${r}.a`);
}
const SKETCH = readFileSync(
  new URL('../firmware/arduino/TbiGpioProof/TbiGpioProof.ino', import.meta.url),
  'utf8',
);

describe('Sprint 13 security fixes on a deployed instance', () => {
  it.skipIf(!HAVE)(
    `${INSTANCE || '(no instance)'}: limits, isolation, shutdown, crash containment`,
    async () => {
      const BUILD = await relay(`/run/${INSTANCE}-build/api.sock`);
      const HOST = await relay(`/run/${INSTANCE}-runtime/api.sock`);
      const A = `s13sec-${RUN}-a`;
      const B = `s13sec-${RUN}-b`;
      const report: Record<string, unknown> = { instance: INSTANCE, run: RUN };
      report.health = (await json(await fetch(`${HOST}/health`))).body;

      // 1. One real build (unique source), and build ownership.
      const submit = (user: string, text: string) =>
        fetch(`${BUILD}/v1/builds`, {
          method: 'POST',
          headers: as(user, { 'content-type': 'application/json' }),
          body: JSON.stringify({
            protocol: 'tbi-lab.build/1',
            profile: 'esp32-arduino-3.3.12',
            files: [{ name: 'sketch.ino', text }],
          }),
        }).then(json);
      const s = await submit(A, `${SKETCH}\n// s13-sec ${RUN}\n`);
      expect([200, 202]).toContain(s.status);
      let sha = (s.body.result as { artifact?: { sha256: string } } | undefined)?.artifact?.sha256;
      const bid = s.body.buildId as string | undefined;
      const btok = s.body.token as string | undefined;
      let buildOwnership: Record<string, number> | null = null;
      if (bid && btok) {
        const st = (user: string, token: string) =>
          fetch(`${BUILD}/v1/builds/${bid}`, {
            headers: as(user, { authorization: `Bearer ${token}` }),
          }).then(json);
        buildOwnership = {
          foreignUser: (await st(B, btok)).status,
          wrongToken: (await st(A, `${btok.slice(0, -1)}${btok.endsWith('A') ? 'B' : 'A'}`)).status,
        };
        for (let k = 0; k < 600 && !sha; k++) {
          const r = await st(A, btok);
          if (r.body.state === 'succeeded')
            sha = (r.body.result as { artifact: { sha256: string } }).artifact.sha256;
          else if (r.body.state === 'failed') break;
          else await wait(500);
        }
      }
      expect(sha, 'the test build must succeed').toBeTruthy();
      report.buildOwnership = buildOwnership;

      // 2. Build request limits.
      const big = await submit(A, `${'/'.repeat(64 * 1024)}\n${SKETCH}`);
      const huge = await fetch(`${BUILD}/v1/builds`, {
        method: 'POST',
        headers: as(A, { 'content-type': 'application/json' }),
        body: JSON.stringify({ pad: 'x'.repeat(1100 * 1024) }),
      }).then(json);
      report.sourceLimit = {
        over64KiB: { status: big.status, error: big.body.error, buildId: big.body.buildId ?? null },
        over1MiB: { status: huge.status, error: huge.body.error },
      };

      // A session for user A.
      const start = async () => {
        const l = await fetch(`${BUILD}/v1/artifacts/${sha}/lease`, {
          method: 'POST',
          headers: as(A),
        }).then(json);
        const a = await fetch(`${HOST}/sessions`, {
          method: 'POST',
          headers: as(A, { 'content-type': 'application/json' }),
          body: JSON.stringify({
            ...circuit().request(sha!),
            protocol: PROTOCOL,
            artifact: { sha256: sha },
            ticket: l.body.ticket,
          }),
        }).then(json);
        expect(a.status, JSON.stringify(a.body)).toBe(201);
        const x = { id: a.body.sessionId as string, token: a.body.token as string };
        await fetch(`${HOST}/sessions/${x.id}/run`, {
          method: 'POST',
          headers: as(A, { authorization: `Bearer ${x.token}` }),
        });
        for (let k = 0; k < 60; k++) {
          const st = await status(x);
          if (st.body.state === 'running' && Number(st.body.simNs ?? 0) > 0) break;
          await wait(250);
        }
        return x;
      };
      const status = (x: { id: string; token: string }, user = A) =>
        fetch(`${HOST}/sessions/${x.id}`, {
          headers: as(user, { authorization: `Bearer ${x.token}` }),
        }).then(json);
      const openStream = async (x: { id: string; token: string }) => {
        const ctl = new AbortController();
        const r = await fetch(`${HOST}/sessions/${x.id}/events?after=0`, {
          headers: as(A, { authorization: `Bearer ${x.token}` }),
          signal: ctl.signal,
        });
        if (r.status !== 200) seen.push(await r.text());
        return { status: r.status, ctl, r };
      };

      // 3. Event-stream cap and isolation, on session 1.
      const s1 = await start();
      const streams = [];
      for (let k = 0; k < 5; k++) streams.push(await openStream(s1));
      const statuses = streams.map((x) => x.status);
      streams[0]!.ctl.abort();
      await wait(300);
      const again = await openStream(s1);
      report.streamCap = { firstFive: statuses, afterFreeingOne: again.status };
      for (const x of [...streams, again]) x.ctl.abort();
      report.isolation = {
        status: (await status(s1, B)).status,
        events: await fetch(`${HOST}/sessions/${s1.id}/events?after=0`, {
          headers: as(B, { authorization: `Bearer ${s1.token}` }),
        }).then((q) => {
          void q.body?.cancel();
          return q.status;
        }),
        command: (
          await fetch(`${HOST}/sessions/${s1.id}/commands`, {
            method: 'POST',
            headers: as(B, {
              authorization: `Bearer ${s1.token}`,
              'content-type': 'application/json',
            }),
            body: JSON.stringify({
              category: 'mirror',
              seq: 1,
              projectRevision: 999,
              component: 'PSU1',
              control: { setpointVoltage: 1 },
            }),
          }).then(json)
        ).status,
        end: (
          await fetch(`${HOST}/sessions/${s1.id}`, {
            method: 'DELETE',
            headers: as(B, { authorization: `Bearer ${s1.token}` }),
          }).then(json)
        ).status,
        ownerStillRunning: (await status(s1)).body.state === 'running',
      };

      // 4. Non-blocking shutdown: /health back to back while the session ends.
      const lat: number[] = [];
      let polling = true;
      const poller = (async () => {
        while (polling) {
          const t = performance.now();
          await fetch(`${HOST}/health`).then((r) => r.text());
          lat.push(performance.now() - t);
        }
      })();
      await wait(500);
      const t0 = performance.now();
      const del = await fetch(`${HOST}/sessions/${s1.id}`, {
        method: 'DELETE',
        headers: as(A, { authorization: `Bearer ${s1.token}` }),
      }).then(json);
      const deleteMs = performance.now() - t0;
      await wait(2000);
      polling = false;
      await poller;
      const sorted = [...lat].sort((a, b) => a - b);
      report.shutdown = {
        deleteStatus: del.status,
        deleteMs: Math.round(deleteMs),
        healthRequests: lat.length,
        healthP50Ms: Math.round(sorted[Math.floor(sorted.length / 2)] ?? -1),
        healthMaxMs: Math.round(sorted.at(-1) ?? -1),
      };

      // 5. Crash containment: kill this session's QEMU unit.
      const pidBefore = hostPid();
      const s2 = await start();
      const unit = `${INSTANCE}-qemu@${s2.id}.service`;
      sudo('systemctl', 'kill', '-s', 'KILL', unit);
      let terminal: Record<string, unknown> | null = null;
      for (let k = 0; k < 60 && !terminal; k++) {
        const st = await status(s2);
        if (['failed', 'ended'].includes(st.body.state as string)) terminal = st.body;
        else await wait(500);
      }
      // The session's own event log, replayed (it closes at the terminal state).
      const ev = await openStream(s2);
      const evText = ev.status === 200 ? await ev.r.text() : '';
      seen.push(evText);
      const stateEvents = evText
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>)
        .filter((e) => e.type === 'state');
      const last = stateEvents.at(-1) ?? null;
      const s3 = await start(); // the user starts again
      await fetch(`${HOST}/sessions/${s3.id}`, {
        method: 'DELETE',
        headers: as(A, { authorization: `Bearer ${s3.token}` }),
      });
      report.crash = {
        reported: terminal ? { state: terminal.state, reason: terminal.reason } : null,
        lastStateEvent: last,
        hostPidBefore: pidBefore,
        hostPidAfter: hostPid(),
        healthAfter: (await fetch(`${HOST}/health`)).status,
        restarted: true,
      };

      // 6. Leftovers.
      let leftovers = { qemuUnits: -1, sessionDirs: -1 };
      for (let k = 0; k < 40; k++) {
        leftovers = {
          qemuUnits: sudo(
            'systemctl',
            'list-units',
            '--plain',
            '--no-legend',
            '--state=active',
            `${INSTANCE}-qemu@*`,
          )
            .stdout.trim()
            .split('\n')
            .filter(Boolean).length,
          sessionDirs: sudo(
            'find',
            `/var/lib/${INSTANCE}-runtime/sessions`,
            '-mindepth',
            '1',
            '-maxdepth',
            '1',
          )
            .stdout.trim()
            .split('\n')
            .filter(Boolean).length,
        };
        if (!leftovers.qemuUnits && !leftovers.sessionDirs) break;
        await wait(500);
      }
      report.leftovers = leftovers;

      const sl = report.sourceLimit as {
        over64KiB: { status: number; error: unknown; buildId: unknown };
        over1MiB: { status: number };
      };
      const iso = report.isolation as Record<string, unknown>;
      const sd = report.shutdown as { deleteStatus: number; healthMaxMs: number };
      const cr = report.crash as {
        hostPidBefore: string;
        hostPidAfter: string;
        healthAfter: number;
      };
      const lastDetail = (last?.detail ?? {}) as Record<string, unknown>;
      const pass = {
        buildOwnership:
          buildOwnership !== null &&
          buildOwnership.foreignUser === 404 &&
          buildOwnership.wrongToken === 404,
        sourceLimitAtSubmit:
          sl.over64KiB.status === 413 &&
          sl.over64KiB.error === 'source_too_large' &&
          sl.over64KiB.buildId === null &&
          sl.over1MiB.status === 413,
        streamCap:
          statuses.slice(0, 4).every((x) => x === 200) &&
          statuses[4] === 429 &&
          again.status === 200,
        isolation:
          iso.status === 404 &&
          iso.events === 404 &&
          iso.command === 404 &&
          iso.end === 404 &&
          iso.ownerStillRunning === true,
        shutdownNonBlocking: sd.deleteStatus < 300 && sd.healthMaxMs <= 150,
        crashContained:
          terminal !== null &&
          cr.hostPidBefore !== '' &&
          cr.hostPidBefore === cr.hostPidAfter &&
          cr.healthAfter === 200,
        noServerTextToClients: seen.every((t) => !SERVER_PATH.test(t)) && !('error' in lastDetail),
        noLeftovers: leftovers.qemuUnits === 0 && leftovers.sessionDirs === 0,
      };
      report.pass = pass;
      recordEvidence(`s13-deployed-security-${INSTANCE}`, report);
      console.log(JSON.stringify(report, null, 2));
      expect(pass).toEqual(Object.fromEntries(Object.keys(pass).map((k) => [k, true])));
    },
    900_000,
  );
});
