/**
 * Sprint 13 H5: five-session capacity acceptance against a DEPLOYED instance (the alpha VM, or the
 * staging instance for harness validation): the real gate identity header, the deployed build
 * service and Session Host, the per-session sandboxed QEMU units (cgroup CPU, memory and task
 * limits), the installed policy and admission. The in-process C-5 harness (c5-capacity) measures
 * the same quantities without the sandbox; only this one can accept the alpha host.
 *
 * Measurement only, non-destructive: fresh test principals per run, every session and build is the
 * harness's own, nothing is installed, restarted or reconfigured. (Fault injection, if enabled,
 * kills only the harness's own session QEMU unit.)
 *
 *   TBI_C5_DEPLOYED=<instance: tbi | tbi-s8> TBI_C5_N=5 TBI_C5_SECONDS=600 [TBI_C5_FAULTS=1]
 *   [TBI_C5_BUILD_EVERY=600] npx vitest run --config vitest.runtime.config.ts \
 *     runtime/tests/c5-deployed.runtime.test.ts
 *
 * Phases:
 *  1. Builds: the N users submit their workload sketch AT ONCE (each made unique so it is really
 *     compiled, never a cache hit) to the deployed build service; worst completion <= 120 s, none
 *     refused, all succeed.
 *  2. Sessions: each user leases its artifact and creates and runs a session (workload mix: sonar
 *     R2, dht R2, gpio R1, lcd R3, gpio); startup latency (create -> running with simulation time).
 *  3. Load, SECONDS: each session holds its event stream (as the real client does); every second,
 *     each session's status (simulation time, the host's pacing and tick-gap statistics) and the
 *     host's CPU, load, memory and QEMU RSS; build bursts run alongside. Criteria (PM D-2): every
 *     session p5 >= 0.995x over 5 s windows after a 30 s warm-up; tick-gap p99 <= 100 ms; no
 *     session fails.
 *  4. Isolation under load: another user, and another user's valid session token, can neither
 *     read, stream, command nor end a session; the owner's session is unaffected.
 *  5. Faults (optional): one session ended and re-created; one session's QEMU unit killed: the
 *     failure is reported, its unit and directory are gone, the user can start again.
 *  6. Clean-up: every session ended; no QEMU unit, build job unit or session directory left.
 * The report (recordEvidence `c5-deployed-...`) records the host, the instance's policy, bundle and
 * runtime hashes, and every number.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { recordEvidence } from '../harness/env.js';
import { Circuit } from '../host/tests/r1-support.js';
import { PROTOCOL } from '../host/protocol.js';

const INSTANCE = process.env.TBI_C5_DEPLOYED ?? '';
const N = Number(process.env.TBI_C5_N ?? 1);
const SECONDS = Number(process.env.TBI_C5_SECONDS ?? 120);
const FAULTS = process.env.TBI_C5_FAULTS === '1';
const BUILD_EVERY_S = Number(process.env.TBI_C5_BUILD_EVERY ?? 0);
const WARMUP_S = 30;
const sudo = (...args: string[]) => spawnSync('sudo', ['-n', ...args], { encoding: 'utf8' });
const HAVE =
  INSTANCE !== '' &&
  sudo('test', '-f', `/etc/systemd/system/${INSTANCE}-session-host.service`).status === 0;
const SESSIONS_DIR = `/var/lib/${INSTANCE}-runtime/sessions`;
const RUN = Date.now().toString(36);

// ---- The deployed sockets, through root relays (the gate's role; the harness sets the identity).
const relays: ChildProcess[] = [];
async function relay(socket: string): Promise<string> {
  const port = 5800 + Math.floor(Math.random() * 150);
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
const json = async (r: Response) => ({
  status: r.status,
  body: (await r.json().catch(() => ({}))) as Record<string, unknown>,
});

// ---- Workloads (the C-5 mix), as the app would request them.
const SKETCH: Record<string, string> = {
  sonar: 'TbiHcSr04',
  dht: 'TbiDht22',
  lcd: 'TbiLcd',
  gpio: 'TbiGpioProof',
};
const MIX = ['sonar', 'dht', 'gpio', 'lcd', 'gpio', 'sonar'];
function circuit(w: string): Circuit {
  if (w === 'sonar') {
    const c = new Circuit().psu(5);
    const u = c.add('sensor.hc_sr04');
    const r1 = c.add('component.resistor');
    const r2 = c.add('component.resistor');
    c.set(u, 'distance', { value: 0.5, unit: 'metre' });
    c.wire('PSU1.positive', `${u}.vcc`).wire(`${u}.gnd`, 'GND1.ref').pad(5, `${u}.trig`);
    c.ohms(r1, 1000).ohms(r2, 2000);
    c.wire(`${u}.echo`, `${r1}.a`).wire(`${r1}.b`, `${r2}.a`).wire(`${r2}.b`, 'GND1.ref');
    return c.pad(18, `${r1}.b`);
  }
  if (w === 'dht') {
    const c = new Circuit().psu(3.3);
    const u = c.add('sensor.dht22');
    const r = c.add('component.resistor');
    c.wire('PSU1.positive', `${u}.vdd`).wire(`${u}.gnd`, 'GND1.ref');
    c.ohms(r, 10_000).wire(`${r}.a`, 'PSU1.positive').wire(`${r}.b`, `${u}.data`);
    return c.pad(4, `${u}.data`);
  }
  if (w === 'lcd') {
    const c = new Circuit().psu(4.5);
    const d = c.add('display.lcd1602_i2c');
    const p2 = c.add('instrument.lab_psu');
    c.set(p2, 'setpointVoltage', { value: 3.3, unit: 'volt' }).set(p2, 'outputEnabled', true);
    c.wire(`${p2}.negative`, 'GND1.ref')
      .wire('PSU1.positive', `${d}.vcc`)
      .wire(`${d}.gnd`, 'GND1.ref');
    for (const [line, gpio] of [
      ['sda', 21],
      ['scl', 22],
    ] as const) {
      const r = c.add('component.resistor');
      c.ohms(r, 4700).wire(`${r}.a`, `${p2}.positive`).wire(`${r}.b`, `${d}.${line}`);
      c.pad(gpio, `${d}.${line}`);
    }
    return c;
  }
  const c = new Circuit().psu(3.3);
  const r = c.add('component.resistor');
  const d = c.add('component.led');
  c.ohms(r, 220).wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref');
  return c.pad(2, `${r}.a`);
}
const sketchText = (w: string, user: string) =>
  `${readFileSync(new URL(`../firmware/arduino/${SKETCH[w]}/${SKETCH[w]}.ino`, import.meta.url), 'utf8')}\n// c5-deployed ${user}\n`;

// ---- Host measurements.
function cpu() {
  const f = readFileSync('/proc/stat', 'utf8')
    .split('\n')[0]!
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  const idle = f[3]! + f[4]!;
  const total = f.reduce((a, b) => a + b, 0);
  return { busy: total - idle, total, steal: f[7] ?? 0 };
}
/** The session's QEMU unit memory (cgroup MemoryCurrent), MiB: the sandbox hides the pid. */
const unitMemMb = (id: string) => {
  const v = sudo(
    'systemctl',
    'show',
    '-p',
    'MemoryCurrent',
    '--value',
    `${INSTANCE}-qemu@${id}.service`,
  ).stdout.trim();
  return /^\d+$/.test(v) ? Number(v) / 2 ** 20 : null;
};
const pct = (a: number[], p: number) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const sha = (f: string) => sudo('sha256sum', f).stdout.split(' ')[0] ?? null;

interface Live {
  user: string;
  workload: string;
  id: string;
  token: string;
  startedAt: number;
  startupMs: number | null;
  last: [number, number];
  last5: [number, number];
  ticks: number;
  rates5: number[];
  fault?: string;
  status?: Record<string, unknown>;
  /** The session's event stream, held open as the real client does (it also holds the lease). */
  stream?: AbortController;
  streamBytes: number;
}

describe('C-5 deployed: N concurrent ESP32 sessions on a deployed instance', () => {
  it.skipIf(!HAVE)(
    `${INSTANCE || '(no instance)'}: N=${N}, ${SECONDS} s`,
    async () => {
      const BUILD = await relay(`/run/${INSTANCE}-build/api.sock`);
      const HOST = await relay(`/run/${INSTANCE}-runtime/api.sock`);
      const users = Array.from({ length: N }, (_, i) => `c5d-${RUN}-u${i}`);
      const workloads = users.map((_, i) => MIX[i % MIX.length]!);

      // 1. Builds: all at once, each really compiled.
      type BuildRec = {
        user: string;
        workload: string;
        status: number;
        submittedMs: number;
        doneMs?: number;
        ok?: boolean;
        sha?: string;
        refused?: string;
      };
      const burst = async (round: number): Promise<BuildRec[]> =>
        Promise.all(
          users.map(async (user, i) => {
            const rec: BuildRec = {
              user,
              workload: workloads[i]!,
              status: 0,
              submittedMs: performance.now(),
            };
            const s = await fetch(`${BUILD}/v1/builds`, {
              method: 'POST',
              headers: as(user, { 'content-type': 'application/json' }),
              body: JSON.stringify({
                protocol: 'tbi-lab.build/1',
                profile: 'esp32-arduino-3.3.12',
                files: [
                  { name: 'sketch.ino', text: sketchText(workloads[i]!, `${user}-r${round}`) },
                ],
              }),
            }).then(json);
            rec.status = s.status;
            if (s.status !== 202 && s.status !== 200) {
              rec.refused = String(s.body.error ?? s.status);
              return rec;
            }
            if (s.status === 200) throw new Error('unexpected cache hit for a unique sketch');
            for (;;) {
              const st = (await (
                await fetch(`${BUILD}/v1/builds/${s.body.buildId as string}`, {
                  headers: as(user, { authorization: `Bearer ${s.body.token as string}` }),
                })
              ).json()) as {
                state: string;
                result?: { ok: boolean; artifact?: { sha256: string } };
              };
              if (st.state === 'succeeded' || st.state === 'failed') {
                rec.doneMs = performance.now();
                rec.ok = st.state === 'succeeded';
                rec.sha = st.result?.artifact?.sha256;
                return rec;
              }
              if (performance.now() - rec.submittedMs > 600_000) {
                rec.refused = `stuck ${st.state}`;
                return rec;
              }
              await new Promise((r) => setTimeout(r, 500));
            }
          }),
        );
      const builds = await burst(0);
      const worstBuildMs = Math.max(...builds.map((b) => (b.doneMs ?? Infinity) - b.submittedMs));

      // 2. Sessions.
      const sessions: Live[] = [];
      const admission: { user: string; status: number; error?: unknown }[] = [];
      const start = async (i: number, replaces?: number) => {
        const user = users[i]!;
        const b = builds[i]!;
        if (!b.sha) return 0;
        const l = await fetch(`${BUILD}/v1/artifacts/${b.sha}/lease`, {
          method: 'POST',
          headers: as(user),
        }).then(json);
        const req = circuit(workloads[i]!).request(b.sha);
        const t0 = performance.now();
        const a = await fetch(`${HOST}/sessions`, {
          method: 'POST',
          headers: as(user, { 'content-type': 'application/json' }),
          body: JSON.stringify({
            ...req,
            protocol: PROTOCOL,
            artifact: { sha256: b.sha },
            ticket: l.body.ticket,
          }),
        }).then(json);
        admission.push({
          user,
          status: a.status,
          ...(a.status !== 201 ? { error: a.body.error } : {}),
        });
        if (a.status !== 201) return a.status;
        const x: Live = {
          user,
          workload: workloads[i]!,
          id: a.body.sessionId as string,
          token: a.body.token as string,
          startedAt: t0,
          startupMs: null,
          last: [t0, 0],
          last5: [t0, 0],
          ticks: 0,
          rates5: [],
          stream: new AbortController(),
          streamBytes: 0,
        };
        await fetch(`${HOST}/sessions/${x.id}/run`, {
          method: 'POST',
          headers: as(user, { authorization: `Bearer ${x.token}` }),
        });
        void fetch(`${HOST}/sessions/${x.id}/events?after=0`, {
          headers: as(user, { authorization: `Bearer ${x.token}` }),
          signal: x.stream!.signal,
        })
          .then(async (r) => {
            const rd = r.body?.getReader();
            for (;;) {
              const c = await rd?.read();
              if (!c || c.done) return;
              x.streamBytes += c.value.byteLength;
            }
          })
          .catch(() => undefined); // aborted at clean-up, or closed by the host at a terminal state
        if (replaces !== undefined) sessions[replaces] = x;
        else sessions.push(x);
        return a.status;
      };
      for (let i = 0; i < N; i++) await start(i);
      const statusOf = (x: Live, user = x.user, token = x.token) =>
        fetch(`${HOST}/sessions/${x.id}`, {
          headers: as(user, { authorization: `Bearer ${token}` }),
        }).then(json);

      // 3. Load, with 4. isolation and 5. faults inside it.
      const isolation: Record<string, number>[] = [];
      const faults: Record<string, unknown> = {};
      const cpuBusy: number[] = [];
      const load: number[] = [];
      const memAvail: number[] = [];
      const qemuRss: number[] = [];
      let prev = cpu();
      const host0 = prev;
      const t0 = performance.now();
      let nextBurst = BUILD_EVERY_S > 0 ? BUILD_EVERY_S : Infinity;
      let round = 0;
      const soakBuilds: BuildRec[] = [];
      // Bursts run alongside the per-second sampling (awaiting one stalled sampling for a whole
      // build: the 2026-10-13 smoke's soak session then ended by lease).
      const bursts: Promise<void>[] = [];
      while (performance.now() - t0 < SECONDS * 1000) {
        await new Promise((r) => setTimeout(r, 1000));
        const now = performance.now();
        const elapsed = (now - t0) / 1000;
        for (const x of sessions) {
          if (x.fault) continue;
          const st = await statusOf(x);
          x.status = st.body;
          const sim = Number(st.body.simNs ?? 0) / 1e9;
          if (x.startupMs === null && st.body.state === 'running' && sim > 0)
            x.startupMs = Math.round(now - x.startedAt);
          if (++x.ticks % 5 === 0) {
            if ((x.last5[0] - x.startedAt) / 1000 >= WARMUP_S)
              x.rates5.push((sim - x.last5[1]) / ((now - x.last5[0]) / 1000));
            x.last5 = [now, sim];
          }
          const m = unitMemMb(x.id);
          if (m !== null) qemuRss.push(m);
        }
        if (isolation.length === 0 && elapsed >= WARMUP_S + 15 && sessions.length > 0) {
          for (const [k, x] of sessions.entries()) {
            const other = sessions[(k + 1) % sessions.length]!;
            const foreign = `c5d-${RUN}-intruder`;
            const r: Record<string, number> = {
              statusForeignUser: (await statusOf(x, foreign)).status,
              statusOtherUsersToken:
                other === x ? -1 : (await statusOf(x, other.user, other.token)).status,
              eventsForeignUser: await fetch(`${HOST}/sessions/${x.id}/events?after=0`, {
                headers: as(foreign, { authorization: `Bearer ${x.token}` }),
              }).then((q) => {
                void q.body?.cancel();
                return q.status;
              }),
              commandForeignUser: (
                await fetch(`${HOST}/sessions/${x.id}/commands`, {
                  method: 'POST',
                  headers: as(foreign, {
                    authorization: `Bearer ${x.token}`,
                    'content-type': 'application/json',
                  }),
                  body: JSON.stringify({
                    category: 'mirror',
                    seq: 1,
                    projectRevision: 999,
                    component: 'PSU1',
                    control: { setpointVoltage: 1 },
                  }),
                })
              ).status,
              endForeignUser: (
                await fetch(`${HOST}/sessions/${x.id}`, {
                  method: 'DELETE',
                  headers: as(foreign, { authorization: `Bearer ${x.token}` }),
                })
              ).status,
              ownerStillRunningAfter: (await statusOf(x)).body.state === 'running' ? 1 : 0,
            };
            isolation.push(r);
          }
        }
        if (FAULTS && !faults.stop && elapsed >= WARMUP_S + 25 && sessions.length > 0) {
          const x = sessions[0]!;
          x.fault = 'ended';
          const e = await fetch(`${HOST}/sessions/${x.id}`, {
            method: 'DELETE',
            headers: as(x.user, { authorization: `Bearer ${x.token}` }),
          });
          faults.stop = { status: e.status, recreated: await start(users.indexOf(x.user), 0) };
        }
        if (FAULTS && !faults.crash && elapsed >= WARMUP_S + 45 && sessions.length > 1) {
          const x = sessions[1]!;
          x.fault = 'crashed';
          const unit = `${INSTANCE}-qemu@${x.id}.service`;
          sudo('systemctl', 'kill', '-s', 'KILL', unit);
          let reported: unknown = null;
          for (let k = 0; k < 60 && !reported; k++) {
            const st = await statusOf(x);
            if (['failed', 'ended'].includes(st.body.state as string))
              reported = { state: st.body.state, reason: st.body.reason };
            else await new Promise((r) => setTimeout(r, 500));
          }
          faults.crash = {
            reported,
            unitGone: sudo('systemctl', 'is-active', unit).stdout.trim() !== 'active',
          };
          (faults.crash as { recreated?: number }).recreated = await start(
            users.indexOf(x.user),
            1,
          );
        }
        if (elapsed >= nextBurst) {
          bursts.push(burst(++round).then((r) => void soakBuilds.push(...r)));
          nextBurst += BUILD_EVERY_S;
        }
        const c = cpu();
        cpuBusy.push((c.busy - prev.busy) / Math.max(1, c.total - prev.total));
        prev = c;
        load.push(Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]));
        const ma = /MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'));
        if (ma) memAvail.push(Number(ma[1]) / 1024);
      }

      await Promise.all(bursts);

      // 6. Clean-up and leak check.
      const results = sessions.map((x) => ({
        user: x.user,
        workload: x.workload,
        ...(x.fault ? { fault: x.fault } : {}),
        state: x.status?.state,
        reason: x.status?.reason,
        startupMs: x.startupMs,
        rate5sP5: pct(x.rates5, 5),
        rate5sMin: x.rates5.length ? Math.min(...x.rates5) : null,
        windows5s: x.rates5.length,
        pace: x.status?.pace,
        streamBytes: x.streamBytes,
      }));
      for (const x of sessions) {
        await fetch(`${HOST}/sessions/${x.id}`, {
          method: 'DELETE',
          headers: as(x.user, { authorization: `Bearer ${x.token}` }),
        });
        x.stream?.abort();
      }
      let leftovers = { qemuUnits: -1, buildJobs: -1, sessionDirs: -1 };
      for (let k = 0; k < 60; k++) {
        const units = (p: string) =>
          sudo('systemctl', 'list-units', '--plain', '--no-legend', '--state=active', p)
            .stdout.trim()
            .split('\n')
            .filter(Boolean).length;
        const dirs = sudo('find', SESSIONS_DIR, '-mindepth', '1', '-maxdepth', '1')
          .stdout.trim()
          .split('\n')
          .filter(Boolean).length;
        leftovers = {
          qemuUnits: units(`${INSTANCE}-qemu@*`),
          buildJobs: units(`${INSTANCE}-build-job@*`),
          sessionDirs: dirs,
        };
        if (!leftovers.qemuUnits && !leftovers.buildJobs && !leftovers.sessionDirs) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const measured = results.filter((r) => !r.fault && r.windows5s > 0);
      const allBuilds = [...builds, ...soakBuilds];
      const end = cpu();
      const report = {
        instance: INSTANCE,
        n: N,
        seconds: SECONDS,
        warmupExcludedS: WARMUP_S,
        host: {
          cpus: availableParallelism(),
          memTotalMb: Math.round(totalmem() / 2 ** 20),
          kernel: spawnSync('uname', ['-r'], { encoding: 'utf8' }).stdout.trim(),
          cpuBusyMean: cpuBusy.reduce((a, b) => a + b, 0) / Math.max(1, cpuBusy.length),
          cpuBusyP95: pct(cpuBusy, 95),
          stealShare: (end.steal - host0.steal) / Math.max(1, end.total - host0.total),
          loadMax: load.length ? Math.max(...load) : null,
          memAvailableMinMb: memAvail.length ? Math.round(Math.min(...memAvail)) : null,
          qemuUnitMemMaxMb: qemuRss.length ? Math.round(Math.max(...qemuRss)) : null,
        },
        deployed: {
          health: (await fetch(`${HOST}/health`).then(json)).body,
          policySha256: sha(`/etc/${INSTANCE}/policy.json`),
          runtimeJsonSha256: sha(`/etc/${INSTANCE}/runtime.json`),
          qemuUnitSha256: sha(`/etc/systemd/system/${INSTANCE}-qemu@.service`),
        },
        builds: allBuilds.map((b) => ({
          user: b.user,
          workload: b.workload,
          status: b.status,
          ok: b.ok ?? null,
          refused: b.refused ?? null,
          completionMs: b.doneMs !== undefined ? Math.round(b.doneMs - b.submittedMs) : null,
        })),
        worstBuildMs: Number.isFinite(worstBuildMs) ? Math.round(worstBuildMs) : null,
        admission,
        sessions: results,
        isolation,
        ...(FAULTS ? { faults } : {}),
        leftovers,
        pass: {
          sessionsAdmitted: admission.filter((a) => a.status === 201).length >= N,
          rate5sP5AtLeast0995:
            measured.length > 0 && measured.every((r) => (r.rate5sP5 ?? 0) >= 0.995),
          tickGapP99AtMost100: measured.every(
            (r) =>
              ((r.pace as { tickGapMs?: { p99?: number } } | undefined)?.tickGapMs?.p99 ??
                Infinity) <= 100,
          ),
          noFailures: results.filter((r) => !r.fault).every((r) => r.state === 'running'),
          buildsAllSucceeded: allBuilds.every((b) => b.ok === true),
          buildsNoneRefused: allBuilds.every((b) => !b.refused),
          buildWorstAtMost120s: worstBuildMs <= 120_000,
          isolationEnforced:
            isolation.length > 0 &&
            isolation.every(
              (r) =>
                [
                  r.statusForeignUser,
                  r.eventsForeignUser,
                  r.commandForeignUser,
                  r.endForeignUser,
                  r.statusOtherUsersToken,
                ].every((s) => s !== undefined && (s === -1 || s >= 400)) &&
                r.ownerStillRunningAfter === 1,
            ),
          ...(FAULTS
            ? {
                // Only the faults that ran (the crash needs two sessions): ended -> re-created;
                // crashed -> reported, its unit gone, re-created. Judged on the faulted users' own
                // re-admissions (a policy refusal of another user is `sessionsAdmitted`).
                faultsRecovered:
                  (!faults.stop ||
                    ((faults.stop as { status: number }).status < 300 &&
                      (faults.stop as { recreated?: number }).recreated === 201)) &&
                  (!faults.crash ||
                    ((faults.crash as { unitGone?: boolean }).unitGone === true &&
                      !!(faults.crash as { reported?: unknown }).reported &&
                      (faults.crash as { recreated?: number }).recreated === 201)),
              }
            : {}),
          noLeftovers:
            leftovers.qemuUnits === 0 && leftovers.buildJobs === 0 && leftovers.sessionDirs === 0,
        },
      };
      recordEvidence(`c5-deployed-${INSTANCE}-n${N}-${SECONDS}s${FAULTS ? '-faults' : ''}`, report);
      console.log(JSON.stringify(report, null, 2));
      // The harness reports; acceptance is the `pass` record (a policy that admits fewer than N
      // sessions is a finding, not a harness failure).
      expect(report.leftovers).toEqual({ qemuUnits: 0, buildJobs: 0, sessionDirs: 0 });
    },
    (SECONDS + 1500) * 1000,
  );
});
